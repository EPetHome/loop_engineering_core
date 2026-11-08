/** 测试节点：只运行卡上命令及已登记的只读准备/环境恢复方法，不调用任何其他节点。 */
import { appendFileSync, lstatSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Exec, ExecResult } from "./git.ts";
import type { NodeInput, NodeOutput } from "./kernel.ts";
import { classifyFailure, type Failure } from "./failure.ts";
import { checkedMaterialPath, createRunResource, managedShell, releaseRunResource, resourceLine } from "./resources.ts";
import { fileDigest, managedConfig, workspaceGuard } from "./kernel-workspace.ts";
import { confirmedConsumerRelease, readTaskRun, updateTaskRun, taskDefinition } from "./node-ledger.ts";
import { createTestWorkspace } from "./test-workspace.ts";

export async function runTestNode(input: NodeInput, exec: Exec): Promise<NodeOutput> {
  const command = taskDefinition(input.run).test!, log = join(input.evidenceDir, "test.log"), report = join(input.evidenceDir, "test.json");
  const operations: string[] = [], calls: unknown[] = [], evidence = [log, report];
  writeFileSync(log, "", { mode: 0o600 });
  if (/^无[:：]/.test(command)) {
    writeFileSync(report, JSON.stringify({ command, result: "没验证", reason: command }));
    return { status: "没验证", reason: command, evidence, operations: [command], released: true };
  }
  const deadline = input.deadline ?? Date.now() + input.run.card.limits.测试.timeoutMin * 60_000;
  const resource = createRunResource(`kernel-test:${input.run.id}:${input.attempt}`, 0, input.procsFile);
  // 专用、首次为空的运行时输出通道；不靠忽略规则猜测既有 .pyc 是否可写，也不改卡上命令。
  const runtimeCache = { variable: "PYTHONPYCACHEPREFIX", path: join(resource.dir, "python-cache"), resource: resource.id,
    artifacts: [] as { path: string; relative: string; hash: string; size: number }[], capturedAt: "", release: "未确认" };
  const captureCache = (path: string): void => {
    const info = lstatSync(path, { throwIfNoEntry: false });
    if (!info) return;
    checkedMaterialPath(resource.dir, path);
    if (info.isDirectory()) for (const name of readdirSync(path)) captureCache(join(path, name));
    else {
      if (!info.isFile() || info.nlink !== 1 || !path.endsWith(".pyc")) throw new Error(`运行时缓存通道出现未知产物/链接：${path}`);
      runtimeCache.artifacts.push({ path, relative: relative(runtimeCache.path, path), hash: fileDigest(path), size: info.size });
    }
  };
  let output: NodeOutput = { status: "没验证", reason: "测试未完成", evidence, operations, released: false };
  let consumersReleased = true;
  let checkout: ReturnType<typeof createTestWorkspace> | undefined;
  const guard = workspaceGuard(input.run);
  const live = (): void => {
    input.signal?.throwIfAborted();
    const r = readTaskRun(input.ledger, input.taskId);
    if (r.stopped || r.abandoned || r.activity?.id !== input.attempt || r.userVersion !== input.run.userVersion || (r.epoch ?? 0) !== (input.run.epoch ?? 0)) throw new Error("测试已取消或输入版本变化");
    if (workspaceGuard(r) !== guard) throw new Error("测试/恢复期间原候选工作区或索引变化，当前结果无效");
    checkout?.assertUnchanged();
  };
  const execute = async (cmd: string, role: string): Promise<ExecResult> => {
    live(); if (Date.now() >= deadline) throw new Error("测试节点独立时间预算耗尽");
    const started = new Date().toISOString(); operations.push(`$ ${cmd}（cwd ${checkout!.cwd}；候选隔离检出；${role}；${started}）`);
    appendFileSync(log, `\n${started} [${role}] $ ${cmd}\ncwd: ${checkout!.cwd}\nsource: ${input.run.worktree}\nPYTHONPYCACHEPREFIX: ${runtimeCache.path}\n`);
    const witness = checkout!.command(cmd), previouslyReleased = consumersReleased; consumersReleased = false;
    let result: ExecResult;
    try {
      result = await exec("/bin/sh", ["-c", managedShell(cmd, resource)], { cwd: checkout!.cwd, timeout: Math.max(1, deadline - Date.now()), signal: input.signal,
        role, env: { ...witness.env, GIT_OPTIONAL_LOCKS: "0", PYTHONPYCACHEPREFIX: runtimeCache.path, AUTOREVIEW_RUN_DIR: input.evidenceDir, AUTOREVIEW_BASE_REV: input.run.base, AUTOREVIEW_BATCH_FILE: input.run.file, AUTOREVIEW_TASK: taskDefinition(input.run).name },
        onControl: witness.onControl, onOutput: (chunk) => appendFileSync(log, chunk) });
    } catch (error) { witness.finish({ code: 1, stdout: "", stderr: String(error), killed: true, processesReleased: false }); throw error; }
    witness.finish(result);
    consumersReleased = previouslyReleased && result.processesReleased === true;
    appendFileSync(log, `\nexit=${result.code}; interrupted=${result.killed}; released=${result.processesReleased}\n${result.stdout}\n${result.stderr}\n`);
    calls.push({ command: cmd, role, cwd: checkout!.cwd, runtimeCache: runtimeCache.path, started, ended: new Date().toISOString(), ...result });
    live(); return result;
  };
  try {
    input.registerResource?.(resource);
    checkout = createTestWorkspace(input);
    operations.push(`隔离检出 ${checkout.cwd}；绑定 ${input.candidate.commit}/${input.candidate.tree} 与输入 ${input.inputs}；原候选严格守卫，产物不回写`);
    let result = await execute(command, "任务测试"), failure: Failure | undefined;
    for (;;) {
      if (!consumersReleased) { failure = { kind: "environment", reason: "测试消费者释放未确认" }; break; }
      if (result.code === 0 && !result.killed) { failure = undefined; output = { status: "通过", evidence, operations, released: true }; break; }
      failure = classifyFailure(result.code, `${result.stdout}\n${result.stderr}`, result.killed);
      if (failure.kind === "product" || input.signal?.aborted || Date.now() >= deadline) break;
      const allowed = updateTaskRun(input.ledger, input.taskId, (r) => {
        const counters = (r.counters ??= {}).测试 ??= { repairs: 0, recoveries: 0 };
        if (r.stopped || r.activity?.id !== input.attempt || counters.recoveries >= r.card.limits.测试.maxRecoveries) return false;
        counters.recoveries++; return true;
      });
      if (!allowed) break;
      const preparation = managedConfig(input.run.worktree, input.run.inputVersion === 2).preparation;
      if (preparation) {
        // 复用已登记方法，但不进入可写产品的方法修复分支，也不展开准备服务的另一个重试循环。
        if (failure.kind === "environment" && preparation.recover && preparation.maxRecoveries > 0) {
          const recovered = await execute(preparation.recover, "测试环境恢复");
          if (recovered.code !== 0 || recovered.killed || !consumersReleased) { failure = { kind: "environment", reason: "已有恢复方法失败或释放未确认" }; break; }
        }
        const checked = await execute(preparation.check, "测试只读条件复查");
        if (checked.code !== 0 || checked.killed || !consumersReleased) { failure = classifyFailure(checked.code, `${checked.stdout}\n${checked.stderr}`, checked.killed); if (failure.kind === "product") failure.kind = "method"; break; }
      } else operations.push("没有已登记的适用恢复方法；仅按剩余额度重试原命令");
      result = await execute(command, "任务测试恢复重试");
    }
    if (failure) output = { status: failure.kind === "product" ? "不通过" : "没验证", failure: failure.kind, reason: failure.reason, evidence, operations, released: consumersReleased };
  } catch (error) {
    output = { status: "中断", failure: "environment", reason: String(error), evidence, operations, released: consumersReleased };
  } finally {
    await new Promise<void>((ok) => setImmediate(ok));
    try { captureCache(runtimeCache.path); runtimeCache.capturedAt = new Date().toISOString(); }
    catch (error) { output.status = "中断"; output.failure = "environment"; output.reason = [output.reason, String(error)].filter(Boolean).join("；"); }
    const lateReceipt = readTaskRun(input.ledger, input.taskId).consumerReleases?.find((r) => r.attempt === input.attempt && r.confirmed);
    const consumersKnown = consumersReleased || confirmedConsumerRelease(readTaskRun(input.ledger, input.taskId), input.attempt);
    const released = releaseRunResource(resource, !consumersKnown);
    runtimeCache.release = released.status;
    output.released = consumersKnown && released.status === "released";
    if (checkout) {
      const isolation = checkout.finish(output.released); evidence.push(isolation.evidence);
      if (isolation.reason) { output.status = "中断"; output.failure = "environment"; output.reason = [output.reason, isolation.reason].filter(Boolean).join("；"); }
      const retained = readTaskRun(input.ledger, input.taskId).testWorkspaces?.find((e) => e.attempt === input.attempt)?.state !== "released";
      if (retained) output.released = false;
    }
    if (!output.released) { output.status = "没验证"; output.failure = "environment"; output.reason = `${output.reason ?? ""}；${resourceLine(released)}`; }
    writeFileSync(report, JSON.stringify({ attempt: input.attempt, candidate: input.candidate, inputs: input.inputs, command, cwd: checkout?.cwd, source: input.run.worktree, deadline,
      calls, runtimeCache, executorConsumersReleased: consumersReleased, consumerReleaseProof: lateReceipt, result: output.status, failure: output.failure, reason: output.reason, released: output.released, resource }, null, 2), { mode: 0o600 });
  }
  return output;
}

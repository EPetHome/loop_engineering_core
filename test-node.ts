/** 测试节点：只运行卡上命令及已登记的只读准备/环境恢复方法，不调用任何其他节点。 */
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Exec, ExecResult } from "./git.ts";
import type { NodeInput, NodeOutput } from "./kernel.ts";
import { classifyFailure, type Failure } from "./failure.ts";
import { createRunResource, managedShell, releaseRunResource, resourceLine } from "./resources.ts";
import { managedConfig, workspaceGuard } from "./kernel-workspace.ts";
import { readTaskRun, updateTaskRun, taskDefinition } from "./node-ledger.ts";

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
  let output: NodeOutput = { status: "没验证", reason: "测试未完成", evidence, operations, released: false };
  let consumersReleased = true;
  const guard = workspaceGuard(input.run);
  const live = (): void => {
    input.signal?.throwIfAborted();
    const r = readTaskRun(input.ledger, input.taskId);
    if (r.stopped || r.abandoned || r.activity?.id !== input.attempt || r.userVersion !== input.run.userVersion || (r.epoch ?? 0) !== (input.run.epoch ?? 0)) throw new Error("测试已取消或输入版本变化");
    if (workspaceGuard(r) !== guard) throw new Error("测试/恢复期间产品工作区或索引变化，当前结果无效");
  };
  const execute = async (cmd: string, role: string): Promise<ExecResult> => {
    live(); if (Date.now() >= deadline) throw new Error("测试节点独立时间预算耗尽");
    const started = new Date().toISOString(); operations.push(`$ ${cmd}（cwd ${input.run.worktree}；${role}；${started}）`);
    appendFileSync(log, `\n${started} [${role}] $ ${cmd}\ncwd: ${input.run.worktree}\n`);
    const result = await exec("/bin/sh", ["-c", managedShell(cmd, resource)], { cwd: input.run.worktree, timeout: Math.max(1, deadline - Date.now()), signal: input.signal,
      role, env: { AUTOREVIEW_RUN_DIR: input.evidenceDir, AUTOREVIEW_BASE_REV: input.run.base, AUTOREVIEW_BATCH_FILE: input.run.file, AUTOREVIEW_TASK: taskDefinition(input.run).name },
      onOutput: (chunk) => appendFileSync(log, chunk) });
    consumersReleased &&= result.processesReleased === true;
    appendFileSync(log, `\nexit=${result.code}; interrupted=${result.killed}; released=${result.processesReleased}\n${result.stdout}\n${result.stderr}\n`);
    calls.push({ command: cmd, role, cwd: input.run.worktree, started, ended: new Date().toISOString(), ...result });
    live(); return result;
  };
  try {
    input.registerResource?.(resource);
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
      const preparation = managedConfig(input.run.worktree).preparation;
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
    const released = releaseRunResource(resource);
    output.released = consumersReleased && released.status === "released";
    if (!output.released) { output.status = "没验证"; output.failure = "environment"; output.reason = `${output.reason ?? ""}；${resourceLine(released)}`; }
    writeFileSync(report, JSON.stringify({ attempt: input.attempt, candidate: input.candidate, inputs: input.inputs, command, cwd: input.run.worktree, deadline,
      calls, result: output.status, failure: output.failure, reason: output.reason, released: output.released, resource }, null, 2), { mode: 0o600 });
  }
  return output;
}

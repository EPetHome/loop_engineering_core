/** 部署节点：实际发布身份 → cmd/check → 可证明安全的本机反向 CAS；绝不推送或读旧队列。 */
import { closeSync, copyFileSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { acquireProjectExecution } from "./project-execution.ts";
import { executeDeploymentCommand } from "./deployment-exec.ts";
import { checkInputs, dirtyPaths, fileDigest, frozenCardProblem, gitRaw, workspaceGuard } from "./kernel-workspace.ts";
import { readRun, updateRun, type DeploymentAttempt, type KernelRun } from "./node-ledger.ts";
import { gitText, worktreeForBranch } from "./workspace.ts";
import { consumerProblem } from "./local-node-queue.ts";
import { eventLock } from "./events.ts";
import type { NodeInput, NodeOutput } from "./kernel.ts";
import type { Exec } from "./git.ts";

export function deploymentUncertainty(attempt: DeploymentAttempt | undefined): string | undefined {
  if (!attempt) return undefined;
  if (attempt.calls.some((c) => !c.ended || c.killed || c.released !== true) || attempt.rollback?.state === "intent"
    || attempt.category === "cancelled" && attempt.calls.length > 0) return "已有部署动作的外部副作用未确认；保留日志和现场，须人工核对，不盲目重跑或回退";
  if (attempt.status === "blocked" && attempt.calls.length > 0) return "命令已启动但部署边界失效，副作用需人工核对；不盲重跑或回退";
  if (!attempt.ended && attempt.status !== "waiting") return "部署在途尝试未收尾，不能重复执行";
  return undefined;
}
export async function runDeploymentNode(input: NodeInput, exec: Exec, retryAttempt?: string): Promise<NodeOutput> {
  const { run } = input, plan = run.deploymentPlan!, p = run.publication!;
  const old = run.deploymentAttempts?.at(-1), uncertain = deploymentUncertainty(old);
  if (uncertain) throw new Error(uncertain);
  const attempt: DeploymentAttempt = { id: input.attempt, inputs: input.inputs, publication: { commit: p.commit, tree: p.tree }, config: plan.config, cwd: plan.cwd,
    started: new Date().toISOString(), status: "waiting", calls: [], released: true, ...(retryAttempt ? { retryOf: retryAttempt } : {}), log: join(input.evidenceDir, "deployment.log"), procs: input.procsFile!, binding: checkInputs(run, "部署") };
  writeFileSync(attempt.log, "", { mode: 0o600 });
  const claimed = updateRun(input.ledger, (r) => {
    if (r.stopped || r.activity?.id !== input.attempt || r.deploymentAttempts?.at(-1)?.id !== retryAttempt) return false;
    (r.deploymentAttempts ??= []).push(attempt); return true;
  });
  if (!claimed) return { status: "没验证", reason: "部署执行/重跑绑定的原尝试已变化；未执行过期命令", evidence: [attempt.log], operations: [], released: true };
  const save = (change: (a: DeploymentAttempt, r: KernelRun) => void): void => updateRun(input.ledger, (r) => {
    const a = r.deploymentAttempts!.find((a) => a.id === input.attempt)!; change(a, r); Object.assign(attempt, a);
  });
  const live = (): void => {
    input.signal?.throwIfAborted(); const r = readRun(input.ledger);
    if (gitText(r.repo, ["remote", "get-url", "--push", "origin"]) !== p.origin) throw new Error("发布 origin 身份变化，未继续部署/回退");
    if (r.stopped || r.abandoned || r.pendingCard || frozenCardProblem(r) || r.activity?.id !== input.attempt || (r.epoch ?? 0) !== (run.epoch ?? 0)
      || r.publication?.commit !== p.commit || r.publication.push !== "成功" || checkInputs(r, "部署").hash !== input.inputs) throw new Error("部署控制/配置/卡或发布身份变化，禁止后续命令及回退");
  };
  const targetRun = (): KernelRun => ({ ...readRun(input.ledger), worktree: plan.cwd, branch: "dev", workspaceCreated: true });
  const version = (commit: string): void => {
    live(); const r = targetRun();
    if (worktreeForBranch(r.repo, "dev")?.path !== plan.cwd || gitText(plan.cwd, ["rev-parse", "HEAD"]) !== commit || gitText(r.repo, ["rev-parse", "refs/heads/dev"]) !== commit
      || gitText(plan.cwd, ["rev-parse", "HEAD^{tree}"]) !== gitText(r.repo, ["rev-parse", `${commit}^{tree}`])) throw new Error("当前本地目标已前进/来源不明或执行目录不是本批发布；未部署旧版本、未回退");
    if (dirtyPaths(r).length) throw new Error(`运行目录有脏内容，不部署、不回退：${dirtyPaths(r).join("、")}`);
    // 配置/本机脚本不属于 Git 树，也必须保持冻结的原始字节。
    for (const file of r.localFiles.filter((f) => f !== ".autoreview.json")) if (!existsSync(join(plan.cwd, file)) || fileDigest(join(plan.cwd, file)) !== run.localHashes[file]) throw new Error(`部署本机方法变更：${file}`);
  };
  let release: ((released: boolean) => void) | undefined, released = true;
  const operations: string[] = [], evidence = [attempt.log, join(input.evidenceDir, "deployment.json")];
  let status: NodeOutput["status"] = "没验证", reason = "部署未执行";
  const command = async (cmd: string, phase: "deploying" | "checking" | "redeploying", commit: string): Promise<boolean> => {
    version(commit); const guard = workspaceGuard(targetRun(), undefined, false);
    const index = gitText(plan.cwd, ["rev-parse", "--path-format=absolute", "--git-path", "index"]), indexBytes = readFileSync(index);
    const started = new Date().toISOString();
    save((a, r) => { live(); a.status = phase; a.calls.push({ command: cmd, phase, commit, started }); r.activity!.kind = "deploying"; });
    operations.push(`$ ${cmd}；cwd ${plan.cwd}；commit ${commit}；${phase}`);
    const result = await executeDeploymentCommand({ command: cmd, phase, commit, cwd: plan.cwd, timeoutMin: plan.config.timeoutMin, procs: attempt.procs, log: attempt.log, exec, signal: input.signal, label: `kernel-deployment:${run.id}:${input.attempt}:${phase}`,
      env: { AUTOREVIEW_RUN_DIR: input.evidenceDir, AUTOREVIEW_BATCH_FILE: run.file }, live: () => { version(commit); if (workspaceGuard(targetRun(), undefined, false) !== guard) throw new Error("命令启动前源码变化"); } });
    released &&= result.processesReleased === true;
    save((a, r) => { if (r.activity?.id === input.attempt) r.activity.kind = "waiting"; Object.assign(a.calls.at(-1)!, { ended: new Date().toISOString(), code: result.code, killed: result.killed, released: result.processesReleased, resource: result.resource }); a.released = released;
      if (result.code === 0 && !result.killed && released) a.running = commit; });
    if (!released || consumerProblem(attempt.procs)) { save((a) => { a.category = "release"; }); throw new Error("部署消费者释放未确认，不继续检查/回退"); }
    version(commit);
    if (workspaceGuard(targetRun(), undefined, false) !== guard || readFileSync(index).compare(indexBytes) !== 0) throw new Error("部署命令擅自修改源码/索引（含写后还原），本次结果无效，不回退");
    if (result.killed) { save((a) => { a.category = "timeout"; }); throw new Error("部署命令超时/取消，外部副作用未知，不自动回退或重做"); }
    return result.code === 0;
  };
  try {
    release = await acquireProjectExecution(plan.cwd, "deploy", attempt.procs, input.signal, live);
    version(p.commit);
    if (!await command(plan.config.cmd!, "deploying", p.commit)) {
      reason = "部署 cmd 失败，保留日志，不自动回退"; status = "不通过"; save((a) => { a.status = "failed"; a.category = "command"; });
    } else if (await command(plan.config.check!, "checking", p.commit)) {
      reason = `已部署 ${p.commit}，部署后检查通过`; status = "通过"; save((a) => { a.status = "succeeded"; });
    } else {
      save((a) => { a.category = "check"; a.status = "rolling-back"; });
      version(p.commit);
      const unlock = eventLock(join(run.common, "loop-kernel-dev.lock"));
      try {
        version(p.commit);
        if (!p.targetBefore || p.targetBefore === p.commit) throw new Error("上一版不明确，未回退");
        const touched = gitRaw(run.repo, ["diff", "--name-only", "--no-renames", "-z", p.commit, p.targetBefore, "--"]).split("\0").filter(Boolean);
        const unknown = gitRaw(plan.cwd, ["ls-files", "--others", "-z"]).split("\0").filter(Boolean);
        if (unknown.some((f) => touched.some((t) => f === t || f.startsWith(`${t}/`) || t.startsWith(`${f}/`)))) throw new Error("回退会覆盖未跟踪/忽略文件，保留现场，不回退");
        const index = gitText(plan.cwd, ["rev-parse", "--path-format=absolute", "--git-path", "index"]), lock = `${index}.lock`, scratch = join(input.evidenceDir, "rollback-index");
        const fd = openSync(lock, "wx", 0o600); let installed = false;
        try {
          copyFileSync(index, scratch);
          const checkout = (dry: boolean): void => {
            const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "read-tree", ...(dry ? ["-n"] : []), "-m", "-u", p.commit, p.targetBefore], { cwd: plan.cwd, env: { ...process.env, GIT_INDEX_FILE: scratch }, encoding: "utf8" });
            if (result.status !== 0) throw new Error(`安全回退检出失败：${result.stderr || result.stdout}`);
          };
          checkout(true);
          save((a) => { live(); a.rollback = { from: p.commit, to: p.targetBefore, state: "intent", at: new Date().toISOString() }; });
          updateRun(input.ledger, (r) => {
            version(p.commit); // 反向 CAS 与停止共用账本短锁，意图先持久化。
            gitText(run.repo, ["-c", "core.hooksPath=/dev/null", "update-ref", "refs/heads/dev", p.targetBefore, p.commit]);
            checkout(false); writeFileSync(fd, readFileSync(scratch)); fsyncSync(fd); renameSync(lock, index); installed = true;
            r.deploymentAttempts!.find((a) => a.id === input.attempt)!.rollback!.state = "applied";
          });
        } finally { closeSync(fd); if (!installed) rmSync(lock, { force: true }); rmSync(scratch, { force: true }); }
      } finally { unlock(); }
      version(p.targetBefore);
      if (await command(plan.config.cmd!, "redeploying", p.targetBefore)) {
        reason = `部署后 check 失败；本地已回退并重新部署上一版 ${p.targetBefore}；远端仍是 ${p.commit}，未远端回退/重推`;
        save((a) => { a.status = "rolled-back"; a.rollback!.state = "recovered"; });
      } else {
        reason = `部署后 check 失败；本地已回退到 ${p.targetBefore}，恢复上一版部署失败；远端仍是 ${p.commit}`;
        save((a) => { a.status = "failed"; a.rollback!.state = "failed"; });
      }
      status = "不通过";
    }
  } catch (error) {
    reason = String(error);
    const current = readRun(input.ledger);
    let changed = !!frozenCardProblem(current); try { changed ||= checkInputs(current, "部署").hash !== input.inputs; } catch { changed = true; }
    const cancelled = current.stopped || (current.epoch ?? 0) !== (run.epoch ?? 0) || input.signal?.aborted && !changed;
    save((a) => { a.status = cancelled ? "cancelled" : "blocked"; a.category = cancelled ? "cancelled" : a.category ?? "identity"; });
  } finally {
    released &&= !consumerProblem(attempt.procs) && !consumerProblem(`${attempt.procs}.cleanup`);
    release?.(released);
    save((a, r) => {
      if (r.stopped || (r.epoch ?? 0) !== (run.epoch ?? 0)) {
        a.status = "cancelled"; a.category = "cancelled"; status = "中断";
        reason = `${reason}；控制代次已撤销，原命令/回退事实保留，不把迟到结束记成有效成功`;
      }
      a.ended = new Date().toISOString(); a.reason = reason; a.released = released;
    });
    writeFileSync(evidence[1], JSON.stringify(attempt, null, 2), { mode: 0o600 });
  }
  return { status, reason, failure: status === "通过" ? undefined : "environment", evidence, operations, released };
}

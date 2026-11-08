/** 批次验收节点：复用单轮执行/证据/授权/资源；只返回统一结果，不派返修。 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseAcceptanceConfig, readMarker } from "./config.ts";
import { runAcceptanceOnce } from "./acceptance.ts";
import type { AcceptanceRecord } from "./acceptance-core.ts";
import { acceptanceSignature, checkInputs, managedConfig, reusedAcceptanceItems, workspaceGuard } from "./kernel-workspace.ts";
import { readRun, updateRun } from "./node-ledger.ts";
import { consumerProblem } from "./local-node-queue.ts";
import type { Exec } from "./git.ts";
import type { NodeInput, NodeOutput } from "./kernel.ts";
import type { RunResource } from "./resources.ts";
export async function runAcceptanceNode(input: NodeInput, exec: Exec): Promise<NodeOutput> {
  const run = input.run, state = run.acceptanceState!, plan = state?.plan;
  if (!state || !plan) throw new Error("没有内核冻结的验收范围");
  const config = parseAcceptanceConfig(readMarker(run.worktree).acceptance, run.worktree, process.env);
  if (!config) throw new Error("验收方法缺失，未调用验收方");
  const active = new Set(run.card.tasks.map((t) => t.name));
  const criteria = { ...state.criteria, items: state.criteria.items.filter((i) => !state.owners[i.id] || active.has(state.owners[i.id])).map((i) => state.grants?.version === state.criteria.version && state.grants.denied.includes(i.id) ? { ...i, declined: true } : i) };
  const signature = acceptanceSignature(run);
  if (plan.signature !== signature) throw new Error("本轮标准、授权或相关输入变化；原范围保留，需受控确认后重跑");
  const retained = reusedAcceptanceItems(run);
  const evidence: string[] = [], operations: string[] = [], guard = workspaceGuard(run), deadline = input.deadline!;
  let released = true, resource: RunResource | undefined, record: AcceptanceRecord | undefined;
  const execute: Exec = async (cmd, args, opts) => { const result = await exec(cmd, args, { ...opts, env: { ...opts.env, GIT_OPTIONAL_LOCKS: "0" } }); released &&= result.processesReleased === true; return result; };
  const live = (): void => {
    input.signal?.throwIfAborted(); const r = readRun(input.ledger);
    if (r.stopped || r.activity?.id !== input.attempt || r.userVersion !== run.userVersion || checkInputs(r, "验收").hash !== input.inputs || workspaceGuard(r) !== guard) throw new Error("验收候选/输入/工作区或控制代次变化");
  };
  let output: NodeOutput;
  for (;;) {
    live();
    const index = evidence.length, runDir = join(input.evidenceDir, `acceptance-${index}`);
    operations.push(`统一验收第 ${state.round} 轮；实测 ${plan.ids.join("、")}；沿用 ${retained.map((i) => i.id).join("、") || "无"}；树 ${input.candidate.tree}；deadline ${deadline}`);
    try {
      const result = await runAcceptanceOnce({ workDir: run.worktree, devSessionId: `${run.id}:batch`, round: state.round,
        deliveryNote: `受检工作区是只读候选 ${input.candidate.commit}（tree ${input.candidate.tree}）。不得在受检目录安装依赖、构建、生成或修改任何文件，包括被 Git 忽略的 node_modules、dist、日志与临时脚本；这些写入会中止验收。需要运行时，先将该精确候选归档/检出到系统临时目录，在副本安装原 lockfile 依赖、构建和验证；模型、渠道、账号及数据仍遵守本批隔离边界。测试脚本和证据写验收 runDir 或临时目录，核对副本与本候选的源码一致；不得把另一版本的结果当成当前通过。不要在受检目录后台启动 npm ci。当前候选自身的构建/类型错误属于产品缺陷，应按文件职责及受影响标准归因，不伪称模型或环境故障。`,
        state: { requirement: checkInputs(run).requirement, criteria, grants: state.grants },
        config, reviewerModel: managedConfig(run.worktree, true).reviewerModel, reviewerThinking: managedConfig(run.worktree, true).reviewerThinking,
        exec: execute, cleanupExec: execute, runDir, procsFile: input.procsFile, deadline, now: Date.now, previousFailed: state.previous?.items.filter((i) => i.verdict !== "通过" && i.verdict !== "需人工").map((i) => i.id) ?? [],
        explicitScope: { ids: plan.ids, retained }, boundedDeadline: true, signal: input.signal, checkLive: live, saveState: () => {},
        upstreamEpochs: { candidate: input.candidate, mapping: run.batch?.contributions, inputs: input.inputs, criteria: state.hash, grants: state.grants, round: state.round, ids: plan.ids },
        registerResource: (r) => { resource = r; input.registerResource?.(r); } });
      if (result.kind === "judged") record = result.record; else record = result.attempts?.at(-1);
      if (record) evidence.push(join(record.runDir, "result.json"));
      else { const path = join(input.evidenceDir, `paused-${index}.json`); writeFileSync(path, JSON.stringify(result, null, 2)); evidence.push(path); }
      released &&= !consumerProblem(input.procsFile!) && !consumerProblem(`${input.procsFile}.cleanup`) && (!resource || resource.status === "released");
      const failed = record?.items.filter((i) => i.verdict === "不通过") ?? [];
      const timedOut = Date.now() >= deadline;
      const product = !timedOut && result.kind === "judged" && record?.verdict === "不通过" && !record.failureKind && failed.every((i) => !!state.owners[i.id]);
      const pass = !timedOut && result.kind === "judged" && ["通过", "部分验证"].includes(record!.verdict) && record!.items.every((i) => ["通过", "需人工"].includes(i.verdict));
      output = { status: pass && released ? "通过" : product && released ? "不通过" : "没验证", failure: pass ? undefined : product ? "product" : result.kind === "paused" ? result.failureKind ?? "environment" : record?.failureKind ?? "unknown",
        reason: timedOut ? "验收/证据收尾超过本轮剩余 deadline，已有证据保留但不能通过" : result.kind === "paused" ? `${result.reason}；${result.hint}` : record?.reason, evidence, operations, released, acceptance: record };
      if (pass || product || !released || input.signal?.aborted || Date.now() >= deadline || result.kind === "paused" && /授权|异议/.test(result.reason)) break;
      const retry = updateRun(input.ledger, (r) => {
        const c = (r.counters ??= {}).验收 ??= { repairs: 0, recoveries: 0 };
        if (r.stopped || r.activity?.id !== input.attempt || c.recoveries >= r.card.limits.验收.maxRecoveries) return false;
        c.recoveries++; return true;
      });
      if (!retry) break;
      operations.push("非产品恢复：仅按剩余 deadline 和持久化额度重新调用本验收，不派任务返修");
    } catch (error) {
      const path = join(input.evidenceDir, `interrupted-${index}.txt`); writeFileSync(path, String(error)); evidence.push(path);
      released &&= !consumerProblem(input.procsFile!) && (!resource || resource.status === "released");
      output = { status: "中断", reason: String(error), failure: "environment", evidence, operations, released, acceptance: record }; break;
    }
  }
  return output!;
}

/** 入口装配：固定开发评审/提交执行器；Pi、宿主 Hook 与 CLI 使用同一账本和状态。 */
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { typedByUser } from "./acceptance-core.ts";
import { classifyMarker } from "./core.ts";
import { digest } from "./development-card.ts";
import { checkInputs, deliverCandidate, frozenCardProblem } from "./kernel-workspace.ts";
import { currentCandidate, executeNode, nodeCheckLines, qualification, queryKernel, writeKernelSummary, type NodeOutput } from "./kernel.ts";
import { activityAlive, findUserDecision, kernelRoot, readRun, updateRun, type UserDecision } from "./node-ledger.ts";
import { reviewDevelopment } from "./development-node.ts";
import { submitCandidate } from "./submission-node.ts";
import { appendLedgerRecord, appendMergeRecord } from "./ledger.ts";
import { systemNotify } from "./notify.ts";
import { processStartTime, readProcs } from "./procs.ts";
import type { Exec } from "./git.ts";
import type { ReviewerCall } from "./static-review.ts";
import { runTestNode } from "./test-node.ts";
import { applyPendingCardChange, recordCardControl } from "./kernel-controls.ts";
import { createChildExec } from "./hosts/review-hook.ts";
import { consumerProblem, readLocalQueue } from "./local-node-queue.ts";
import { validResult } from "./node-ledger.ts";

export const MANAGED_CONVENTION = ["【Loop 受管单任务】", "开发评审是一个原子节点；修复仍在本会话。最后一行写【交付完成】；需要用户决定写【需要你决定】。",
  "不要自行 git add/commit/merge/push；交付边界由程序仅提交卡上范围内改动。不要暂存本机文件或用户既有改动。",
  "自行做必要的定向自检，不跑全量；Loop 不运行卡外测试、验收、部署。只有卡上安排的测试才由程序执行；机器返修不得自行移除必需测试，改卡必须记录来源并保留用户决定。"].join("\n");

export function managedLedger(cwd: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const path = env.AUTOREVIEW_KERNEL_LEDGER;
  if (!path) return undefined;
  const run = readRun(path);
  if (run.id !== env.AUTOREVIEW_KERNEL_RUN || realpathSync(cwd) !== run.worktree || run.release.status === "已释放") throw new Error("受管任务身份不符，拒绝采用用户工作区");
  return path;
}
export function attachSession(path: string, host: "pi" | "claude" | "codex", id: string, log?: string): void {
  if (!id.trim() || id === "unknown" || /[\0\r\n]/.test(id)) throw new Error("宿主没有可精确恢复的会话身份，未认领任务");
  updateRun(path, (r) => {
    if (r.stopped || r.abandoned) throw new Error("本任务已停止；需显式续跑");
    if (r.session?.id && r.session.id !== id) throw new Error("不允许新会话冒充原开发会话；请精确恢复原 ID");
    const owner = host !== "pi" && r.launch ? { pid: r.launch.pid, started: r.launch.processStarted } : { pid: process.pid, started: processStartTime(process.pid) };
    r.session = { host, id, log, ...owner, launchId: process.env.AUTOREVIEW_KERNEL_LAUNCH };
    if (r.activity?.kind === "starting") r.activity = undefined; // 不覆盖正在排队/执行的其他节点。
  });
}
export function developerActive(path: string): void {
  updateRun(path, (r) => {
    if (r.stopped || r.publication || r.abandoned) throw new Error("任务已停止或已发布，不再自动开发");
    if (r.activity && !["starting", "developing"].includes(r.activity.kind) && activityAlive(r.activity) !== false) throw new Error("测试/检查仍执行或归属未确认，停止并确认释放后才能编辑源码");
    const problem = frozenCardProblem(r); if (problem) throw new Error(problem);
    checkInputs(r); // 进入开发/返修边界也不能静默采用未重新确认的引用内容。
    r.activity = { id: randomUUID(), node: "开发评审", kind: "developing", pid: r.session?.pid ?? process.pid, started: r.session?.started ?? processStartTime(process.pid), session: r.session?.id };
    r.stopReason = undefined;
  });
}
export function pauseManaged(path: string, reason: string): void {
  updateRun(path, (r) => { r.activity = undefined; r.stopReason = reason; r.stopped = true; r.epoch = (r.epoch ?? 0) + 1; });
  writeKernelSummary(path);
}
/** 仅适配层已核对来源为 interactive/rpc 或宿主 UserPromptSubmit 时调用；机器消息/文件块不授权。 */
export function recordManagedUserInput(path: string, raw: string, source: string, materials?: { text: string; files: { path: string; text: string }[] }, shown?: Pick<UserDecision, "candidate" | "inputs" | "userVersion" | "missing">): UserDecision | undefined {
  if (consumeManagedRepair(path, raw, materials)) return undefined;
  const text = typedByUser(raw).trim();
  if (!text || !["pi:interactive", "pi:rpc", "claude:UserPromptSubmit", "codex:UserPromptSubmit", "terminal:tty"].includes(source)) return undefined;
  if (recordCardControl(path, text, source)) return undefined;
  const run = readRun(path);
  const merge = new RegExp(`^合入(?:本批|这批|[「"']?${run.card.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[」"']?)(?:\\s*(?:--接受未验证|接受未验证|按现状))?[。！!\\s]*$`);
  if (merge.test(text) || source === "terminal:tty" && /^合入 [0-9a-f]{8}$/.test(text)) {
    const q = qualification(run), candidate = currentCandidate(run);
    if (!q.inputs) throw new Error("检查输入无法冻结，修复输入后才能确认例外合入");
    if (shown && (candidate.commit !== shown.candidate.commit || candidate.tree !== shown.candidate.tree || q.inputs !== shown.inputs
      || run.userVersion !== shown.userVersion || JSON.stringify(q.missing) !== JSON.stringify(shown.missing))) throw new Error("确认期间候选、标准或用户版本变化，请按当前内容重新确认");
    const decision: UserDecision = { id: randomUUID(), at: new Date().toISOString(), source, text, candidate, inputs: q.inputs, userVersion: run.userVersion, missing: q.missing };
    updateRun(path, (r) => {
      const current = currentCandidate(r);
      if (r.userVersion !== decision.userVersion || checkInputs(r).hash !== decision.inputs || current.commit !== candidate.commit || current.tree !== candidate.tree) throw new Error("用户决定期间候选或输入变化");
      r.decisions.push(decision);
    });
    writeKernelSummary(path); return decision;
  }
  // 普通新输入撤销旧检查资格；不清零返修计数。机器原会话返修不走这里。
  updateRun(path, (r) => {
    r.userVersion += 1; r.userInputs.push(materials?.text ?? raw);
    r.userFiles = [...new Set([...(r.userFiles ?? []), ...(materials?.files ?? []).map((f) => resolve(r.worktree, f.path))])];
    for (const file of materials?.files ?? []) (r.userFileVersions ??= {})[resolve(r.worktree, file.path)] = digest(Buffer.from(file.text, "utf8"));
    r.stopReason = "真实用户输入更新，需按当前输入重新交付";
  });
  return undefined;
}
export async function mergeManaged(path: string, options: { accept?: boolean; decision?: UserDecision; automatic?: boolean; dryRun?: boolean } = {}): Promise<NodeOutput> {
  const run = readRun(path), q = qualification(run);
  if (run.publication) return { status: run.publication.push === "成功" ? "通过" : "没验证", reason: `本地发布记录已存在；推送 ${queryKernel(path).publication?.push}，不自动重试。${run.publication.reason ?? ""}`, evidence: [], operations: [], released: true };
  // 例外只豁免缺少结论；卡、候选、目标、资源身份始终不能豁免。
  if (!q.candidate) throw new Error(`合入身份核对失败：\n${q.missing.join("\n")}`);
  currentCandidate(run);
  const cardProblem = frozenCardProblem(run); if (cardProblem) throw new Error(cardProblem);
  if (run.pendingCard || run.release.status === "未确认" || readLocalQueue().items.some((t) => t.ledger === path) || run.abandoned || run.activity && activityAlive(run.activity) !== false) throw new Error("还有节点活动、归属未确认或任务已放弃，未合入；先停止并确认资源");
  const procs = join(run.dir, "review.procs.json");
  if (existsSync(procs)) {
    const raw = JSON.parse(readFileSync(procs, "utf8"));
    if (!Array.isArray(raw) || raw.length || readProcs(procs).length) throw new Error("评审消费者释放未确认，不能合入；请先用统一停止入口核对并释放登记进程");
  }
  for (const result of run.results.filter((r) => !r.released)) {
    const problem = consumerProblem(join(run.dir, "attempts", result.id, "test.procs.json"));
    if (problem) throw new Error(problem);
  }
  if (q.missing.length && !options.accept) throw new Error(`普通合入被拒绝：\n${q.missing.join("\n")}`);
  if (options.automatic && options.accept) throw new Error("自动调度禁止接受未验证");
  const decision = findUserDecision(run, q.candidate, q.inputs, q.missing, options.decision?.id);
  if (options.dryRun) return { status: q.missing.length ? "没验证" : "通过", reason: "只读核对，未发布；例外执行仍须真实用户决定", evidence: [], operations: q.missing, released: true };
  if (options.accept && !decision) throw new Error("没有绑定本候选与逐项欠项的真实用户决定；请在原会话亲手输入「合入本批」，或在交互终端确认统一命令；卡/提示词/机器消息不算授权");
  updateRun(path, (r) => {
    if (r.userVersion !== run.userVersion || checkInputs(r).hash !== q.inputs) throw new Error("合入交接前检查输入或用户决定已变化");
    r.stopped = false; r.stopReason = undefined; if (r.activity && activityAlive(r.activity) === false) r.activity = undefined;
  }); // 停止不是放弃，允许显式发布已登记候选。
  const result = await executeNode(path, "提交", (input) => submitCandidate(input, options.accept ? decision : undefined));
  const published = readRun(path).publication;
  if (published?.local === "merged") {
    try { appendMergeRecord({ project: run.repo, batch: run.card.name, entry: `${run.id}:${published.commit}`, commit: published.commit, file: run.file, manual: [],
      notes: [`候选树：${published.tree}`, `推送 origin/dev：${published.push}；${published.reason ?? ""}`, ...nodeCheckLines(run),
        ...(options.accept && decision ? [`用户接受未验证：${decision.source}；${decision.at}；${decision.text}`, ...decision.missing] : [])] }, process.env.AUTOREVIEW_KERNEL_ROOT ? join(kernelRoot(), "交付记录.md") : undefined); }
    catch (error) { updateRun(path, (r) => { (r.notes ??= []).push(`合入索引写入失败：${String(error)}`); }); }
  }
  writeKernelSummary(path); return result;
}
export interface DeliveryOptions { exec: Exec; signal?: AbortSignal; callReviewer?: ReviewerCall; testExec?: Exec }
export function consumeManagedRepair(path: string, raw: string, materials?: { files: { path: string; text: string }[] }): boolean {
  const run = readRun(path), repair = run.repair;
  if (!repair) return false;
  // 核对真正收到的完整正文，不把“包含正确 token”或保存副本自洽当作来源证明。
  const native = run.native, launch = process.env.AUTOREVIEW_KERNEL_LAUNCH;
  const trustedClaude = repair.host === "claude" && !!launch && native?.launch === launch && run.session?.launchId === launch
    && process.env.AUTOREVIEW_KERNEL_NATIVE_BINDING === native.binding;
  const wrapper = `<cross-session-message>\n${repair.message}\n</cross-session-message>`;
  const body = trustedClaude && raw === wrapper ? raw.slice("<cross-session-message>\n".length, -"\n</cross-session-message>".length) : raw;
  const exactBody = body === repair.message && digest(body) === repair.hash;
  const references = [`@${repair.file}`, `@"${repair.file}"`, `请读取并执行 @"${repair.file}"`];
  const byFile = references.includes(raw) && materials?.files.length === 1
    && resolve(materials.files[0].path) === repair.file && digest(materials.files[0].text) === repair.hash;
  // 包装之外有追加文本（包括撤权）必须留给真实输入路径，不能吞掉。
  if (!exactBody && !byFile) return false;
  if (repair.session !== run.session?.id || repair.host !== run.session?.host || repair.userVersion !== run.userVersion || repair.epoch !== (run.epoch ?? 0)
    || repair.candidate.tree !== run.candidate?.tree || repair.inputs !== checkInputs(run, "测试").hash || digest(repair.message) !== repair.hash) throw new Error("机器返修的原会话/候选/输入身份已失效");
  if (repair.state === "read") return true;
  updateRun(path, (r) => { if (r.repair?.id === repair.id) { r.repair.state = "read"; r.repair.readAt = new Date().toISOString(); } });
  return true;
}
export async function reportManaged(path: string): Promise<void> {
  const run = readRun(path), q = queryKernel(path), checks = nodeCheckLines(run);
  writeKernelSummary(path);
  try { appendLedgerRecord({ project: run.repo, session: `${run.id}:${run.revision}`, task: run.card.name, result: `${q.status}；${q.reason}`, summary: join(run.dir, "summary.md"),
    checks: { test: checks.find((s) => s.startsWith("测试："))!.slice(3), review: checks[0].slice(3), acceptance: "没验证（本次未安排）" }, pending: [] }, process.env.AUTOREVIEW_KERNEL_ROOT ? join(kernelRoot(), "交付记录.md") : undefined); }
  catch (error) { updateRun(path, (r) => { (r.notes ??= []).push(`交付索引写入失败：${String(error)}`); }); }
  await systemNotify("Loop 单任务", q.lines.join("\n"));
}
/** 固定直线推进，节点之间仅通过账本交换结果。 */
export async function advanceManaged(path: string, options: { signal?: AbortSignal; testExec?: Exec } = {}): Promise<NodeOutput> {
  applyPendingCardChange(path);
  let run = readRun(path);
  if (run.stopped || run.abandoned || run.publication) throw new Error("任务已停止/放弃/发布，不能自动推进");
  const candidate = currentCandidate(run);
  if (!validResult(run, "开发评审", candidate, checkInputs(run, "开发评审").hash)) throw new Error(`缺当前开发评审结论；请在原会话续跑交付`);
  let output: NodeOutput = { status: "通过", evidence: [], operations: ["已有开发评审结论"], released: true };
  if (run.card.flow.includes("测试")) {
    output = await executeNode(path, "测试", (input) => runTestNode(input, options.testExec ?? createChildExec(input.procsFile)),
      { signal: options.signal, localSlot: !/^无[:：]/.test(run.card.tasks[0].test!) });
    if (output.stale) return output;
    if (applyPendingCardChange(path)) return advanceManaged(path, options);
    const last = readRun(path).results.filter((r) => r.node === "测试").at(-1);
    if (output.status !== "通过") {
      updateRun(path, (r) => {
        r.blockedNode = "测试";
        const counter = (r.counters ??= {}).测试 ??= { repairs: 0, recoveries: 0 };
        if (output.failure === "product" && output.released && !r.stopped && counter.repairs < r.card.limits.测试.maxRepairs && last) {
          if (r.repair?.attempt === last.id) { output.message = r.repair.message; return; }
          counter.repairs++;
          const id = randomUUID(), token = randomUUID();
          const message = `【Loop 测试返修】[${id}:${token}]\n测试产品失败，第 ${counter.repairs} 次测试返修（独立于静态评审次数）。\n任务 ${r.card.tasks[0].name}；候选 ${candidate.commit}/${candidate.tree}\n实际命令：${r.card.tasks[0].test}\n原因：${output.reason}\n失败输出摘录：\n${output.evidence.filter((p) => p.endsWith("test.log") && existsSync(p)).map((p) => readFileSync(p, "utf8").slice(-8000)).join("\n")}\n完整输出与证据：${output.evidence.join("、")}\n只在本原开发会话修复并定向自检；交付后先重新开发评审再测试。不得自行移除必需测试或降低标准。最后写【交付完成】。`;
          const file = join(r.dir, `test-repair-${id}.md`); writeFileSync(file, message, { flag: "wx", mode: 0o600 });
          r.repair = { id, token, attempt: last.id, session: r.session?.id ?? "unattached", host: r.session?.host ?? r.card.host, candidate, inputs: checkInputs(r, "测试").hash,
            userVersion: r.userVersion, epoch: r.epoch ?? 0, message, hash: digest(message), file, state: "pending", at: new Date().toISOString() };
          output.message = message; r.stopReason = "测试产品失败，返修回原开发会话";
        } else {
          r.stopped = true; r.stopReason = output.failure === "product" ? "达到测试返修上限；提高卡上测试限额后再继续，计数不清零" : output.reason ?? output.status;
          if (!output.released) r.release = { status: "未确认", details: [r.stopReason] };
        }
      });
      if (!output.message) await reportManaged(path);
      else writeKernelSummary(path);
      return output;
    }
    applyPendingCardChange(path); run = readRun(path);
  }
  if (run.card.flow.includes("提交")) output = await mergeManaged(path, { automatic: true });
  await reportManaged(path); return output;
}
export async function completeManagedDelivery(path: string, text: string, options: DeliveryOptions): Promise<NodeOutput> {
  let run = readRun(path);
  if (run.stopped || run.abandoned || run.publication || run.activity && !["starting", "developing"].includes(run.activity.kind)) return { status: "中断", reason: run.stopReason ?? "已有节点执行或任务停止", evidence: [], operations: [], released: true };
  if (classifyMarker(text) === "decision") { pauseManaged(path, "开发方需要你决定"); return { status: "中断", reason: "开发方需要你决定", evidence: [], operations: [], released: true }; }
  try {
    updateRun(path, (r) => { if (r.activity?.kind === "developing") r.activity = undefined; });
    applyPendingCardChange(path); run = readRun(path);
    const candidate = deliverCandidate(run);
    updateRun(path, (r) => { if (r.userVersion !== run.userVersion || r.stopped) throw new Error("交付期间输入或停止状态变化"); r.candidate = candidate; r.activity = undefined; });
    writeFileSync(join(run.dir, "delivery.md"), text);
    const output = await executeNode(path, "开发评审", (input) => reviewDevelopment(input, { ...options, signal: input.signal }), { signal: options.signal });
    if (output.stale) return output;
    const handoff = updateRun(path, (r) => {
      if (r.userVersion !== run.userVersion || r.activity || r.stopped || r.candidate?.tree !== candidate.tree) return false;
      if (output.message) r.repairs++;
      else if (output.status !== "通过") { r.stopped = true; r.stopReason = output.reason ?? output.status; if (!output.released) r.release = { status: "未确认", details: [r.stopReason] }; }
      return true;
    });
    if (!handoff) return { ...output, status: "中断", reason: "交接前输入或活动变化", message: undefined, stale: true };
    applyPendingCardChange(path);
    if (output.status === "通过") { const next = await advanceManaged(path, options); return readRun(path).card.flow.includes("测试") ? next : output; }
    if (!output.message) await reportManaged(path); else writeKernelSummary(path);
    return output;
  } catch (error) {
    const current = readRun(path);
    if (current.userVersion === run.userVersion && !current.activity) pauseManaged(path, String(error));
    return { status: "中断", reason: String(error), evidence: [], operations: [], released: false };
  }
}

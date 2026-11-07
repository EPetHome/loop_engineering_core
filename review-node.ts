/** 只评审已有对象：直接共享静态调用；不准备、不开发、不返修、不创建候选提交。 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildReviewInput, deriveReviewerSessionId } from "./core.ts";
import { executeStaticReview, staticReviewer, ReviewerCallFailure, type ReviewerCall } from "./static-review.ts";
import { saveReviewSnapshot } from "./snapshots.ts";
import { checkInputs, gitRaw, managedConfig } from "./kernel-workspace.ts";
import { readRun, updateRun } from "./node-ledger.ts";
import type { NodeInput, NodeOutput } from "./kernel.ts";
import { createGitEvidence, type Exec } from "./git.ts";

export async function runReviewNode(input: NodeInput, exec: Exec, call?: ReviewerCall): Promise<NodeOutput> {
  let released = true;
  const trackedExec: Exec = async (command, args, options) => {
    const previous = released; released = false;
    const result = await exec(command, args, { ...options, role: options.role ?? "只评审 Git 取证" });
    released = previous && result.processesReleased === true;
    if (!released) throw new Error(`只评审取证/评审消费者释放未确认，保留现场；exit=${result.code}\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  try { return await reviewExisting(input, trackedExec, call); }
  catch (error) {
    const log = join(input.evidenceDir, "review-preflight-error.log"); writeFileSync(log, String(error));
    return { status: "没验证", reason: String(error), failure: "environment", evidence: [log], operations: ["只评审取证失败；未转入开发/返修"], released };
  }
}
async function reviewExisting(input: NodeInput, exec: Exec, call?: ReviewerCall): Promise<NodeOutput> {
  const { run } = input, comparison = run.reviewComparison!, specification = run.card.review!, config = managedConfig(run.repo, true), started = Date.now();
  const files = gitRaw(run.worktree, ["diff", "--name-only", "-z", comparison.base.commit, comparison.head.commit, "--"]).split("\0").filter(Boolean);
  const checked = checkInputs(run, "评审"), write = (name: string, text: string): string => {
    const path = join(input.evidenceDir, name); writeFileSync(path, text, { mode: 0o600 }); return path;
  };
  const live = (): void => {
    input.signal?.throwIfAborted(); const r = readRun(input.ledger);
    if (r.stopped || r.activity?.id !== input.attempt || checkInputs(r, "评审").hash !== input.inputs) throw new Error("只评审已取消或输入变化；原结论无效");
  };
  const text = buildReviewInput({ round: 1, firstReview: true, requirement: checked.requirement,
    currentCriteria: specification.criteria ? readFileSync(specification.criteria, "utf8") : "未提供标准；不生成或改写用户标准",
    projectContext: `只评审已有比较；base ${comparison.base.commit}/${comparison.base.tree}；head ${comparison.head.commit}/${comparison.head.tree}。只出报告，不开发、不运行测试/验收/提交/部署。`,
    deliveryNote: specification.note ? readFileSync(specification.note, "utf8") : "只读静态评审",
    diff: gitRaw(run.worktree, ["diff", "--no-ext-diff", "--no-textconv", comparison.base.commit, comparison.head.commit, "--"]),
    diffStat: gitRaw(run.worktree, ["diff", "--stat", comparison.base.commit, comparison.head.commit, "--"]), untracked: [] });
  const inputPath = write("input.md", text), inputsPath = write("inputs.json", JSON.stringify({ comparison, inputs: input.inputs, files: checked.files }, null, 2));
  const snapshot = await saveReviewSnapshot({ exec, cwd: run.worktree, session: run.id, round: run.results.filter((r) => r.node === "评审").length + 1, baseline: comparison.base.commit,
    candidate: await createGitEvidence(exec, run.worktree, input.signal).snapshot(), input: text, inputPath,
    root: join(run.dir, "review-snapshots"), signal: input.signal });
  const timeoutMs = run.card.limits.开发评审.timeoutMin * 60_000;
  let consumersReleased = true, callIndex = 0;
  const callLogs: string[] = [];
  const actual = call ?? staticReviewer({ cwd: run.worktree, config, exec, signal: input.signal, procsFile: input.procsFile });
  const tracked: ReviewerCall = async (...args) => {
    consumersReleased = false; const index = ++callIndex;
    try {
      const result = await actual(...args); consumersReleased = result.processesReleased === true;
      callLogs.push(write(`call-${index}.json`, JSON.stringify({ session: args[0], timeoutMs: args[2], ...result }, null, 2))); return result;
    } catch (error) { if (error instanceof ReviewerCallFailure) consumersReleased = error.processesReleased; callLogs.push(write(`call-${index}.log`, String(error))); throw error; }
  };
  let output: Awaited<ReturnType<typeof executeStaticReview>>;
  try {
    output = await executeStaticReview({ session: deriveReviewerSessionId(run.id), developer: run.id, round: 1, input: inputPath,
      deadline: started + timeoutMs, timeoutMs, keepOutput: true, requireRelease: true, live, call: tracked, write });
  } catch (error) {
    const log = write("cancelled.log", String(error));
    output = { error: String(error), timedOut: false, logs: [log], released: consumersReleased };
  }
  const parsed = output.parsed;
  const status = !parsed || !output.released ? "没验证" : parsed.mustFix.length ? "不通过" : "通过";
  const reason = !output.released ? "评审消费者释放未确认" : !parsed ? output.error : parsed.mustFix.length ? "有必须修改；只出报告，不派返修" : "无必须修改；仅为静态报告，不授予合入资格";
  const report = join(input.evidenceDir, "report.md"), json = join(input.evidenceDir, "report.json");
  const record = { v: 1, id: run.id, attempt: input.attempt, baseline: comparison.base.commit, candidate: comparison.head.commit, comparison, inputs: input.inputs,
    files, status, reason, model: config.reviewerModel, durationMs: Date.now() - started, mustFix: parsed?.mustFix ?? [], mustFixRaw: parsed?.mustFixRaw ?? "",
    suggestions: parsed?.minor ?? [], questions: parsed?.questions ?? [], evidence: [inputPath, inputsPath, snapshot, ...callLogs, ...output.logs], released: output.released };
  writeFileSync(json, JSON.stringify(record, null, 2));
  writeFileSync(report, ["# 只评审报告", `基线：${comparison.base.commit} / ${comparison.base.tree}`, `候选：${comparison.head.commit} / ${comparison.head.tree}`,
    `输入：${input.inputs}`, `模型：${config.reviewerModel}`, `耗时：${record.durationMs} ms`, `结果：${status}；${reason}`, "测试/验收/提交/部署：没验证（本次未安排）",
    "\n## 改动文件", ...files.map((p) => `- ${p}`), "\n## 必须修改", parsed?.mustFixRaw || "无（调用失败时不代表已验证）", "\n## 建议", ...(parsed?.minor ?? []).map((s) => `- ${s}`),
    "\n## 证据", ...record.evidence.map((p) => `- ${p}`), ""].join("\n"));
  updateRun(input.ledger, (r) => { if (r.activity?.id === input.attempt && !r.stopped) r.reviewReport = { report, json, attempt: input.attempt }; });
  return { status, reason, failure: parsed ? parsed.mustFix.length ? "product" : undefined : "environment", evidence: [report, json, ...record.evidence],
    operations: [`只读比较 ${comparison.base.commit} → ${comparison.head.commit}；模型 ${config.reviewerModel}；最多一次失败重试，共用 ${timeoutMs}ms`], released: output.released };
}

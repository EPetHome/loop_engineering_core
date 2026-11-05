/** 只评审入口：隔离检出候选，调用共享评审引擎，最终只保留报告与证据。 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractCriteria } from "./acceptance-core.ts";
import { findProjectRoot, resolveProjectConfig, type ProjectConfigOverrides } from "./config.ts";
import { batchInfo, eventReason, pushEvent, writePhase, type BatchInfo } from "./events.ts";
import { createChildExec } from "./hosts/review-hook.ts";
import { beginBatchRun } from "./launch.ts";
import type { ReviewPlan } from "./pipeline.ts";
import { processStartTime, readProcs, reapProcs } from "./procs.ts";
import { DEFAULT_MODEL, errorText, newReviewState, runReviewRound, type ReviewDeps, type ReviewOutcome } from "./review.ts";
import { gitResult, gitText } from "./workspace.ts";

export async function runReviewOnly(review: ReviewPlan, options: {
  file?: string; name?: string; dir?: string; dryRun?: boolean; configOverrides?: ProjectConfigOverrides;
  callReviewer?: ReviewDeps["callReviewer"]; now?: () => number;
} = {}): Promise<Record<string, unknown>> {
  const initialConfig = resolveProjectConfig(findProjectRoot(review.repo), options.configOverrides);
  if (options.dryRun) {
    const base = revision(review.repo, review.base), head = revision(review.repo, review.head);
    for (const file of [review.requirement, review.criteria, review.note]) if (file) readFileSync(file, "utf8");
    return { ok: true, command: "评审", recipe: "review-only", dryRun: true, base, head, effectiveConfig: initialConfig.effectiveConfig, lines: [`只读预览：评审 ${base} → ${head}；不建 worktree、不调用评审`] };
  }
  let effectiveConfig = initialConfig.effectiveConfig;
  const id = randomUUID(), started = Date.now();
  const dir = join(homedir(), ".pi-autoreview", "reports", id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const report = join(dir, "report.md"), json = join(dir, "report.json"), procs = join(dir, "review.procs.json");
  const request = join(dir, "request.json");
  writeFileSync(request, JSON.stringify({ name: options.name ?? "只评审", recipe: "review-only", review }));
  const info: BatchInfo = { ...batchInfo(options.file ?? request, review.repo, options.dir ?? dir),
    project: resolve(review.repo), batch: { file: resolve(options.file ?? request), name: options.name ?? "只评审", recipe: "review-only" }, stages: [] };
  const active = beginBatchRun(info);
  try {
  const controller = new AbortController();
  const interrupt = (): void => controller.abort(new Error("评审被中断"));
  const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"];
  for (const signal of signals) process.on(signal, interrupt);
  let temp: string | undefined, worktree: string | undefined;
  let base: string | null = null, head: string | null = null, model = DEFAULT_MODEL, failure = "";
  let files: string[] = [], outcome: ReviewOutcome | undefined;
  const state = newReviewState();
  const session = { host: "review-only", id, pid: process.pid, processStarted: processStartTime(process.pid), runId: active.runId };
  const detail = { recipe: "review-only", base: review.base, head: review.head };
  writePhase(info, null, "running", { status: "started", session, detail });
  pushEvent(info, null, "started", eventReason(), {}, detail);
  try {
    base = revision(review.repo, review.base); head = revision(review.repo, review.head);
    const requirement = review.requirement ? readFileSync(review.requirement, "utf8") : undefined;
    const criteria = review.criteria ? readFileSync(review.criteria, "utf8") : undefined;
    const note = review.note ? readFileSync(review.note, "utf8") : "";
    state.baseline = base; state.requirement = requirement;
    if (criteria) {
      const items = extractCriteria(criteria.includes("## 验收标准") ? criteria : `## 验收标准\n${criteria}`);
      if (!items?.length) throw new Error("criteria 文件里没有验收标准条目");
      state.criteria = { version: 1, source: "用户", items, updatedAt: new Date().toISOString() };
    }
    const ownedTemp = realpathSync(mkdtempSync(join(tmpdir(), "loop-review-")));
    const checkout = join(ownedTemp, "worktree");
    temp = ownedTemp; worktree = checkout;
    checkedGit(review.repo, ["-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", checkout, head]);
    files = checkedGit(checkout, ["diff", "--name-only", "-z", base, head, "--"]).split("\0").filter(Boolean);
    const root = findProjectRoot(checkout);
    const { raw, effectiveConfig: resolvedEffectiveConfig, methods, context, ...config } = resolveProjectConfig(root, options.configOverrides);
    effectiveConfig = resolvedEffectiveConfig;
    model = config.reviewerModel;
    outcome = await runReviewRound({
      sink: "report", cwd: checkout, devSessionId: id, round: 1, state, deliveryNote: note,
      config: { ...config, maxRepairs: 0 },
      exec: createChildExec(procs), procsFile: procs, env: {}, signal: controller.signal,
      checkLive: () => controller.signal.throwIfAborted(), callReviewer: options.callReviewer, now: options.now,
      writeInput: (name, text) => { const path = join(dir, name); writeFileSync(path, text); return path; }, saveState: () => {},
      snapshotDir: join(dir, "review-snapshots"),
    });
    if (outcome.kind !== "report") failure = [outcome.reason ?? "评审失败", outcome.notes].filter(Boolean).join("：");
  } catch (error) { failure = errorText(error); }
  finally {
    try {
      reapProcs(procs, { ownerPid: process.pid });
      if (readProcs(procs).length) throw new Error(`评审资源释放未确认：${procs}`);
    } catch (error) { failure = [failure, errorText(error)].filter(Boolean).join("；"); }
    try {
      if (worktree) {
        // 只移除本次 mkdtemp 下自己创建的分离检出，绝不 prune 其他工作区。
        const registered = gitText(review.repo, ["worktree", "list", "--porcelain"]).split("\n").includes(`worktree ${worktree}`);
        if (registered) checkedGit(review.repo, ["worktree", "remove", "--force", worktree]);
        else if (existsSync(worktree)) rmSync(worktree, { recursive: true }); // add 失败留下的本次私有目录。
        if (existsSync(worktree)) throw new Error(`临时 worktree 释放未确认：${worktree}`);
      }
      if (temp) rmSync(temp, { recursive: true });
    } catch (error) { failure = [failure, errorText(error)].filter(Boolean).join("；"); }
    for (const signal of signals) process.off(signal, interrupt);
  }
  const parsed = outcome?.review;
  const exitCode = failure || !parsed ? 2 : parsed.mustFix.length ? 1 : 0;
  const result = { v: 1, ok: exitCode !== 2, action: "评审", command: "评审", recipe: "review-only", id,
    repo: resolve(review.repo), baseline: base, candidate: head, files, mustFix: parsed?.mustFix ?? [], mustFixRaw: parsed?.mustFixRaw ?? "",
    suggestions: parsed?.minor ?? [], questions: parsed?.questions ?? [], conclusion: failure ? "评审失败" : parsed?.conclusion,
    model, durationMs: Date.now() - started, exitCode, report, reportJson: json,
    effectiveConfig, reason: eventReason(failure), record: outcome?.record ?? state.rounds.at(-1) ?? null };
  writeFileSync(json, `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(report, ["# 只评审报告", `基线：${base ?? review.base}`, `候选：${head ?? review.head}`, `模型：${model}`, `耗时：${result.durationMs} ms`,
    `结论：${result.conclusion ?? "评审失败"}`, failure ? `评审失败：${failure}` : "", "\n## 改动文件", ...files.map((file) => `- ${file}`),
    "\n## 必修（含触发条件和后果）", parsed?.mustFixRaw || "无", "\n## 建议", ...result.suggestions.map((item) => `- ${item}`),
    "\n## 需求疑问", ...result.questions.map((item) => `- ${item}`), ""].join("\n"));
  const evidence = { report, reportJson: json }, finalDetail = { recipe: "review-only", report, reportJson: json, exitCode };
  writePhase(info, null, exitCode === 2 ? "failed" : "done", { status: exitCode === 2 ? "failed" : "done", ...result.reason, session, evidence, detail: finalDetail });
  pushEvent(info, null, exitCode === 2 ? "failed" : "done", result.reason, evidence, finalDetail);
  return { ...result, lines: [`${result.conclusion}；必修 ${result.mustFix.length} 条，建议 ${result.suggestions.length} 条`, `报告：${report}`, `JSON：${json}`] };
  } finally { active.release(); }
}

function checkedGit(repo: string, args: string[]): string {
  const result = gitResult(repo, args);
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} 失败：${result.stderr || result.stdout}`);
  return result.stdout;
}
function revision(repo: string, ref: string): string {
  return checkedGit(repo, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]).trim();
}

// loop 启动在独立组运行此入口；不能在共享调用者进程中直接承担可停止的评审。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void (async () => {
    try {
      const file = resolve(process.argv[2]);
      const { parsePlan } = await import("./pipeline.ts");
      const plan = parsePlan(JSON.parse(readFileSync(file, "utf8")), dirname(file), process.env, { batchFile: file });
      if (plan.recipe !== "review-only") throw new Error("只评审入口只接受 review-only 配方");
      const result = await runReviewOnly(plan.review!, { file, name: plan.name, dir: plan.dir });
      console.log(JSON.stringify(result)); process.exitCode = result.exitCode as number;
    } catch (error) { console.log(JSON.stringify({ ok: false, recipe: "review-only", exitCode: 2, error: errorText(error) })); process.exitCode = 2; }
  })();
}

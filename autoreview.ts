/**
 * autoreview.ts — pi 自动评审扩展（入口）。
 *
 * 开发方最后一行写【交付完成】时自动评审；有必修就发回同一开发会话返修，
 * 最多返修 N 次；没有必修或到达上限就停下并通知、写总结。
 * 评审子进程复用固定会话；评审只读，不能改工作区（前后指纹校验）。
 *
 * 加载：pi -e /Users/Admin/Desktop/loop/autoreview.ts
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  buildRepairMessage,
  buildReviewInput,
  classifyMarker,
  decideNext,
  deriveReviewerSessionId,
  parseReview,
  renderSummary,
  type ParsedReview,
  type RoundRecord,
} from "./core.ts";

const PI_BIN = "/Users/Admin/.local/bin/pi";
const PERMISSION_EXT = "/Users/Admin/.pi/agent/npm/node_modules/@gotgenes/pi-permission-system/src/index.ts";
const DEFAULT_MODEL = "openai-codex/gpt-6-astra";
const DEFAULT_THINKING = "xhigh";
const DEFAULT_MAX_REPAIRS = 3;
const DEFAULT_TIMEOUT_MIN = 60;
const EXT_DIR = dirname(fileURLToPath(import.meta.url));
const CONVENTION = [
  "【自动评审约定】",
  "- 完成本次全部工作（含自测）后，在最后一条回复的最后一行单独写：【交付完成】",
  "- 需要用户决定、无法继续时，最后一行写：【需要你决定】，并写清楚要决定什么。",
  "- 收到「自动评审」消息后，逐条处理其中的必修：修好的写「第 N 条：已修」；不同意的写「第 N 条：异议：理由」。全部处理完，同样以【交付完成】结尾。",
].join("\n");

interface AutoreviewState {
  enabled: boolean;
  requirement?: string;
  baseline?: string;
  baselineUntracked?: string[];
  lastSnapshot?: string;
  lastUntracked?: string[];
  reviewerSessionId?: string;
  rounds: RoundRecord[];
  repairs: number;
  phase: "idle" | "reviewing" | "done" | "paused";
  pauseReason?: string;
  unresolvedMustFix?: string;
  awaitingRepair?: boolean;
}

interface Snapshot {
  ref: string;
  tree: string;
  untracked: { path: string; hash: string }[];
  fingerprint: string;
}

interface ExecLike {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

function newState(): AutoreviewState {
  return { enabled: true, rounds: [], repairs: 0, phase: "idle" };
}

function flagString(pi: ExtensionAPI, name: string, fallback: string): string {
  const value = pi.getFlag(name);
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function positiveInt(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

async function git(pi: ExtensionAPI, cwd: string, args: string[], timeout = 30_000): Promise<ExecLike> {
  return pi.exec("git", args, { cwd, timeout });
}

function tail(text: string, max: number): string {
  const trimmed = (text ?? "").trim();
  return trimmed.length <= max ? trimmed : `…${trimmed.slice(-max)}`;
}

function nowStamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

/** 取最后一条助手消息的文本。 */
function lastAssistantText(entries: SessionEntry[]): string {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.type !== "message") continue;
    const message = entry.message as { role?: string; content?: unknown };
    if (message.role !== "assistant") continue;
    const content = message.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .filter((block): block is { type: "text"; text: string } =>
          Boolean(block) && typeof block === "object" && (block as { type?: string }).type === "text",
        )
        .map((block) => block.text)
        .join("\n");
    }
    return "";
  }
  return "";
}

/** 工作区快照：stash create 提交（干净时用 HEAD）+ 未跟踪文件哈希。 */
async function snapshot(pi: ExtensionAPI, cwd: string): Promise<Snapshot> {
  const stash = await git(pi, cwd, ["stash", "create"]);
  const ref = stash.code === 0 && stash.stdout.trim() ? stash.stdout.trim() : "HEAD";
  const treeRes = await git(pi, cwd, ["rev-parse", `${ref}^{tree}`]);
  const tree = treeRes.code === 0 ? treeRes.stdout.trim() : "";
  const filesRes = await git(pi, cwd, ["ls-files", "--others", "--exclude-standard"]);
  const paths = (filesRes.stdout ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).sort();
  const untracked: { path: string; hash: string }[] = [];
  for (const path of paths) {
    const hashRes = await git(pi, cwd, ["hash-object", path]);
    if (hashRes.code === 0) untracked.push({ path, hash: hashRes.stdout.trim() });
  }
  const fingerprint = createHash("sha256")
    .update([tree, ...untracked.map((item) => `${item.path}:${item.hash}`)].join("\n"))
    .digest("hex");
  return { ref, tree, untracked, fingerprint };
}

/** 比较两次快照，列出变化的文件（含评审期间新建/改动的未跟踪文件）。 */
async function changedFilesBetween(
  pi: ExtensionAPI,
  cwd: string,
  before: Snapshot,
  after: Snapshot,
): Promise<string[]> {
  const files = new Set<string>();
  const beforeMap = new Map(before.untracked.map((item) => [item.path, item.hash]));
  const afterMap = new Map(after.untracked.map((item) => [item.path, item.hash]));
  for (const [path, hash] of afterMap) if (beforeMap.get(path) !== hash) files.add(path);
  for (const [path] of beforeMap) if (!afterMap.has(path)) files.add(path);
  if (before.tree !== after.tree) {
    const diff = await git(pi, cwd, ["diff", "--name-only", before.ref, after.ref]);
    if (diff.code === 0) {
      for (const line of diff.stdout.split(/\r?\n/)) if (line.trim()) files.add(line.trim());
    } else {
      files.add("（受跟踪文件有变化，无法逐项列出）");
    }
  }
  return [...files].sort();
}

/** 评审前的基线之外新出现的未跟踪文件。 */
async function newUntrackedFiles(pi: ExtensionAPI, cwd: string, base: string[]): Promise<string[]> {
  const res = await git(pi, cwd, ["ls-files", "--others", "--exclude-standard"]);
  const baseSet = new Set(base);
  return (res.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((path) => path && !baseSet.has(path));
}

/** macOS 通知 + TUI 通知；尽量不影响主流程。 */
async function notifyUser(pi: ExtensionAPI, ctx: ExtensionContext, body: string, type: "info" | "warning"): Promise<void> {
  try {
    ctx.ui.notify(`自动评审：${body}`, type);
  } catch {
    /* 无 UI 时忽略 */
  }
  try {
    const escaped = body.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    await pi.exec("osascript", ["-e", `display notification "${escaped}" with title "自动评审"`], { timeout: 15_000 });
  } catch {
    /* 通知失败不影响流程 */
  }
}

export default function autoreviewExtension(pi: ExtensionAPI): void {
  let state = newState();
  let gitAvailable = false;
  let reviewRunning = false;

  const summaryPath = (ctx: ExtensionContext): string =>
    join(homedir(), ".pi-autoreview", basename(ctx.cwd), `${ctx.sessionManager.getSessionId()}.md`);

  const saveState = (): void => {
    pi.appendEntry("autoreview-state", state);
  };

  const updateStatus = (ctx: ExtensionContext): void => {
    if (!gitAvailable) {
      ctx.ui.setStatus("autoreview", undefined);
      return;
    }
    let text: string | undefined;
    if (state.phase === "reviewing") text = `自动评审中（第 ${state.rounds.length + 1} 轮）`;
    else if (state.phase === "paused") text = "自动评审：暂停";
    else if (state.phase === "done") text = "自动评审：完成";
    else if (!state.enabled) text = "自动评审：已关闭";
    ctx.ui.setStatus("autoreview", text);
  };

  const writeSummary = async (
    ctx: ExtensionContext,
    status: "进行中" | "完成" | "暂停",
    pauseReason?: string,
    unresolvedMustFix?: string,
    changedFiles?: string[],
    notes?: string,
  ): Promise<void> => {
    const statusRes = await git(pi, ctx.cwd, ["status", "--short"]);
    const text = renderSummary({
      cwd: ctx.cwd,
      devSessionId: ctx.sessionManager.getSessionId(),
      reviewerSessionId: state.reviewerSessionId ?? deriveReviewerSessionId(ctx.sessionManager.getSessionId()),
      status,
      pauseReason,
      rounds: state.rounds,
      repairs: state.repairs,
      unresolvedMustFix,
      changedFiles,
      gitStatusShort: statusRes.stdout ?? "",
      notes,
    });
    const file = summaryPath(ctx);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  };

  /** 调用评审：测试命令或真实 pi 子进程（同一个评审会话）。 */
  const callReviewer = async (
    reviewerSessionId: string,
    round: number,
    inputPath: string,
    cwd: string,
  ): Promise<ExecLike> => {
    const timeoutMin = positiveInt(flagString(pi, "autoreview-review-timeout-min", String(DEFAULT_TIMEOUT_MIN)), DEFAULT_TIMEOUT_MIN);
    const timeout = Math.max(60_000, Math.round(timeoutMin * 60_000));
    const fake = flagString(pi, "autoreview-reviewer-cmd", "");
    if (fake) {
      const cmd = fake.includes("/") && !isAbsolute(fake) ? resolve(EXT_DIR, fake) : fake;
      return pi.exec(cmd, [String(round), inputPath, reviewerSessionId], { cwd, timeout });
    }
    const model = flagString(pi, "autoreview-reviewer-model", DEFAULT_MODEL);
    const thinking = flagString(pi, "autoreview-reviewer-thinking", DEFAULT_THINKING);
    const args = [
      "--offline", "-p", "--session-id", reviewerSessionId, "--model", model, "--thinking", thinking,
      "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
      "--tools", "read,grep,find,ls,bash", "-e", PERMISSION_EXT,
      "--append-system-prompt", join(EXT_DIR, "review-prompt.md"), `@${inputPath}`,
    ];
    return pi.exec(PI_BIN, args, { cwd, timeout });
  };

  const pause = async (
    ctx: ExtensionContext,
    reason: string,
    unresolvedMustFix?: string,
    changedFiles?: string[],
    notes?: string,
  ): Promise<void> => {
    state.phase = "paused";
    state.pauseReason = reason;
    state.unresolvedMustFix = unresolvedMustFix;
    state.awaitingRepair = false;
    saveState();
    updateStatus(ctx);
    await writeSummary(ctx, "暂停", reason, unresolvedMustFix, changedFiles, notes);
    await notifyUser(pi, ctx, `${basename(ctx.cwd)}：暂停（${reason}）`, "warning");
  };

  /** 跑一轮完整评审；文件发送和通知都在里面串行完成。 */
  const runReview = async (ctx: ExtensionContext, round: number): Promise<void> => {
    const cwd = ctx.cwd;
    const devSessionId = ctx.sessionManager.getSessionId();
    const startedAt = nowStamp();
    const startedTs = Date.now();

    const before = await snapshot(pi, cwd);
    const baseRef = round === 1 ? state.baseline : state.lastSnapshot;
    const baseUntracked = (round === 1 ? state.baselineUntracked : state.lastUntracked) ?? [];
    const diff = baseRef ? await git(pi, cwd, ["diff", baseRef]) : { stdout: "", stderr: "", code: 1, killed: false };
    const stat = baseRef ? await git(pi, cwd, ["diff", "--stat", baseRef]) : { stdout: "", stderr: "", code: 1, killed: false };
    const untracked = await newUntrackedFiles(pi, cwd, baseUntracked);
    const deliveryNote = lastAssistantText(ctx.sessionManager.getEntries());
    const previousMustFix = state.rounds.length > 0 ? state.rounds[state.rounds.length - 1].mustFixRaw : undefined;
    const inputText = buildReviewInput({
      round,
      requirement: state.requirement,
      deliveryNote,
      previousMustFix,
      diff: diff.stdout ?? "",
      diffStat: stat.stdout ?? "",
      untracked,
    });
    const dir = join(homedir(), ".pi-autoreview", basename(cwd));
    mkdirSync(dir, { recursive: true });
    const inputPath = join(dir, `review-input-${devSessionId}-r${round}.md`);
    writeFileSync(inputPath, inputText);

    const reviewerSessionId = state.reviewerSessionId ?? deriveReviewerSessionId(devSessionId);
    state.reviewerSessionId = reviewerSessionId;
    saveState();

    let parsed: ParsedReview | undefined;
    let lastError = "";
    for (let attempt = 1; attempt <= 2 && !parsed; attempt += 1) {
      const result = await callReviewer(reviewerSessionId, round, inputPath, cwd);
      if (result.killed) {
        lastError = `第 ${attempt} 次评审超时或被终止（退出码 ${result.code}）`;
      } else if (result.code !== 0) {
        lastError = `第 ${attempt} 次评审退出码 ${result.code}：${tail(result.stderr, 300)}`;
      } else if (!result.stdout.trim()) {
        lastError = `第 ${attempt} 次评审输出为空`;
      } else {
        const outcome = parseReview(result.stdout);
        if (outcome.ok) parsed = outcome.review;
        else lastError = `第 ${attempt} 次评审输出无法解析：${outcome.error}`;
      }
      if (!parsed) ctx.ui.setStatus("autoreview", `自动评审中（第 ${round} 轮，重试 ${attempt}）`);
    }

    const after = await snapshot(pi, cwd);
    const changed = await changedFilesBetween(pi, cwd, before, after);
    const record: RoundRecord = {
      round,
      startedAt,
      durationMs: Date.now() - startedTs,
      conclusion: parsed?.conclusion ?? "",
      mustFixRaw: parsed?.mustFixRaw ?? "",
      mustFix: parsed?.mustFix ?? [],
      minor: parsed?.minor ?? [],
      questions: parsed?.questions ?? [],
      recheck: parsed?.recheck ?? [],
      note: parsed?.note,
      failed: parsed ? undefined : lastError,
    };
    state.rounds.push(record);
    state.lastSnapshot = before.ref;
    state.lastUntracked = before.untracked.map((item) => item.path);

    if (changed.length > 0) {
      await pause(ctx, "评审改动了工作区", parsed && parsed.mustFix.length > 0 ? parsed.mustFixRaw : undefined, changed);
      return;
    }
    if (!parsed) {
      await pause(ctx, "评审失败", undefined, undefined, lastError);
      return;
    }

    const maxRepairs = positiveInt(flagString(pi, "autoreview-max-repairs", String(DEFAULT_MAX_REPAIRS)), DEFAULT_MAX_REPAIRS);
    const action = decideNext(parsed.mustFix.length, state.repairs, maxRepairs);
    if (action === "done") {
      state.phase = "done";
      state.awaitingRepair = false;
      state.unresolvedMustFix = undefined;
      saveState();
      updateStatus(ctx);
      await writeSummary(ctx, "完成");
      await notifyUser(pi, ctx, `${basename(cwd)}：完成（评审 ${state.rounds.length} 次，返修 ${state.repairs} 次）`, "info");
      return;
    }
    if (action === "pause") {
      await pause(ctx, "达到返修上限", parsed.mustFixRaw);
      return;
    }

    state.repairs += 1;
    state.awaitingRepair = true;
    state.phase = "idle";
    saveState();
    updateStatus(ctx);
    await writeSummary(ctx, "进行中");
    const message = buildRepairMessage(state.repairs, parsed.mustFixRaw);
    if (ctx.isIdle()) pi.sendUserMessage(message);
    else pi.sendUserMessage(message, { deliverAs: "followUp" });
  };

  const startReview = async (ctx: ExtensionContext, trigger: "auto" | "command"): Promise<void> => {
    if (!gitAvailable || (trigger === "auto" && !state.enabled)) return;
    if (reviewRunning || state.phase === "reviewing") {
      ctx.ui.notify("自动评审：已有评审在进行", "warning");
      return;
    }
    reviewRunning = true;
    if (trigger === "command" || state.phase === "done") state.repairs = 0;
    state.phase = "reviewing";
    state.pauseReason = undefined;
    state.unresolvedMustFix = undefined;
    state.awaitingRepair = false;
    const round = state.rounds.length + 1;
    saveState();
    updateStatus(ctx);
    try {
      await runReview(ctx, round);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await pause(ctx, "评审失败", undefined, undefined, `扩展内部错误：${message}`);
    } finally {
      reviewRunning = false;
      updateStatus(ctx);
    }
  };

  pi.registerFlag("autoreview-max-repairs", { type: "string", default: String(DEFAULT_MAX_REPAIRS), description: "自动评审返修上限" });
  pi.registerFlag("autoreview-reviewer-model", { type: "string", default: DEFAULT_MODEL, description: "评审模型" });
  pi.registerFlag("autoreview-reviewer-thinking", { type: "string", default: DEFAULT_THINKING, description: "评审思考档位" });
  pi.registerFlag("autoreview-review-timeout-min", { type: "string", default: String(DEFAULT_TIMEOUT_MIN), description: "单次评审保护时长（分钟）" });
  pi.registerFlag("autoreview-reviewer-cmd", { type: "string", default: "", description: "仅测试：外部评审命令" });

  pi.registerCommand("review", {
    description: "立即评审当前改动（返修计数重新算）",
    handler: async (_args, ctx) => {
      if (!gitAvailable) {
        ctx.ui.notify("自动评审：不是 git 仓库，已关闭", "warning");
        return;
      }
      if (reviewRunning || state.phase === "reviewing") {
        ctx.ui.notify("自动评审：已有评审在进行", "warning");
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify("自动评审：开发方正在运行，等停下来再评审", "warning");
        return;
      }
      void startReview(ctx, "command");
    },
  });

  pi.registerCommand("review-off", {
    description: "关闭自动评审",
    handler: async (_args, ctx) => {
      state.enabled = false;
      saveState();
      updateStatus(ctx);
      ctx.ui.notify("自动评审已关闭", "info");
    },
  });

  pi.registerCommand("review-on", {
    description: "打开自动评审",
    handler: async (_args, ctx) => {
      state.enabled = true;
      saveState();
      updateStatus(ctx);
      ctx.ui.notify("自动评审已打开", "info");
    },
  });

  pi.registerCommand("review-status", {
    description: "显示自动评审状态",
    handler: async (_args, ctx) => {
      if (!gitAvailable) {
        ctx.ui.notify("自动评审：不是 git 仓库，已关闭", "warning");
        return;
      }
      const devSessionId = ctx.sessionManager.getSessionId();
      const phase =
        state.phase === "reviewing"
          ? `评审中（第 ${state.rounds.length + 1} 轮）`
          : state.phase === "paused"
            ? `暂停（${state.pauseReason ?? "未知原因"}）`
            : state.phase === "done"
              ? "完成"
              : "空闲";
      ctx.ui.notify(
        [
          `自动评审：${state.enabled ? "开启" : "关闭"}`,
          `状态：${phase}`,
          `评审 ${state.rounds.length} 次，返修 ${state.repairs} 次`,
          `评审会话：${state.reviewerSessionId ?? deriveReviewerSessionId(devSessionId)}`,
          `总结：${summaryPath(ctx)}`,
        ].join("\n"),
        "info",
      );
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const probe = await git(pi, ctx.cwd, ["rev-parse", "--git-dir"], 10_000);
    gitAvailable = probe.code === 0;
    state = newState();
    reviewRunning = false;
    const entries = ctx.sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i];
      if (entry.type === "custom" && entry.customType === "autoreview-state" && entry.data) {
        state = { ...newState(), ...(entry.data as AutoreviewState) };
        break;
      }
    }
    if (state.phase === "reviewing") state.phase = "idle"; // 上次进程退出后没有评审在跑
    if (!gitAvailable) {
      ctx.ui.notify("不是 git 仓库，自动评审已关闭", "warning");
      return;
    }
    updateStatus(ctx);
    if (state.phase === "paused") {
      ctx.ui.notify(`自动评审：上次暂停（${state.pauseReason ?? "未知原因"}），输入 /review 继续`, "info");
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!gitAvailable) return;
    if (state.baseline === undefined) {
      const snap = await snapshot(pi, ctx.cwd);
      state.baseline = snap.ref;
      state.baselineUntracked = snap.untracked.map((item) => item.path);
      saveState();
    }
    if (state.requirement === undefined && event.prompt.trim()) {
      state.requirement = event.prompt;
      saveState();
    }
    if (state.enabled) {
      const existing = event.systemPromptOptions.appendSystemPrompt ?? "";
      event.systemPromptOptions.appendSystemPrompt = existing ? `${existing}\n\n${CONVENTION}` : CONVENTION;
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!gitAvailable) return;
    if (reviewRunning || state.phase === "reviewing") return;
    if (state.phase === "paused") return;
    const marker = classifyMarker(lastAssistantText(ctx.sessionManager.getEntries()));
    if (marker === "decision") {
      await pause(ctx, "开发方需要你决定");
      return;
    }
    if (marker === "delivered") {
      if (!state.enabled) return;
      state.awaitingRepair = false;
      void startReview(ctx, "auto");
      return;
    }
    if (state.awaitingRepair) {
      await pause(ctx, "开发方停下了，但没写交付标记");
    }
  });
}

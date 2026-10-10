#!/usr/bin/env node
/**
 * e2e.mjs — 自动评审实操验收（RPC 驱动；开发方与真实评审都用 ds4.1-flash）。
 *
 * 每个场景：建玩具仓库 → 启动挂 autoreview 的开发方 pi → 只发一条需求，全程不提醒、不干预
 * → 等场景结束（见 waitForEnd）→ 按验收标准判定 🟢 通过 / 🔴 不通过 / ⚪ 无法判定 → 写报告。
 * 通过的场景清理现场；不通过、无法判定的场景保留现场，看完手动删。
 *
 * 用法：node test/e2e.mjs [A1 A2 ...]    不传则跑全部
 * 退出码：0 全部通过；1 有不通过；2 没有不通过但有无法判定（验收未完成）
 * 输出最后两行是结论和报告路径；作为 --autoreview-accept-cmd 运行时会进自动评审总结。
 */
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyMarker, parseReview } from "../core.ts";

const REPO_ROOT = dirname(fileURLToPath(import.meta.url)).replace(/\/test$/, "");
/** AUTOREVIEW_E2E_PI、AUTOREVIEW_E2E_STUCK_MS 仅供 e2e.test.ts 用假 pi 验证驱动。 */
const PI = process.env.AUTOREVIEW_E2E_PI || "/Users/Admin/.local/bin/pi";
const PERMISSION_EXT = "/Users/Admin/.pi/agent/npm/node_modules/@gotgenes/pi-permission-system/src/index.ts";
const AUTOREVIEW = join(REPO_ROOT, "autoreview.ts");
const FAKE_REVIEWER = "test/fake-reviewer.mjs";
/** 开发方与真实评审统一用 ds4.1-flash。 */
const MODEL = "opencode-go/deepseek-v4.1-flash";
const THINKING = "low";
const PROMPT = "修复 calc.py 中 add 的错误，新建 test_calc.py 并用 python3 运行通过。";
const SCENARIO_TIMEOUT_MS = 30 * 60 * 1000;
/** 开发方停下这么久，既没开始评审也没继续干活，就判场景卡住。 */
const STUCK_AFTER_MS = Number(process.env.AUTOREVIEW_E2E_STUCK_MS) || 60 * 1000;
const POLL_MS = 2000;
const TMP_ROOT = existsSync("/private/tmp") ? "/private/tmp" : tmpdir();

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
const tail = (text, max = 300) => {
  const trimmed = (text ?? "").trim();
  return trimmed.length <= max ? trimmed : `…${trimmed.slice(-max)}`;
};
const run = (cmd, args, cwd) => {
  const res = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(" ")} 失败：${res.stderr || res.stdout}`);
  return res.stdout;
};
const stamp = () => new Date().toLocaleString("zh-CN", { hour12: false });

// ───────────────────────── 纯函数：解析、终态、判定、报告（e2e.test.ts 覆盖） ─────────────────────────

export const statusOf = (summary) => (/^- 状态：(.+)$/m.exec(summary ?? "")?.[1] ?? "").trim();
export const acceptRunOf = (summary) => (/^- 验收命令：(.+)$/m.exec(summary ?? "")?.[1] ?? "").trim();
export const countsOf = (summary) => {
  const match = /^- 评审 (\d+) 次，返修 (\d+) 次$/m.exec(summary ?? "");
  return { reviews: Number(match?.[1] ?? 0), repairs: Number(match?.[2] ?? 0) };
};

export function hasParsedLatestRound(state) {
  const round = state?.rounds?.at(-1);
  return Boolean(round && !round.failed && ["通过", "需返修"].includes(round.conclusion));
}

/** 总结到达终态：暂停，或完成且（需要时）验收命令已出结果。 */
export function summaryFinished(summary, waitAcceptRun = false) {
  const status = statusOf(summary);
  if (status.startsWith("暂停")) return true;
  if (!status.startsWith("完成")) return false;
  if (!waitAcceptRun) return true;
  const acceptRun = acceptRunOf(summary);
  return acceptRun !== "" && acceptRun !== "进行中";
}

/** 第 1 轮评审输入里的「开发方交付说明」，也就是触发评审时开发方的最后一条回复。 */
export function deliveryNoteOf(reviewInput) {
  return /## 开发方交付说明\n([\s\S]*?)(?:\n## |$)/.exec(reviewInput ?? "")?.[1]?.trim() ?? "";
}

export function endText(end) {
  switch (end.kind) {
    case "summary": return "总结到达终态";
    case "stuck": {
      const idle = `开发方停下 ${Math.round(STUCK_AFTER_MS / 1000)} 秒`;
      return end.dirty ? `${idle}，有未评审的改动却没有开始评审` : `${idle}，没有任何改动`;
    }
    case "timeout": return `超过 ${Math.round(SCENARIO_TIMEOUT_MS / 60_000)} 分钟没有结束`;
    case "exited": return `pi 提前退出（退出码 ${end.code}）`;
    case "interrupted": return "验收被中断";
    case "error": return `驱动或环境异常：${end.message}`;
    default: return end.kind;
  }
}

/**
 * 场景判定：
 * - 前提不满足（模型行为让场景测不到目标）→ ⚪
 * - 没有正常结束：没干活、模型接口报错、驱动/环境异常、被中断 → ⚪；其余（卡住且有改动、超时、pi 退出）→ 🔴
 * - 正常结束：有任一标准不满足 → 🔴，否则 🟢
 */
export function judge({ end, checks = [], precondition, modelErrors = [] }) {
  if (end.kind === "summary") {
    if (precondition) return { verdict: "unknown", reason: precondition };
    const failed = checks.filter((item) => !item.ok);
    return failed.length > 0
      ? { verdict: "fail", reason: `${failed.length} 项标准不满足` }
      : { verdict: "pass", reason: "全部标准满足" };
  }
  if ((end.kind === "stuck" && !end.dirty) || end.kind === "error" || end.kind === "interrupted") {
    return { verdict: "unknown", reason: endText(end) };
  }
  if (modelErrors.length > 0) return { verdict: "unknown", reason: `${endText(end)}；期间模型接口报错：${tail(modelErrors.at(-1), 200)}` };
  return { verdict: "fail", reason: endText(end) };
}

const ICON = { pass: "🟢", fail: "🔴", unknown: "⚪" };
const WORD = { pass: "通过", fail: "不通过", unknown: "无法判定" };

export function overallOf(results) {
  const count = (verdict) => results.filter((item) => item.verdict === verdict).length;
  const pass = count("pass"), fail = count("fail"), unknown = count("unknown");
  const tally = `${pass} 通过 / ${fail} 不通过 / ${unknown} 无法判定`;
  if (fail > 0) return { text: `🔴 不通过（${tally}）`, exitCode: 1 };
  if (unknown > 0 || results.length === 0) return { text: `⚪ 验收未完成（${tally}）`, exitCode: 2 };
  return { text: `🟢 验收通过（${tally}）`, exitCode: 0 };
}

export function renderReport({ startedAt, durationSeconds, runDir, results, interrupted = false }) {
  const overall = overallOf(results);
  const lines = [
    "# 自动评审 E2E 验收报告",
    "",
    `- 结论：${overall.text}${interrupted ? "；验收被中断，后面的场景没有跑" : ""}`,
    `- 开始：${startedAt}，耗时 ${durationSeconds} 秒`,
    `- 开发方与真实评审模型：${MODEL}（thinking ${THINKING}）`,
    "- 驱动只发一条需求，全程不提醒、不干预",
    `- 运行目录：${runDir}（不通过、无法判定场景的现场在这里，看完手动删）`,
    "",
    "## 总览",
    "",
    "| 场景 | 结果 | 结束方式 | 总结状态 | 评审/返修 | 耗时 |",
    "|---|---|---|---|---|---|",
    ...results.map((item) => `| ${item.id} ${item.name} | ${ICON[item.verdict]} ${WORD[item.verdict]} | ${endText(item.end)} | ${item.status || "—"} | ${item.counts.reviews}/${item.counts.repairs} | ${item.durationSeconds} 秒 |`),
  ];
  for (const item of results) {
    lines.push("", `## ${item.id} ${item.name} — ${ICON[item.verdict]} ${WORD[item.verdict]}`, "");
    lines.push(`- 判定：${item.reason}`);
    if (item.reason !== endText(item.end)) lines.push(`- 结束方式：${endText(item.end)}${item.status ? `；总结状态「${item.status}」` : ""}`);
    for (const check of item.checks) lines.push(`- ${check.ok ? "🟢" : "🔴"} ${check.name}${check.ok ? "" : ` —— ${check.detail}`}`);
    for (const note of item.notes) lines.push(`- ℹ️ ${note}`);
    if (item.scene) lines.push(`- 现场：${item.scene}`);
  }
  return `${lines.join("\n")}\n`;
}

// ───────────────────────── 会话文件读取 ─────────────────────────

function findSessionFiles(id, root) {
  if (!existsSync(root)) return [];
  const res = spawnSync("find", [root, "-name", `*_${id}.jsonl`, "-type", "f"], { encoding: "utf8" });
  return (res.stdout || "").split("\n").map((line) => line.trim()).filter(Boolean);
}

function sessionEntries(file) {
  if (!file || !existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((block) => block && block.type === "text").map((block) => block.text).join("\n");
  return "";
}

/** 会话里的消息，按顺序：{ role, text }。 */
function sessionMessages(file) {
  return sessionEntries(file)
    .filter((entry) => entry.type === "message" && entry.message)
    .map((entry) => ({ role: entry.message.role, text: textOf(entry.message.content) }));
}

const isRepairMessage = (message) => message.role === "user" && /^【自动评审 · 第 \d+ 次返修】/.test(message.text);
const gitDirty = (repo) => spawnSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).stdout.trim() !== "";
const readInput = (ctx, round) => {
  const path = join(ctx.dataDir, `review-input-${ctx.devSessionId}-r${round}.md`);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
};

class Checks {
  constructor() { this.results = []; }
  expect(name, ok, detail = "") { this.results.push({ name, ok: Boolean(ok), detail }); }
}

// ───────────────────────── 验收标准 ─────────────────────────

/** 每个场景都要满足的通用标准 G1–G5。 */
function commonChecks(ctx, def, check) {
  const status = statusOf(ctx.summary);
  check.expect(`G1 结束状态为「${def.expect}」`, status === def.expect, `实际「${status}」`);
  check.expect("G2 零人工干预：驱动只发了 1 条需求", ctx.promptsSent === 1, `实际 ${ctx.promptsSent} 条`);
  const file = ctx.devSessionFiles[0];
  const repairs = sessionMessages(file).filter(isRepairMessage).length;
  check.expect(
    "G3 只有一个开发会话，返修消息都在里面",
    ctx.devSessionFiles.length === 1 && repairs === (ctx.state?.repairs ?? -1),
    `会话文件 ${ctx.devSessionFiles.length} 个，返修消息 ${repairs} 条，状态里返修 ${ctx.state?.repairs ?? "（无状态）"} 次`,
  );
  const commits = run("git", ["rev-list", "--count", "HEAD"], ctx.repo).trim();
  const staged = spawnSync("git", ["diff", "--cached", "--quiet"], { cwd: ctx.repo }).status === 0;
  check.expect("G4 没有新提交，暂存区没动", commits === "1" && staged, `提交数 ${commits}，暂存区${staged ? "干净" : "有内容"}`);
  const counts = countsOf(ctx.summary);
  check.expect(
    "G5 总结里的评审、返修次数与会话状态一致",
    ctx.state && counts.reviews === ctx.state.rounds.length && counts.repairs === ctx.state.repairs,
    `总结 ${counts.reviews}/${counts.repairs}，状态 ${ctx.state?.rounds?.length ?? "无"}/${ctx.state?.repairs ?? "无"}`,
  );
}

const FAKE = ["--autoreview-reviewer-cmd", FAKE_REVIEWER];

export const SCENARIOS = {
  A1: {
    name: "真实开发 + 真实评审",
    env: {},
    flags: () => ["--autoreview-reviewer-model", MODEL, "--autoreview-reviewer-thinking", THINKING],
    expect: "完成",
    precondition: (ctx) => statusOf(ctx.summary) === "暂停（达到返修上限）"
      ? "真实开发方与真实评审返修到上限仍没收敛（模型行为，不是产品问题）" : undefined,
    checks(ctx, check) {
      check.expect("A1-1 评审输出能结构化解析", hasParsedLatestRound(ctx.state), JSON.stringify(ctx.state?.rounds?.at(-1) ?? null));
      const tests = spawnSync("python3", ["test_calc.py"], { cwd: ctx.repo, encoding: "utf8", timeout: 60_000 });
      check.expect("A1-2 成果可用：python3 test_calc.py 退出码 0（否则是评审放过了不可用的成果）", tests.status === 0,
        `退出码 ${tests.status}：${tail(tests.stderr || tests.stdout)}`);
      const probe = spawnSync("python3", ["-c", "from calc import add; assert add(2, 3) == 5 and add(-1, 1) == 0"],
        { cwd: ctx.repo, encoding: "utf8", timeout: 60_000 });
      check.expect("A1-3 成果正确：独立检查 add(2,3)==5、add(-1,1)==0", probe.status === 0, `退出码 ${probe.status}：${tail(probe.stderr)}`);
      reviewerSessionChecks(ctx, check);
    },
  },
  A2: {
    name: "返修一次后通过",
    env: { FAKE_MODE: "pass-after-1" },
    flags: () => FAKE,
    expect: "完成",
    checks(ctx, check) {
      const counts = countsOf(ctx.summary);
      check.expect("A2-1 评审 2 次、返修 1 次", counts.reviews === 2 && counts.repairs === 1, `评审 ${counts.reviews} 次，返修 ${counts.repairs} 次`);
      const messages = sessionMessages(ctx.devSessionFiles[0]);
      const repairs = messages.filter(isRepairMessage);
      check.expect("A2-2 恰好 1 条返修消息，带必修原文和逐条处理要求",
        repairs.length === 1 && repairs[0].text.includes("add 使用了减法") && repairs[0].text.includes("请逐条处理"),
        `返修消息 ${repairs.length} 条：${tail(repairs[0]?.text ?? "", 200)}`);
      const input = readInput(ctx, 2);
      check.expect("A2-3 第 2 轮评审输入带上一轮必修和开发方回应",
        input.includes("## 上一轮必修") && input.includes("add 使用了减法") && input.includes("## 开发方最新回复"),
        input ? tail(input, 300) : "第 2 轮评审输入文件不存在");
      check.expect("A2-4 评审恰好被调用 2 次", ctx.fakeCalls.length === 2, `实际 ${ctx.fakeCalls.length} 次`);
      const repairIndex = messages.findIndex(isRepairMessage);
      const responded = repairIndex >= 0 && messages.slice(repairIndex + 1).some((item) => item.role === "assistant" && /第\s*1\s*条/.test(item.text));
      ctx.notes.push(`开发方是否逐条回应「第 1 条：…」（模型行为，只记录不判定）：${responded ? "是" : "否"}`);
    },
  },
  A3: {
    name: "达到返修上限",
    env: { FAKE_MODE: "always-fix" },
    flags: () => [...FAKE, "--autoreview-max-repairs", "1"],
    expect: "暂停（达到返修上限）",
    checks(ctx, check) {
      const counts = countsOf(ctx.summary);
      check.expect("A3-1 评审 2 次、返修 1 次", counts.reviews === 2 && counts.repairs === 1, `评审 ${counts.reviews} 次，返修 ${counts.repairs} 次`);
      check.expect("A3-2 总结列出未解决的必修", ctx.summary.includes("## 未解决的必修"), "总结里没有「## 未解决的必修」");
      check.expect("A3-3 开发成果还在工作区", gitDirty(ctx.repo), "工作区是干净的");
    },
  },
  A4: {
    name: "评审失败",
    env: { FAKE_MODE: "fail" },
    flags: () => FAKE,
    expect: "暂停（评审失败）",
    checks(ctx, check) {
      check.expect("A4-1 评审恰好被调用 2 次（重试 1 次）", ctx.fakeCalls.length === 2, `实际 ${ctx.fakeCalls.length} 次`);
      check.expect("A4-2 开发成果还在工作区", gitDirty(ctx.repo), "工作区是干净的");
    },
  },
  A5: {
    name: "评审改了文件",
    env: { FAKE_MODE: "modify" },
    flags: () => FAKE,
    expect: "暂停（评审改动了工作区）",
    checks(ctx, check) {
      check.expect("A5-1 总结列出被改的文件", ctx.summary.includes("reviewer-touched.txt"), "总结里没有 reviewer-touched.txt");
    },
  },
  A6: {
    name: "不写标记也会评审",
    env: { FAKE_MODE: "pass" },
    flags: () => FAKE,
    expect: "完成",
    precondition: (ctx) => classifyMarker(deliveryNoteOf(readInput(ctx, 1))) === "none"
      ? undefined : "开发方写了交付标记，测不到「无标记自动评审」（模型行为，不是产品问题）",
    checks(ctx, check) {
      const counts = countsOf(ctx.summary);
      check.expect("A6-1 没写标记也自动完成了 1 轮评审", counts.reviews === 1 && ctx.fakeCalls.length === 1,
        `评审 ${counts.reviews} 次，评审被调用 ${ctx.fakeCalls.length} 次`);
    },
  },
  A7: {
    name: "评审完成后自动执行验收命令",
    env: { FAKE_MODE: "pass" },
    flags: (paths) => [...FAKE, "--autoreview-accept-cmd", `echo accepted >> '${paths.acceptLog}' && echo FAKE_ACCEPT_OUTPUT`],
    expect: "完成",
    waitAcceptRun: true,
    checks(ctx, check) {
      const acceptRun = acceptRunOf(ctx.summary);
      check.expect("A7-1 总结里验收命令结果为「通过」", acceptRun === "通过", `实际「${acceptRun}」`);
      const runs = existsSync(ctx.acceptLog) ? readFileSync(ctx.acceptLog, "utf8").split("\n").filter(Boolean).length : 0;
      check.expect("A7-2 验收命令恰好执行 1 次", runs === 1, `实际 ${runs} 次`);
      check.expect("A7-3 由评审完成自动触发", /第 \d+ 轮评审完成后自动执行/.test(ctx.summary), "总结里没有自动触发记录");
      const log = /^- 完整输出：(.+)$/m.exec(ctx.summary)?.[1] ?? "";
      check.expect("A7-4 总结带验收命令输出，完整输出写进日志", ctx.summary.includes("FAKE_ACCEPT_OUTPUT") && existsSync(log),
        `日志「${log}」`);
    },
  },
};

/** A1：评审会话唯一且复用；只评审了 1 次时直接补跑两次同一评审会话来确认复用。 */
function reviewerSessionChecks(ctx, check) {
  const counts = countsOf(ctx.summary);
  const reviewerId = `autoreview-rev-${ctx.devSessionId}`;
  const files = findSessionFiles(reviewerId, ctx.sessionRoot);
  check.expect("A1-4 评审会话文件存在且只有一个", files.length === 1, `实际 ${files.length} 个`);
  if (!files[0]) return;
  const users = () => sessionMessages(files[0]).filter((item) => item.role === "user").length;
  check.expect(`A1-5 评审会话里的用户消息不少于评审次数（${counts.reviews}）`, users() >= counts.reviews, `实际 ${users()} 条`);
  if (counts.reviews !== 1) return;
  const inputPath = join(ctx.dataDir, `review-input-${ctx.devSessionId}-r1.md`);
  if (!existsSync(inputPath)) {
    check.expect("A1-6 第 1 轮评审输入文件存在", false, inputPath);
    return;
  }
  const args = [
    "--offline", "-p", "--session-id", reviewerId, "--model", MODEL, "--thinking", THINKING,
    "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--tools", "read,grep,find,ls,bash",
    "-e", PERMISSION_EXT, "--append-system-prompt", join(REPO_ROOT, "review-prompt.md"), `@${inputPath}`,
  ];
  const before = users();
  for (let i = 1; i <= 2; i += 1) {
    const res = spawnSync(PI, args, { cwd: ctx.repo, env: ctx.env, encoding: "utf8", timeout: 300_000 });
    const parsed = parseReview(res.stdout || "");
    check.expect(`A1-6 补跑同一评审会话第 ${i} 次成功且能解析`, res.status === 0 && parsed.ok,
      `退出码 ${res.status}：${tail(res.stderr || res.stdout, 300)}`);
  }
  const after = findSessionFiles(reviewerId, ctx.sessionRoot);
  check.expect("A1-7 补跑两次仍写进同一个评审会话文件",
    after.length === 1 && after[0] === files[0] && users() >= before + 2, `文件 ${after.join(", ")}；用户消息 ${before} → ${users()}`);
}

// ───────────────────────── 驱动 ─────────────────────────

let interrupted = false;
let currentChild;

function killGroup(child, signal) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  try { process.kill(-child.pid, signal); } catch {
    try { child.kill(signal); } catch { /* 已退出 */ }
  }
}

async function closeChild(child) {
  try { child.stdin.end(); } catch { /* 已结束 */ }
  const exited = () => child.exitCode !== null || Boolean(child.signalCode);
  for (let waited = 0; waited < 10_000 && !exited(); waited += 500) await sleep(500);
  if (exited()) return;
  killGroup(child, "SIGTERM");
  await sleep(2000);
  killGroup(child, "SIGKILL");
}

function prepareScene(id, runDir) {
  const scene = join(runDir, id);
  const repo = join(scene, `calc-${id.toLowerCase()}`);
  mkdirSync(repo, { recursive: true });
  run("git", ["init", "-q"], repo);
  run("git", ["config", "user.email", "e2e@example.com"], repo);
  run("git", ["config", "user.name", "e2e"], repo);
  writeFileSync(join(repo, "calc.py"), "def add(a, b):\n    return a - b\n");
  run("git", ["add", "calc.py"], repo);
  run("git", ["commit", "-q", "-m", "init"], repo);
  // 测试进程的 HOME、凭据副本、会话和总结都放在场景目录；不改用户配置。
  const home = join(scene, "home");
  const agentDir = join(home, ".pi", "agent");
  mkdirSync(agentDir, { recursive: true });
  const sourceAgent = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  for (const name of ["auth.json", "models.json", "settings.json"]) {
    const source = join(sourceAgent, name);
    if (existsSync(source)) cpSync(source, join(agentDir, name));
  }
  const permissionConfig = join("extensions", "pi-permission-system", "config.json");
  mkdirSync(dirname(join(agentDir, permissionConfig)), { recursive: true });
  cpSync(join(sourceAgent, permissionConfig), join(agentDir, permissionConfig));
  return {
    scene, repo, home, sessionRoot: join(agentDir, "sessions"), agentDir,
    fakeDir: join(scene, "fake"), acceptLog: join(scene, "accept-calls.log"),
    dataDir: join(home, ".pi-autoreview", basename(repo)),
  };
}

async function runScenario(id, def, runDir) {
  const paths = prepareScene(id, runDir);
  const env = {
    ...process.env, HOME: paths.home, PI_CODING_AGENT_DIR: paths.agentDir,
    PI_CODING_AGENT_SESSION_DIR: paths.sessionRoot, FAKE_STATE_DIR: paths.fakeDir, ...def.env,
  };
  const args = [
    "--offline", "--mode", "rpc", "--model", MODEL, "--thinking", THINKING,
    "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--tools", "read,edit,write,bash",
    "-e", PERMISSION_EXT, "-e", AUTOREVIEW, ...def.flags(paths),
  ];
  // detached：pi 及其评审子进程同属一个进程组，收尾时整组结束。
  const child = spawn(PI, args, { cwd: paths.repo, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
  currentChild = child;
  const ctx = {
    ...paths, id, env, summary: "", state: undefined, devSessionId: "", sessionFile: "", devSessionFiles: [],
    fakeCalls: [], promptsSent: 0, statusText: "", modelErrors: [], stderr: "", notes: [],
  };
  let busy = false;
  let settledAt = 0;
  let stdoutBuf = "";

  const send = (record) => {
    if (record.type === "prompt") ctx.promptsSent += 1;
    try { child.stdin.write(`${JSON.stringify(record)}\n`); } catch { /* 子进程可能已退出 */ }
  };
  const handleRecord = (record) => {
    if (record.type === "response" && record.command === "get_state" && record.data) {
      ctx.devSessionId = record.data.sessionId ?? "";
      ctx.sessionFile = record.data.sessionFile ?? "";
    } else if (record.type === "extension_ui_request" && record.method === "setStatus") {
      ctx.statusText = record.statusText ?? "";
    } else if (record.type === "message_end" && record.message?.role === "assistant" && record.message.stopReason === "error") {
      ctx.modelErrors.push(record.message.errorMessage ?? "未知错误");
    } else if (record.type === "agent_start") {
      busy = true;
    } else if (record.type === "agent_settled") {
      busy = false;
      settledAt = Date.now();
    }
  };
  child.stdout.on("data", (chunk) => {
    stdoutBuf += chunk.toString();
    const lines = stdoutBuf.split("\n");
    stdoutBuf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try { handleRecord(JSON.parse(line)); } catch { /* 忽略非 JSON 输出 */ }
    }
  });
  child.stderr.on("data", (chunk) => { ctx.stderr = `${ctx.stderr}${chunk}`.slice(-4000); });

  send({ type: "get_state", id: "gs" });
  send({ type: "prompt", id: "p1", message: PROMPT });

  const summaryPath = () => join(paths.dataDir, `${ctx.devSessionId}.md`);
  const deadline = Date.now() + SCENARIO_TIMEOUT_MS;
  let end;
  while (!end) {
    if (process.ppid === 1) interrupted = true; // 父进程没了（例如被评审扩展终止），不再继续
    if (ctx.devSessionId && existsSync(summaryPath())) ctx.summary = readFileSync(summaryPath(), "utf8");
    if (interrupted) end = { kind: "interrupted" };
    else if (child.exitCode !== null || child.signalCode) end = { kind: "exited", code: child.exitCode ?? child.signalCode };
    else if (ctx.summary && summaryFinished(ctx.summary, def.waitAcceptRun)) end = { kind: "summary" };
    else if (Date.now() > deadline) end = { kind: "timeout" };
    else if (!busy && settledAt > 0 && Date.now() - settledAt > STUCK_AFTER_MS && !/评审中|自动验收|验收命令执行中/.test(ctx.statusText)) {
      end = { kind: "stuck", dirty: gitDirty(paths.repo) };
    } else await sleep(POLL_MS);
  }
  await closeChild(child);
  currentChild = undefined;

  if (ctx.devSessionId) ctx.devSessionFiles = findSessionFiles(ctx.devSessionId, paths.sessionRoot);
  ctx.state = sessionEntries(ctx.sessionFile)
    .filter((entry) => entry.type === "custom" && entry.customType === "autoreview-state").at(-1)?.data;
  const log = join(paths.fakeDir, "calls.log");
  if (existsSync(log)) ctx.fakeCalls = readFileSync(log, "utf8").split("\n").filter(Boolean);
  return { ctx, end };
}

function evaluate(def, ctx, end) {
  const check = new Checks();
  let precondition;
  if (end.kind === "summary") {
    try {
      commonChecks(ctx, def, check);
      def.checks(ctx, check);
      precondition = def.precondition?.(ctx);
    } catch (error) {
      check.expect("场景检查执行完成", false, error.message);
    }
  }
  if (ctx.stderr && end.kind !== "summary") ctx.notes.push(`pi stderr 尾部：${tail(ctx.stderr, 600)}`);
  return { checks: check.results, ...judge({ end, checks: check.results, precondition, modelErrors: ctx.modelErrors }) };
}

async function main() {
  const wanted = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
  const ids = wanted.length > 0 ? wanted : Object.keys(SCENARIOS);
  const unknown = ids.filter((id) => !SCENARIOS[id]);
  if (unknown.length > 0) {
    console.log(`未知场景：${unknown.join(", ")}；可选 ${Object.keys(SCENARIOS).join(" ")}`);
    process.exitCode = 2;
    return;
  }
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(signal, () => { interrupted = true; killGroup(currentChild, "SIGTERM"); });
  }
  const runDir = mkdtempSync(join(TMP_ROOT, "autoreview-e2e-"));
  const startedAt = stamp();
  const started = Date.now();
  const results = [];
  for (const id of ids) {
    if (interrupted) break;
    const def = SCENARIOS[id];
    console.log(`\n===== ${id} ${def.name} =====`);
    const scenarioStarted = Date.now();
    let ctx;
    let end;
    try {
      ({ ctx, end } = await runScenario(id, def, runDir));
    } catch (error) {
      killGroup(currentChild, "SIGKILL");
      currentChild = undefined;
      ctx = { notes: [], summary: "", modelErrors: [], stderr: "" };
      end = { kind: "error", message: tail(error.message, 300) };
    }
    const verdict = evaluate(def, ctx, end);
    const scene = join(runDir, id);
    const keep = verdict.verdict !== "pass";
    if (!keep) rmSync(scene, { recursive: true, force: true });
    const result = {
      id, name: def.name, end, status: statusOf(ctx.summary), counts: countsOf(ctx.summary),
      durationSeconds: Math.round((Date.now() - scenarioStarted) / 1000), notes: ctx.notes,
      scene: keep && existsSync(scene) ? scene : "", ...verdict,
    };
    results.push(result);
    console.log(`  ${ICON[result.verdict]} ${WORD[result.verdict]}：${result.reason}（${result.durationSeconds} 秒）`);
    for (const item of result.checks.filter((check) => !check.ok)) console.log(`    🔴 ${item.name} —— ${item.detail}`);
  }
  const report = renderReport({ startedAt, durationSeconds: Math.round((Date.now() - started) / 1000), runDir, results, interrupted });
  const reportPath = join(runDir, "report.md");
  writeFileSync(reportPath, report);
  writeFileSync(join(runDir, "results.json"), JSON.stringify(results, null, 2));
  const overall = overallOf(results);
  console.log(`\n验收结论：${overall.text}${interrupted ? "（被中断）" : ""}`);
  console.log(`验收报告：${reportPath}`);
  process.exitCode = interrupted && overall.exitCode === 0 ? 2 : overall.exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

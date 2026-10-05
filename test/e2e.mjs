#!/usr/bin/env node
/**
 * e2e.mjs — 自动评审联调驱动（RPC 模式）。
 * 每个场景建一个玩具仓库，启动开发方 pi（便宜模型），等总结文件出现「完成/暂停」，
 * 然后断言状态、会话文件、假评审调用次数、git 提交等。
 *
 * 用法：node test/e2e.mjs [R1 R2 ...]    不传则跑全部
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(fileURLToPath(import.meta.url)).replace(/\/test$/, "");
const PI = "/Users/Admin/.local/bin/pi";
const PERMISSION_EXT = "/Users/Admin/.pi/agent/npm/node_modules/@gotgenes/pi-permission-system/src/index.ts";
const AUTOREVIEW = join(REPO_ROOT, "autoreview.ts");
const PROMPT = "修复 calc.py 中 add 的错误，新建 test_calc.py 并用 python3 运行通过。";
const CHEAP_MODEL = "opencode-go/deepseek-v4.1-flash";
const SCENARIO_TIMEOUT_MS = 20 * 60 * 1000;
const NUDGE_AFTER_MS = 45 * 1000;
const MAX_NUDGES = 8;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const run = (cmd, args, cwd) => {
  const res = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(" ")} 失败：${res.stderr || res.stdout}`);
  return res.stdout;
};

function extractText(message) {
  if (!message || message.role !== "assistant") return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter((block) => block && block.type === "text").map((block) => block.text).join("\n");
  }
  return "";
}

function marker(text) {
  const lines = (text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const last = lines.length > 0 ? lines[lines.length - 1] : "";
  if (last === "【交付完成】") return "delivered";
  if (last === "【需要你决定】") return "decision";
  return "none";
}

function findSessionFiles(id) {
  const root = join(homedir(), ".pi", "agent", "sessions");
  if (!existsSync(root)) return [];
  const res = spawnSync("find", [root, "-name", `*_${id}.jsonl`, "-type", "f"], { encoding: "utf8" });
  return (res.stdout || "").split("\n").map((line) => line.trim()).filter(Boolean);
}

function sessionUserMessages(file) {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((entry) => entry && entry.type === "message" && entry.message && entry.message.role === "user")
    .map((entry) => {
      const content = entry.message.content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        return content.filter((block) => block && block.type === "text").map((block) => block.text).join("\n");
      }
      return "";
    });
}

const statusOf = (summary) => (/^- 状态：(.+)$/m.exec(summary)?.[1] ?? "").trim();
const countsOf = (summary) => {
  const match = /^- 评审 (\d+) 次，返修 (\d+) 次$/m.exec(summary);
  return { reviews: Number(match?.[1] ?? 0), repairs: Number(match?.[2] ?? 0) };
};

class Checks {
  constructor() {
    this.results = [];
  }
  expect(name, ok, detail = "") {
    this.results.push({ name, ok: Boolean(ok), detail });
  }
  includes(name, haystack, needle) {
    this.expect(name, typeof haystack === "string" && haystack.includes(needle), `未找到 ${JSON.stringify(needle)}`);
  }
}

const SCENARIOS = {
  R1: {
    name: "返修 1 次后通过",
    env: { FAKE_MODE: "pass-after-1" },
    flags: ["--autoreview-reviewer-cmd", "test/fake-reviewer.mjs"],
    async run(ctx, check) {
      check.includes("状态为完成", ctx.summary, "- 状态：完成");
      check.includes("评审 2 次、返修 1 次", ctx.summary, "- 评审 2 次，返修 1 次");
      check.expect("开发会话只有一个会话文件", ctx.devSessionFiles.length === 1, `实际 ${ctx.devSessionFiles.length} 个`);
      if (ctx.devSessionFiles[0]) {
        const users = sessionUserMessages(ctx.devSessionFiles[0]);
        const repairMessages = users.filter((text) => text.startsWith("【自动评审 · 第 1 次返修】"));
        check.expect("恰好 1 条返修用户消息", repairMessages.length === 1, `实际 ${repairMessages.length} 条`);
      }
      const commits = run("git", ["rev-list", "--count", "HEAD"], ctx.repo).trim();
      check.expect("玩具仓库没有新提交", commits === "1", `提交数 ${commits}`);
    },
  },
  R2: {
    name: "达到上限",
    env: { FAKE_MODE: "always-fix" },
    flags: ["--autoreview-reviewer-cmd", "test/fake-reviewer.mjs", "--autoreview-max-repairs", "1"],
    async run(ctx, check) {
      check.includes("状态为暂停（达到返修上限）", ctx.summary, "- 状态：暂停（达到返修上限）");
      check.includes("评审 2 次、返修 1 次", ctx.summary, "- 评审 2 次，返修 1 次");
      check.includes("未解决的必修一节列出必修", ctx.summary, "## 未解决的必修");
      const calc = readFileSync(join(ctx.repo, "calc.py"), "utf8");
      check.expect("开发成果仍在玩具仓库工作区", calc.includes("return a + b"), "calc.py 未包含修复");
    },
  },
  R3: {
    name: "评审失败",
    env: { FAKE_MODE: "fail" },
    flags: ["--autoreview-reviewer-cmd", "test/fake-reviewer.mjs"],
    async run(ctx, check) {
      check.includes("状态为暂停（评审失败）", ctx.summary, "- 状态：暂停（评审失败）");
      check.expect("假评审恰好被调用 2 次", ctx.fakeCalls.length === 2, `实际 ${ctx.fakeCalls.length} 次`);
      const calc = readFileSync(join(ctx.repo, "calc.py"), "utf8");
      check.expect("开发成果仍在玩具仓库工作区", calc.includes("return a + b"), "calc.py 未包含修复");
    },
  },
  R4: {
    name: "评审改了文件",
    env: { FAKE_MODE: "modify" },
    flags: ["--autoreview-reviewer-cmd", "test/fake-reviewer.mjs"],
    async run(ctx, check) {
      check.includes("状态为暂停（评审改动了工作区）", ctx.summary, "- 状态：暂停（评审改动了工作区）");
      check.includes("总结列出被改的文件", ctx.summary, "reviewer-touched.txt");
    },
  },
  R5: {
    name: "真实评审接线（便宜模型）",
    env: {},
    flags: ["--autoreview-reviewer-model", CHEAP_MODEL, "--autoreview-reviewer-thinking", "low"],
    async run(ctx, check) {
      const counts = countsOf(ctx.summary);
      check.expect("总结里有评审轮次", counts.reviews >= 1, `评审 ${counts.reviews} 次`);
      check.includes("评审输出被解析（有结论）", ctx.summary, "结论：");
      const reviewerId = `autoreview-rev-${ctx.devSessionId}`;
      const files = findSessionFiles(reviewerId);
      check.expect("评审会话文件存在且只有一个", files.length === 1, `实际 ${files.length} 个`);
      if (files[0]) {
        const users = sessionUserMessages(files[0]);
        check.expect(
          `评审会话里的用户消息不少于评审次数（${users.length} >= ${counts.reviews}）`,
          users.length >= counts.reviews,
          `实际 ${users.length} 条`,
        );
      }
      if (counts.reviews === 1) {
        const home = join(homedir(), ".pi-autoreview", basename(ctx.repo));
        const inputs = existsSync(home) ? readdirSync(home).filter((name) => name.startsWith(`review-input-${ctx.devSessionId}-r`)) : [];
        const inputPath = inputs.length > 0 ? join(home, inputs[0]) : join(ctx.repo, "review-input-fallback.md");
        if (!existsSync(inputPath)) writeFileSync(inputPath, "## 需求原文\n补测\n\n## 本轮改动\n（无）\n");
        const args = [
          "--offline", "-p", "--session-id", reviewerId, "--model", CHEAP_MODEL, "--thinking", "low",
          "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--tools", "read,grep,find,ls,bash",
          "-e", PERMISSION_EXT, "--append-system-prompt", join(REPO_ROOT, "review-prompt.md"), `@${inputPath}`,
        ];
        const before = files[0] ? sessionUserMessages(files[0]).length : 0;
        for (let i = 0; i < 2; i += 1) {
          const res = spawnSync(PI, args, { cwd: ctx.repo, encoding: "utf8", timeout: 300_000 });
          check.expect(`补跑评审第 ${i + 1} 次成功`, res.status === 0, `退出码 ${res.status}：${(res.stderr || "").slice(-200)}`);
        }
        const after = findSessionFiles(reviewerId);
        check.expect("补跑后仍是同一个评审会话文件", after.length === 1 && after[0] === files[0], `文件：${after.join(", ")}`);
        if (after[0]) {
          const nowUsers = sessionUserMessages(after[0]).length;
          check.expect("补跑两次都写进同一会话文件", nowUsers >= before + 2, `之前 ${before} 条，现在 ${nowUsers} 条`);
        }
      }
    },
  },
  R6: {
    name: "默认评审（Astra）跑一次",
    env: {},
    flags: [],
    async run(ctx, check) {
      check.expect("总结里有评审轮次", countsOf(ctx.summary).reviews >= 1, "没有评审轮次");
      check.includes("评审输出被解析（有结论）", ctx.summary, "结论：");
      ctx.notes.push(`Astra 轮次：${(ctx.summary.match(/^### 第 \d+ 轮（.*耗时 (\d+) 秒）/gm) || []).join("；")}`);
    },
  },
};

async function runScenario(id, def) {
  const repo = mkdtempSync("/private/tmp/autoreview-e2e-");
  const fakeDir = `${repo}.fake`;
  run("git", ["init", "-q"], repo);
  run("git", ["config", "user.email", "e2e@example.com"], repo);
  run("git", ["config", "user.name", "e2e"], repo);
  writeFileSync(join(repo, "calc.py"), "def add(a, b):\n    return a - b\n");
  run("git", ["add", "calc.py"], repo);
  run("git", ["commit", "-q", "-m", "init"], repo);

  const env = { ...process.env, FAKE_STATE_DIR: fakeDir, ...def.env };
  const args = [
    "--offline", "--mode", "rpc", "--model", CHEAP_MODEL, "--thinking", "low",
    "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--tools", "read,edit,write,bash",
    "-e", PERMISSION_EXT, "-e", AUTOREVIEW, ...def.flags,
  ];
  const child = spawn(PI, args, { cwd: repo, env, stdio: ["pipe", "pipe", "pipe"] });
  const result = {
    repo, id, def, summary: "", devSessionId: "", devSessionFiles: [], fakeCalls: [],
    statusText: "", notes: [], stderr: "", records: 0, checks: [], error: "",
  };
  let stdoutBuf = "";
  let stderrBuf = "";
  let lastAssistant = "";
  let settledAt = 0;
  let busy = false;
  let nudges = 0;
  let sessionFile = "";

  const send = (record) => {
    try {
      child.stdin.write(`${JSON.stringify(record)}\n`);
    } catch {
      /* 子进程可能已退出 */
    }
  };

  const handleRecord = (record) => {
    result.records += 1;
    if (record.type === "response" && record.command === "get_state" && record.data) {
      result.devSessionId = record.data.sessionId ?? "";
      sessionFile = record.data.sessionFile ?? "";
    } else if (record.type === "extension_ui_request") {
      if (record.method === "setStatus") result.statusText = record.statusText ?? "";
      else if (record.method === "notify") result.notes.push(record.message ?? "");
    } else if (record.type === "message_end") {
      if (record.message?.role === "assistant") lastAssistant = extractText(record.message);
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
      try {
        handleRecord(JSON.parse(line));
      } catch {
        /* 忽略非 JSON 输出 */
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    stderrBuf += chunk.toString();
    result.stderr = stderrBuf.slice(-4000);
  });

  send({ type: "get_state", id: "gs" });
  send({ type: "prompt", id: "p1", message: PROMPT });

  const deadline = Date.now() + SCENARIO_TIMEOUT_MS;
  let timedOut = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    if (result.devSessionId) {
      result.summaryPath = join(homedir(), ".pi-autoreview", basename(repo), `${result.devSessionId}.md`);
      if (existsSync(result.summaryPath)) {
        result.summary = readFileSync(result.summaryPath, "utf8");
        const status = statusOf(result.summary);
        if (status.startsWith("完成") || status.startsWith("暂停")) break;
      }
    }
    if (
      !busy &&
      settledAt > 0 &&
      Date.now() - settledAt > NUDGE_AFTER_MS &&
      !result.statusText.includes("评审中") &&
      marker(lastAssistant) === "none" &&
      nudges < MAX_NUDGES
    ) {
      nudges += 1;
      result.notes.push(`nudge ${nudges}`);
      send({ type: "prompt", id: `nudge-${nudges}`, message: "请继续完成工作；全部完成后，在最后一行写【交付完成】。" });
    }
    await sleep(2000);
  }
  if (!result.summary || !(statusOf(result.summary).startsWith("完成") || statusOf(result.summary).startsWith("暂停"))) {
    timedOut = Date.now() >= deadline;
    if (timedOut || !result.summary) {
      result.error = timedOut ? "场景超时" : "pi 提前退出或没写出总结";
    }
  }

  try {
    child.stdin.end();
  } catch {
    /* 已结束 */
  }
  const exited = await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    sleep(10_000).then(() => false),
  ]);
  if (!exited) {
    child.kill("SIGTERM");
    await sleep(2000);
    if (child.exitCode === null) child.kill("SIGKILL");
  }

  if (result.devSessionId) result.devSessionFiles = findSessionFiles(result.devSessionId);
  if (existsSync(fakeDir)) {
    const log = join(fakeDir, "calls.log");
    if (existsSync(log)) {
      result.fakeCalls = readFileSync(log, "utf8").split("\n").filter(Boolean);
    }
  }
  result.nudges = nudges;
  result.timedOut = timedOut;
  return result;
}


async function main() {
  const wanted = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
  const ids = wanted.length > 0 ? wanted : Object.keys(SCENARIOS);
  const failures = [];
  for (const id of ids) {
    const def = SCENARIOS[id];
    if (!def) {
      console.log(`跳过未知场景 ${id}`);
      continue;
    }
    console.log(`\n===== ${id} ${def.name} =====`);
    const started = Date.now();
    let ctx;
    try {
      ctx = await runScenario(id, def);
    } catch (error) {
      failures.push(`${id}: 驱动异常 ${error.message}`);
      console.log(`驱动异常：${error.stack}`);
      continue;
    }
    const check = new Checks();
    if (!ctx.error) {
      try {
        await def.run(ctx, check);
      } catch (error) {
        check.expect("场景检查执行完成", false, error.message);
      }
    } else {
      check.expect("场景跑完", false, ctx.error);
    }
    for (const item of check.results) {
      console.log(`  ${item.ok ? "🟢" : "🔴"} ${item.name}${item.ok ? "" : ` —— ${item.detail}`}`);
      if (!item.ok) failures.push(`${id}: ${item.name} —— ${item.detail}`);
    }
    console.log(`  （耗时 ${Math.round((Date.now() - started) / 1000)} 秒，nudge ${ctx.nudges} 次）`);
    if (ctx.error) {
      console.log(`  ctx.error=${ctx.error}\n  状态栏=${ctx.statusText}\n  最近通知=${ctx.notes.slice(-5).join(" | ")}`);
    } else {
      const counts = ctx.summary.match(/^- 评审 \d+ 次，返修 \d+ 次$/m)?.[0] ?? "";
      const rounds = (ctx.summary.match(/^### 第 \d+ 轮（[^）]*）/gm) ?? []).join("；");
      const conclusion = ctx.summary.match(/^结论：.+$/m)?.[0] ?? "";
      const unresolved = ctx.summary.includes("## 未解决的必修") ? "有未解决必修" : "无未解决必修";
      console.log(`  ${counts}；${unresolved}`);
      console.log(`  ${rounds}`);
      console.log(`  ${conclusion}`);
    }
    if (ctx.stderr) console.log(`  stderr 尾部：${ctx.stderr.slice(-800)}`);
    // 清理：玩具仓库、假状态、以及这次运行写入的总结与评审输入
    rmSync(ctx.repo, { recursive: true, force: true });
    rmSync(`${ctx.repo}.fake`, { recursive: true, force: true });
    if (ctx.summaryPath) rmSync(dirname(ctx.summaryPath), { recursive: true, force: true });
  }
  console.log("\n===== 汇总 =====");
  if (failures.length === 0) {
    console.log("全部通过");
  } else {
    console.log("失败项：");
    for (const failure of failures) console.log(`- ${failure}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

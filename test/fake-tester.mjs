#!/usr/bin/env node
/**
 * fake-tester.mjs — 联调用假验收方：真的调用运行目录里的 ./ev 留证据，再按格式输出报告。
 * 用法：fake-tester.mjs <轮次> <验收输入文件> <验收会话id> <运行目录>
 * 环境：FAKE_ACC_MODE=pass|lazy|garbage|modify|unreachable|kill|kill-restart|dirty
 *         （lazy：第 1 次不留证据就报通过，更正后再好好做；unreachable：每条都报不通过、实际是连接被拒；
 *          kill：先关掉被测系统（按运行目录里的 server.pid）再照常报告；kill-restart：关掉后再用 setsid 起一个
 *          逃出进程组的服务占同一个端口（端口取自 FAKE_ACC_URL）；dirty：每条都报「数据不是初始状态」）
 *       FAKE_ACC_STRONG=<模式>（换强模型重验时用的模式；不设就和 FAKE_ACC_MODE 一样）
 *       FAKE_ACC_UNKNOWN=A3（这些条目报「无法验证」，原因是标准含糊）
 *       FAKE_ACC_FAIL=A2,A3（这些条目报「不通过」，证据照样留）
 *       FAKE_ACC_FAIL_ONCE=A2（只在第 1 次调用时报「不通过」，之后通过；需要 FAKE_STATE_DIR 计数）
 *       FAKE_ACC_TOUCH=<文件绝对路径>（每次调用都往这个文件追加一行，模拟验收期间来源资料变化）
 *       FAKE_ACC_URL=<网址>（每条都用 node fetch 这个网址留证据；不设就 echo）
 *       FAKE_STATE_DIR=<目录>（记录调用次数与参数）
 */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [round, inputFile, sessionId, runDir] = process.argv.slice(2);
const strong = (sessionId ?? "").includes("acc-strong");
const mode = (strong && process.env.FAKE_ACC_STRONG) || process.env.FAKE_ACC_MODE || "pass";
const unknownIds = (process.env.FAKE_ACC_UNKNOWN ?? "").split(",").map((id) => id.trim()).filter(Boolean);
const failIds = (process.env.FAKE_ACC_FAIL ?? "").split(",").map((id) => id.trim()).filter(Boolean);
const failOnceIds = (process.env.FAKE_ACC_FAIL_ONCE ?? "").split(",").map((id) => id.trim()).filter(Boolean);
const stateDir = process.env.FAKE_STATE_DIR;
if (process.env.FAKE_ACC_TOUCH) appendFileSync(process.env.FAKE_ACC_TOUCH, `touch ${Date.now()}\n`);

let count = 1;
if (stateDir) {
  mkdirSync(stateDir, { recursive: true });
  appendFileSync(join(stateDir, "acc-calls.log"), `${round}\t${inputFile}\t${sessionId}\t${runDir}\n`);
  const countFile = join(stateDir, "acc-count");
  count = (existsSync(countFile) ? Number.parseInt(readFileSync(countFile, "utf8"), 10) || 0 : 0) + 1;
  writeFileSync(countFile, String(count));
}

if (mode === "garbage") {
  process.stdout.write("我看了一下，感觉还行。\n");
  process.exit(0);
}

// 从「## 验收标准」一节取编号；更正输入里没有标准，就回头读同一运行目录的 input.md。
const source = readFileSync(inputFile, "utf8").includes("## 验收标准") ? readFileSync(inputFile, "utf8") : readFileSync(join(runDir, "input.md"), "utf8");
const section = source.split(/^## 验收标准（.*$/m)[1]?.split(/^## /m)[0] ?? "";
const ids = [...section.matchAll(/^(A\d+)\./gm)].map((match) => match[1]);
const projectDir = /被测项目目录：(.+?)（/.exec(source)?.[1];

if (mode === "modify" && projectDir) writeFileSync(join(projectDir, "tester-touched.txt"), "验收方不该改项目\n");

// 上一版 loop 出事的场景：验收方为了「清数据」自己关掉、重启被测系统。
if (mode === "kill" || mode === "kill-restart") {
  if (mode === "kill-restart") {
    const port = new URL(process.env.FAKE_ACC_URL ?? "http://127.0.0.1:0").port;
    // 等端口空出来就占上；60 秒后自己退出，测试清理失败也不会一直留着。
    const orphan = `const { createServer } = require("node:http");
const port = Number(process.argv[1]);
const listen = () => { const server = createServer((q, r) => r.end("orphan")); server.once("error", () => setTimeout(listen, 20)); server.listen(port, "127.0.0.1"); };
listen(); setTimeout(() => process.exit(0), 60000);`;
    spawn(process.execPath, ["-e", orphan, port], { detached: true, stdio: "ignore" }).unref();
  }
  process.kill(Number(readFileSync(join(runDir, "server.pid"), "utf8")), "SIGTERM");
  // 程序发现系统退出会立刻停掉验收方；没被停掉的话，下面留的证据都在关掉之后。
  await new Promise((resolveWait) => setTimeout(resolveWait, 1500));
}

const lazy = mode === "lazy" && !readFileSync(inputFile, "utf8").includes("证据有问题");
const url = process.env.FAKE_ACC_URL;
const lines = ["## 结论：通过", "## 逐条结果"];
for (const id of ids) {
  if (mode === "checkpoint-complete" && count > 1 && id === ids[0]) continue;
  let excerpt = `看到了 ${id}`;
  if (!lazy) {
    const command = url ? ["node", "-e", `fetch(${JSON.stringify(url)}).then((r) => r.text()).then((t) => console.log(t))`] : ["echo", excerpt];
    const res = spawnSync(join(runDir, "ev"), [id, "--", ...command], { cwd: runDir, encoding: "utf8" });
    if (url) excerpt = (res.stdout ?? "").trim().split("\n")[0] || "（空）";
  }
  if (mode === "dirty") {
    lines.push(`${id}：无法验证`, "- 原因：数据不是初始状态（已经有之前留下的记录）");
  } else if (unknownIds.includes(id)) {
    lines.push(`${id}：无法验证`, "- 原因：标准写得含糊，没法判断");
  } else if (mode === "unreachable") {
    lines.push(`${id}：不通过`, "- 实际：curl: (7) Failed to connect to 127.0.0.1 port 3000: Connection refused", `- 证据摘录：${excerpt}`);
  } else if (failIds.includes(id) || (count === 1 && failOnceIds.includes(id))) {
    lines.push(`${id}：不通过`, "- 复现：照标准操作", "- 预期：符合标准", `- 实际：${excerpt}`, `- 证据摘录：${excerpt}`);
  } else {
    lines.push(`${id}：通过`, `- 证据摘录：${excerpt}`);
  }
}
if (["checkpoint-regression", "checkpoint-complete", "checkpoint-conflict"].includes(mode)) {
  if (count === 1 && mode !== "checkpoint-conflict") {
    process.stdout.write(`## 结论：通过\n## 逐条结果\n${ids[0]}：通过\n- 证据摘录：看到了 ${ids[0]}\n`);
    process.exit(0);
  }
  const file = join(runDir, "partial.json");
  for (const id of mode === "checkpoint-complete" ? ids.slice(1) : ids) {
    const failed = id === ids[0];
    writeFileSync(file, JSON.stringify({ verdict: failed ? "不通过" : "通过", fields: { "证据摘录": `看到了 ${id}`, "复现": "再次检查", "预期": "符合标准", "实际": "与预期不同" } }));
    const saved = spawnSync(join(runDir, "result"), [id, file], { cwd: runDir, encoding: "utf8" });
    if (saved.status !== 0) throw new Error(saved.stderr);
  }
  if (mode !== "checkpoint-conflict") { process.stdout.write("这次没有合法最终标题\n"); process.exit(0); }
}
if (mode === "checkpoint" || mode === "checkpoint-all") {
  const file = join(runDir, "partial.json");
  for (const id of mode === "checkpoint-all" ? ids : ids.slice(0, 1)) {
    writeFileSync(file, JSON.stringify({ verdict: "通过", fields: { "证据摘录": `看到了 ${id}` } }));
    const saved = spawnSync(join(runDir, "result"), [id, file], { cwd: runDir, encoding: "utf8" });
    if (saved.status !== 0) throw new Error(saved.stderr);
  }
  process.exit(mode === "checkpoint-all" ? 0 : 2);
}
lines.push("## 额外发现", "- 首页标题有错别字");
process.stdout.write(`${lines.join("\n")}\n`);

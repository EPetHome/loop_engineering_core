#!/usr/bin/env node
/**
 * fake-tester.mjs — 联调用假验收方：真的调用运行目录里的 ./ev 留证据，再按格式输出报告。
 * 用法：fake-tester.mjs <轮次> <验收输入文件> <验收会话id> <运行目录>
 * 环境：FAKE_ACC_MODE=pass|lazy|garbage|modify（lazy：第 1 次不留证据就报通过，更正后再好好做）
 *       FAKE_ACC_FAIL=A2,A3（这些条目报「不通过」，证据照样留）
 *       FAKE_ACC_URL=<网址>（每条都用 node fetch 这个网址留证据；不设就 echo）
 *       FAKE_STATE_DIR=<目录>（记录调用次数与参数）
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [round, inputFile, sessionId, runDir] = process.argv.slice(2);
const mode = process.env.FAKE_ACC_MODE || "pass";
const failIds = (process.env.FAKE_ACC_FAIL ?? "").split(",").map((id) => id.trim()).filter(Boolean);
const stateDir = process.env.FAKE_STATE_DIR;

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

const lazy = mode === "lazy" && !readFileSync(inputFile, "utf8").includes("证据有问题");
const url = process.env.FAKE_ACC_URL;
const lines = ["## 结论：通过", "## 逐条结果"];
for (const id of ids) {
  let excerpt = `看到了 ${id}`;
  if (!lazy) {
    const command = url ? ["node", "-e", `fetch(${JSON.stringify(url)}).then((r) => r.text()).then((t) => console.log(t))`] : ["echo", excerpt];
    const res = spawnSync(join(runDir, "ev"), [id, "--", ...command], { cwd: runDir, encoding: "utf8" });
    if (url) excerpt = (res.stdout ?? "").trim().split("\n")[0] || "（空）";
  }
  if (failIds.includes(id)) {
    lines.push(`${id}：不通过`, "- 复现：照标准操作", "- 预期：符合标准", `- 实际：${excerpt}`, `- 证据摘录：${excerpt}`);
  } else {
    lines.push(`${id}：通过`, `- 证据摘录：${excerpt}`);
  }
}
lines.push("## 额外发现", "- 首页标题有错别字");
process.stdout.write(`${lines.join("\n")}\n`);

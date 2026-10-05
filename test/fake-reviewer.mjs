#!/usr/bin/env node
/**
 * fake-reviewer.mjs — 联调用假评审。
 * 用法：fake-reviewer.mjs <轮次> <评审输入文件> <评审会话id>
 * 环境：FAKE_MODE=pass|pass-after-1|always-fix|fail|modify
 *       FAKE_STATE_DIR=<目录>（记录调用次数与参数）
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [round, inputFile, sessionId] = process.argv.slice(2);
const mode = process.env.FAKE_MODE || "pass";
const stateDir = process.env.FAKE_STATE_DIR;

let count = 0;
if (stateDir) {
  mkdirSync(stateDir, { recursive: true });
  appendFileSync(join(stateDir, "calls.log"), `${round}\t${inputFile}\t${sessionId}\n`);
  const countFile = join(stateDir, "count");
  count = existsSync(countFile) ? Number.parseInt(readFileSync(countFile, "utf8"), 10) || 0 : 0;
  count += 1;
  writeFileSync(countFile, String(count));
}

if (mode === "fail") {
  process.stderr.write("fake reviewer: 故意失败\n");
  process.exit(1);
}

if (mode === "modify") {
  writeFileSync(join(process.cwd(), "reviewer-touched.txt"), "评审不该改文件\n");
}

const fix = mode === "always-fix" || (mode === "pass-after-1" && count === 1);
if (fix) {
  process.stdout.write(`## 结论：需返修
## 必修
1. 位置：calc.py:2
   问题：add 使用了减法
   依据：需求要求修复 add 的错误
   建议：改成 return a + b
## 小问题
- 测试文件命名可以更明确
## 需求疑问
- 无
## 上轮必修复查
- 无
`);
} else {
  process.stdout.write(`## 结论：通过
## 必修
无
## 小问题
- 无
## 需求疑问
- 无
## 上轮必修复查
- 无
`);
}

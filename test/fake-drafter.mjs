#!/usr/bin/env node
/**
 * fake-drafter.mjs — 联调用假起草方：输出两条验收标准。
 * 用法：fake-drafter.mjs <起草输入文件> <起草会话id>
 * 环境：FAKE_DRAFT_MODE=ok|fail；FAKE_STATE_DIR=<目录>（记录调用）
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [inputFile, sessionId] = process.argv.slice(2);
if (process.env.FAKE_STATE_DIR) {
  mkdirSync(process.env.FAKE_STATE_DIR, { recursive: true });
  appendFileSync(join(process.env.FAKE_STATE_DIR, "draft-calls.log"), `${inputFile}\t${sessionId}\t${readFileSync(inputFile, "utf8").length}\n`);
}
if (process.env.FAKE_DRAFT_MODE === "fail") {
  process.stderr.write("fake drafter: 故意失败\n");
  process.exit(1);
}
process.stdout.write(`## 验收标准
A1. 操作：执行 todo add "买菜"
    预期：输出「已添加」
A2. 操作：执行 todo list
    预期：列表里有「买菜」
`);

#!/usr/bin/env node
/** 只读经验起草替身；输入/输出日志只能由测试显式指向临时目录。 */
import { appendFileSync, readFileSync } from "node:fs";
const [inputPath, session] = process.argv.slice(2);
const input = readFileSync(inputPath, "utf8");
if (process.env.FAKE_EXPERIENCE_LOG) appendFileSync(process.env.FAKE_EXPERIENCE_LOG, `${JSON.stringify({ input, session })}\n`);
if (process.env.FAKE_EXPERIENCE_MODE === "fail") { console.error("模拟经验起草失败"); process.exit(1); }
const issues = JSON.parse(input.split("## 本会话必修\n")[1]);
const candidates = input.split("## 本机候选（含已拒绝；同类必须复用编号）\n")[1].split("## 本会话必修")[0];
const candidate = /### (C\d+)/.exec(candidates)?.[1];
const approved = input.split("## 已批准经验\n")[1].split("## 本机候选")[0];
console.log(JSON.stringify({ items: issues.map((issue) => {
  const id = /\bP\d+\b/.exec(issue.text)?.[0];
  if (id && approved.includes(`### ${id} `)) return { index: issue.index, kind: "experience", id };
  if (candidate) return { index: issue.index, kind: "candidate", id: candidate };
  return { index: issue.index, kind: "new", entry: {
    title: "模拟同类问题", phenomenon: "真实入口未保持约定行为。", cause: "边界状态没有复核。", practice: "在提交边界复核状态。", invalidWhen: "相关入口已移除或专项检查覆盖。",
  } };
}) }));

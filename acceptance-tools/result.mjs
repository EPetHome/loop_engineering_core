#!/usr/bin/env node
/** 每完成一条就提交结构化结果；这里只保存，程序仍核对原始证据。 */
import { readFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [runDir, id, file] = process.argv.slice(2);
try {
  if (!/^A[1-9]\d*$/.test(id ?? "") || !file) throw new Error("用法：./result A1 结果.json");
  const call = process.env.AUTOREVIEW_ACCEPTANCE_CALL;
  if (!/^[a-f0-9-]{36}$/.test(call ?? "") || readFileSync(join(runDir, "call-id"), "utf8").trim() !== call) throw new Error("过期或无效的验收调用，拒绝覆盖检查点");
  const attempt = readFileSync(join(runDir, "attempt-id"), "utf8").trim();
  const value = JSON.parse(readFileSync(file, "utf8"));
  if (!["通过", "不通过", "无法验证"].includes(value.verdict) || !value.fields || typeof value.fields !== "object"
    || Array.isArray(value.fields) || Object.values(value.fields).some((v) => typeof v !== "string")) throw new Error("需要 verdict 和字符串键值 fields");
  const dir = join(runDir, "checkpoints", call); mkdirSync(dir, { recursive: true });
  const target = join(dir, `${id}.json`), tmp = `${target}.${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ attempt, call, id, verdict: value.verdict, fields: value.fields }));
  renameSync(tmp, target);
  console.log(`${id} 已保存；最终判定仍须通过证据检查。`);
} catch (error) { console.error(error.message); process.exitCode = 1; }

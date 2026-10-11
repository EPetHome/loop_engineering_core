#!/usr/bin/env node
/**
 * ev.mjs — 验收方留证据：跑一条命令，把命令、目录、时间、退出码和输出原样追加到
 * <运行目录>/evidence/<条目>.txt，同时把输出打印出来。程序只认这个工具和 browser.mjs 写下的证据。
 *
 * 运行目录里的 ./ev 包装脚本会补上第一个参数（运行目录），验收方这样用：
 *   ./ev A1 -- curl -s http://localhost:3000/api/todos
 *   ./ev A1 --cwd /项目目录 -- node bin/todo.js list
 *   ./ev A1 -- "curl -s http://localhost:3000/api | head -5"   （只给一个参数时用 sh -c，支持管道）
 * 选项：--cwd <目录>（默认运行目录）、--timeout <秒>（默认 120）。退出码与命令相同。
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const MAX_STREAM = 200 * 1024;
const [runDir, id, ...rest] = process.argv.slice(2);
const usage = "用法：./ev <条目，如 A1> [--cwd <目录>] [--timeout <秒>] -- <命令> [参数...]";

if (!runDir || !id || !/^[AG]\d+$/.test(id)) {
  process.stderr.write(`${usage}\n`);
  process.exit(2);
}
let cwd = runDir;
let timeoutSec = 120;
let index = 0;
for (; index < rest.length && rest[index] !== "--"; index += 1) {
  if (rest[index] === "--cwd") cwd = resolve(runDir, rest[++index] ?? "");
  else if (rest[index] === "--timeout") timeoutSec = Number.parseInt(rest[++index] ?? "", 10) || timeoutSec;
  else break;
}
const command = rest[index] === "--" ? rest.slice(index + 1) : rest.slice(index);
if (command.length === 0) {
  process.stderr.write(`${usage}\n`);
  process.exit(2);
}

const shell = command.length === 1;
const res = shell
  ? spawnSync("/bin/sh", ["-c", command[0]], { cwd, encoding: "utf8", timeout: timeoutSec * 1000, maxBuffer: 20 * 1024 * 1024 })
  : spawnSync(command[0], command.slice(1), { cwd, encoding: "utf8", timeout: timeoutSec * 1000, maxBuffer: 20 * 1024 * 1024 });
const stdout = res.stdout ?? "";
const stderr = res.stderr ?? "";
const cap = (text) => (text.length > MAX_STREAM ? `${text.slice(0, MAX_STREAM)}\n…（超过 ${MAX_STREAM} 字节，已截断）` : text);
let code = res.status ?? 1;
let status = `退出码：${code}`;
if (res.error) status = `无法执行：${res.error.message}`;
else if (res.signal) status = `被终止：${res.signal}${res.signal === "SIGTERM" ? `（超过 ${timeoutSec} 秒）` : ""}`;

const dir = join(runDir, "evidence");
mkdirSync(dir, { recursive: true });
const file = join(dir, `${id}.txt`);
const count = existsSync(file) ? (readFileSync(file, "utf8").match(new RegExp(`^=== ${id} #`, "gm")) ?? []).length : 0;
appendFileSync(file, [
  `=== ${id} #${count + 1} ${new Date().toISOString()}`,
  `$ ${shell ? command[0] : command.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(" ")}`,
  `目录：${cwd}`,
  status,
  "--- 标准输出",
  cap(stdout).replace(/\n$/, ""),
  "--- 标准错误",
  cap(stderr).replace(/\n$/, ""),
  "",
].join("\n") + "\n");

process.stdout.write(stdout);
process.stderr.write(stderr);
process.stderr.write(`[ev] ${status}；已记录到 evidence/${id}.txt\n`);
if (res.error || res.signal) code = code || 1;
process.exit(code);

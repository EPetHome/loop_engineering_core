/** 项目文档与代码的只读事实索引；只更新 Loop 数据目录，不修改 AGENTS.md 或业务来源。 */
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findProjectRoot, readMarker } from "./config.ts";
import { readJson, writeJsonAtomic } from "./pipeline-core.ts";
import { reapRunResources } from "./resources.ts";
import { processStartTime } from "./procs.ts";

type Role = "rules" | "requirement" | "design" | "guide" | "code";
interface Source { id: string; path: string; role: Role; dependsOn: string[]; optional: boolean }
export interface ContextConfig { root: string; sources: Source[]; maxChars: number; intervalSec: number }
interface Fact { path: string; source: string; role: Role; hash: string; symbols: string[]; missing?: boolean }
export interface ContextSnapshot {
  project: string; revision: number; fingerprint: string; inputsFingerprint: string; updatedAt: string;
  files: Fact[]; missing: string[]; sources?: Source[];
}
export interface ContextChange { path: string; kind: "added" | "modified" | "deleted"; before?: string; after?: string }
export interface ContextResult { snapshot: ContextSnapshot; changed: boolean; changes: ContextChange[]; affected: string[]; path: string; text: string }

const digest = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const roles = new Set(["rules", "requirement", "design", "guide", "code"]);
const ignored = /(^|[/\\])(?:\.git|node_modules|target|dist|\.venv|\.aws|\.ssh|\.pi-autoreview|logs?|temp)(?:[/\\]|$)|(^|[/\\])(?:\.env(?:\..*)?|auth\.json|credentials(?:\..*)?)$/;
const textFile = /\.(?:md|txt|ts|tsx|js|jsx|mjs|cjs|py|java|go|rs|vue|json|yaml|yml|toml|sh|sql)$/;

export function parseContext(raw: unknown, configRoot: string): ContextConfig | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("context 必须是对象");
  const data = raw as Record<string, unknown>;
  if (data.root !== undefined && (typeof data.root !== "string" || !data.root.trim())) throw new Error("context.root 必须是非空路径");
  const root = resolve(configRoot, (data.root as string) ?? ".");
  if (!Array.isArray(data.sources) || !data.sources.length) throw new Error("context.sources 必须明确列出来源");
  const sources: Source[] = data.sources.map((raw, index) => {
    const source = typeof raw === "string" ? { path: raw, role: "guide" } : raw;
    if (!source || typeof source !== "object" || typeof source.path !== "string" || !source.path.trim()) throw new Error(`context.sources[${index}] 缺少 path`);
    const path = relative(root, resolve(root, source.path));
    if (!path || isAbsolute(source.path) || path.startsWith("..") || ignored.test(path)) throw new Error(`context 来源越界或属于排除区域：${source.path}`);
    const role = source.role ?? "guide";
    if (!roles.has(role)) throw new Error(`context.sources[${index}].role 无效`);
    const id = source.id ?? path;
    if (typeof id !== "string" || !id.trim()) throw new Error("context 来源 id 必须是非空字符串");
    const dependsOn = source.dependsOn ?? [];
    if (!Array.isArray(dependsOn) || dependsOn.some((v) => typeof v !== "string")) throw new Error("context.dependsOn 必须是来源 id 数组");
    if (source.optional !== undefined && typeof source.optional !== "boolean") throw new Error("context.optional 必须是布尔值");
    return { id, path, role: role as Role, dependsOn, optional: source.optional === true };
  });
  const ids = new Set(sources.map((s) => s.id));
  if (ids.size !== sources.length || sources.some((s) => s.dependsOn.some((id) => !ids.has(id)))) throw new Error("context 来源 id 重复或依赖不存在");
  const maxChars = data.maxChars ?? 12000, intervalSec = data.intervalSec ?? 0;
  if (!Number.isSafeInteger(maxChars) || (maxChars as number) < 1000 || (maxChars as number) > 100000) throw new Error("context.maxChars 必须在 1000—100000 之间");
  if (!Number.isSafeInteger(intervalSec) || (intervalSec as number) < 0 || ((intervalSec as number) > 0 && (intervalSec as number) < 30)) throw new Error("context.intervalSec 必须为 0 或不小于 30 的整数");
  return { root, sources, maxChars: maxChars as number, intervalSec: intervalSec as number };
}

export function loadContext(cwd: string): ContextConfig | undefined {
  const root = findProjectRoot(cwd);
  return root ? parseContext(readMarker(root).context, root) : undefined;
}

/** 消费完成资格时重新读取实际来源；删除配置也不能让旧来源身份变成有效。 */
export function sourceInputsProblem(cwd: string, expected?: string): string | undefined {
  const config = loadContext(cwd);
  if (!config) return expected ? "上游来源配置已移除，需要重新确认输入" : undefined;
  const current = refreshContext(config).snapshot;
  if (current.missing.length) return `上游来源缺失：${current.missing.join("、")}`;
  if (current.inputsFingerprint !== expected) return "上游来源版本已变化，原任务输入保持冻结";
  return undefined;
}

export const contextDir = (config: ContextConfig): string => join(
  process.env.AUTOREVIEW_PROJECTS_ROOT ?? join(homedir(), ".pi-autoreview", "projects"), digest(realpathSync(config.root)).slice(0, 16));

function sourceFiles(root: string, path: string): string[] {
  const file = resolve(root, path);
  if (!existsSync(file)) return [];
  const info = lstatSync(file);
  if (info.isSymbolicLink()) throw new Error(`上下文来源不跟随符号链接：${path}`);
  const rel = relative(realpathSync(root), realpathSync(file));
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`上下文来源越出根目录：${path}`);
  if (info.isFile()) return [path];
  if (!info.isDirectory()) throw new Error(`上下文来源不是普通文件或目录：${path}`);
  return readdirSync(file).sort().flatMap((name) => {
    const child = join(path, name);
    if (ignored.test(child)) return [];
    const item = lstatSync(resolve(root, child));
    return item.isDirectory() || textFile.test(name) ? sourceFiles(root, child) : [];
  });
}

function symbols(text: string): string[] {
  return text.split(/\r?\n/).flatMap((line, i) => {
    const match = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s+|class\s+|interface\s+|type\s+|def\s+|(?:const|let)\s+)([\w$]+)/.exec(line);
    return match ? [`${match[1]}:${i + 1}`] : [];
  }).slice(0, 40);
}

/** 无变化时不更新 snapshot/context.md，也不追加日志或调用模型。 */
function refreshUnlocked(config: ContextConfig, query = ""): ContextResult {
  const files: Fact[] = [], missing: string[] = [];
  const contents = new Map<string, Buffer>();
  let totalBytes = 0;
  for (const source of config.sources) {
    const paths = sourceFiles(config.root, source.path);
    if (!paths.length && !source.optional) missing.push(source.path);
    for (const path of paths) {
      if (files.length >= 2000) throw new Error("上下文来源超过 2000 个文件，请缩小登记范围");
      const bytes = readFileSync(resolve(config.root, path));
      if (bytes.length > 1024 * 1024 || bytes.includes(0)) throw new Error(`上下文来源过大或不是文本：${path}`);
      totalBytes += bytes.length;
      if (totalBytes > 16 * 1024 * 1024) throw new Error("上下文来源总量超过 16 MiB，请缩小登记范围");
      const hash = digest(bytes); contents.set(hash, bytes);
      files.push({ path, source: source.id, role: source.role, hash, symbols: source.role === "code" ? symbols(bytes.toString("utf8")) : [] });
    }
  }
  files.sort((a, b) => `${a.source}/${a.path}`.localeCompare(`${b.source}/${b.path}`));
  const fingerprint = digest(JSON.stringify({ sources: config.sources, files, missing }));
  const inputsFingerprint = digest(JSON.stringify({ sources: config.sources.filter((s) => s.role !== "code"), files: files.filter((f) => f.role !== "code"), missing }));
  const dir = contextDir(config);
  const previous = readJson<ContextSnapshot>(join(dir, "snapshot.json"));
  const changed = previous?.fingerprint !== fingerprint;
  const before = new Map((previous?.files ?? []).map((f) => [`${f.source}/${f.path}`, f]));
  const after = new Map(files.map((f) => [`${f.source}/${f.path}`, f]));
  const changes: ContextChange[] = [];
  const affected = new Set<string>();
  const sourceChanges = [...new Set([...config.sources, ...(previous?.sources ?? [])].map((s) => s.id))]
    .filter((id) => JSON.stringify(config.sources.find((s) => s.id === id)) !== JSON.stringify(previous?.sources?.find((s) => s.id === id)));
  for (const id of sourceChanges) affected.add(id);
  for (const [key, fact] of after) {
    const old = before.get(key);
    if (old?.hash !== fact.hash) { changes.push({ path: fact.path, kind: old ? "modified" : "added", before: old?.hash, after: fact.hash }); affected.add(fact.source); }
  }
  for (const [key, fact] of before) if (!after.has(key)) { changes.push({ path: fact.path, kind: "deleted", before: fact.hash }); affected.add(fact.source); }
  let count = -1;
  while (count !== affected.size) {
    count = affected.size;
    for (const source of config.sources) if (source.dependsOn.some((id) => affected.has(id))) affected.add(source.id);
  }
  const snapshot: ContextSnapshot = changed ? {
    project: realpathSync(config.root), revision: (previous?.revision ?? 0) + 1, fingerprint, inputsFingerprint,
    updatedAt: new Date().toISOString(), files, missing, sources: config.sources,
  } : previous!;
  if (changed) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // 内容按哈希保存一份，旧版本可回看；不能只留哈希却覆盖原文。
    mkdirSync(join(dir, "contents"), { recursive: true, mode: 0o700 });
    for (const file of files) {
      const target = join(dir, "contents", file.hash);
      if (!existsSync(target)) writeFileSync(target, contents.get(file.hash)!, { mode: 0o600 });
    }
    const event = { type: "source-change", revision: snapshot.revision, at: snapshot.updatedAt, changes, sourceChanges, affected: [...affected], missing,
      note: "哈希变化只表示内容变化；相关旧结论待核对，不自动改变需求、授权或验收标准。" };
    appendFileSync(join(dir, "changes.jsonl"), `${JSON.stringify(event)}\n`, { mode: 0o600 });
    writeJsonAtomic(join(dir, "snapshot.json"), snapshot);
    writeFileSync(join(dir, "context.md"), renderContext(config, snapshot), { mode: 0o600 });
  }
  return { snapshot, changed, changes, affected: [...affected], path: join(dir, "context.md"), text: renderContext(config, snapshot, query) };
}

/** 跨会话更新同一索引时串行发布，避免两个“第 N 版”；锁只覆盖本地文件读写。 */
export function refreshContext(config: ContextConfig, query = ""): ContextResult {
  const dir = contextDir(config), lock = join(dir, "refresh.lock");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const token = randomUUID(), deadline = Date.now() + 1000;
  for (;;) {
    try {
      const fd = openSync(lock, "wx", 0o600);
      try { writeFileSync(fd, JSON.stringify({ pid: process.pid, started: processStartTime(process.pid), token })); }
      finally { closeSync(fd); }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = readJson<{ pid: number; started: string; token: string }>(lock);
      if (owner && Number.isInteger(owner.pid) && owner.pid > 1 && owner.started) {
        const started = processStartTime(owner.pid);
        let gone = Boolean(started && started !== owner.started);
        if (!started) { try { process.kill(owner.pid, 0); } catch (e) { gone = (e as NodeJS.ErrnoException).code === "ESRCH"; } }
        if (gone && readJson<{ token: string }>(lock)?.token === owner.token) { unlinkSync(lock); continue; }
      }
      if (Date.now() >= deadline) throw new Error("项目上下文正在更新或锁归属未确认，请稍后重试");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try { return refreshUnlocked(config, query); }
  finally { if (readJson<{ token: string }>(lock)?.token === token) unlinkSync(lock); }
}

function renderContext(config: ContextConfig, snapshot: ContextSnapshot, query = ""): string {
  const terms = [...new Set(query.match(/[\p{L}\p{N}_-]{2,}/gu) ?? [])].slice(0, 60);
  const score = (f: Fact): number => terms.filter((term) => `${f.path} ${f.symbols.join(" ")}`.includes(term)).length;
  const ordered = [...snapshot.files].sort((a, b) => score(b) - score(a));
  const lines = [`# 当前来源与定位（第 ${snapshot.revision} 版）`, `项目：${snapshot.project}`, `指纹：${snapshot.fingerprint}`,
    "这是可回指的来源索引，不是业务已通过的结论；根因推断与独立评审仍需读取相关源码。",
    ...(snapshot.missing.length ? [`缺少来源：${snapshot.missing.join("、")}`] : [])];
  let length = lines.join("\n").length;
  for (const file of ordered) {
    const row = `- [${file.role}] ${file.path}（${file.hash.slice(0, 12)}）${file.symbols.length ? `；候选定义：${file.symbols.join("、")}` : ""}`;
    if (length + row.length > config.maxChars) { lines.push("其余内容按任务需要读取原文；完整来源见 snapshot.json。"); break; }
    lines.push(row); length += row.length;
  }
  return `${lines.join("\n")}\n`;
}

/** 固定格式交付索引：引用原总结，不复制多份事实；同一输入与结果重复调用不追加。 */
export function recordProjectOutcome(config: ContextConfig, session: string, status: string, summary: string, expectedInputs?: string): void {
  const { snapshot } = refreshContext(config);
  if (status === "done" && expectedInputs && snapshot.inputsFingerprint !== expectedInputs) throw new Error("发布结果前上游来源变化，未记录为当前版本完成");
  const dir = contextDir(config), id = digest(session).slice(0, 24);
  const record = { session, status, summary, revision: snapshot.revision, inputsFingerprint: expectedInputs ?? snapshot.inputsFingerprint };
  const path = join(dir, "deliveries", `${id}.json`);
  if (JSON.stringify(readJson(path)) === JSON.stringify(record)) return;
  writeJsonAtomic(path, record);
  appendFileSync(join(dir, "changes.jsonl"), `${JSON.stringify({ type: "outcome", at: new Date().toISOString(), ...record })}\n`);
}

async function main(): Promise<void> {
  const cwd = resolve(process.argv[2] ?? process.cwd());
  const config = loadContext(cwd);
  if (!config) throw new Error("项目尚未配置 context.sources");
  const check = () => { const result = refreshContext(config); reapRunResources(); if (result.changed) process.stdout.write(`来源第 ${result.snapshot.revision} 版：${result.path}\n`); };
  check();
  if (process.argv.includes("--watch")) setInterval(check, Math.max(30, config.intervalSec) * 1000);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

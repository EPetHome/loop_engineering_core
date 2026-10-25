/**
 * methods.ts — 项目方法自测指纹和基线空跑缓存。
 *
 * 指纹 = loop 版本 + methods.paths 下全部文件的哈希 + 方法相关配置 + methods.probe 输出。
 * 记录在项目数据目录的 methods.json；基线门禁按提交的树哈希缓存最近 50 个。
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { findProjectRoot, parseGateConfig, parseMethodsConfig, readMarker, type GateConfig, type MethodsConfig } from "./config.ts";
import { writeJsonAtomic } from "./pipeline-core.ts";
import { projectDataDir } from "./project-context.ts";
import { currentTree, gitResult, isClean } from "./workspace.ts";

const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const tail = (value: string, max = 500): string => value.trim().slice(-max);

export interface MethodFile { path: string; hash: string; missing?: boolean }
export interface ProbeResult { command: string; exitCode: number; hash: string }
export interface MethodsComponents {
  loopVersion: string;
  files: MethodFile[];
  config: string;
  probe?: ProbeResult;
}
export interface MethodsRecord {
  version: 1;
  fingerprint: string;
  components: MethodsComponents;
  updatedAt: string;
  gateTrees: string[];
  /** 启动入口的权限自动执行检查通过时的指纹；与方法自测分开记录。 */
  permissionFingerprint?: string;
  permissionCheckedAt?: string;
}

export interface MethodsOptions { recheck?: boolean; dryRun?: boolean; loopRoot: string; env?: NodeJS.ProcessEnv }

export const methodsRecordPath = (root: string, env: NodeJS.ProcessEnv = process.env): string =>
  join(projectDataDir(root, env), "methods.json");

export function readMethodsRecord(root: string, env: NodeJS.ProcessEnv = process.env): MethodsRecord | undefined {
  const path = methodsRecordPath(root, env);
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as Partial<MethodsRecord>;
    if (!data || data.version !== 1 || typeof data.fingerprint !== "string" || !data.components
      || !Array.isArray(data.components.files) || !Array.isArray(data.gateTrees)) return undefined;
    return data as MethodsRecord;
  } catch { return undefined; }
}

function loopVersion(loopRoot: string): string {
  const res = gitResult(loopRoot, ["describe", "--always", "--dirty"]);
  return res.status === 0 && res.stdout.trim() ? res.stdout.trim() : "unknown";
}

function walk(root: string, path: string, output: MethodFile[]): void {
  const absolute = resolve(root, path);
  if (!existsSync(absolute)) {
    output.push({ path: path.replace(/\\/g, "/"), hash: "missing", missing: true });
    return;
  }
  const info = lstatSync(absolute);
  const rel = relative(root, absolute).replace(/\\/g, "/");
  if (info.isSymbolicLink()) {
    output.push({ path: rel, hash: hash(`link:${readlinkSync(absolute)}`) });
    return;
  }
  if (info.isFile()) {
    output.push({ path: rel, hash: hash(readFileSync(absolute)) });
    return;
  }
  if (!info.isDirectory()) {
    output.push({ path: rel, hash: "unsupported" });
    return;
  }
  for (const name of readdirSync(absolute).sort()) {
    if (name === ".git") continue;
    walk(root, join(rel, name), output);
  }
}

/** methods.paths 下的全部文件，按路径排序；缺失路径也记一条，变化时可指出。 */
export function methodFiles(root: string, methods: MethodsConfig | undefined): MethodFile[] {
  const files: MethodFile[] = [];
  for (const path of methods?.paths ?? []) walk(root, path, files);
  const unique = new Map<string, MethodFile>();
  for (const file of files) unique.set(file.path, file);
  return [...unique.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function configHash(root: string): string {
  const raw = existsSync(join(root, ".autoreview.json")) ? readMarker(root) : {};
  return hash(JSON.stringify({ methods: raw.methods ?? null, gate: raw.gate ?? null }));
}

function probe(root: string, command: string, dryRun: boolean): ProbeResult {
  if (dryRun) return { command, exitCode: 0, hash: hash("probe-skipped-in-dry-run") };
  const res = spawnSync("/bin/sh", ["-c", command], { cwd: root, encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
  const output = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  return { command, exitCode: res.status ?? 1, hash: hash(`${res.status ?? 1}\n${output}`) };
}

export function methodsComponents(root: string, loopRoot: string, options: { dryRun?: boolean } = {}): MethodsComponents {
  const methods = parseMethodsConfig(existsSync(join(root, ".autoreview.json")) ? readMarker(root).methods : undefined, root);
  const probeConfig = methods?.probe;
  return {
    loopVersion: loopVersion(loopRoot),
    files: methodFiles(root, methods),
    config: configHash(root),
    ...(probeConfig ? { probe: probe(root, probeConfig, options.dryRun === true) } : {}),
  };
}

export const methodsFingerprint = (components: MethodsComponents): string => hash(JSON.stringify(components));

export function changedParts(previous: MethodsRecord | undefined, current: MethodsComponents): string[] {
  if (!previous) return ["还没有方法自测记录"];
  const changes: string[] = [];
  if (previous.components.loopVersion !== current.loopVersion) {
    changes.push(`loop 版本发生变化：${previous.components.loopVersion} → ${current.loopVersion}`);
  }
  const before = new Map(previous.components.files.map((file) => [file.path, file]));
  const after = new Map(current.files.map((file) => [file.path, file]));
  for (const [path, file] of after) {
    const old = before.get(path);
    if (!old) changes.push(`方法文件发生变化：${path}（新增）`);
    else if (old.hash !== file.hash) changes.push(`方法文件发生变化：${path}（${file.missing ? "缺失" : "内容"}）`);
  }
  for (const [path, file] of before) {
    if (!after.has(path)) changes.push(`方法文件发生变化：${path}（删除）`);
  }
  if (previous.components.config !== current.config) changes.push("方法相关配置发生变化");
  const oldProbe = previous.components.probe, newProbe = current.probe;
  if (JSON.stringify(oldProbe) !== JSON.stringify(newProbe)) changes.push("methods.probe 输出发生变化");
  return changes;
}

function runCommand(root: string, command: string, timeoutMs: number): { ok: boolean; output: string; code: number } {
  const res = spawnSync("/bin/sh", ["-c", command], { cwd: root, encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
  const output = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  return { ok: (res.status ?? 1) === 0 && !res.error, output, code: res.status ?? 1 };
}

export interface MethodsRunResult {
  skipped: boolean;
  changed: string[];
  fingerprint: string;
  selfCheck?: { command: string; passed: boolean; output: string };
  baseline?: { tree: string; cached: boolean; passed?: boolean; output?: string };
  record: MethodsRecord;
  written: boolean;
}

/** 指纹不变就跳过；变了（或 --recheck）执行一次 selfCheck 和基线空跑，通过后才更新记录。 */
export function runMethodsSelfTest(root: string, options: MethodsOptions): MethodsRunResult {
  const env = options.env ?? process.env;
  const previous = readMethodsRecord(root, env);
  const current = methodsComponents(root, options.loopRoot, { dryRun: options.dryRun });
  const fingerprint = methodsFingerprint(current);
  const unchanged = previous?.fingerprint === fingerprint;
  if (unchanged && !options.recheck) {
    return { skipped: true, changed: [], fingerprint, record: previous, written: false };
  }
  const changes = changedParts(previous, current);
  const record: MethodsRecord = {
    version: 1, fingerprint, components: current, updatedAt: new Date().toISOString(), gateTrees: previous?.gateTrees ?? [],
    ...(previous?.permissionFingerprint === fingerprint
      ? { permissionFingerprint: previous.permissionFingerprint, permissionCheckedAt: previous.permissionCheckedAt } : {}),
  };
  if (options.dryRun) {
    return { skipped: false, changed: changes, fingerprint, record, written: false };
  }
  const methods = parseMethodsConfig(existsSync(join(root, ".autoreview.json")) ? readMarker(root).methods : undefined, root);
  if (methods?.selfCheck) {
    const result = runCommand(root, methods.selfCheck, 10 * 60_000);
    if (!result.ok) throw new Error(`方法自测未通过（${methods.selfCheck}，退出码 ${result.code}）：${tail(result.output)}`);
    record.components = current;
    const check = { command: methods.selfCheck, passed: true, output: result.output };
    const baseline = baselineGate(root, env, options.recheck === true);
    if (baseline?.tree) record.gateTrees = [baseline.tree, ...record.gateTrees.filter((tree) => tree !== baseline.tree)].slice(0, 50);
    writeJsonAtomic(methodsRecordPath(root, env), record);
    return { skipped: false, changed: changes, fingerprint, selfCheck: check, ...(baseline ? { baseline } : {}), record, written: true };
  }
  const baseline = baselineGate(root, env, options.recheck === true);
  if (baseline?.tree) record.gateTrees = [baseline.tree, ...record.gateTrees.filter((tree) => tree !== baseline.tree)].slice(0, 50);
  writeJsonAtomic(methodsRecordPath(root, env), record);
  return { skipped: false, changed: changes, fingerprint, ...(baseline ? { baseline } : {}), record, written: true };
}

/** 基线空跑：开工依据的树已经在缓存里就跳过；否则跑一次门禁，通过后由调用方写进记录。 */
function baselineGate(root: string, env: NodeJS.ProcessEnv, force = false): { tree: string; cached: boolean; passed?: boolean; output?: string } | undefined {
  if (!existsSync(join(root, ".autoreview.json"))) return undefined;
  const gate = parseGateConfig(readMarker(root).gate) as GateConfig | undefined;
  if (!gate) return undefined;
  const tree = currentTree(root);
  const previous = readMethodsRecord(root, env);
  if (!force && previous?.gateTrees.includes(tree)) return { tree, cached: true };
  const result = runCommand(root, gate.cmd, gate.timeoutMin * 60_000);
  if (!result.ok) throw new Error(`基线空跑门禁未通过（${gate.cmd}，退出码 ${result.code}）：${tail(result.output)}`);
  if (!isClean(root)) throw new Error("基线空跑门禁改动了工作区；请把构建产物写进 .gitignore 或项目外，再重新开工");
  return { tree, cached: false, passed: true, output: result.output };
}

/** 当前方法指纹；启动入口的权限检查也用它判断是否跳过。 */
export function currentMethodsFingerprint(root: string, loopRoot: string, env: NodeJS.ProcessEnv = process.env): { fingerprint: string; components: MethodsComponents; record?: MethodsRecord } {
  const components = methodsComponents(root, loopRoot);
  const fingerprint = methodsFingerprint(components);
  return { fingerprint, components, record: readMethodsRecord(root, env) };
}

/** 权限检查通过后只更新权限检查标记，不改方法自测的 fingerprint/components。 */
export function recordPermissionCheck(root: string, fingerprint: string, components: MethodsComponents, env: NodeJS.ProcessEnv = process.env): void {
  const previous = readMethodsRecord(root, env);
  const record: MethodsRecord = previous
    ? { ...previous, permissionFingerprint: fingerprint, permissionCheckedAt: new Date().toISOString() }
    : { version: 1, fingerprint: "", components, updatedAt: new Date().toISOString(), gateTrees: [],
        permissionFingerprint: fingerprint, permissionCheckedAt: new Date().toISOString() };
  mkdirSync(dirname(methodsRecordPath(root, env)), { recursive: true });
  writeJsonAtomic(methodsRecordPath(root, env), record);
}

/** 任何候选门禁通过时记下树哈希；项目有 .autoreview.json 才记录，写失败不影响门禁结论。 */
export function recordGateTree(cwd: string, tree: string, env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const root = findProjectRoot(cwd) ?? cwd;
    if (!existsSync(join(root, ".autoreview.json"))) return false;
    const path = methodsRecordPath(root, env);
    const previous = readMethodsRecord(root, env);
    const record: MethodsRecord = previous && previous.version === 1
      ? { ...previous, gateTrees: [tree, ...(previous.gateTrees ?? []).filter((item) => item !== tree)].slice(0, 50) }
      : { version: 1, fingerprint: "", components: { loopVersion: "unknown", files: [], config: "" }, updatedAt: new Date().toISOString(), gateTrees: [tree] };
    mkdirSync(dirname(path), { recursive: true });
    writeJsonAtomic(path, record);
    return true;
  } catch { return false; }
}

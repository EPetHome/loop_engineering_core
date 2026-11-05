/** Loop 登记资源的释放与目录瘦身；调用方必须先确认会话完成及目录归属。 */
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, rmSync, statfsSync, unlinkSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { processStartTime, readProcs, reapProcs } from "./procs.ts";
import { writeJsonAtomic } from "./pipeline-core.ts";

export interface RunResource {
  id: string;
  root: string;
  dir: string;
  /** 报告、失败现场与旧脚本的系统临时文件保留在独立目录。 */
  evidenceDir: string;
  procsFile?: string;
  label: string;
  ownerPid: number;
  ownerStarted: string;
  createdAt: string;
  status: "active" | "released" | "retained" | "cleanup-failed";
  detail?: string;
}

export const resourceRoot = (): string => process.env.AUTOREVIEW_RESOURCE_ROOT
  ? resolve(process.env.AUTOREVIEW_RESOURCE_ROOT) : join(homedir(), ".pi-autoreview", "resources");
const markerPath = (resource: RunResource): string => join(resource.root, `${resource.id}.json`);
const validId = (id: string): boolean => /^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(id);
const persist = (resource: RunResource): void => writeJsonAtomic(markerPath(resource), resource);

export function availableBytes(path: string): number {
  const data = statfsSync(path);
  return Number(data.bavail) * Number(data.bsize);
}

export function createRunResource(label: string, minFreeMiB = Number(process.env.AUTOREVIEW_MIN_FREE_MIB ?? 256), procsFile?: string): RunResource {
  if (!Number.isFinite(minFreeMiB) || minFreeMiB < 0) throw new Error("AUTOREVIEW_MIN_FREE_MIB 必须是非负数");
  const root = resourceRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (availableBytes(root) < minFreeMiB * 1024 * 1024) throw new Error(`ENOSPC: 运行目录可用空间低于 ${minFreeMiB} MiB，停止启动新任务`);
  const id = randomUUID();
  const resource: RunResource = {
    id, root, dir: join(root, id), evidenceDir: join(root, "evidence", id), procsFile, label, ownerPid: process.pid,
    ownerStarted: processStartTime(process.pid), createdAt: new Date().toISOString(), status: "active",
  };
  // 先登记，再创建；创建失败时也有可检查的记录。
  persist(resource);
  mkdirSync(resource.dir, { mode: 0o700 });
  mkdirSync(resource.evidenceDir, { recursive: true, mode: 0o700 });
  return resource;
}

/**
 * 这次运行还有没有自己的消费者在登记：只看 runId 等于本资源编号的登记。
 * 没有 runId 的旧登记身份不明，继续保护；别的运行的登记不属于本次释放范围。
 */
function hasOwnConsumer(resource: RunResource): boolean {
  if (!resource.procsFile) return false;
  return [resource.procsFile, `${resource.procsFile}.cleanup`]
    .some((file) => readProcs(file).some((entry) => entry.runId === undefined || entry.runId === resource.id));
}

export function releaseRunResource(resource: RunResource, retain = false): RunResource {
  if (!validId(resource.id) || resolve(resource.root) !== resolve(resourceRoot())
    || resolve(resource.dir) !== resolve(resource.root, resource.id)) {
    return Object.assign(resource, { status: "cleanup-failed" as const, detail: "目录不属于当前受管资源根，未删除" });
  }
  let registered: RunResource;
  try { registered = JSON.parse(readFileSync(markerPath(resource), "utf8")); }
  catch { return Object.assign(resource, { status: "cleanup-failed" as const, detail: "缺少资源身份记录，未删除" }); }
  if (registered.id !== resource.id || registered.dir !== resource.dir || registered.ownerPid !== resource.ownerPid
    || registered.ownerStarted !== resource.ownerStarted) return Object.assign(resource, { status: "cleanup-failed" as const, detail: "资源身份不匹配，未删除" });
  if (!retain && hasOwnConsumer(resource)) {
    resource.status = "cleanup-failed"; resource.detail = "消费者释放未确认，缓存与证据均保留";
    persist(resource); return resource;
  }
  try {
    if (retain || !resource.evidenceDir) resource.status = "retained";
    else {
      if (existsSync(resource.dir)) {
        if (lstatSync(resource.dir).isSymbolicLink() || realpathSync(resource.dir) !== join(realpathSync(resource.root), resource.id)) {
          throw new Error("资源路径已替换为链接或其他位置，未删除");
        }
        rmSync(resource.dir, { recursive: true });
      }
      resource.status = "released";
    }
    resource.detail = undefined;
  } catch (error) { resource.status = "cleanup-failed"; resource.detail = String(error); }
  // 清理失败也保留登记，不能丢失下次补偿所需的信息。
  persist(resource);
  return resource;
}

/** 仅回收登记所有者已退出的临时目录；证据、保留现场及活动任务一律保留。 */
export function reapRunResources(): RunResource[] {
  const root = resourceRoot();
  if (!existsSync(root)) return [];
  const results: RunResource[] = [];
  for (const file of readdirSync(root).filter((name) => /^[0-9a-f-]+\.json$/.test(name))) {
    let resource: RunResource;
    try { resource = JSON.parse(readFileSync(join(root, file), "utf8")); } catch { continue; }
    if (!["active", "cleanup-failed"].includes(resource.status) || !resource.ownerStarted
      || !Number.isInteger(resource.ownerPid) || resource.ownerPid < 2) continue;
    const started = processStartTime(resource.ownerPid);
    if (started === resource.ownerStarted) continue;
    // ps 失败和进程已退出不同；无法确认时保留。
    if (!started) {
      try { process.kill(resource.ownerPid, 0); continue; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue; }
    }
    // 宿主死亡不等于使用它的 detached 子进程已结束；先按登记回收，仍有自己的消费者就保留。
    if (resource.procsFile) {
      const registries = [resource.procsFile, `${resource.procsFile}.cleanup`];
      for (const file of registries) reapProcs(file);
      if (hasOwnConsumer(resource)) continue;
    }
    results.push(releaseRunResource(resource));
  }
  return results;
}

/** 不跟随受管根以内的链接；系统临时目录自身的 /var → /private/var 别名不影响核对。 */
export function checkedMaterialPath(root: string, path: string): void {
  const rel = relative(resolve(root), resolve(path));
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("路径越出登记范围");
  let current = resolve(root);
  for (const part of ["", ...rel.split(sep).filter(Boolean)]) {
    if (part) current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error(`符号链接，归属不明：${current}`);
  }
  if (realpathSync(path) !== join(realpathSync(root), rel)) throw new Error("实际路径与登记不符");
}

export interface MaterialCleanup {
  apply: boolean;
  files: number;
  bytes: number;
  paths: string[];
  unknown: { path: string; reason: string }[];
  failures: { path: string; reason: string }[];
}

export const newMaterialCleanup = (apply: boolean): MaterialCleanup => ({ apply, files: 0, bytes: 0, paths: [], unknown: [], failures: [] });
const SMALL_FILE_BYTES = 256 * 1024;
const KEEP_DIRS = new Set(["evidence", "checkpoints", "logs"]);
const keepFile = (name: string): boolean => /^(?:result.*\.json|input\.md)$/i.test(name) || /\.(?:log|png|jpg)$/i.test(name);

/**
 * 根目录必须已由调用方按登记确认；仅逐项 unlink/rmdir，不递归 rm、不跟随链接。
 * 保留目录的后代继承保护；node_modules 是明确可丢弃的例外，其内部链接仅 unlink 本身。
 * 小型未知二进制保守保留。
 */
export function slimMaterialDirectory(root: string, dir: string, result: MaterialCleanup, canDelete: () => boolean = () => true): void {
  type Removal = { path: string; stat: Stats; directory: boolean; link?: boolean };
  const plan: Removal[] = [];
  const visit = (path: string, protectedDir = false, modules = false): boolean => {
    try {
      const stat = lstatSync(path), name = path.slice(path.lastIndexOf(sep) + 1);
      if (modules && stat.isSymbolicLink()) {
        checkedMaterialPath(root, dirname(path));
        plan.push({ path, stat, directory: false, link: true }); return true;
      }
      checkedMaterialPath(root, path);
      if (stat.isDirectory()) {
        const discard = modules || name === "node_modules";
        const keep = !discard && (protectedDir || KEEP_DIRS.has(name));
        let empty = true;
        for (const child of readdirSync(path).sort()) if (!visit(join(path, child), keep, discard)) empty = false;
        if (empty && !keep) { plan.push({ path, stat, directory: true }); return true; }
        return false;
      }
      if (!stat.isFile()) {
        result.unknown.push({ path, reason: "不是普通文件或目录，保留" }); return false;
      }
      if (!modules && (protectedDir || keepFile(name) || stat.size <= SMALL_FILE_BYTES)) return false;
      if (stat.nlink > 1) { result.unknown.push({ path, reason: "存在其他硬链接，不能确认可释放空间，保留" }); return false; }
      plan.push({ path, stat, directory: false }); return true;
    } catch (error) {
      result.unknown.push({ path, reason: String(error) }); return false;
    }
  };
  visit(dir);
  for (const entry of plan) {
    let allowed = false;
    try { allowed = canDelete(); } catch { /* 无法核对也不能删除 */ }
    if (!allowed) {
      result.failures.push({ path: entry.path, reason: "会话状态、消费者或归属登记在扫描后变化，剩余材料保留" });
      break;
    }
    try {
      if (result.apply) {
        checkedMaterialPath(root, entry.link ? dirname(entry.path) : entry.path);
        const stat = lstatSync(entry.path);
        if (stat.dev !== entry.stat.dev || stat.ino !== entry.stat.ino || (!entry.directory && (stat.size !== entry.stat.size || stat.mtimeMs !== entry.stat.mtimeMs))) throw new Error("扫描后材料发生变化，未删除");
        if (entry.directory) rmdirSync(entry.path); else unlinkSync(entry.path);
      }
      result.paths.push(entry.path);
      if (!entry.directory) {
        result.files += 1;
        if (!entry.link) result.bytes += entry.stat.blocks === undefined ? entry.stat.size : entry.stat.blocks * 512;
      }
    } catch (error) { result.failures.push({ path: entry.path, reason: String(error) }); }
  }
}

export function materialCleanupLine(result: MaterialCleanup): string {
  return `运行材料瘦身：${result.apply ? "删除" : "预计删除"} ${result.files} 个文件，${result.apply ? "释放" : "可释放"}约 ${(result.bytes / 1024 / 1024).toFixed(2)} MiB；保留结果、输入、证据、检查点、日志、截图和 ≤256 KiB 小文件`;
}

export function materialCleanupNotes(result: MaterialCleanup): string[] {
  return [
    ...result.unknown.map(({ path, reason }) => `归属不明，保留：${path}（${reason}）`),
    ...result.failures.map(({ path, reason }) => `删除失败，仅提示：${path}（${reason}）`),
  ];
}

const quote = (text: string): string => `'${text.replace(/'/g, "'\\''")}'`;

export function managedShell(command: string, resource: RunResource): string {
  return `export AUTOREVIEW_RUN_ID=${quote(resource.id)} AUTOREVIEW_TEMP_DIR=${quote(resource.dir)} AUTOREVIEW_EVIDENCE_DIR=${quote(resource.evidenceDir)} TMPDIR=${quote(resource.evidenceDir)}\n${command}`;
}

export function resourceLine(resource: RunResource): string {
  return `${resource.label}：${resource.status}（${resource.dir}）${resource.evidenceDir ? `；保留证据：${resource.evidenceDir}` : ""}${resource.detail ? `；${resource.detail}` : ""}`;
}

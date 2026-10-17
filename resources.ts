/** 只管理 Loop 创建、具有身份记录的运行临时目录；证据与用户文件不在此处清理。 */
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statfsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
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

const rootPath = (): string => process.env.AUTOREVIEW_RESOURCE_ROOT
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
  const root = rootPath();
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

export function releaseRunResource(resource: RunResource, retain = false): RunResource {
  if (!validId(resource.id) || resolve(resource.root) !== resolve(rootPath())
    || resolve(resource.dir) !== resolve(resource.root, resource.id)) {
    return Object.assign(resource, { status: "cleanup-failed" as const, detail: "目录不属于当前受管资源根，未删除" });
  }
  let registered: RunResource;
  try { registered = JSON.parse(readFileSync(markerPath(resource), "utf8")); }
  catch { return Object.assign(resource, { status: "cleanup-failed" as const, detail: "缺少资源身份记录，未删除" }); }
  if (registered.id !== resource.id || registered.dir !== resource.dir || registered.ownerPid !== resource.ownerPid
    || registered.ownerStarted !== resource.ownerStarted) return Object.assign(resource, { status: "cleanup-failed" as const, detail: "资源身份不匹配，未删除" });
  if (!retain && resource.procsFile && [resource.procsFile, `${resource.procsFile}.cleanup`].some((file) => readProcs(file).length)) {
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
  const root = rootPath();
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
    // 宿主死亡不等于使用它的 detached 子进程已结束；先按登记回收，仍有消费者就保留。
    if (resource.procsFile) {
      const registries = [resource.procsFile, `${resource.procsFile}.cleanup`];
      for (const file of registries) reapProcs(file);
      if (registries.some((file) => readProcs(file).length)) continue;
    }
    results.push(releaseRunResource(resource));
  }
  return results;
}

const quote = (text: string): string => `'${text.replace(/'/g, "'\\''")}'`;

export function managedShell(command: string, resource: RunResource): string {
  return `export AUTOREVIEW_RUN_ID=${quote(resource.id)} AUTOREVIEW_TEMP_DIR=${quote(resource.dir)} AUTOREVIEW_EVIDENCE_DIR=${quote(resource.evidenceDir)} TMPDIR=${quote(resource.evidenceDir)}\n${command}`;
}

export function resourceLine(resource: RunResource): string {
  return `${resource.label}：${resource.status}（${resource.dir}）${resource.evidenceDir ? `；保留证据：${resource.evidenceDir}` : ""}${resource.detail ? `；${resource.detail}` : ""}`;
}

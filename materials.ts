/** 会话完成后的磁盘材料瘦身。身份来自 Loop 记录，不由目录名、时间或 PID 推断。 */
import { closeSync, lstatSync, openSync, readFileSync, readSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { writeJsonAtomic } from "./pipeline-core.ts";
import { projectRootOf } from "./ledger.ts";
import { REVIEW_SNAPSHOTS } from "./snapshots.ts";
import {
  checkedMaterialPath, materialCleanupLine, materialCleanupNotes, newMaterialCleanup, resourceRoot, slimMaterialDirectory,
  type MaterialCleanup, type RunResource,
} from "./resources.ts";

export interface MaterialSession {
  format: "loop-session-materials-v1";
  sessionId: string;
  workDir: string;
  phase: string;
  summary: string;
  procsFile: string;
  acceptanceDir: string;
  runDirs: string[];
}

export function materialSession(sessionId: string, workDir: string, summary: string, phase: string, runDirs: string[] = []): MaterialSession {
  const stem = basename(summary, ".md"), dir = dirname(summary);
  return { format: "loop-session-materials-v1", sessionId, workDir, phase, summary,
    procsFile: join(dir, `${stem}.procs.json`), acceptanceDir: join(dir, "acceptance", stem), runDirs };
}

const sessionFile = (session: MaterialSession): string => session.summary.replace(/\.md$/, ".materials.json");

/** 小型材料归属索引；阶段只是快照，历史清理的删除资格必须另查当前原生会话状态。 */
export function recordMaterialSession(session: MaterialSession): void {
  // 尚无材料时不为开发输入额外创建数据目录；首次材料落盘后的保存会补记。
  try {
    if (!materialExists(dirname(session.summary))) return;
    writeJsonAtomic(sessionFile(session), session);
  }
  catch (error) {
    // 不能让一次写入失败留下可用于删除的旧 done。失败仅提示，不影响业务状态。
    try { rmSync(sessionFile(session), { force: true }); } catch { /* 历史清理仍会核对原生状态/总结 */ }
    process.stderr.write(`运行材料登记失败，仅提示：${String(error)}\n`);
  }
}

export function registerAcceptanceMaterials(sessionId: string, workDir: string, runDir: string, procsFile?: string): void {
  writeJsonAtomic(join(runDir, ".loop-run.json"), { format: "loop-acceptance-materials-v1", sessionId, workDir, runDir, procsFile });
}

const json = (path: string): any => JSON.parse(readFileSync(path, "utf8"));
const unknown = (result: MaterialCleanup, path: string, reason: string): void => {
  if (!result.unknown.some((item) => item.path === path)) result.unknown.push({ path, reason });
};
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";
const phaseOf = (state: any): string => state.acceptRun?.result === "进行中" ? "accepting" : state.phase;
const resourceChecks = new WeakMap<RunResource, () => boolean>();
const materialExists = (path: string): boolean => {
  try { lstatSync(path); return true; }
  catch (error) { if (missing(error)) return false; throw error; }
};

/** 时间/节点号只用于发现检查后的变化，不用于认领归属。 */
function watchFile(root: string, path: string): () => boolean {
  checkedMaterialPath(root, path);
  const before = lstatSync(path);
  return () => {
    try {
      checkedMaterialPath(root, path);
      const after = lstatSync(path);
      return before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs;
    } catch { return false; }
  };
}

/** 不使用容错的 readProcs：登记损坏不等于没有消费者。这里只读，不杀进程、不改登记。 */
function consumersStopped(procsFile: string): boolean {
  return [procsFile, `${procsFile}.cleanup`].every((path) => {
    try {
      checkedMaterialPath(dirname(procsFile), path);
      const entries = json(path);
      return Array.isArray(entries) && entries.length === 0;
    } catch (error) { return missing(error); }
  });
}

function registeredResources(root: string, result: MaterialCleanup, procsFile?: string): RunResource[] {
  const resources: RunResource[] = [];
  try {
    checkedMaterialPath(root, root);
    for (const name of readdirSync(root).filter((name) => name.endsWith(".json")).sort()) {
      const file = join(root, name);
      let associated = !procsFile;
      try {
        const unchanged = watchFile(root, file);
        const item = json(file) as RunResource;
        associated ||= item.procsFile === procsFile;
        if (!associated) continue;
        if (typeof item.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(item.id) || name !== `${item.id}.json`
          || item.root !== resolve(root) || item.dir !== join(root, item.id) || item.evidenceDir !== join(root, "evidence", item.id)
          || typeof item.procsFile !== "string" || !item.ownerStarted || !Number.isInteger(item.ownerPid)) throw new Error("资源身份/路径不匹配或没有会话关联登记");
        resourceChecks.set(item, unchanged);
        resources.push(item);
      } catch (error) { if (associated) unknown(result, file, String(error)); }
    }
  } catch (error) { if (!missing(error)) unknown(result, root, String(error)); }
  return resources;
}

function acceptanceRegistration(session: MaterialSession, path: string): (() => boolean) | undefined {
  try {
    checkedMaterialPath(dirname(session.acceptanceDir), path);
    const marker = join(path, ".loop-run.json");
    if (materialExists(marker)) {
      const unchanged = watchFile(path, marker), item = json(marker);
      if (item.format === "loop-acceptance-materials-v1" && item.sessionId === session.sessionId && item.workDir === session.workDir
        && item.runDir === path && item.procsFile === session.procsFile) return unchanged;
      return;
    }
    // 旧轮次须同时在会话记录中被引用，并由实际 result.json 再次确认位置。
    if (!session.runDirs.includes(path)) return;
    const unchanged = watchFile(path, join(path, "result.json"));
    if (json(join(path, "result.json")).runDir === path) return unchanged;
  } catch { /* 不能核对就保留 */ }
}

function cleanSession(session: MaterialSession, resources: RunResource[], result: MaterialCleanup, unchanged: () => boolean = () => true): void {
  if (session.phase !== "done") return;
  if (!consumersStopped(session.procsFile)) {
    unknown(result, session.procsFile, "消费者释放未确认或进程登记损坏，本会话材料全部保留"); return;
  }
  for (const item of resources.filter((item) => item.procsFile === session.procsFile)) {
    for (const path of [item.dir, item.evidenceDir]) {
      try {
        if (!materialExists(path)) continue;
        if (!["released", "retained"].includes(item.status)) { unknown(result, path, `资源状态 ${item.status}，释放未确认`); continue; }
        const registered = resourceChecks.get(item);
        slimMaterialDirectory(item.root, path, result, () => unchanged() && registered?.() === true && consumersStopped(session.procsFile));
      } catch (error) { unknown(result, path, String(error)); }
    }
  }
  try {
    checkedMaterialPath(dirname(dirname(session.acceptanceDir)), session.acceptanceDir);
    for (const name of readdirSync(session.acceptanceDir).sort()) {
      const path = join(session.acceptanceDir, name);
      const registered = acceptanceRegistration(session, path);
      if (!registered) { unknown(result, path, "验收目录缺少登记，或登记与会话/实际路径不符"); continue; }
      slimMaterialDirectory(dirname(dirname(session.acceptanceDir)), path, result, () => unchanged() && registered() && consumersStopped(session.procsFile));
    }
  } catch (error) { if (!missing(error)) unknown(result, session.acceptanceDir, String(error)); }
}

/** 完成边界调用，失败只返回提示；不修改会话状态或资源登记。 */
export function slimCompletedSession(session: MaterialSession): string {
  const result = newMaterialCleanup(true);
  try {
    const statePath = session.summary.replace(/\.md$/, ".state.json");
    const identity = materialExists(statePath) ? statePath : sessionFile(session);
    const unchanged = materialExists(identity) ? watchFile(dirname(session.summary), identity) : () => true;
    if (materialExists(identity) && phaseOf(json(identity)) !== session.phase) throw new Error("持久状态与完成边界不符，材料保留");
    cleanSession(session, registeredResources(resourceRoot(), result, session.procsFile), result, unchanged);
  }
  catch (error) { result.failures.push({ path: session.summary, reason: String(error) }); }
  return [materialCleanupLine(result), ...materialCleanupNotes(result)].join("\n");
}

function headerOf(summary: string): { workDir: string; sessionId: string; done: boolean; runDirs: string[] } | undefined {
  const text = readFileSync(summary, "utf8");
  if (!text.startsWith("# 自动评审总结\n")) return;
  const header = text.split(/^## /m, 1)[0];
  const workDir = /^- 项目：(.+)$/m.exec(header)?.[1];
  const sessionId = /^- 开发会话：(.+?)　评审会话：/m.exec(header)?.[1];
  if (!workDir || !sessionId) return;
  return { workDir, sessionId, done: /^- 状态：完成$/m.test(header),
    runDirs: [...text.matchAll(/^验收：[^\n]*；材料：(.+)）$/gm)].map((match) => match[1]) };
}

/** 从尾部逐块读取最新持久状态；不把文件名当身份，不把读不到状态当完成。 */
function piState(path: string, session: MaterialSession): any {
  const fd = openSync(path, "r");
  try {
    const first = Buffer.alloc(64 * 1024), size = readSync(fd, first, 0, first.length, 0);
    const header = JSON.parse(first.subarray(0, size).toString("utf8").split("\n", 1)[0]);
    if (header.type !== "session" || header.id !== session.sessionId || header.cwd !== session.workDir) return;
    let end = lstatSync(path).size, pending = Buffer.alloc(0);
    while (end > 0) {
      const start = Math.max(0, end - 64 * 1024), chunk = Buffer.alloc(end - start);
      readSync(fd, chunk, 0, chunk.length, start);
      const content = Buffer.concat([chunk, pending]);
      const boundary = start === 0 ? 0 : content.indexOf(10) + 1;
      const lines = boundary === 0 && start > 0 ? [] : content.subarray(boundary).toString("utf8").split("\n");
      pending = start === 0 ? Buffer.alloc(0) : boundary === 0 ? content : content.subarray(0, boundary);
      for (const line of lines.reverse()) {
        if (!line.trim()) continue;
        // 不能跨过损坏/写到一半的新记录，回退认领更早的 done。
        const entry = JSON.parse(line);
        if (entry.type === "custom" && entry.customType === "autoreview-state") {
          if (!entry.data || typeof entry.data.phase !== "string") throw new Error("原生会话状态无效");
          return entry.data;
        }
      }
      if (pending.length > 16 * 1024 * 1024) throw new Error("单条会话状态过大，不能安全核对");
      end = start;
    }
  } finally { closeSync(fd); }
}

function piFiles(root: string): string[] {
  if (!materialExists(root)) return [];
  checkedMaterialPath(root, root);
  return readdirSync(root).flatMap((name) => {
    const dir = join(root, name);
    if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) return [];
    return readdirSync(dir).filter((name) => name.endsWith(".jsonl")).map((name) => join(dir, name));
  });
}

const runsOf = (state: any): string[] => Array.isArray(state?.rounds)
  ? state.rounds.map((round: any) => round?.acceptance?.runDir).filter((path: unknown): path is string => typeof path === "string") : [];

/** 漏网登记只读核对：按总结中的项目/会话身份定位，再读权威原生状态，不沿用材料索引的旧 done。 */
export function readRecordedSession(project: string, sessionId: string, options: { dataRoot?: string; piSessionsRoot?: string } = {}): { session: MaterialSession; state: any } {
  if (!sessionId || /[/\\\0]/.test(sessionId)) throw new Error("会话 ID 无效");
  const root = resolve(options.dataRoot ?? join(homedir(), ".pi-autoreview")), matches: MaterialSession[] = [];
  const target = projectRootOf(project);
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) continue;
    const summary = join(dir, `${sessionId}.md`);
    if (!materialExists(summary)) continue;
    checkedMaterialPath(root, summary);
    const header = headerOf(summary);
    if (!header || header.sessionId !== sessionId || projectRootOf(header.workDir) !== target) continue;
    if (!header.done) throw new Error("该会话总结不是完成态，不能登记漏网");
    matches.push(materialSession(sessionId, header.workDir, summary, "done", header.runDirs));
  }
  if (matches.length !== 1) throw new Error("找不到唯一匹配项目、会话的完成记录");
  const session = matches[0], statePath = session.summary.replace(/\.md$/, ".state.json");
  let state: any;
  if (materialExists(statePath)) { checkedMaterialPath(root, statePath); state = json(statePath); }
  else {
    const nativeRoot = options.piSessionsRoot ?? join(homedir(), ".pi", "agent", "sessions");
    const states = piFiles(nativeRoot).filter((path) => basename(path).endsWith(`_${sessionId}.jsonl`)).flatMap((path) => {
      checkedMaterialPath(nativeRoot, path);
      const state = piState(path, session); return state ? [state] : [];
    });
    if (states.length !== 1) throw new Error("缺少唯一匹配的原生会话状态");
    state = states[0];
  }
  if (phaseOf(state) !== "done" || !Array.isArray(state.rounds)) throw new Error("该会话当前尚未完成，不能登记漏网");
  return { session, state };
}

export interface HistoryCleanup extends MaterialCleanup {
  sessions: { sessionId: string; summary: string; phase: string }[];
  /** 明确保留，绝不送入按大小/依赖目录瘦身的扫描。 */
  retained: { path: string; kind: "评审快照" }[];
}

export function cleanupMaterialHistory(options: { apply?: boolean; dataRoot?: string; resourcesRoot?: string; piSessionsRoot?: string } = {}): HistoryCleanup {
  const result: HistoryCleanup = { ...newMaterialCleanup(options.apply === true), sessions: [], retained: [] };
  const root = resolve(options.dataRoot ?? join(homedir(), ".pi-autoreview"));
  const resourcesRoot = resolve(options.resourcesRoot ?? resourceRoot());
  const resources = registeredResources(resourcesRoot, result), sessions: { session: MaterialSession; unchanged: () => boolean }[] = [];
  let nativeFiles: string[] | undefined;
  const nativeRoot = options.piSessionsRoot ?? join(homedir(), ".pi", "agent", "sessions");
  const acceptanceRoots: string[] = [];
  try {
    checkedMaterialPath(root, root);
    for (const name of readdirSync(root).sort()) {
      const dir = join(root, name);
      if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory() || dir === resourcesRoot) continue;
      const snapshots = join(dir, REVIEW_SNAPSHOTS);
      if (materialExists(snapshots)) result.retained.push({ path: snapshots, kind: "评审快照" });
      const acceptance = join(dir, "acceptance");
      if (materialExists(acceptance)) acceptanceRoots.push(acceptance);
      for (const file of readdirSync(dir).filter((name) => name.endsWith(".md")).sort()) {
        const summary = join(dir, file);
        try {
          const checks = [watchFile(root, summary)];
          const header = headerOf(summary);
          if (!header) continue;
          const session = materialSession(header.sessionId, header.workDir, summary, header.done ? "done" : "paused", header.runDirs);
          const marker = sessionFile(session), statePath = summary.replace(/\.md$/, ".state.json");
          let materialPhase: string | undefined;
          if (materialExists(marker)) {
            checks.push(watchFile(root, marker));
            const item = json(marker);
            if (item.format !== session.format || item.sessionId !== session.sessionId || item.workDir !== session.workDir
              || item.summary !== summary || item.procsFile !== session.procsFile || item.acceptanceDir !== session.acceptanceDir
              || !["idle", "reviewing", "accepting", "done", "paused"].includes(item.phase) || !Array.isArray(item.runDirs) || !item.runDirs.every((path: unknown) => typeof path === "string")) throw new Error("会话材料登记不匹配");
            materialPhase = item.phase;
          }
          // 材料登记与原生状态不是原子写入；即使登记和总结都是 done，也不能跳过权威状态核对。
          if (materialExists(statePath)) {
            checks.push(watchFile(root, statePath));
            const state = json(statePath);
            if (typeof state.phase !== "string") throw new Error("会话状态无效");
            session.phase = phaseOf(state); session.runDirs = runsOf(state);
          } else {
            nativeFiles ??= piFiles(nativeRoot);
            const states = nativeFiles.filter((path) => basename(path).endsWith(`_${session.sessionId}.jsonl`)).flatMap((path) => {
              const check = watchFile(nativeRoot, path);
              const state = piState(path, session);
              if (state) checks.push(check);
              return state ? [state] : [];
            });
            if (states.length !== 1) throw new Error("缺少唯一匹配的原生会话状态，不能仅凭完成总结删除");
            session.phase = phaseOf(states[0]); session.runDirs = runsOf(states[0]);
          }
          if (materialPhase !== undefined && materialPhase !== session.phase) throw new Error(`材料登记与原生会话状态不一致（登记 ${materialPhase}，原生 ${session.phase}），材料保留`);
          if (header.done !== (session.phase === "done")) throw new Error(`总结与原生会话状态不一致（原生 ${session.phase}），材料保留`);
          // checks 始终包含实际采用的原生状态文件；逐项删除前复核，不能只监视材料索引。
          sessions.push({ session, unchanged: () => checks.every((check) => check()) });
        } catch (error) { unknown(result, summary, String(error)); }
      }
    }
  } catch (error) { if (!missing(error)) unknown(result, root, String(error)); }
  for (const { session, unchanged } of sessions) {
    result.sessions.push({ sessionId: session.sessionId, summary: session.summary, phase: session.phase });
    cleanSession(session, resources, result, unchanged);
  }
  // 列出没有可核对会话的登记和未登记目录；不进入这些目录猜测内容。
  for (const item of resources) if (!sessions.some(({ session }) => session.procsFile === item.procsFile)) {
    for (const path of [item.dir, item.evidenceDir]) {
      try { if (materialExists(path)) unknown(result, path, "资源登记没有匹配且可核对的会话"); }
      catch (error) { unknown(result, path, String(error)); }
    }
  }
  const listUnknown = (bound: string, base: string, known: Set<string>): void => {
    try {
      checkedMaterialPath(bound, base);
      for (const name of readdirSync(base).sort()) {
        const path = join(base, name);
        if (!known.has(path)) unknown(result, path, "没有匹配的 Loop 归属登记");
      }
    } catch (error) { if (!missing(error)) unknown(result, base, String(error)); }
  };
  listUnknown(resourcesRoot, join(resourcesRoot, "evidence"), new Set(resources.map((item) => item.evidenceDir)));
  // 缓存根里没有登记的目录也只列出，不按 UUID 外观认领。
  try {
    checkedMaterialPath(resourcesRoot, resourcesRoot);
    for (const name of readdirSync(resourcesRoot)) {
      const path = join(resourcesRoot, name);
      if (name !== "evidence" && !name.endsWith(".json") && !resources.some((item) => item.dir === path)) unknown(result, path, "没有匹配的资源登记");
    }
  } catch (error) { if (!missing(error)) unknown(result, resourcesRoot, String(error)); }
  for (const base of acceptanceRoots) listUnknown(root, base, new Set(sessions.map(({ session }) => session.acceptanceDir)));
  return result;
}

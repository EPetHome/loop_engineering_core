/** 项目经验：项目文件只读；候选、复发计数和活动会话只存在本机。唯一项目写入口是 approveExperience。 */
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { findProjectRoot } from "./config.ts";
import { projectDataDir, projectRootHash } from "./project-context.ts";

export interface ExperienceEntry {
  id: string;
  title: string;
  phenomenon: string;
  cause: string;
  practice: string;
  count: number;
  metadata: string[];
}
export interface ExperienceCandidate extends ExperienceEntry {
  status: "pending" | "approved" | "rejected";
  sessions: string[];
  evidence: string[];
  approvedId?: string;
}
interface ExperienceStore {
  version: 1;
  candidates: ExperienceCandidate[];
  occurrences: Record<string, { count: number; sessions: string[] }>;
  drafted: Record<string, string>;
}
const emptyStore = (): ExperienceStore => ({ version: 1, candidates: [], occurrences: {}, drafted: {} });
export const experienceFile = (root: string): string => join(root, ".autoreview", "经验.md");
export const experienceDataFile = (root: string): string => join(projectDataDir(root), "experience.json");

/** 兼容首批草稿里次数在正文之前的顺序；写回时统一为标题、三行正文、元数据。 */
export function parseExperience(text: string): ExperienceEntry[] {
  const entries: ExperienceEntry[] = [];
  const headings = [...text.matchAll(/^#{1,6}\s+(P\d+)\s+([^\r\n]+)\s*$/gm)];
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    const body = text.slice(heading.index! + heading[0].length, headings[index + 1]?.index ?? text.length);
    const field = (name: string): string => {
      const matches = [...body.matchAll(new RegExp(`^${name}[：:]\\s*(.+)$`, "gm"))];
      if (matches.length !== 1 || !matches[0][1].trim()) throw new Error(`${heading[1]} 必须有且只有一行「${name}」`);
      return matches[0][1].trim();
    };
    if (entries.some((item) => item.id === heading[1])) throw new Error(`经验编号重复：${heading[1]}`);
    const metadata = body.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !/^(现象|根因|正确做法)[：:]/.test(line));
    const count = Number(/^(?:出现)?次数[：:]\s*(\d+)/m.exec(metadata.join("\n"))?.[1] ?? 0);
    entries.push({ id: heading[1], title: heading[2].trim(), phenomenon: field("现象"), cause: field("根因"), practice: field("正确做法"), count, metadata });
  }
  return entries;
}
export function readExperience(root: string): ExperienceEntry[] {
  try { return parseExperience(readFileSync(experienceFile(root), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
export function compactExperience(entry: ExperienceEntry): string {
  return `### ${entry.id} ${entry.title}\n现象：${entry.phenomenon}\n根因：${entry.cause}\n正确做法：${entry.practice}`;
}
export function experienceInjection(cwd: string, reviewer = false): string {
  const root = findProjectRoot(cwd);
  const entries = root ? readExperience(root) : [];
  if (!entries.length) return "";
  return [reviewer
    ? "逐条对照以下项目经验。发现的问题属于某条经验时，在该条问题中标出「经验 Pxx」；没有命中不要牵强标注。清单只能由用户批准写入，不得修改。"
    : "【项目经验对照清单】\n动手前逐条对照以下经验，避免复发。清单只能由用户批准写入，开发方不得修改或自行追加。",
  ...entries.map(compactExperience)].join("\n\n");
}

export function readExperienceStore(root: string): ExperienceStore {
  let data: ExperienceStore;
  try { data = JSON.parse(readFileSync(experienceDataFile(root), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyStore(); throw error; }
  if (!data || data.version !== 1 || !Array.isArray(data.candidates) || !data.occurrences || !data.drafted) throw new Error("本机经验库格式无效，未覆盖原数据");
  return data;
}
function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temp, content, { flag: "wx" }); renameSync(temp, path); }
  finally { rmSync(temp, { force: true }); }
}
/** 同一项目所有写入口共用短锁；只确认死亡所有者才回收，未知归属不删除。 */
function withExperienceLock<T>(root: string, action: () => T): T {
  const lock = `${experienceDataFile(root)}.lock`, recovery = `${lock}.recovery`;
  mkdirSync(dirname(lock), { recursive: true });
  const readOwner = (): { pid: number; token: string } | undefined => {
    try { return JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")); } catch { return undefined; }
  };
  const dead = (pid: number): boolean => {
    if (!Number.isInteger(pid) || pid < 2) return false;
    try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  };
  const deadline = Date.now() + 2000;
  for (;;) {
    try { mkdirSync(lock); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const previous = readOwner();
      if (previous && dead(previous.pid)) {
        let elected = false;
        try {
          mkdirSync(recovery); elected = true;
          const current = readOwner();
          if (current?.token === previous.token && dead(current.pid)) rmSync(lock, { recursive: true });
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        finally { if (elected) rmSync(recovery, { recursive: true, force: true }); }
      }
      if (Date.now() >= deadline) throw new Error("本机经验库正忙或锁归属未确认，请稍后再试");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try { writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, token: randomUUID() })); return action(); }
  finally { rmSync(lock, { recursive: true, force: true }); }
}
export function updateExperienceStore<T>(root: string, action: (store: ExperienceStore) => T): T {
  return withExperienceLock(root, () => {
    const store = readExperienceStore(root);
    const result = action(store);
    atomicWrite(experienceDataFile(root), `${JSON.stringify(store, null, 2)}\n`);
    return result;
  });
}
/** Hook 原生输入状态中的活动事实；与授权同次落盘，不依赖经验登记锁。 */
export interface HookExperienceActivity {
  root: string; host: string; session: string; turn: string; active: boolean; runId?: string;
  /** 记录创建时捕获的规范项目根哈希；扫描不再要求历史目录或别名存在。 */
  projectId?: string;
}
export const hookExperienceDir = (root: string): string =>
  join(homedir(), ".pi-autoreview", basename(root).replace(/[^A-Za-z0-9._-]/g, "_") || "project");
export function hookExperienceStates(root: string): { file: string; activity: HookExperienceActivity }[] {
  const dir = hookExperienceDir(root), canonicalRoot = realpathSync(root), projectId = projectRootHash(canonicalRoot);
  let names: string[];
  try { names = readdirSync(dir); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const states: { file: string; activity: HookExperienceActivity }[] = [];
  for (const name of names.filter((name) => name.endsWith(".state.json"))) {
    const file = join(dir, name);
    if (!lstatSync(file).isFile()) throw new Error(`开发会话状态无法核对：${file}`);
    const activity = JSON.parse(readFileSync(file, "utf8")).experienceActivity as HookExperienceActivity | undefined;
    if (activity === undefined) continue; // 旧状态仍由已有的活动登记阻挡，不按目录名猜项目归属。
    if (!activity) throw new Error(`开发会话活动状态无法核对：${file}`);
    if (activity.projectId !== undefined) {
      if (typeof activity.projectId !== "string" || !/^[a-f0-9]{16}$/.test(activity.projectId)) throw new Error(`开发会话项目身份无法核对：${file}`);
      if (activity.projectId !== projectId) continue;
    } else {
      // 兼容已落盘的旧版记录：不改写历史。不同路径且明确已结束的记录无需再访问其项目目录。
      if (typeof activity.root !== "string" || !isAbsolute(activity.root)) throw new Error(`开发会话项目身份无法核对：${file}`);
      const path = resolve(activity.root);
      if (path !== resolve(root) && path !== canonicalRoot) {
        if (activity.active === false) continue;
        // 旧版未结束记录仍可能经别名指向目标；只有能确认属于别的项目时才忽略。
        try { if (projectRootHash(activity.root) !== projectId) continue; }
        catch { throw new Error(`旧开发会话项目身份无法核对：${file}`); }
      }
    }
    if (typeof activity.root !== "string" || typeof activity.active !== "boolean" || typeof activity.host !== "string"
      || typeof activity.session !== "string" || typeof activity.turn !== "string") throw new Error(`开发会话活动状态无法核对：${file}`);
    states.push({ file, activity });
  }
  return states;
}
const sessionsFile = (root: string): string => join(dirname(experienceDataFile(root)), "experience-sessions.json");
function readSessions(root: string): Record<string, boolean> {
  try {
    const data = JSON.parse(readFileSync(sessionsFile(root), "utf8"));
    if (!data || Array.isArray(data) || typeof data !== "object" || Object.values(data).some((value) => value !== true)) throw new Error("开发会话登记无法核对，未批准写入");
    return data;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
}
/** 活动登记与候选数据分开：候选损坏/起草落盘失败不能阻断完成；批准仍使用同一把锁。 */
export function experienceSession(cwd: string, session: string, active: boolean): void {
  const root = findProjectRoot(cwd);
  if (!root) return;
  withExperienceLock(root, () => {
    const sessions = readSessions(root);
    if (active) sessions[session] = true;
    else {
      delete sessions[session];
      // 精确续接同一 Pi 会话并收尾后，移除已确认死亡的旧实例登记；活实例和未知归属保留。
      const identity = /^(pi:[^:]+):\d+:[^:]+$/.exec(session)?.[1];
      if (identity) for (const key of Object.keys(sessions)) {
        const owner = /^(pi:[^:]+):(\d+):[^:]+$/.exec(key);
        if (owner?.[1] !== identity) continue;
        try { process.kill(Number(owner[2]), 0); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") delete sessions[key]; }
      }
    }
    atomicWrite(sessionsFile(root), `${JSON.stringify(sessions, null, 2)}\n`);
  });
}

/** 次数沿用历史的“不同开发会话”口径；同一会话反复复查和完成起草不会重复加一。 */
export function markExperienceRecurrence(root: string, session: string, raw: string): string {
  const entries = readExperience(root);
  const ids = [...new Set([...raw.matchAll(/\bP\d+\b/g)].map((match) => match[0]))].filter((id) => entries.some((entry) => entry.id === id));
  if (!ids.length) return raw;
  const counts = updateExperienceStore(root, (store) => Object.fromEntries(ids.map((id) => {
    const entry = entries.find((item) => item.id === id)!;
    const occurrence = store.occurrences[id] ??= { count: entry.count, sessions: [] };
    occurrence.count = Math.max(entry.count, occurrence.count);
    if (!occurrence.sessions.includes(session)) { occurrence.sessions.push(session); occurrence.count += 1; }
    return [id, occurrence.count];
  })));
  return raw.split(/(?=^[ \t]*\d+\.\s)/m).map((item) => {
    if (!/^[ \t]*\d+\.\s/.test(item)) return item;
    const hits = ids.filter((id) => new RegExp(`\\b${id}\\b`).test(item));
    return hits.length ? `${item.trimEnd()}\n   （${hits.map((id) => `经验 ${id}，第 ${counts[id]} 次出现`).join("；")}）\n` : item;
  }).join("");
}
const normalized = (value: string): string => value.normalize("NFKC").replace(/[\p{P}\p{Z}\s]/gu, "").toLowerCase();
export const sameExperience = (a: ExperienceEntry, b: ExperienceEntry): boolean =>
  normalized(a.title) === normalized(b.title) && normalized(a.cause) === normalized(b.cause);
export const candidateCount = (item: ExperienceCandidate): number => item.count + item.sessions.length;
export function addExperienceCandidate(store: ExperienceStore, entry: ExperienceEntry, session?: string, evidence?: string): ExperienceCandidate {
  let candidate = store.candidates.find((item) => sameExperience(item, entry));
  if (!candidate) {
    const next = Math.max(0, ...store.candidates.map((item) => Number(item.id.slice(1)))) + 1;
    candidate = { ...entry, id: `C${String(next).padStart(2, "0")}`, status: "pending", sessions: [], evidence: [] };
    store.candidates.push(candidate);
  }
  candidate.count = Math.max(candidate.count, entry.count);
  if (session && !candidate.sessions.includes(session)) candidate.sessions.push(session);
  if (evidence && !candidate.evidence.includes(evidence)) candidate.evidence.push(evidence);
  return candidate;
}
export function importExperience(root: string, source: string, dryRun = false): ExperienceCandidate[] {
  const entries = parseExperience(readFileSync(source, "utf8"));
  if (!entries.length) throw new Error("候选文件没有符合格式的 Pxx 条目");
  const apply = (store: ExperienceStore): ExperienceCandidate[] => entries.map((entry) => addExperienceCandidate(store, entry, undefined, `导入：${source}；原编号 ${entry.id}`));
  return dryRun ? apply(readExperienceStore(root)) : updateExperienceStore(root, apply);
}
function selectedCandidates(store: ExperienceStore, selection: string): ExperienceCandidate[] {
  const items = selection === "全部" ? store.candidates.filter((item) => item.status === "pending") : store.candidates.filter((item) => item.id === selection);
  if (!items.length) throw new Error(`没有待批候选：${selection}`);
  if (items.some((item) => item.status !== "pending")) throw new Error(`候选已处理：${selection}`);
  return items;
}
export function rejectExperience(root: string, selection: string, dryRun = false): ExperienceCandidate[] {
  const apply = (store: ExperienceStore): ExperienceCandidate[] => {
    const items = selectedCandidates(store, selection); for (const item of items) item.status = "rejected"; return items;
  };
  return dryRun ? apply(readExperienceStore(root)) : updateExperienceStore(root, apply);
}
function safeProjectTarget(root: string): void {
  for (const path of [join(root, ".autoreview"), experienceFile(root)]) {
    try { if (lstatSync(path).isSymbolicLink()) throw new Error(`经验批准不跟随符号链接：${path}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
export function approveExperience(root: string, selection: string, dryRun = false): ExperienceCandidate[] {
  const apply = (store: ExperienceStore): ExperienceCandidate[] => {
    if (Object.values(readSessions(root)).some(Boolean) || hookExperienceStates(root).some(({ activity }) => activity.active)) {
      throw new Error("该项目还有进行中的开发会话，未写入经验.md；请会话完成后稍后再批");
    }
    safeProjectTarget(root);
    const file = experienceFile(root), original = existsSync(file) ? readFileSync(file, "utf8") : "";
    const approved = parseExperience(original), items = selectedCandidates(store, selection);
    let next = Math.max(0, ...approved.map((item) => Number(item.id.slice(1))));
    const additions: string[] = [];
    for (const item of items) {
      // 文件写成而本机状态未写成时可安全重入，不重复追加。
      let entry = approved.find((entry) => sameExperience(entry, item));
      if (!entry) {
        entry = { ...item, id: `P${String(++next).padStart(2, "0")}`, count: candidateCount(item) };
        const metadata = item.metadata.filter((line) => !/^(?:出现)?次数[：:]/.test(line));
        additions.push(compactExperience(entry).replace(/^### /, "## "), `出现次数：${entry.count} 个不同开发会话。`,
          ...metadata, ...item.evidence.map((line) => `证据：${line}`), `候选：${item.id}`, "");
        approved.push(entry);
      }
      item.status = "approved"; item.approvedId = entry.id;
    }
    if (!dryRun && additions.length) {
      const content = `${original || "# 项目经验\n"}${original.endsWith("\n") ? "\n" : "\n\n"}${additions.join("\n")}`;
      safeProjectTarget(root);
      if ((existsSync(file) ? readFileSync(file, "utf8") : "") !== original) throw new Error("经验.md 已变化，未覆盖；请重新批准");
      atomicWrite(file, content);
    }
    return items;
  };
  return dryRun ? apply(readExperienceStore(root)) : updateExperienceStore(root, apply);
}
export function experienceTodos(cwd: string, error?: string): string[] {
  const root = findProjectRoot(cwd);
  if (!root) return [];
  const todos: string[] = [];
  if (error) todos.push(`经验候选起草失败：${error}（不影响会话完成）。`);
  try {
    if (readExperience(root).length > 30) todos.push(`项目经验超过 30 条，请合并或退役；本次仍全部注入：${experienceFile(root)}`);
    const pending = readExperienceStore(root).candidates.filter((item) => item.status === "pending" && candidateCount(item) >= 2);
    for (const item of pending) todos.push(`待批准经验 ${item.id}：${item.title}（${candidateCount(item)} 个不同开发会话）。执行 bin/loop 经验 列出 ${JSON.stringify(root)} 查看并批准或拒绝。`);
  } catch (error) { todos.push(`本机经验候选无法读取：${(error as Error).message}（不影响会话完成）。`); }
  return todos;
}

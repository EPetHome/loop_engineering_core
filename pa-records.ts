/** PA 留底与授权合并；查询只读这些记录，不触发投递或恢复。 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { extractCriteria, grantsFromUser, isPARelayEnvelope, typedByUser, type Criteria, type Grants } from "./acceptance-core.ts";
import { eventLock } from "./events.ts";
import { statusPath } from "./pipeline-core.ts";

export interface RelaySource { id: string; at: string; input: number; grant?: string }
export interface PAInputState { userInputVia?: "user" | "pa"; userInputCount?: number; paRelays?: RelaySource[] }
export type WordState = "sending" | "delivered" | "unknown" | "read" | "failed";
export interface WordRecord {
  v: 1; id: string; text: string; sha256: string; state: WordState; via: "pa"; at: string; readAt?: string; reason?: string;
  session?: { host: string; id: string; pid?: number; processStarted?: string };
}
export interface PAGrant { id: string; text: string; at: string; via: "pa"; criteriaHash?: string; criteriaEpoch?: string }
interface GrantScope { criteriaHash: string; criteriaEpoch: string }
interface GrantBinding extends GrantScope { id: string; sha256: string; approved: string[]; denied: string[] }
interface GrantBindings extends GrantScope { v: 1; bindings: GrantBinding[] }
export function checkPAId(id: string): void {
  if (!/^[\p{L}\p{N}_.:@-]{1,160}$/u.test(id) || id === "." || id === "..") throw new Error("PA 编号须为 1–160 位字母、数字或 _ . : @ -");
}
export const wordsDir = (dir: string, stage: string): string => statusPath(dir, stage).replace(/\.status\.json$/, ".words");
export function wordPath(dir: string, stage: string, id: string): string { checkPAId(id); return join(wordsDir(dir, stage), `${id}.json`); }
export const grantsPath = (dir: string): string => join(dir, "grants.pa.jsonl");
export const textHash = (text: string): string => createHash("sha256").update(text).digest("hex");
export const relayMessage = (id: string, text: string): string => `【用户原话 · 经 PA 转达 · ${id}】\n${text}`;
export const hasRelayHeader = isPARelayEnvelope;
export function parseRelay(text: string): { id: string; text: string } | undefined {
  const match = /^【用户原话 · 经 PA 转达 · ([^\n】]+)】\r?\n/.exec(text);
  if (!match) return;
  try { checkPAId(match[1]); } catch { return; }
  return { id: match[1], text: text.slice(match[0].length) };
}
/** 不把损坏或读失败的幂等记录当作不存在，否则可能重复投递。 */
export function readPAJson<T>(path: string): T | undefined {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
}
export function writePAJson(path: string, record: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temp, `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 }); renameSync(temp, path); }
  finally { rmSync(temp, { force: true }); }
}
export function wordRecords(dir: string, stage: string): WordRecord[] {
  let names: string[];
  try { names = readdirSync(wordsDir(dir, stage)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  return names.filter((name) => name.endsWith(".json")).flatMap((name) => {
    const record = readPAJson<WordRecord>(join(wordsDir(dir, stage), name));
    return record?.id && typeof record.text === "string" ? [record] : [];
  }).sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}
/** 全部编号（包括直接写文件的行）都供 PA 对账；坏行不能被静默略过后继续使用授权。 */
export function readPAGrants(dir: string): PAGrant[] {
  let text: string;
  try { text = readFileSync(grantsPath(dir), "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  return text.split(/\r?\n/).filter((line) => line.trim()).map((line) => {
    let row: PAGrant;
    try { row = JSON.parse(line); } catch (error) { throw new Error(`PA 授权记录不是合法 JSON：${String(error)}`); }
    if (!row || typeof row.id !== "string" || typeof row.text !== "string" || typeof row.at !== "string" || row.via !== "pa") throw new Error("PA 授权记录格式无效");
    checkPAId(row.id); return row as PAGrant;
  });
}
/** 标准全文条目（含段归属）与版本绑定；授权行、时间戳不属于标准，不参与指纹。 */
export function paCriteriaHash(criteria: Criteria, requirement = ""): string {
  const items = extractCriteria(requirement) ?? criteria.items;
  return textHash(JSON.stringify([criteria.version, items.map(({ id, text }) => [id, text])]));
}
const grantRecordHash = (row: PAGrant): string => textHash(JSON.stringify([row.id, row.text, row.at, row.criteriaHash ?? null, row.criteriaEpoch ?? null]));
function withGrantBindings<T>(dir: string, criteria: Criteria, requirement: string, action: (state: GrantBindings, previous: GrantScope) => T): T {
  const release = eventLock(join(dir, ".pa-grants.lock"));
  try {
    const path = join(dir, "grants.pa.bindings.json"), criteriaHash = paCriteriaHash(criteria, requirement);
    const loaded = readPAJson<GrantBindings>(path);
    const state: GrantBindings = loaded ?? { v: 1, criteriaHash, criteriaEpoch: randomUUID(), bindings: [] };
    if (state.v !== 1 || typeof state.criteriaHash !== "string" || typeof state.criteriaEpoch !== "string" || !Array.isArray(state.bindings)) throw new Error("PA 授权绑定记录损坏，未重新授权");
    const before = JSON.stringify(state), previous = { criteriaHash: state.criteriaHash, criteriaEpoch: state.criteriaEpoch };
    // 即使标准随后改回原文，也不能复活已经失效的授权代次。
    if (state.criteriaHash !== criteriaHash) {
      for (const row of readPAGrants(dir)) if (!state.bindings.some((item) => item.id === row.id)) {
        state.bindings.push({ id: row.id, sha256: grantRecordHash(row), criteriaHash: row.criteriaHash ?? previous.criteriaHash,
          criteriaEpoch: row.criteriaEpoch ?? previous.criteriaEpoch, approved: [], denied: [] });
      }
      state.criteriaHash = criteriaHash; state.criteriaEpoch = randomUUID();
    }
    const result = action(state, previous);
    if (!loaded || before !== JSON.stringify(state)) writePAJson(path, state);
    return result;
  } finally { release(); }
}
/** 续跑答复在写入原文前就绑定当时确认的标准，不能等到下次解析时猜版本。 */
export function bindPAGrant(dir: string, row: PAGrant, criteria: Criteria, requirement: string): PAGrant {
  return withGrantBindings(dir, criteria, requirement, (state) => ({ ...row, criteriaHash: state.criteriaHash, criteriaEpoch: state.criteriaEpoch }));
}
export function mergePAGrants(dir: string, text: string, criteria: Criteria): { grants?: Grants; used: string[] } {
  return withGrantBindings(dir, criteria, text, (state, previous) => {
    let grants = grantsFromUser(text, criteria);
    const used: string[] = [];
    for (const row of readPAGrants(dir)) {
      const sha256 = grantRecordHash(row);
      let binding = state.bindings.find((item) => item.id === row.id);
      if (!binding) {
        // A9 的直接写入首读即冻结；标准刚变化时，未绑定的旧行不能被解释为新标准答复。
        const scope = row.criteriaHash !== undefined || row.criteriaEpoch !== undefined
          ? { criteriaHash: row.criteriaHash ?? "", criteriaEpoch: row.criteriaEpoch ?? "" } : previous;
        const current = scope.criteriaHash === state.criteriaHash && scope.criteriaEpoch === state.criteriaEpoch;
        const parsed = current ? grantsFromUser(typedByUser(row.text), criteria) : undefined;
        binding = { id: row.id, sha256, ...scope, approved: parsed?.approved ?? [], denied: parsed?.denied ?? [] };
        state.bindings.push(binding);
      }
      if (binding.sha256 !== sha256 || binding.criteriaHash !== state.criteriaHash || binding.criteriaEpoch !== state.criteriaEpoch
        || !(binding.approved.length || binding.denied.length)) continue;
      // 只合并已冻结的具体编号，不再把历史「全部」交给当前标准重新解释。
      const approved = new Set(grants?.approved ?? []), denied = new Set(grants?.denied ?? []);
      for (const id of binding.approved) { approved.add(id); denied.delete(id); }
      for (const id of binding.denied) { denied.add(id); approved.delete(id); }
      grants = { version: criteria.version, approved: [...approved], denied: [...denied] };
      if (!used.includes(row.id)) used.push(row.id);
    }
    return { grants, used };
  });
}
export function rememberPAInput(state: PAInputState, source?: { id: string; at: string }, grant?: string): void {
  state.userInputCount = (state.userInputCount ?? 0) + 1;
  state.userInputVia = source ? "pa" : "user";
  if (source) (state.paRelays ??= []).push({ ...source, input: state.userInputCount, ...(grant ? { grant } : {}) });
}
export function relaySourceLines(relays: RelaySource[] = []): string[] {
  return relays.flatMap((row) => [`- 第 ${row.input} 条用户输入经 PA 转达，编号 ${row.id}（${row.at}）`,
    ...(row.grant ? [`- 授权答复经 PA 转达，编号 ${row.id}：${JSON.stringify(row.grant)}`] : [])]);
}

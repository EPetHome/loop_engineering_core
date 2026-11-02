/** PA 事件及当前阶段。追加失败绝不阻断业务；查询只读这里的记录，不消费历史事件。 */
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, closeSync, constants, existsSync, linkSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { findProjectRoot, readPAConfig } from "./config.ts";
import { processStartTime } from "./procs.ts";
import { queueAcceptance, readJson, writeJsonAtomic } from "./pipeline-core.ts";
import type { FailureKind } from "./failure.ts";
import type { AcceptanceRecord } from "./acceptance-core.ts";
import type { RoundRecord, AcceptRunRecord } from "./core.ts";
import type { QueueAcceptance } from "./pipeline-core.ts";

export const REASON_CATEGORIES = ["需要你决定", "返修到上限", "环境", "方法", "超时", "返修后没改动", "输入变化", "授权待答复", "内部错误", "已停止", "其他"] as const;
export type ReasonCategory = typeof REASON_CATEGORIES[number];
export interface EventReason { category: ReasonCategory; text: string }
export type EventStatus = "started" | "needs-decision" | "paused" | "repair-limit" | "done" | "failed" | "resumed" | "queue";
export type NextAction = "send" | "resume" | "grant" | "manual";
export type Evidence = Record<string, string>;
export interface BatchIdentity { file: string; name: string; recipe: string }
export interface BatchInfo {
  project: string; batch: BatchIdentity; dir: string;
  stages: { stage: string; cwd: string; branch?: string; prompt?: string }[];
}
export interface LoopEvent {
  v: 1; seq: number; id: string; at: string; project: string; batch: BatchIdentity; stage: string | null;
  status: EventStatus; reason: EventReason; evidence: Evidence; detail: Record<string, unknown>;
}
export interface PhaseRecord {
  /** 状态及会话的批次归属；不能只用默认目录名认领。 */
  batchFile?: string;
  phase: "running" | "reviewing" | "paused" | "done" | "failed";
  status: EventStatus | "running"; category: ReasonCategory; text: string; since: string; updatedAt: string;
  round: number; repairs: number; next?: NextAction; evidence: Evidence; detail: Record<string, unknown>;
  session?: { host: string; id: string; pid?: number; processStarted?: string; runId?: string; log?: string };
}

/** 映射只针对 Loop 原因短句；命令已经给出的 FailureKind 优先，绝不分析日志猜分类。 */
const reasonRules: [RegExp, ReasonCategory][] = [
  [/^已停止(?:$|[：；])/, "已停止"],
  [/开发方需要你决定|对验收标准有异议/, "需要你决定"],
  [/达到返修上限|已到 .*轮上限/, "返修到上限"],
  [/等你授权|要你授权|\[授权\].*(?:未答复|还没答复|没通过)/, "授权待答复"],
  [/返修后没有任何改动|收到整批验收返修后没改代码/, "返修后没改动"],
  [/上游来源|来源配置|准备阻塞|准备未完成|开发前准备|开跑前检查|开跑前检查没过|没有需求原文|验收标准起草失败|门禁期间工作区变了|验收期间工作区变了|门禁检查方法故障|门禁原因待诊断|无法验收|没法确定归谁|必需验收尚未确认完成|当前必需验收尚未通过|目录.*分支|项目配置不可用|旧完成记录没有资格身份|段未取得当前完成资格|--from 验收 需要各段都已完成/, "方法"],
  [/输入.*(?:变化|更新)|需求、标准或授权已变化|配置已变化|候选.*变化|工作区或提交发生了变化|评审改动了工作区|完成依据失效|段资格|段完成资格|段的完成资格|整合前段资格|整批完成资格|资格已变化|资格被撤销|候选或配置已变化/, "输入变化"],
  [/超时|准备时间预算已用完/, "超时"],
  [/端口 .*已被占用|环境|资源释放|释放未确认|联调准备失败|门禁无法执行|重置数据失败|流水线已取消|必需验收命令.*(?:中断|无法执行)/, "环境"],
  [/评审失败|评审被中断|内部错误|状态.*(?:保存|写入)失败|总结写入失败|提交失败|提交核对失败|完成后进合入队列失败|启动失败|启动入口失败|整批验收没有跑完|无法读取.*git|git .*失败/, "内部错误"],
  [/必需验收命令|^门禁|整批验收暂停|尚未完成提交/, "方法"],
];
export function eventReason(text = "", failureKind?: FailureKind): EventReason {
  const category = failureKind !== undefined
    ? ({ environment: "环境", method: "方法", product: "其他", unknown: "其他" } as const)[failureKind]
    : reasonRules.find(([pattern]) => pattern.test(text))?.[1] ?? "其他";
  return { category, text };
}
export function pauseStatus(reason: EventReason): EventStatus {
  return reason.category === "返修到上限" ? "repair-limit" : reason.text === "开发方需要你决定" ? "needs-decision" : "paused";
}
export function canonicalBatchFile(file: string): string {
  const absolute = resolve(file);
  let parent = absolute;
  while (!existsSync(parent) && dirname(parent) !== parent) parent = dirname(parent);
  return resolve(realpathSync(parent), relative(parent, absolute));
}
export const eventsRoot = (): string => join(homedir(), ".pi-autoreview", "events");
export const batchEventKey = (file: string): string => createHash("sha256").update(canonicalBatchFile(file)).digest("hex");
export const phasePath = (dir: string, stage: string | null): string => join(dir, stage === null ? "batch.phase.json" : `${stage.replace(/[/\\:*?"<>|\s]+/g, "_")}.phase.json`);
export const batchInfoPath = (dir: string): string => join(dir, "batch.info.json");
export const pipelineRoot = (): string => join(homedir(), ".pi-autoreview", "pipelines");

/** 解析、启动、查询和停止使用同一套默认名称与状态目录。 */
export function batchLocation(raw: Record<string, unknown>, planDir: string): { name: string; recipe: string; dir: string } {
  const recipe = String(raw.recipe ?? "develop");
  const name = typeof raw.name === "string" ? raw.name.trim() : recipe === "review-only" ? "只评审" : "未命名批次";
  const dir = raw.dir === undefined ? join(pipelineRoot(), name.replace(/[/\\:*?"<>|\s]+/g, "_")) : resolve(planDir, String(raw.dir).trim());
  return { name, recipe, dir };
}

export function batchInfo(file: string, cwd: string, dir?: string): BatchInfo {
  const raw = readJson<any>(file) ?? {};
  const location = batchLocation(raw, dirname(file));
  const target = dir ?? location.dir;
  const previous = readJson<BatchInfo>(batchInfoPath(target));
  const batch = { file: canonicalBatchFile(file), name: location.name, recipe: location.recipe };
  return { project: previous?.batch.file === batch.file ? previous.project : resolve(findProjectRoot(cwd) ?? cwd), batch, dir: resolve(target),
    stages: Object.entries(raw.stages ?? {}).map(([stage, value]: [string, any]) => {
      const old = previous?.batch.file === batch.file ? previous.stages.find((item) => item.stage === stage) : undefined;
      return { stage, cwd: value.cwd ? resolve(dirname(file), value.cwd) : old?.cwd ?? resolve(cwd),
        ...(value.branch ?? raw.branch ?? old?.branch ? { branch: value.branch ?? raw.branch ?? old?.branch } : {}), ...(value.prompt ? { prompt: resolve(dirname(file), value.prompt) } : {}) };
    }) };
}
export function recordBatchInfo(info: BatchInfo): void {
  try { if (JSON.stringify(readJson(batchInfoPath(info.dir))) !== JSON.stringify(info)) writeJsonAtomic(batchInfoPath(info.dir), info); }
  catch (error) { eventError(info.batch.file, null, error); }
}
export function eventError(file: string, seq: number | null, error: unknown, detail: Record<string, unknown> = {}): void {
  try {
    mkdirSync(eventsRoot(), { recursive: true });
    appendFileSync(join(eventsRoot(), "errors.log"), `${JSON.stringify({ at: new Date().toISOString(), batch: file, seq, ...detail, reason: String(error) })}\n`);
  } catch { /* 连本机留底也不可写时，stderr 是最后出口。 */ }
  try { process.stderr.write(`[Loop PA] ${file} seq=${seq ?? "未分配"}：${String(error)}\n`); } catch { /* 业务不能受观测故障影响 */ }
}
interface Owner { pid: number; started: string; token: string }
function ownerDead(owner: Owner): boolean {
  const started = processStartTime(owner.pid);
  if (started) return started !== owner.started;
  try { process.kill(owner.pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}
/** 完整锁身份通过硬链接原子发布；回收者同样串行，不按年龄接管。 */
export function eventLock(path = join(eventsRoot(), ".lock"), waitMs = 15_000): () => void {
  const root = dirname(path), token = randomUUID();
  mkdirSync(root, { recursive: true });
  const mine: Owner = { pid: process.pid, started: processStartTime(process.pid), token };
  if (!mine.started) throw new Error("无法确认事件锁进程启动时间");
  const temp = join(root, `lock-${token}.tmp`), reclaim = `${path}.reclaim`;
  writeFileSync(temp, JSON.stringify(mine), { flag: "wx", mode: 0o600 });
  const deadline = Date.now() + waitMs;
  try {
    for (;;) {
      try { linkSync(temp, path); return () => { if (readJson<Owner>(path)?.token === token) rmSync(path); }; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      const old = readJson<Owner>(path);
      if (!old && !existsSync(path)) continue; // EEXIST 后持有者可能已释放。
      if (!old?.started || !old.token || !Number.isInteger(old.pid) || old.pid < 1) throw new Error("事件锁身份不明，保留锁");
      if (ownerDead(old)) {
        try {
          linkSync(temp, reclaim);
          try { if (readJson<Owner>(path)?.token === old.token) rmSync(path); }
          finally { if (readJson<Owner>(reclaim)?.token === token) rmSync(reclaim); }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          const owner = readJson<Owner>(reclaim);
          if (owner?.started && ownerDead(owner) && readJson<Owner>(reclaim)?.token === owner.token) rmSync(reclaim);
        }
      }
      if (!existsSync(path)) continue;
      if (Date.now() >= deadline) throw new Error("等待事件锁超时");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  } finally { rmSync(temp, { force: true }); }
}
interface Sequence { seq: number; last: Record<string, string> }
const sequencePath = (file: string): string => join(eventsRoot(), `${batchEventKey(file)}.json`);
export function lastEventSeq(file: string): number { return readJson<Sequence>(sequencePath(file))?.seq ?? 0; }
const stable = (value: any): any => Array.isArray(value) ? value.map(stable) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value;
const absoluteEvidence = (evidence: Evidence): Evidence => Object.fromEntries(Object.entries(evidence).filter(([, value]) => typeof value === "string" && isAbsolute(value)));

/** 先落盘消耗序号，再尝试一次 O_APPEND write；不扫描、不修复、不补发接收目录。 */
export function pushEvent(info: BatchInfo, stage: string | null, status: EventStatus, reason: EventReason = eventReason(), evidence: Evidence = {}, detail: Record<string, unknown> = {}): LoopEvent | undefined {
  let seq: number | null = null, release: (() => void) | undefined;
  try {
    const dir = readPAConfig().eventsDir;
    if (!dir) {
      if (detail.via === "pa") eventError(info.batch.file, null, "PA 恢复事件未配置接收目录", { via: "pa", id: detail.id });
      return;
    }
    release = eventLock();
    const path = sequencePath(info.batch.file);
    let state: Sequence;
    try { state = JSON.parse(readFileSync(path, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; state = { seq: 0, last: {} }; }
    if (!Number.isSafeInteger(state.seq) || state.seq < 0 || !state.last || typeof state.last !== "object") throw new Error("事件序号记录损坏，未重置");
    // 队列通知不改变批次/段的完成代次；生命周期只与上一次真实转换比对。
    const key = `${stage === null ? "@batch" : `stage:${stage}`}${status === "queue" ? ":queue" : ""}`;
    const critical = status === "done" ? { scope: detail.scope, commit: detail.commit, commits: detail.commits, completion: detail.completion, recipe: detail.recipe, report: detail.report }
      : status === "queue" ? { queueStatus: detail.queueStatus, position: detail.position, returnCount: detail.returnCount, reason: detail.reason } : detail;
    const signature = JSON.stringify(stable([status, reason, critical]));
    if (state.last[key] === signature && status !== "resumed") return;
    seq = ++state.seq;
    state.last[key] = status === "resumed" ? "" : signature;
    if (!Number.isSafeInteger(state.seq)) throw new Error("事件序号超出安全整数范围");
    const temp = `${path}.${randomUUID()}.tmp`;
    try { writeFileSync(temp, JSON.stringify(state)); renameSync(temp, path); }
    finally { rmSync(temp, { force: true }); }
    const now = new Date(), id = randomUUID();
    const event: LoopEvent = { v: 1, seq, id, at: now.toISOString(), project: resolve(info.project), batch: info.batch, stage, status, reason,
      evidence: absoluteEvidence(evidence), detail };
    if (Buffer.byteLength(JSON.stringify(detail)) > 8192) {
      const path = join(eventsRoot(), "details", `${id}.json`);
      mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(detail));
      event.evidence.detail = path;
      event.detail = { path, ...Object.fromEntries(["next", "scope", "branch", "commit", "via", "id", "failureKind", "paGrantsUsed"].filter((key) => key in detail).map((key) => [key, detail[key]])) };
    }
    mkdirSync(dir, { recursive: true });
    const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");
    const fd = openSync(join(dir, `events-${date}.jsonl`), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND, 0o600);
    try {
      const line = Buffer.from(`${JSON.stringify(event)}\n`);
      if (writeSync(fd, line) !== line.length) throw new Error("事件未完整写入");
    } finally { closeSync(fd); }
    return event;
  } catch (error) { eventError(info.batch.file, seq, error, { ...(detail.via === "pa" ? { via: "pa", id: detail.id } : {}), ...(detail.paGrantsUsed ? { paGrantsUsed: detail.paGrantsUsed } : {}) }); return; }
  finally { try { release?.(); } catch (error) { eventError(info.batch.file, seq, error); } }
}

export function writePhase(info: BatchInfo, stage: string | null, phase: PhaseRecord["phase"], options: Partial<Omit<PhaseRecord, "phase" | "since" | "updatedAt">> = {}): PhaseRecord | undefined {
  try {
    recordBatchInfo(info);
    const path = phasePath(info.dir, stage), previous = readJson<PhaseRecord>(path), now = new Date().toISOString();
    const next: PhaseRecord = { status: phase === "done" || phase === "failed" || phase === "paused" ? phase : "running", category: "其他", text: "", round: 0, repairs: 0, evidence: {}, detail: {}, ...options, phase, batchFile: canonicalBatchFile(info.batch.file),
      since: previous?.phase === phase && previous.text === (options.text ?? "") ? previous.since : now, updatedAt: now };
    next.evidence = absoluteEvidence(next.evidence);
    writeJsonAtomic(path, next); return next;
  } catch (error) { eventError(info.batch.file, null, error); return; }
}

/** 验收调用结束不等于批次已提交；欠项与证据在真实提交完成前继续受保护。 */
export function reportUncommittedBatch(info: BatchInfo, record?: AcceptanceRecord, paGrantsUsed?: string[]): void {
  const reason = eventReason(record?.verdict === "部分验证" ? "整批验收部分验证，尚未完成提交" : "整批尚未完成提交，成果与证据保留");
  const evidence = { summary: join(info.dir, "report.md"), ...(record?.runDir ? { acceptance: record.runDir } : {}) };
  const next: NextAction = record?.verdict === "部分验证" ? "resume" : "manual";
  const detail = { next, acceptance: { verdict: record?.verdict ?? "未验证", ...queueAcceptance(record) },
    paGrantsUsed: paGrantsUsed ?? readJson<PhaseRecord>(phasePath(info.dir, null))?.detail.paGrantsUsed ?? [] };
  writePhase(info, null, "paused", { status: "paused", ...reason, next, evidence, detail });
  if (info.batch.file) pushEvent(info, null, "paused", reason, evidence, detail);
}

/** 两个宿主的开始/评审/暂停/恢复/完成共用。段 done 只记 phase，由提交成功的程序发事件。 */
export function observeStage(options: {
  cwd: string; summary: string; session: NonNullable<PhaseRecord["session"]>;
  phase: PhaseRecord["phase"]; state: { rounds: RoundRecord[]; repairs: number; pauseReason?: string; unresolvedMustFix?: string; unresolvedAcceptance?: string; acceptRun?: AcceptRunRecord; queueReviewedAcceptance?: QueueAcceptance | null };
  reason?: string; failureKind?: FailureKind; question?: string; via?: "user" | "auto"; replay?: boolean; env?: NodeJS.ProcessEnv;
}): void {
  try {
  const env = options.env ?? process.env, file = env.AUTOREVIEW_BATCH_FILE, stage = env.AUTOREVIEW_STAGE, dir = env.AUTOREVIEW_PIPELINE_DIR;
  if (!stage || !dir) return;
  // 旧自定义流水线可能没有批次文件，仍补 phase，但不伪造 PA 的批次身份。
  const info = file ? batchInfo(file, options.cwd, dir) : { project: resolve(options.cwd), batch: { file: "", name: "", recipe: "develop" }, dir, stages: [] };
  const previous = readJson<PhaseRecord>(phasePath(dir, stage)), state = options.state, round = state.rounds.at(-1);
  const reason = eventReason(options.reason ?? "", options.failureKind);
  const status = options.phase === "paused" ? pauseStatus(reason) : options.phase === "done" ? "done" : options.phase === "failed" ? "failed" : options.via ? "resumed" : "started";
  const evidence: Evidence = { summary: options.summary, ...(round?.gate?.logPath ? { log: round.gate.logPath } : {}), ...(round?.acceptance?.runDir ? { acceptance: round.acceptance.runDir } : {}),
    ...(state.acceptRun?.logPath ? { log: state.acceptRun.logPath } : {}), ...(round?.snapshot ? { review: round.snapshot } : {}), ...(options.session.log ? { session: options.session.log } : {}) };
  const detail: Record<string, unknown> = options.phase === "done" ? completionDetail(round, state.queueReviewedAcceptance) : { round: state.rounds.length, repairs: state.repairs };
  if (options.failureKind) detail.failureKind = options.failureKind;
  if (options.phase === "paused") detail.next = "send";
  if (status === "repair-limit") detail.mustFix = state.unresolvedMustFix || state.unresolvedAcceptance || round?.mustFixRaw || round?.gate?.outputTail || "";
  if (status === "needs-decision") {
    detail.question = options.question ?? (options.replay ? previous?.detail.question : "") ?? "";
    const choices = String(detail.question).split(/\r?\n/).filter((line) => /^\s*(?:[A-Z]|\d+)[.、)）]\s*\S/.test(line));
    if (choices.length) detail.options = choices;
  }
  if (options.via) detail.via = options.via;
  const batchPhase = readJson<PhaseRecord>(phasePath(dir, null));
  if (!options.replay && options.phase !== "done" && options.phase !== "paused" && (!batchPhase || ["done", "failed"].includes(batchPhase.phase))) writePhase(info, null, "running");
  writePhase(info, stage, options.phase, { status, ...reason, round: state.rounds.length, repairs: state.repairs, session: { ...options.session, runId: options.session.runId ?? env.AUTOREVIEW_LAUNCH_ID }, evidence, detail,
    ...(options.phase === "paused" ? { next: "send" } : {}) });
  if (!file || options.replay || options.phase === "reviewing" || options.phase === "done") return;
  if (status === "started" && previous?.session?.id === options.session.id) return;
  const prompt = info.stages.find((item) => item.stage === stage)?.prompt;
  pushEvent(info, stage, status, reason, evidence, status === "started" ? { recipe: info.batch.recipe, ...(prompt ? { prompt } : {}) } : detail);
  } catch (error) { eventError(options.env?.AUTOREVIEW_BATCH_FILE ?? process.env.AUTOREVIEW_BATCH_FILE ?? "", null, error); }
}
export function completionDetail(round?: RoundRecord, qualified?: QueueAcceptance | null): Record<string, unknown> {
  const acceptance = qualified ?? queueAcceptance(round?.acceptance);
  return { gate: round?.gate?.result ?? "未配置", review: { verdict: round?.reviewConclusion ?? round?.conclusion ?? "未验证", mustFix: round?.mustFix?.length ?? null, suggestions: round?.minor?.length ?? null },
    acceptance: { verdict: qualified === null ? "未验证" : round?.acceptance?.verdict ?? (qualified ? "沿用原完成资格" : "未配置"), ...acceptance } };
}

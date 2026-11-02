/** PA 送话：先留底、单次投递、一次性消费；任何不确定结果都不重发。 */
import { setTimeout as sleep } from "node:timers/promises";
import { join } from "node:path";
import { batchInfo, eventError, eventLock, eventReason, phasePath, pushEvent, type BatchInfo, type PhaseRecord } from "./events.ts";
import { processStartTime } from "./procs.ts";
import { readJson, statusPath, type StageStatus } from "./pipeline-core.ts";
import { deliverHookWords } from "./hosts/inbox-bridge.ts";
import { checkPAId, hasRelayHeader, parseRelay, readPAJson, relayMessage, textHash, wordPath, wordsDir, writePAJson, type WordRecord } from "./pa-records.ts";

export function paInfo(file: string): BatchInfo {
  const raw = readJson<{ stages?: unknown }>(file);
  if (!raw?.stages || typeof raw.stages !== "object") throw new Error(`无法读取批次：${file}`);
  return batchInfo(file, process.cwd());
}
export const sessionAlive = (session?: { pid?: number; processStarted?: string }): boolean => Boolean(session?.pid && session.processStarted && processStartTime(session.pid) === session.processStarted);
function receipt(record: WordRecord): Record<string, unknown> {
  return { v: 1, ok: ["delivered", "read"].includes(record.state), command: "送话", id: record.id, state: record.state === "sending" ? "unknown" : record.state, sha256: record.sha256, at: record.at,
    ...(record.readAt ? { readAt: record.readAt } : {}), ...(record.reason || record.state === "sending" ? { reason: eventReason(record.reason ?? "投递尚未定案，不重发") } : {}) };
}
export async function sendWords(options: { info: BatchInfo; stage: string; id: string; readText: () => string; wait?: number; env?: NodeJS.ProcessEnv; dryRun?: boolean;
  deliver?: (status: StageStatus, message: string) => Promise<void> }): Promise<Record<string, unknown>> {
  const env = options.env ?? process.env, { info, stage, id } = options;
  if (env.AUTOREVIEW_STAGE !== undefined || env.AUTOREVIEW_PIPELINE_DIR !== undefined) throw new Error("开发会话环境禁止调用 loop 送话");
  checkPAId(id);
  if (!info.stages.some((item) => item.stage === stage)) throw new Error(`批次没有段：${stage}`);
  const path = wordPath(info.dir, stage, id);
  let record: WordRecord | undefined, status: StageStatus | undefined, fresh = false;
  // 并发查重与 sending 原子化；异步宿主调用不持锁，收件方也不等这把锁。
  const prepare = (): Record<string, unknown> | undefined => {
    record = readPAJson<WordRecord>(path);
    if (record) {
      if (record.id !== id || record.v !== 1 || typeof record.text !== "string" || typeof record.sha256 !== "string" || !["sending", "delivered", "unknown", "read", "failed"].includes(record.state)) throw new Error("送话记录格式损坏，不重发");
      return;
    }
    const phase = readJson<PhaseRecord>(phasePath(info.dir, stage));
    status = readJson<StageStatus>(statusPath(info.dir, stage));
    const session = phase?.session ?? (status ? { host: status.host ?? "pi", id: status.sessionId, pid: status.pid, processStarted: status.processStarted } : undefined);
    if (!sessionAlive(session)) {
      record = { v: 1, id, via: "pa", text: "", sha256: textHash(""), at: new Date().toISOString(), state: "failed", reason: "会话已关闭", session };
    } else {
      if (!phase || ["running", "reviewing"].includes(phase.phase)) return { v: 1, ok: false, command: "送话", id, state: "rejected", reason: eventReason("段正在运行") };
      if (!["paused", "done"].includes(phase.phase)) return { v: 1, ok: false, command: "送话", id, state: "rejected", reason: eventReason("段不处于可送话状态") };
      const text = options.readText();
      record = { v: 1, id, via: "pa", text, sha256: textHash(text), at: new Date().toISOString(), state: "sending", session };
      // 投递依据必须是核对过的 phase 身份，不使用别的会话留下的旧 status。
      status = { ...status, stage, host: session!.host, sessionId: session!.id, pid: session!.pid, processStarted: session!.processStarted } as StageStatus;
      fresh = true;
    }
    if (!options.dryRun) writePAJson(path, record);
  };
  let early: Record<string, unknown> | undefined;
  if (options.dryRun) early = prepare();
  else { const release = eventLock(join(info.dir, ".pa-send.lock")); try { early = prepare(); } finally { release(); } }
  if (early) return early;
  if (options.dryRun) return { ...receipt(record!), dryRun: true };
  if (fresh) {
    let state: WordRecord["state"] = "delivered", reason: string | undefined;
    try {
      if (options.deliver) await options.deliver(status!, relayMessage(id, record!.text));
      else if (status!.host !== "pi") await deliverHookWords(info.dir, stage, status!, relayMessage(id, record!.text), id, info.stages.find((item) => item.stage === stage)!.cwd);
      // pi 的持久用户原话收件位置就是 words/；只有 delivered 才能被轮询消费。
    } catch (error) { state = "unknown"; reason = String(error); }
    record = { ...record!, state, ...(reason ? { reason } : {}) }; writePAJson(path, record);
  }
  const deadline = Date.now() + (options.wait ?? 0) * 1000;
  for (;;) {
    record = readPAJson<WordRecord>(path)!;
    if (record.state !== "delivered" || Date.now() >= deadline) return receipt(record);
    await sleep(Math.min(25, Math.max(1, deadline - Date.now())));
  }
}

/** UserPromptSubmit 可能比发送调用返回更早到达：只等 sending 定案，不把 sending 当作授权。 */
export async function consumeRelay(options: { message: string; info: BatchInfo; stage: string; session: { host: string; id: string }; summary?: string }): Promise<{ id: string; text: string; at: string } | undefined> {
  const { info, stage, message, session } = options;
  if (!hasRelayHeader(message)) return;
  const parsed = parseRelay(message);
  const fail = (): undefined => {
    pushEvent(info, stage, "resumed", eventReason("送话核对失败"), options.summary ? { summary: options.summary } : {}, { via: "auto", ...(parsed ? { id: parsed.id } : {}) });
    return;
  };
  if (!parsed) return fail();
  try {
    const path = wordPath(info.dir, stage, parsed.id), deadline = Date.now() + 31_000;
    while (readPAJson<WordRecord>(path)?.state === "sending" && Date.now() < deadline) await sleep(20);
    const release = eventLock(join(wordsDir(info.dir, stage), ".consume.lock"));
    try {
      const row = readPAJson<WordRecord>(path);
      if (!row || row.id !== parsed.id || row.via !== "pa" || row.state !== "delivered" || row.sha256 !== textHash(parsed.text)
        || row.text !== parsed.text || row.session?.id !== session.id || row.session?.host !== session.host || !sessionAlive(row.session)) return fail();
      const at = new Date().toISOString();
      writePAJson(path, { ...row, state: "read", readAt: at });
      // 读一次就报一次，不依赖是否原来暂停/已完成，也不依赖后续 Git、配置或总结成功。
      pushEvent(info, stage, "resumed", eventReason(), options.summary ? { summary: options.summary } : {}, { via: "pa", id: row.id });
      return { id: row.id, text: parsed.text, at };
    } finally { release(); }
  } catch (error) { eventError(info.batch.file, null, error, { via: "pa", id: parsed.id }); return fail(); }
}

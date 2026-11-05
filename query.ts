/** PA v1 快照：仅 JSON、mtime、每段一次进程身份核对；绝不导入队列执行器或解析/启动流水线。 */
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { batchInfo, batchInfoPath, canonicalBatchFile, eventReason, lastEventSeq, pauseStatus, phasePath, pipelineRoot, type BatchInfo, type PhaseRecord } from "./events.ts";
import { readJson, statusPath, type StageStatus } from "./pipeline-core.ts";
import { processStartTime } from "./procs.ts";
import { readPAGrants, wordRecords } from "./pa-records.ts";
import type { MergeQueue } from "./merge-queue.ts";

const list = (path: string): string[] => { try { return readdirSync(path); } catch { return []; } };
function queues(): MergeQueue[] {
  const root = process.env.AUTOREVIEW_MERGE_QUEUE_ROOT || join(homedir(), ".pi-autoreview", "merge-queues");
  return list(root).flatMap((name) => {
    const queue = readJson<MergeQueue>(join(root, name, "queue.json"));
    return queue?.version === 1 && Array.isArray(queue.batches) && Array.isArray(queue.entries) ? [queue] : [];
  });
}
function activity(paths: (string | undefined)[]): string | null {
  const times = paths.flatMap((path) => { try { return path ? [statSync(path).mtimeMs] : []; } catch { return []; } });
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
}
const paused = (phase: PhaseRecord | undefined) => phase?.phase === "paused"
  ? { category: phase.category, text: phase.text, since: phase.since } : null;

export function queryBatches(file?: string): { v: 1; at: string; batches: Record<string, unknown>[] } {
  const queueStates = queues(), infos = new Map<string, BatchInfo>();
  const add = (info: BatchInfo | undefined): void => { if (info?.batch?.file && Array.isArray(info.stages)) infos.set(canonicalBatchFile(info.batch.file), info); };
  if (file) {
    const raw = readJson<Record<string, unknown>>(resolve(file));
    if (!raw) throw new Error(`无法读取批次文件：${resolve(file)}`);
    const fallback = batchInfo(resolve(file), dirname(resolve(file)));
    const recorded = readJson<BatchInfo>(batchInfoPath(fallback.dir));
    add(recorded?.batch.file === fallback.batch.file ? recorded : fallback);
  } else {
    for (const name of list(pipelineRoot())) add(readJson<BatchInfo>(batchInfoPath(join(pipelineRoot(), name))));
    for (const queue of queueStates) for (const batch of queue.batches) add(readJson<BatchInfo>(batchInfoPath(batch.dir)) ?? {
      project: batch.project, batch: { file: batch.file, name: batch.name, recipe: "develop" }, dir: batch.dir,
      stages: batch.stages.map((stage) => ({ stage: stage.name, cwd: stage.cwd, branch: stage.branch, prompt: stage.prompt })),
    });
  }
  const batches = [...infos.values()].sort((a, b) => a.batch.file.localeCompare(b.batch.file)).map((info) => {
    const queue = queueStates.find((queue) => queue.batches.some((batch) => canonicalBatchFile(batch.file) === info.batch.file));
    const registered = queue?.batches.find((batch) => canonicalBatchFile(batch.file) === info.batch.file);
    const entry = queue?.entries.filter((item) => item.batch === registered?.id).at(-1);
    const active = queue?.entries.filter((item) => ["pending", "testing", "ready", "returning", "merging", "withdrawing"].includes(item.status)).sort((a, b) => a.order - b.order) ?? [];
    const recorded = readJson<BatchInfo>(batchInfoPath(info.dir));
    const owned = recorded?.batch.file && canonicalBatchFile(recorded.batch.file) === canonicalBatchFile(info.batch.file)
      && canonicalBatchFile(recorded.dir) === canonicalBatchFile(info.dir);
    const belongs = (path?: string): boolean => !path || canonicalBatchFile(path) === canonicalBatchFile(info.batch.file);
    const batchRecord = owned ? readJson<PhaseRecord>(phasePath(info.dir, null)) : undefined;
    const batchPhase = belongs(batchRecord?.batchFile) ? batchRecord : undefined;
    const commit = registered?.commits?.[0];
    const stages = info.stages.map((stage) => {
      const statusFile = statusPath(info.dir, stage.stage), phaseFile = phasePath(info.dir, stage.stage);
      const statusRecord = owned ? readJson<StageStatus>(statusFile) : undefined, phaseRecord = owned ? readJson<PhaseRecord>(phaseFile) : undefined;
      const status = belongs(statusRecord?.batchFile) ? statusRecord : undefined, phase = belongs(phaseRecord?.batchFile) ? phaseRecord : undefined;
      const reason = eventReason(status?.pauseReason);
      const state = phase ? phase.phase === "running" || phase.phase === "reviewing" ? "running" : phase.status
        : status?.event === "paused" ? pauseStatus(reason) : status?.event === "startup-failed" ? "failed" : status?.event === "done" ? "done" : "running";
      const session = phase?.session ?? (status ? { host: status.host ?? "pi", id: status.sessionId, pid: status.pid, processStarted: status.processStarted, log: undefined } : undefined);
      const evidence = Object.fromEntries(Object.entries({ ...(status?.summary ? { summary: status.summary } : {}), ...phase?.evidence }).filter(([, path]) => isAbsolute(path)));
      return { stage: stage.stage, state, round: phase?.round ?? 0, repairs: phase?.repairs ?? 0,
        lastActivity: activity([statusFile, phaseFile, evidence.summary, session?.log]),
        pause: phase ? paused(phase) : status?.event === "paused" ? { ...reason, since: status.updatedAt } : null,
        ...(phase?.next ? { next: phase.next } : {}),
        session: session ? { host: session.host, id: session.id, alive: session.pid && session.processStarted ? processStartTime(session.pid) === session.processStarted : false } : null,
        evidence, paRelays: (owned ? wordRecords(info.dir, stage.stage) : []).filter((row) => row.state === "read").sort((a, b) => (b.readAt ?? b.at).localeCompare(a.readAt ?? a.at)).slice(0, 50).map((row) => ({ id: row.id, at: row.readAt ?? row.at })) };
    });
    return { project: info.project, batch: { ...info.batch, paGrants: (owned ? readPAGrants(info.dir) : []).map(({ id, at }) => ({ id, at })) },
      branch: commit?.branch ?? batchPhase?.detail.branch ?? info.stages[0]?.branch ?? null,
      commit: commit?.commit ?? batchPhase?.detail.commit ?? null, pushed: commit?.pushed ?? null,
      ...(registered?.commits && registered.commits.length > 1 ? { commits: registered.commits } : {}),
      state: batchPhase?.phase === "reviewing" || batchPhase?.phase === "running" ? "running" : batchPhase?.status ?? null,
      pause: paused(batchPhase), ...(batchPhase?.next ? { next: batchPhase.next } : {}), stages,
      queue: entry ? { status: entry.status, position: active.findIndex((item) => item.id === entry.id) + 1 || null, returnCount: entry.returnCount ?? 0, reason: entry.reason ?? null, log: entry.log ?? null } : null,
      evidence: batchPhase?.evidence ?? {}, events: { lastSeq: lastEventSeq(info.batch.file) } };
  });
  return { v: 1, at: new Date().toISOString(), batches };
}

/** PA 续跑请求去重；旧批次只给迁移说明，新卡复用内核，不重开旧编排。 */
import { join } from "node:path";
import { canonicalBatchFile, eventLock, eventReason, type BatchInfo } from "./events.ts";
import { findKernelLedger } from "./kernel-cli.ts";
import { readRun } from "./node-ledger.ts";
import { resumeManaged } from "./kernel-runtime.ts";
import { PIPELINE_MIGRATION } from "./pipeline.ts";
import { checkPAId, readPAJson, writePAJson } from "./pa-records.ts";

export async function resumeBatch(options: { info: BatchInfo; id: string; readGrant?: () => string; dryRun?: boolean }): Promise<Record<string, unknown>> {
  const { info, id } = options;
  checkPAId(id);
  const ledger = findKernelLedger(info.batch.file, info.project);
  // 旧卡连拒绝收据目录/锁也不创建；确定性拒绝本身幂等，旧缓存不能重新宣称已启动。
  if (!ledger) return { v: 1, ok: false, command: "续跑", id, state: "rejected", reason: eventReason(PIPELINE_MIGRATION), ...(options.dryRun ? { dryRun: true } : {}) };
  const run = readRun(ledger);
  const refused = (reason: string) => ({ v: 1, ok: false, command: "续跑", id, state: "rejected", reason: eventReason(reason), ...(options.dryRun ? { dryRun: true } : {}) });
  if (canonicalBatchFile(run.file) !== canonicalBatchFile(info.batch.file) || canonicalBatchFile(run.dir) !== canonicalBatchFile(info.dir) || canonicalBatchFile(run.repo) !== canonicalBatchFile(info.project)) return refused("新卡归属不匹配，未创建收据或续跑");
  if (options.readGrant) return refused("新卡授权须通过已有送话入口投递到原任务（--stage 任务名）；不在整批续跑中代填授权");
  const path = join(run.dir, "pa-resumes", `${id}.json`);
  const prepare = (): Record<string, unknown> => {
    const previous = readPAJson<Record<string, unknown>>(path);
    if (previous) return previous;
    const result: Record<string, unknown> = { v: 1, ok: true, command: "续跑", id, state: "starting", ledger };
    if (!options.dryRun) writePAJson(path, result); // 未知/在途重复请求不重新派发。
    return result;
  };
  let result: Record<string, unknown>;
  if (options.dryRun) return { ...prepare(), dryRun: true };
  const release = eventLock(join(info.dir, ".pa-resume.lock"));
  try {
    const previous = readPAJson<Record<string, unknown>>(path);
    if (previous) return previous;
    result = prepare();
  } finally { release(); }
  if (!result.ok) return result;
  try { result = { ...result, state: "started", result: await resumeManaged(result.ledger as string, true) }; }
  catch (error) { result = { ...result, ok: false, state: "failed", reason: eventReason(String(error)) }; }
  // 与持久收据/CLI JSON 使用同一形状，重复请求不因 undefined 字段产生第二种答复。
  const receipt: Record<string, unknown> = JSON.parse(JSON.stringify(result));
  writePAJson(path, receipt);
  return receipt;
}

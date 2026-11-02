/** 整批 PA 续跑；只重启编排，不改标准文件，不恢复已关闭的段会话。 */
import { spawn } from "node:child_process";
import { appendFileSync, closeSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { authorizationStatus, grantsFromUser, typedByUser, type Criteria } from "./acceptance-core.ts";
import { eventError, eventLock, eventReason, phasePath, pushEvent, writePhase, type BatchInfo, type PhaseRecord } from "./events.ts";
import { parsePlan } from "./pipeline.ts";
import { inboxPath, readJson, statusPath, type InboxMessage, type StageStatus } from "./pipeline-core.ts";
import { processStartTime } from "./procs.ts";
import { appendPARelayRecord } from "./ledger.ts";
import { sessionAlive } from "./pa.ts";
import { bindPAGrant, checkPAId, grantsPath, readPAGrants, readPAJson, writePAJson, type PAGrant } from "./pa-records.ts";

export async function resumeBatch(options: { info: BatchInfo; id: string; readGrant?: () => string; dryRun?: boolean;
  launch?: (argv: string[], cwd: string, log: string) => Promise<{ pid: number; processStarted: string }> }): Promise<Record<string, unknown>> {
  const { info, id } = options;
  checkPAId(id);
  const path = join(info.dir, "pa-resumes", `${id}.json`);
  const previous = readPAJson<Record<string, unknown>>(path);
  if (previous) return previous;
  const refused = (text: string, extra: Record<string, unknown> = {}) => ({ v: 1, ok: false, command: "续跑", id, state: "rejected", reason: eventReason(text), ...extra });
  let argv: string[] = [], grant: PAGrant | undefined, result: Record<string, unknown> | undefined;
  const prepare = () => {
    result = readPAJson<Record<string, unknown>>(path);
    if (result) return;
    const phase = readJson<PhaseRecord>(phasePath(info.dir, null));
    if (phase?.next === "manual") { result = refused(`需要在电脑上处理：${phase.text}`); return; }
    if (sessionAlive(phase?.session) || phase?.phase === "running" || phase?.phase === "reviewing") {
      if (sessionAlive(phase?.session)) { result = refused("流水线正在运行"); return; }
      if (!phase?.session?.processStarted) { result = refused("流水线进程身份无法核对"); return; }
    }
    if (!phase || !["resume", "grant"].includes(phase.next ?? "")) { result = refused("整批没有可续跑的暂停位置"); return; }
    const raw = readPAJson<Record<string, unknown>>(info.batch.file);
    const plan = parsePlan(raw, dirname(info.batch.file), process.env,
      { batchFile: info.batch.file, projectRoot: info.project, defaultWorkspace: "dev分支" });
    if (phase.next === "grant") {
      if (!options.readGrant || !plan.acceptance) { result = refused("授权待答复，需提供 --grant-file"); return; }
      const text = options.readGrant(), criteria: Criteria = { source: "用户", version: 1, updatedAt: "", items: plan.acceptance.items };
      const parsed = grantsFromUser(typedByUser(text), criteria);
      if (!parsed || !(parsed.approved.length || parsed.denied.length)) { result = refused("原话解析不出授权答复", { parsed: parsed ?? null, authorization: authorizationStatus(criteria, parsed) }); return; }
      const existing = readPAGrants(info.dir).find((row) => row.id === id);
      if (existing && existing.text !== text) { result = refused("同编号 PA 授权原文不一致"); return; }
      grant = existing ? undefined : options.dryRun ? { id, text, at: new Date().toISOString(), via: "pa" }
        : bindPAGrant(info.dir, { id, text, at: new Date().toISOString(), via: "pa" }, criteria, plan.acceptance.requirement);
    }
    const allDone = [...plan.stages.keys()].every((stage) => {
      const status = readJson<StageStatus>(statusPath(info.dir, stage)), inbox = readJson<InboxMessage>(inboxPath(info.dir, stage));
      return status?.event === "done" && status.readyEpoch && (status.inbox ?? 0) >= (inbox?.seq ?? 0);
    });
    argv = [process.execPath, fileURLToPath(new URL("./pipeline.ts", import.meta.url)), info.batch.file,
      "--project-root", info.project, "--default-workspace", "dev分支", ...(allDone ? ["--from", "验收"] : [])];
    result = { v: 1, ok: true, command: "续跑", id, state: "starting", mode: allDone ? "acceptance" : "pipeline", argv, log: join(info.dir, "pa-resume.log") };
    if (options.dryRun) return;
    if (grant) {
      appendFileSync(grantsPath(info.dir), `${JSON.stringify(grant)}\n`, { mode: 0o600 });
      try { appendPARelayRecord({ project: info.project, session: `pipeline-${info.batch.name}`, summary: join(info.dir, "report.md"), source: { id, at: grant.at, input: readPAGrants(info.dir).length, grant: grant.text } }); }
      catch (error) { eventError(info.batch.file, null, error, { via: "pa", id }); }
    }
    writePAJson(path, result);
    // 先占用短暂的启动位置，另一编号不能趁 spawn 的异步窗口重复启动。
    const occupied = writePhase(info, null, "running", { status: "resumed", detail: { via: "pa", id },
      session: { host: "pipeline-launch", id, pid: process.pid, processStarted: processStartTime(process.pid) } });
    if (!occupied) throw new Error("续跑启动身份无法落盘，未启动编排");
  };
  if (options.dryRun) prepare();
  else { const release = eventLock(join(info.dir, ".pa-resume.lock")); try { prepare(); } finally { release(); } }
  if (!argv.length || options.dryRun) return { ...result!, ...(options.dryRun ? { dryRun: true } : {}) };
  try {
    const launched = await (options.launch ?? launchPipeline)(argv, info.project, join(info.dir, "pa-resume.log"));
    result = { ...result, state: "started", ...launched };
    // 实际编排自己发布 PID 与阶段；父入口绝不读改写，避免覆盖刚到达的 paused/done。
    pushEvent(info, null, "resumed", eventReason(), { log: join(info.dir, "pa-resume.log") }, { via: "pa", id });
  } catch (error) {
    const text = `流水线启动失败：${String(error)}`;
    result = { ...result, ok: false, state: "failed", reason: eventReason(text) };
    writePhase(info, null, "paused", { status: "paused", ...eventReason(text), next: "resume", detail: { via: "pa", id, next: "resume" } });
    pushEvent(info, null, "paused", eventReason(text), {}, { via: "pa", id, next: "resume" });
  }
  writePAJson(path, result);
  return result!;
}

async function launchPipeline(argv: string[], cwd: string, log: string): Promise<{ pid: number; processStarted: string }> {
  const fd = openSync(log, "a", 0o600);
  try {
    const env = { ...process.env };
    for (const key of ["AUTOREVIEW_STAGE", "AUTOREVIEW_PIPELINE_DIR", "AUTOREVIEW_PIPELINE_LAUNCH", "AUTOREVIEW_PIPELINE_LAUNCH_TOKEN"]) delete env[key];
    const child = spawn(argv[0], argv.slice(1), { cwd, env, detached: true, stdio: ["ignore", fd, fd] });
    await new Promise<void>((accept, reject) => { child.once("spawn", accept); child.once("error", reject); });
    const pid = child.pid!, started = processStartTime(pid);
    child.unref();
    if (!started) throw new Error("后台编排启动时间无法核对，请查询批次状态；不会重试");
    return { pid, processStarted: started };
  } finally { closeSync(fd); }
}

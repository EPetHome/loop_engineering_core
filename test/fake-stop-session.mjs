#!/usr/bin/env node
/** 只模拟宿主登记与存活，不创建进程组；组必须由正式 loop 启动链建立。 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { observeStage } from "../events.ts";
import { inboxPath, readJson, writeStageStatus } from "../pipeline-core.ts";
import { processGroup, processStartTime } from "../procs.ts";

const stage = process.env.AUTOREVIEW_STAGE;
const dir = process.env.AUTOREVIEW_PIPELINE_DIR;
const root = process.env.STOP_FIXTURE_DIR;
mkdirSync(root, { recursive: true });
const summary = join(root, `${stage}.md`);
writeFileSync(summary, "替身会话总结与证据，停止后保留\n");
const args = process.argv.slice(2), sessionIndex = args.indexOf("--session");
const inbox = sessionIndex >= 0 ? readJson(inboxPath(dir, stage))?.seq ?? 0 : 0;
const session = { host: "pi", id: sessionIndex >= 0 ? args[sessionIndex + 1] : `fake-${stage}`, pid: process.pid,
  processStarted: processStartTime(process.pid), runId: process.env.AUTOREVIEW_LAUNCH_ID };
writeStageStatus({ dir, stage }, { host: session.host, sessionId: session.id, pid: session.pid, processStarted: session.processStarted, summary, event: "started", inbox });
observeStage({ cwd: process.cwd(), summary, session, state: { rounds: [], repairs: 0 }, phase: "running" });
writeFileSync(join(root, `${stage}.session.json`), JSON.stringify({ ...session, pgid: processGroup(process.pid), args, inbox }));
setTimeout(() => process.exit(90), 60_000);

#!/usr/bin/env node
/** 配置装配替身：不调用模型，记录 Pi 实际收到的参数/配置，并发布测试段状态供真实编排器复核。 */
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureProjectConfigOverrides, findProjectRoot, projectConfigOverridesFromArgs, resolveProjectConfig } from "../config.ts";
import { loadContext, refreshContext } from "../project-context.ts";
import { loadPreparation } from "../preparation.ts";
import { inboxPath, readJson, stageFromEnv, writeStageStatus } from "../pipeline-core.ts";
import { workingTree } from "../commit-batch.ts";
import { queueStageEvent } from "../merge-queue.ts";
import { processStartTime } from "../procs.ts";

const flags = projectConfigOverridesFromArgs(process.argv.slice(2));
const overrides = captureProjectConfigOverrides(flags);
const config = resolveProjectConfig(findProjectRoot(process.cwd()), overrides);
const context = loadContext(process.cwd(), overrides);
const sourceInputs = context ? refreshContext(context).snapshot.inputsFingerprint : undefined;
const preparation = loadPreparation(process.cwd(), overrides);
const link = stageFromEnv();
const sessionIndex = process.argv.indexOf("--session");
const resumed = sessionIndex >= 0;
const sessionId = resumed ? process.argv[sessionIndex + 1] : `config-fixture-${link?.stage ?? "standalone"}`;
const started = processStartTime(process.pid);
const record = {
  args: process.argv.slice(2), cwd: process.cwd(), effectiveConfig: config.effectiveConfig, overrides,
  review: { maxRepairs: config.maxRepairs, reviewerModel: config.reviewerModel, reviewerThinking: config.reviewerThinking, reviewerCmd: config.reviewerCmd },
  preparation: Boolean(preparation), sourceInputs, sessionId, resumed, pid: process.pid, processStarted: started,
};
mkdirSync(process.env.FAKE_CONFIG_LOG, { recursive: true });
writeFileSync(join(process.env.FAKE_CONFIG_LOG, `${link?.stage ?? "standalone"}.json`), JSON.stringify(record));
appendFileSync(join(process.env.FAKE_CONFIG_LOG, "history.jsonl"), `${JSON.stringify(record)}\n`);
if (link) {
  const queue = process.env.FAKE_CONFIG_QUEUE === "1";
  const inbox = queue && resumed ? readJson(inboxPath(link.dir, link.stage))?.seq ?? 0 : 0;
  const status = {
    sessionId, summary: "", event: queue && resumed ? "started" : "done", inbox,
    ...(queue ? { host: "pi", pid: process.pid, processStarted: started } : {}),
    ...(!queue || !resumed ? { readyEpoch: randomUUID() } : {}),
    ...(queue && !resumed ? { candidate: workingTree(process.cwd(), tmpdir()).tree } : {}),
    configOverrides: overrides, sourceInputs,
  };
  writeStageStatus(link, status);
  if (queue && !resumed) queueStageEvent({ cwd: process.cwd(), file: process.env.AUTOREVIEW_BATCH_FILE, stage: link.stage, status });
}

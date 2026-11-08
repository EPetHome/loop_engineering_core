#!/usr/bin/env node
/** 单会话配置装配替身：只记录真实 argv/配置/来源，不发布旧段资格或启动旧引擎。 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { captureProjectConfigOverrides, findProjectRoot, projectConfigOverridesFromArgs, resolveProjectConfig } from "../config.ts";
import { loadContext, refreshContext } from "../project-context.ts";
import { loadPreparation } from "../preparation.ts";
const args = process.argv.slice(2), flags = projectConfigOverridesFromArgs(args), overrides = captureProjectConfigOverrides(flags);
const config = resolveProjectConfig(findProjectRoot(process.cwd()), overrides), context = loadContext(process.cwd(), overrides);
const sessionIndex = args.indexOf("--session"), resumed = sessionIndex >= 0;
const record = { args, cwd: process.cwd(), effectiveConfig: config.effectiveConfig, overrides, review: { maxRepairs: config.maxRepairs, reviewerModel: config.reviewerModel, reviewerThinking: config.reviewerThinking, reviewerCmd: config.reviewerCmd }, preparation: Boolean(loadPreparation(process.cwd(), overrides)), sourceInputs: context ? refreshContext(context).snapshot.inputsFingerprint : undefined, sessionId: resumed ? args[sessionIndex + 1] : "config-fixture-standalone", resumed };
mkdirSync(process.env.FAKE_CONFIG_LOG, { recursive: true });
writeFileSync(join(process.env.FAKE_CONFIG_LOG, "standalone.json"), JSON.stringify(record));
appendFileSync(join(process.env.FAKE_CONFIG_LOG, "history.jsonl"), `${JSON.stringify(record)}\n`);

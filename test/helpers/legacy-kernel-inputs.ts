/** 前两步 b97e154 的只读输入算法夹具：保留旧键与旧元组，不调用当前 checkInputs 或生成新结论。 */
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { findProjectRoot, parseContext, parseMethodsConfig, readMarker } from "../../config.ts";
import { inside, type NodeName } from "../../development-card.ts";
import { managedConfig } from "../../kernel-workspace.ts";
import type { KernelRun } from "../../node-ledger.ts";
const sha = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
export function legacyKernelInputs(run: KernelRun, node: NodeName = "提交") {
  if (run.taskRecords || run.card.flow.includes("验收")) throw new Error("仅用于前两步单任务账本夹具");
  const files: Record<string, string> = {}, task = run.card.tasks[0]; let prompt = "";
  const collect = (path: string, label: string): void => {
    if (!existsSync(path)) { files[label] = "缺失"; return; }
    const s = lstatSync(path); if (s.isSymbolicLink()) throw new Error("旧指纹夹具不跟随链接");
    if (s.isDirectory()) { files[`${label}/`] = "目录"; for (const name of readdirSync(path).sort()) collect(join(path, name), `${label}/${name}`); }
    else { const bytes = readFileSync(path); files[`${label}：${path}`] = sha(Buffer.concat([Buffer.from(`${s.mode & 0o111}:`), bytes])); if (label === "提示词") prompt = bytes.toString("utf8"); }
  };
  collect(run.file, "卡"); collect(task.prompt, "提示词");
  for (const path of run.userFiles ?? []) collect(path, `用户检查输入/${path}`);
  for (const [label, root] of [["原目录", run.repo], ["任务目录", run.worktree]] as const) {
    if (!existsSync(root)) continue;
    for (const path of [...new Set([...run.localFiles, "AGENTS.md", "CLAUDE.md", ".autoreview/经验.md"])]) collect(join(root, path), `${label}/${path}`);
  }
  const configRoot = findProjectRoot(run.repo) ?? run.repo, raw = readMarker(configRoot);
  if (run.inputVersion === 2) for (const [label, root] of [["原目录", run.repo], ["任务目录", run.worktree]] as const) {
    if (!existsSync(root)) continue;
    for (const path of parseMethodsConfig(readMarker(root).methods, root)?.paths ?? []) collect(resolve(root, path), `测试方法/${label}/${path}`);
  }
  const context = parseContext(raw.context, configRoot);
  if (context) for (const source of context.sources.filter((s) => s.role !== "code")) {
    const path = resolve(context.root, source.path); collect(path, `来源/${source.id}`);
    if (inside(run.repo, path) && existsSync(run.worktree)) collect(resolve(run.worktree, relative(run.repo, path)), `任务来源/${source.id}`);
  }
  const config = managedConfig(run.worktree), identityFiles = Object.entries(files).sort(([a], [b]) => a.localeCompare(b));
  let identity: unknown = [identityFiles, run.userVersion, run.userInputs, config.configurationHash, config.reviewerModel, config.reviewerThinking, config.reviewerCmd, run.card.limits.开发评审];
  if (run.inputVersion === 2) {
    const commonFiles = identityFiles.filter(([key]) => !key.startsWith("卡：") && !key.startsWith("测试方法/") && !["原目录/.autoreview.json：", "任务目录/.autoreview.json："].some((prefix) => key.startsWith(prefix)));
    const configs = [run.repo, run.worktree].filter(existsSync).map((root) => readMarker(root));
    const operational = configs.map((c) => Object.fromEntries(Object.entries(c).filter(([key]) => !["gate", "acceptance", "deployment", "preparation", "maxRepairs", "reviewTimeoutMin", "reviewerModel", "reviewerThinking", "reviewerCmd"].includes(key))));
    const common = [commonFiles, operational, run.userVersion, run.userInputs, task.name];
    const review = [common, configs.map((c) => [c.reviewerModel, c.reviewerThinking, c.reviewerCmd]), task.prompt, task.scope, config.reviewerModel, config.reviewerThinking, config.reviewerCmd, run.card.limits.开发评审.timeoutMin];
    const prep = config.preparation;
    const testing = [common, identityFiles.filter(([key]) => key.startsWith("测试方法/")), configs.map((c) => { const p = c.preparation as any; return p ? [p.check, p.recover, p.maxRecoveries, p.timeoutMin] : null; }), task.test, run.card.limits.测试?.timeoutMin ?? 20,
      prep ? { check: prep.check, recover: prep.recover, maxRecoveries: prep.maxRecoveries, timeoutMin: prep.timeoutMin } : null];
    identity = node === "开发评审" ? review : node === "测试" ? testing : [review, testing, run.card.flow, run.cardRevision ?? 0, run.cardHash];
  }
  return { hash: sha(JSON.stringify(identity)), files, requirement: [prompt, ...run.userInputs].join("\n\n") };
}

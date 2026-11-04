/** 仅在配置写入命中后加载。复用 Loop 的只读解析，不执行准备/门禁/开工。 */
import { existsSync } from "node:fs";
import { loadProjectLayout } from "./config.ts";
import { loadConfig } from "./hosts/review-hook.ts";
import { loadBatch } from "./loop.ts";
import { gitText } from "./workspace.ts";
import { checkBatchConfiguration } from "./preflight.ts";

export async function validateProductionFile(file: { path: string; kind: string; root: string }): Promise<string[]> {
  const warnings: string[] = []; // Hook 提醒走结构化上下文，不把迁移提示写到 stderr。
  try {
    if (file.kind === "config") {
      loadProjectLayout(file.root); // release、workspaces、localFiles、methods。
      loadConfig(file.root, {}); // 原有配置解析（含 acceptance、gate、preparation 和预算）。
      return [];
    }
    const { layout } = loadProjectLayout(file.root);
    const root = gitText(file.root, ["rev-parse", "--show-toplevel"]);
    const batch = loadBatch({ root, projectRoot: file.root, layout }, file.path, { warn: (message) => warnings.push(message) });
    const missing = new Set<string>();
    for (const stage of batch.plan.stages.values()) {
      if (stage.prompt && !existsSync(stage.prompt)) missing.add(stage.prompt);
      if (stage.ponytail && !existsSync(stage.ponytail.extension)) missing.add(stage.ponytail.extension);
    }
    const mismatches = checkBatchConfiguration(batch.plan, file.root, { localFileCopies: batch.localFileCopies }).filter((check) => !check.ok)
      .map((check) => check.name.endsWith("的验收说明引用") && /ENOENT/.test(check.detail) ? `尚未找到：${check.detail}` : `${check.name}：${check.detail}`);
    return [...warnings, ...[...missing].map((path) => `尚未找到：${path}`), ...mismatches];
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    // parsePlan 自身会读取验收标准；生产中的文件可以稍后再写，不伪造文件通过校验。
    const missing = /^(?:acceptance|e2e)\.criteria 指的文件不存在：(.*)$/.exec(text); // 兼容旧字段的报错。
    return [...warnings, missing ? `尚未找到：${missing[1]}` : text];
  }
}

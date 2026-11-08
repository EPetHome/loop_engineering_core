/** 配置写入后只读校验；旧批次只诊断，不空跑旧流程。 */
import { loadProjectLayout } from "./config.ts";
import { loadConfig } from "./hosts/review-hook.ts";
import { gitText } from "./workspace.ts";
import { readDevelopmentCard } from "./development-card.ts";
import { managedConfig } from "./kernel-workspace.ts";
import { PIPELINE_MIGRATION } from "./pipeline.ts";
export async function validateProductionFile(file: { path: string; kind: string; root: string }): Promise<string[]> {
  try {
    if (file.kind === "card") {
      const root = gitText(file.root, ["rev-parse", "--show-toplevel"]);
      readDevelopmentCard(file.path, root); managedConfig(root); return [];
    }
    if (file.kind === "config") { loadProjectLayout(file.root); loadConfig(file.root, {}); return []; }
    return [PIPELINE_MIGRATION];
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    return [(error as NodeJS.ErrnoException).code === "ENOENT" ? `尚未找到：${text}` : text];
  }
}

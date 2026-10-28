/** 搬运批次文件时重定位资源引用，保留显式执行/状态目录和日志的原目标。 */
import { dirname, isAbsolute, relative, resolve } from "node:path";

function insideRoot(root: string, absolute: string): string | undefined {
  const rel = relative(root, absolute);
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith("../")) return undefined;
  return rel.split("\\").join("/");
}

/**
 * 提示词和验收标准随 worktree 重定位；仓库外相对引用改成原绝对目标。
 * 其他资源只有列入实际搬运的仓库相对路径 movedFiles 时才跟随，否则固定原目标。
 * cwd、dir、e2e.workDir 和验收日志不是随批次搬运的资源，相对路径固定为原绝对目标。
 */
export function remapBatchReferences(
  raw: Record<string, unknown>, mainRoot: string, batchRoot: string, batchPath: string,
  movedFiles: ReadonlySet<string> = new Set(),
): Record<string, unknown> {
  if (resolve(mainRoot) === resolve(batchRoot)) return structuredClone(raw);
  const batchRel = insideRoot(batchRoot, resolve(batchPath));
  const originalBatch = batchRel ? resolve(mainRoot, batchRel) : resolve(batchPath);
  const originalDir = dirname(originalBatch);
  const remap = (value: unknown): unknown => {
    if (typeof value !== "string" || !value.trim()) return value;
    if (isAbsolute(value)) {
      const rel = insideRoot(mainRoot, resolve(value));
      return rel ? resolve(batchRoot, rel) : value;
    }
    const originalTarget = resolve(originalDir, value);
    return insideRoot(mainRoot, originalTarget) ? value : originalTarget;
  };
  const originalPath = (value: unknown): unknown => {
    if (typeof value !== "string" || !value.trim() || isAbsolute(value.trim())) return value;
    return resolve(originalDir, value.trim());
  };
  const remapDependency = (value: unknown): unknown => {
    if (typeof value !== "string" || !value.trim()) return value;
    const originalTarget = resolve(originalDir, value.trim());
    const rel = insideRoot(mainRoot, originalTarget);
    return rel && movedFiles.has(rel) ? resolve(batchRoot, rel) : originalTarget;
  };
  const remapPonytail = (options: unknown): void => {
    if (!options || typeof options !== "object" || Array.isArray(options)) return;
    const ponytail = (options as Record<string, unknown>).ponytail;
    if (!ponytail || typeof ponytail !== "object" || Array.isArray(ponytail)) return;
    const config = ponytail as Record<string, unknown>;
    if (config.extension !== undefined) config.extension = remapDependency(config.extension);
  };
  const copy = structuredClone(raw);
  if (copy.dir !== undefined) copy.dir = originalPath(copy.dir);
  remapPonytail(copy.pi);
  if (copy.stages && typeof copy.stages === "object" && !Array.isArray(copy.stages)) {
    for (const value of Object.values(copy.stages as Record<string, unknown>)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const stage = value as Record<string, unknown>;
      if (stage.cwd !== undefined) stage.cwd = originalPath(stage.cwd);
      if (stage.prompt !== undefined) stage.prompt = remap(stage.prompt);
      remapPonytail(stage);
    }
  }
  if (copy.e2e && typeof copy.e2e === "object" && !Array.isArray(copy.e2e)) {
    const e2e = copy.e2e as Record<string, unknown>;
    if (e2e.workDir !== undefined) e2e.workDir = originalPath(e2e.workDir);
    if (e2e.criteria !== undefined) e2e.criteria = remap(e2e.criteria);
    if (e2e.acceptance && typeof e2e.acceptance === "object" && !Array.isArray(e2e.acceptance)) {
      const acceptance = e2e.acceptance as Record<string, unknown>;
      if (Array.isArray(acceptance.logs)) acceptance.logs = acceptance.logs.map(originalPath);
      if (acceptance.guide !== undefined) acceptance.guide = remapDependency(acceptance.guide);
      // actions 只允许批次目录内的相对路径，随目录搬运，不改成不合法的绝对路径。
    }
  }
  return copy;
}

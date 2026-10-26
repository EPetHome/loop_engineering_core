/** 把批次文件里的 prompt / e2e.criteria 引用从主 worktree 重定位到批次所在的 worktree。 */
import { dirname, isAbsolute, relative, resolve } from "node:path";

function insideRoot(root: string, absolute: string): string | undefined {
  const rel = relative(root, absolute);
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith("../")) return undefined;
  return rel.split("\\").join("/");
}

/**
 * 仓库内绝对引用改到 batchRoot；仓库外绝对引用不动。
 * 仓库内相对引用保持原样（批次文件的相对位置不变）；原来指向仓库外的相对引用改写成原绝对目标。
 */
export function remapBatchReferences(
  raw: Record<string, unknown>, mainRoot: string, batchRoot: string, batchPath: string,
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
  const copy = structuredClone(raw);
  if (copy.stages && typeof copy.stages === "object" && !Array.isArray(copy.stages)) {
    for (const value of Object.values(copy.stages as Record<string, unknown>)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const stage = value as Record<string, unknown>;
      if (stage.prompt !== undefined) stage.prompt = remap(stage.prompt);
    }
  }
  if (copy.e2e && typeof copy.e2e === "object" && !Array.isArray(copy.e2e)) {
    const e2e = copy.e2e as Record<string, unknown>;
    if (e2e.criteria !== undefined) e2e.criteria = remap(e2e.criteria);
  }
  return copy;
}

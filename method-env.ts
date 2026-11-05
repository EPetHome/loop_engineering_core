/**
 * method-env.ts — loop 交给项目方法的三个环境变量。
 *
 * AUTOREVIEW_BASE_REV 用本段开工依据（会话状态里的 baseline）；批次文件和段名
 * 由启动入口放进环境，没写批次文件时不设置，保持原来的行为。
 */
export interface MethodEnvInput {
  batchFile?: string;
  stage?: string;
}

export function methodEnv(baseRev?: string, input: MethodEnvInput = {}, inherited: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const result: Record<string, string> = {};
  const base = baseRev?.trim() || inherited.AUTOREVIEW_BASE_REV?.trim();
  if (base) result.AUTOREVIEW_BASE_REV = base;
  const batch = input.batchFile?.trim() || inherited.AUTOREVIEW_BATCH_FILE?.trim();
  if (batch) result.AUTOREVIEW_BATCH_FILE = batch;
  const stage = input.stage?.trim() || inherited.AUTOREVIEW_STAGE?.trim();
  if (stage) result.AUTOREVIEW_STAGE = stage;
  return result;
}

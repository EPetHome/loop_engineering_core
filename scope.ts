/**
 * scope.ts — 批次段的越界检查：批次.json 的 scope.allow / scope.deny 解析与匹配。
 *
 * 路径一律相对项目根，按目录前缀匹配；deny 优先。没有写 scope 时不做越界检查。
 */
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { Exec } from "./git.ts";

export interface StageScope {
  /** 只允许这些路径前缀下的改动；没写表示不限制。 */
  allow?: string[];
  /** 落在这些路径前缀下的改动一律越界。 */
  deny?: string[];
}

export type ScopeEnv = Pick<NodeJS.ProcessEnv, "AUTOREVIEW_BATCH_FILE" | "AUTOREVIEW_STAGE">;

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function prefix(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} 必须是非空字符串`);
  const raw = value.trim().replace(/\\/g, "/");
  if (raw.startsWith("/") || /^[A-Za-z]:\//.test(raw)) throw new Error(`${label} 必须是相对项目根的路径前缀：${raw}`);
  const parts: string[] = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") throw new Error(`${label} 不能越出项目根：${raw}`);
    parts.push(part);
  }
  return parts.join("/");
}

function list(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} 必须是非空字符串数组`);
  return value.map((item, index) => prefix(item, `${label}[${index}]`));
}

/** 解析一个段的 scope；没写返回 undefined。字段非法时抛错（说明字段名和原因）。 */
export function parseStageScope(raw: unknown, label: string): StageScope | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) throw new Error(`${label} 必须是 JSON 对象`);
  const allow = raw.allow === undefined ? undefined : list(raw.allow, `${label}.allow`);
  const deny = raw.deny === undefined ? undefined : list(raw.deny, `${label}.deny`);
  return { ...(allow ? { allow } : {}), ...(deny ? { deny } : {}) };
}

const matches = (path: string, prefixes: string[] | undefined): boolean =>
  Boolean(prefixes?.some((item) => item === "" || path === item || path.startsWith(`${item}/`)));

export const inScope = (path: string, scope: StageScope): boolean =>
  !matches(path, scope.deny) && (scope.allow === undefined || matches(path, scope.allow));

/** 越界文件：不在 allow 里或落在 deny 里的文件。 */
export const outOfScope = (paths: string[], scope: StageScope): string[] =>
  paths.filter((path) => !inScope(path, scope));

const pathsFromNul = (text: string): string[] => text.split("\0").filter(Boolean);

/** 从批次文件里取某一段的 scope；没有批次文件、没写段或没写 scope 时返回 undefined。 */
export function loadStageScope(batchFile: string | undefined, stage: string | undefined): StageScope | undefined {
  if (!batchFile || !stage) return undefined;
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(batchFile, "utf8")); }
  catch (error) { throw new Error(`无法读取批次文件 ${batchFile}：${error instanceof Error ? error.message : String(error)}`); }
  if (!isObject(raw)) throw new Error("批次文件必须是 JSON 对象");
  const stages = raw.stages;
  if (!isObject(stages)) throw new Error("批次文件的 stages 必须是对象");
  const value = stages[stage];
  if (value === undefined) return undefined;
  if (!isObject(value)) throw new Error(`批次文件的 stages.${stage} 必须是对象`);
  return parseStageScope(value.scope, `批次文件的 stages.${stage}.scope`);
}

/** 会话环境里带的批次文件与段名；缺一个就不检查。 */
export function stageScopeFromEnv(env: ScopeEnv = process.env): StageScope | undefined {
  return loadStageScope(env.AUTOREVIEW_BATCH_FILE?.trim(), env.AUTOREVIEW_STAGE?.trim());
}

export interface UntrackedMark { path: string; hash: string; mode: string }

/** 开工依据以来改动的文件（相对项目根，含未跟踪文件），按路径排序。 */
export async function changedSince(
  exec: Exec, projectRoot: string, baseRev: string,
  options: { signal?: AbortSignal; timeout?: number; baselineUntracked?: UntrackedMark[] } = {},
): Promise<string[]> {
  const run = async (args: string[]): Promise<string> => {
    const res = await exec("git", ["-c", "core.quotePath=false", "-C", projectRoot, ...args],
      { cwd: projectRoot, timeout: options.timeout ?? 30_000, signal: options.signal });
    if (res.code !== 0 || res.killed) {
      const detail = (res.stderr || res.stdout || "无错误输出").trim().slice(-300);
      throw new Error(`无法对比开工依据 ${baseRev}：git ${args.join(" ")}（退出码 ${res.code}）${detail}`);
    }
    return res.stdout;
  };
  const repoRoot = (await run(["rev-parse", "--show-toplevel"])).trim();
  if (!repoRoot) throw new Error("无法读取仓库根目录，不能做越界检查");
  // git 返回真实路径；项目根可能经过 /tmp 之类的符号链接，先统一成真实路径再换算。
  const canonicalProject = realpathSync(projectRoot);
  const canonicalRepo = realpathSync(repoRoot);
  // 不识别重命名：源路径和目标路径都要进入检查，避免「从禁止目录移入允许目录」漏检。
  const tracked = pathsFromNul(await run(["diff", "--name-only", "--no-renames", "-z", baseRev, "--"]));
  const untracked = pathsFromNul(await run(["ls-files", "--others", "--exclude-standard", "-z"]));
  const toProject = (path: string): string => relative(canonicalProject, resolve(canonicalRepo, path)).replace(/\\/g, "/");
  const baseline = new Map((options.baselineUntracked ?? []).map((item) => [item.path, item]));
  const changedUntracked: string[] = [];
  const currentUntracked = new Set(untracked);
  for (const path of untracked) {
    const old = baseline.get(path);
    if (!old) { changedUntracked.push(path); continue; }
    const hash = (await run(["hash-object", "--", path])).trim();
    const info = lstatSync(resolve(projectRoot, path));
    const mode = info.isSymbolicLink() ? "120000" : (info.mode & 0o111) !== 0 ? "100755" : "100644";
    // 只豁免开工时已经存在、内容与模式都没变的未跟踪文件。
    if (old.hash !== hash || old.mode !== mode) changedUntracked.push(path);
  }
  // 开工时已有、现在删除的未跟踪文件也是改动；转成受跟踪后的变化由上面的 diff 列出。
  for (const path of baseline.keys()) {
    if (!currentUntracked.has(path) && !existsSync(resolve(projectRoot, path))) changedUntracked.push(path);
  }
  return [...new Set([...tracked.map(toProject), ...changedUntracked])].filter(Boolean).sort();
}

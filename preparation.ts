/** 项目拥有准备方法；Loop 只执行有效方法、有限恢复和必要的方法修复。 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { EXT_DIR, findProjectRoot, PI_BIN, readMarker } from "./config.ts";
import { classifyFailure, type FailureKind } from "./failure.ts";
import { createRunResource, managedShell, releaseRunResource, resourceLine } from "./resources.ts";
import { createGitEvidence, type Exec } from "./git.ts";

export interface PreparationConfig {
  root: string;
  check: string;
  recover?: string;
  timeoutMin: number;
  maxRecoveries: number;
  maxRepairs: number;
  repair?: { model: string; thinking: string; paths: string[]; ponytail?: string };
}

export interface PreparationState {
  preparationAttempts?: { environment: number; method: number };
}

export interface PreparationResult {
  ok: boolean;
  kind?: FailureKind;
  reason?: string;
  log: string;
}

const object = (raw: unknown, label: string): Record<string, unknown> => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${label} 必须是对象`);
  return raw as Record<string, unknown>;
};
const string = (raw: unknown, label: string): string => {
  if (typeof raw !== "string" || !raw.trim()) throw new Error(`${label} 必须是非空字符串`);
  return raw.trim();
};
const number = (raw: unknown, fallback: number, label: string, min = 0): number => {
  const value = raw ?? fallback;
  if (!Number.isSafeInteger(value) || (value as number) < min) throw new Error(`${label} 必须是大于等于 ${min} 的整数`);
  return value as number;
};

export function parsePreparation(raw: unknown, root: string): PreparationConfig | undefined {
  if (raw === undefined) return undefined;
  const data = object(raw, "preparation");
  let repair: PreparationConfig["repair"];
  if (data.repair !== undefined) {
    const r = object(data.repair, "preparation.repair");
    if (!Array.isArray(r.paths) || !r.paths.length) throw new Error("preparation.repair.paths 必须列出允许修改的项目文件或目录");
    const paths = r.paths.map((value) => {
      const path = string(value, "preparation.repair.paths");
      const rel = relative(resolve(root), resolve(root, path));
      if (isAbsolute(path) || !rel || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
        || /(^|[/\\])(AGENTS\.md|CLAUDE\.md|\.git|\.autoreview\.json)([/\\]|$)/.test(path)) {
        throw new Error(`preparation.repair.paths 不能越出项目、指向整个项目或稳定规则：${path}`);
      }
      return rel;
    });
    repair = { model: string(r.model, "preparation.repair.model"), thinking: string(r.thinking ?? "high", "preparation.repair.thinking"), paths,
      ...(r.ponytail !== undefined ? { ponytail: resolve(root, string(r.ponytail, "preparation.repair.ponytail")) } : {}) };
  }
  return {
    root: resolve(root), check: string(data.check, "preparation.check"),
    recover: data.recover === undefined ? undefined : string(data.recover, "preparation.recover"),
    timeoutMin: number(data.timeoutMin, 10, "preparation.timeoutMin", 1),
    maxRecoveries: number(data.maxRecoveries, 1, "preparation.maxRecoveries"),
    maxRepairs: number(data.maxRepairs, 1, "preparation.maxRepairs"), repair,
  };
}

export function loadPreparation(cwd: string): PreparationConfig | undefined {
  const root = findProjectRoot(cwd);
  return root ? parsePreparation(readMarker(root).preparation, root) : undefined;
}

export interface PreparationDeps {
  procsFile?: string;
  config: PreparationConfig;
  cwd: string;
  state: PreparationState;
  exec: Exec;
  runDir: string;
  signal?: AbortSignal;
  saveState: () => void | Promise<void>;
  onProgress?: (text: string) => void;
  /** 已知阻塞时先恢复；成功后仍须重新检查条件。 */
  failure?: FailureKind;
  evidence?: string;
}

/** 自动动作只改 preparationAttempts，不接触业务 repairs；计数在动作前持久化。 */
async function prepare(deps: PreparationDeps): Promise<PreparationResult> {
  const { config, state, exec, signal } = deps;
  mkdirSync(deps.runDir, { recursive: true });
  state.preparationAttempts ??= { environment: 0, method: 0 };
  const attempts = state.preparationAttempts;
  const rules = ["AGENTS.md", "CLAUDE.md", ".autoreview.json"].map((name) => {
    const path = join(config.root, name);
    try { return { path, content: readFileSync(path) }; } catch { return { path, content: undefined }; }
  });
  const unchangedRules = (): boolean => rules.every(({ path, content }) => {
    try { const current = readFileSync(path); return content !== undefined && current.equals(content); }
    catch { return content === undefined; }
  });
  const logPath = join(deps.runDir, "preparation.log");
  const log = (line: string): void => {
    let previous = ""; try { previous = readFileSync(logPath, "utf8"); } catch { /* first record */ }
    writeFileSync(logPath, `${previous}${new Date().toISOString()} ${line}\n`);
  };
  const timeout = config.timeoutMin * 60_000;
  const deadline = Date.now() + timeout;
  log(`prepare ${deps.evidence ?? "运行条件检查"}`);
  const git = createGitEvidence(exec, deps.cwd, signal);
  const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  const shell = (cmd: string) => `export AUTOREVIEW_RUN_DIR=${quote(deps.runDir)}; ${cmd}`;
  const options = (role: string) => ({ cwd: deps.cwd, timeout: Math.max(1, deadline - Date.now()), signal, role });
  let failure = deps.failure;
  for (;;) {
    signal?.throwIfAborted();
    if (Date.now() >= deadline) return { ok: false, kind: "environment", reason: "准备时间预算已用完", log: logPath };
    if (failure) {
      const before = await git.snapshot();
      const action = failure;
      if (failure === "environment" && config.recover && attempts.environment < config.maxRecoveries) {
        attempts.environment += 1; await deps.saveState();
        deps.onProgress?.("准备：执行已有环境恢复方法（保留业务返修计数）");
        const result = await exec("/bin/sh", ["-c", shell(config.recover)], options("环境恢复"));
        log(`recover #${attempts.environment} exit=${result.code}\n${result.stdout}\n${result.stderr}`);
        if (result.code !== 0 || result.killed) return { ok: false, kind: "environment", reason: "环境恢复未成功，保留现场", log: logPath };
      } else if (failure === "method" && config.repair && attempts.method < config.maxRepairs) {
        attempts.method += 1; await deps.saveState();
        deps.onProgress?.("准备：方法失效，调用受限准备模型");
        const input = join(deps.runDir, `repair-${attempts.method}.md`);
        writeFileSync(input, [
          "只修复项目准备方法，不实现业务功能，不修改用户要求、验收标准、稳定规则或 .autoreview.json。",
          `允许修改：${config.repair.paths.join("、")}。使用 read/edit/write 工具；不得降低门禁、跳过失败或用空成功替代检查。`,
          `准备命令：${config.check}`, "此前运行证据：", readFileSync(logPath, "utf8").slice(-6000),
          "完成时说明根因、变更及仍未确认的条件。程序会按原命令独立重查。",
        ].join("\n\n"));
        const result = await exec("/usr/bin/env", [
          ...(config.repair.ponytail ? ["PONYTAIL_DEFAULT_MODE=full"] : []),
          `AUTOREVIEW_PREP_ROOT=${config.root}`, `AUTOREVIEW_PREP_PATHS=${JSON.stringify(config.repair.paths)}`,
          PI_BIN, "--offline", "-p", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
          "--tools", "read,edit,write,grep,find,ls", "-e", join(EXT_DIR, "preparation-guard.ts"),
          ...(config.repair.ponytail ? ["-e", config.repair.ponytail] : []),
          "--model", config.repair.model, "--thinking", config.repair.thinking, `@${input}`,
        ], options("准备方法修复"));
        log(`repair #${attempts.method} exit=${result.code}\n${result.stdout}\n${result.stderr}`);
        if (result.code !== 0 || result.killed) return { ok: false, kind: "method", reason: "准备方法修复未完成", log: logPath };
      } else return { ok: false, kind: failure, reason: "缺少对应恢复方法，或该类准备重试预算已用完", log: logPath };
      if (!unchangedRules()) return { ok: false, kind: "method", reason: "准备过程改动了稳定规则或配置，拒绝继续", log: logPath };
      const after = await git.snapshot();
      const changed = await git.changedFiles(before, after);
      if (changed.some((path) => action !== "method" || !config.repair?.paths.some((allowed) => {
        const target = resolve(deps.cwd, path), entry = resolve(config.root, allowed);
        return target === entry || target.startsWith(`${entry}/`);
      }))) return { ok: false, kind: "method", reason: `准备动作越出修改范围：${changed.join("、")}`, log: logPath };
    }
    deps.onProgress?.("准备：检查本次运行条件");
    const beforeCheck = await git.snapshot();
    const result = await exec("/bin/sh", ["-c", shell(config.check)], options("准备检查"));
    log(`check exit=${result.code}\n${result.stdout}\n${result.stderr}`);
    if (!unchangedRules()) return { ok: false, kind: "method", reason: "准备检查改动了稳定规则或配置，拒绝继续", log: logPath };
    if ((await git.snapshot()).fingerprint !== beforeCheck.fingerprint) return { ok: false, kind: "method", reason: "准备检查改动了产品工作区；输出应写到运行目录", log: logPath };
    if (result.code === 0 && !result.killed) return { ok: true, log: logPath };
    failure = classifyFailure(result.code, `${result.stdout}\n${result.stderr}`, result.killed).kind;
    if (failure === "product" || failure === "unknown") return { ok: false, kind: failure, reason: "准备检查未通过，需要诊断证据，不修改产品绕过准备", log: logPath };
  }
}

/** 准备同样拥有临时资源；日志保留，脚本临时产物按归属释放。 */
export async function runPreparation(deps: PreparationDeps): Promise<PreparationResult> {
  const resource = createRunResource(`preparation:${deps.cwd}`, 0, deps.procsFile);
  const exec: Exec = (command, args, options) => {
    if (command === "/bin/sh" && args[0] === "-c") return deps.exec(command, ["-c", managedShell(args[1], resource)], options);
    if (options.role === "准备方法修复") return deps.exec("/usr/bin/env", [
      `AUTOREVIEW_RUN_ID=${resource.id}`, `AUTOREVIEW_TEMP_DIR=${resource.dir}`, `AUTOREVIEW_EVIDENCE_DIR=${resource.evidenceDir}`, `TMPDIR=${resource.evidenceDir}`, command, ...args,
    ], options);
    return deps.exec(command, args, options);
  };
  let result: PreparationResult;
  try { result = await prepare({ ...deps, exec }); }
  finally { releaseRunResource(resource); }
  if (resource.status !== "released") return { ok: false, kind: "environment", reason: resourceLine(resource), log: result.log };
  return result;
}

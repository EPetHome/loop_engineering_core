/** 项目拥有准备方法；Loop 只执行有效方法、有限恢复和必要的方法修复。 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { EXT_DIR, findProjectRoot, PI_BIN, resolveProjectConfig, type ProjectConfigOverrides } from "./config.ts";
export { parsePreparation } from "./config.ts";
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

export function loadPreparation(cwd: string, overrides: ProjectConfigOverrides = {}): PreparationConfig | undefined {
  return resolveProjectConfig(findProjectRoot(cwd), overrides).preparation;
}

export interface PreparationDeps {
  procsFile?: string;
  config: PreparationConfig;
  cwd: string;
  state: PreparationState;
  exec: Exec;
  /** 交给项目方法的环境变量（AUTOREVIEW_BASE_REV 等）；只覆盖指定项。 */
  env?: NodeJS.ProcessEnv;
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
  const options = (role: string) => ({ cwd: deps.cwd, timeout: Math.max(1, deadline - Date.now()), signal, role, ...(deps.env ? { env: deps.env } : {}) });
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
          `允许修改：${config.repair.paths.join("、")}。使用 read/edit/write 工具；不得降低检查标准、跳过失败或用空成功替代检查。`,
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

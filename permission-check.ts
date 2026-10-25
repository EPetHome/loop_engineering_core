#!/usr/bin/env node
/**
 * permission-check.ts — 启动入口的权限自动执行检查。
 *
 * 用项目实际的 Pi 权限配置（全局 + 项目）加载权限扩展，模拟 edit、write、bash 三个工具调用，
 * 有询问或拒绝就报错退出；不执行工具、不调用模型、不改用户配置。检查记录挂在方法指纹上，
 * 指纹不变时第二次启动直接跳过。
 */
import { mkdtempSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PI_BIN, PERMISSION_EXT } from "./config.ts";
import { currentMethodsFingerprint, recordPermissionCheck } from "./methods.ts";
import { PIPELINE_DIR_ENV, PIPELINE_LAUNCH_TOKEN_ENV, STAGE_ENV, writeStageStatus } from "./pipeline-core.ts";

interface Probe { name: string; toolName: string; input: Record<string, unknown> }
type NativeResult = { available: true; ok: boolean; reason?: string } | { available: false; reason: string };
type TrustMode = "auto" | "yes" | "no";

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
const readJson = (path: string): Record<string, unknown> | undefined => {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
  } catch { return undefined; }
};

function argsOf(argv: string[]): { cwd: string; loopRoot: string; pi: string; permission: string; trust: TrustMode } {
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const trust = value("--trust") ?? "auto";
  if (trust !== "auto" && trust !== "yes" && trust !== "no") throw new Error(`--trust 只能是 auto、yes 或 no：${trust}`);
  return {
    cwd: resolve(value("--cwd") ?? process.cwd()),
    loopRoot: resolve(value("--loop-root") ?? dirname(fileURLToPath(import.meta.url))),
    pi: value("--pi") ?? PI_BIN,
    permission: value("--permission") ?? PERMISSION_EXT,
    trust,
  };
}

const canonical = (path: string): string => {
  try { return realpathSync(path); } catch { return resolve(path); }
};

/** 与 Pi 的 hasTrustRequiringProjectResources 对齐：项目里有这些资源时才需要项目信任。 */
function needsProjectTrust(cwd: string): boolean {
  const configDir = join(cwd, ".pi");
  if (["settings.json", "mcp.json", "extensions", "skills", "prompts", "themes", "SYSTEM.md", "APPEND_SYSTEM.md"]
    .some((name) => existsSync(join(configDir, name)))) return true;
  let dir = canonical(cwd);
  for (;;) {
    if (existsSync(join(dir, ".agents", "skills"))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/** 全局设置里的 defaultProjectTrust；没有设置按 ask，非法值明确失败。 */
function defaultProjectTrust(agentDir: string): "always" | "never" | "ask" {
  const file = join(agentDir, "settings.json");
  if (!existsSync(file)) return "ask";
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, "utf8")); }
  catch (error) { throw new Error(`无法读取全局设置 ${file}：${errorText(error)}`); }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`全局设置不是 JSON 对象：${file}`);
  const value = (raw as Record<string, unknown>).defaultProjectTrust;
  if (value === undefined || value === "ask") return "ask";
  if (value === "always" || value === "never") return value;
  throw new Error(`全局设置 defaultProjectTrust 只能是 always、never 或 ask：${String(value)}`);
}

/** 按真实 Pi 的顺序判断项目是否受信任：本次参数 → 是否需要信任 → trust.json → 全局默认。 */
function trustDecision(cwd: string, mode: TrustMode, agentDir: string): boolean {
  if (mode === "yes") return true;
  if (mode === "no") return false;
  if (!needsProjectTrust(cwd)) return true;
  const file = join(agentDir, "trust.json");
  let decisions = new Map<string, boolean>();
  if (existsSync(file)) {
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(file, "utf8")); }
    catch (error) { throw new Error(`无法读取项目信任记录 ${file}：${errorText(error)}`); }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`项目信任记录不是 JSON 对象：${file}`);
    for (const [path, value] of Object.entries(raw as Record<string, unknown>)) {
      if (value === true || value === false) decisions.set(canonical(path), value);
      else if (value !== null) throw new Error(`项目信任记录里 ${path} 的值无效`);
    }
  }
  let dir = canonical(cwd);
  for (;;) {
    const found = decisions.get(dir);
    if (found !== undefined) return found;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  switch (defaultProjectTrust(agentDir)) {
    case "always": return true;
    case "never": return false;
    default: return false; // 检查没有交互界面；ask 等于会询问，不能算自动执行
  }
}

/** 启动入口失败时把原因写回流水线，避免编排程序一直等一个还没启动的会话。 */
function reportStartupFailure(reason: string): void {
  const dir = process.env[PIPELINE_DIR_ENV]?.trim();
  const stage = process.env[STAGE_ENV]?.trim();
  if (!dir || !stage || !process.env[PIPELINE_LAUNCH_TOKEN_ENV]) return;
  try {
    writeStageStatus({ dir, stage }, { sessionId: "startup", summary: "", event: "startup-failed", inbox: 0,
      pauseReason: `权限自动执行检查未通过：${reason}` });
  } catch { /* 写不回状态时仍以非零退出；编排程序会看到进程退出 */ }
}

/** 从实际全局配置复制一份到沙箱，避免检查写用户的日志或改配置；项目配置仍从 cwd 读。 */
function sandboxAgent(actual: string): { dir: string; restore: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "loop-permission-check-"));
  const source = join(actual, "extensions", "pi-permission-system", "config.json");
  const target = join(dir, "extensions", "pi-permission-system", "config.json");
  if (existsSync(source)) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(source));
  }
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  return {
    dir,
    restore: () => {
      if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 按参考做法调用权限扩展自己的 tool_call 处理器；不执行工具、不调用模型。 */
async function nativeCheck(cwd: string, pi: string, permission: string, trusted: boolean): Promise<NativeResult> {
  let dist: string;
  try { dist = resolve(dirname(realpathSync(pi)), ".."); }
  catch (error) { return { available: false, reason: `找不到 pi（${pi}）：${errorText(error)}` }; }
  const loaderPath = join(dist, "core", "extensions", "loader.js");
  if (!existsSync(loaderPath)) return { available: false, reason: `找不到 Pi 扩展加载器：${loaderPath}` };

  const actualAgent = process.env.PI_CODING_AGENT_DIR ? resolve(process.env.PI_CODING_AGENT_DIR) : join(homedir(), ".pi", "agent");
  const sandbox = sandboxAgent(actualAgent);
  let permissionExtension: { handlers: Map<string, Array<(event: unknown, ctx: unknown) => unknown>> } | undefined;
  let ctx: Record<string, unknown> | undefined;
  try {
    const { loadExtensions } = await import(pathToFileURL(loaderPath).href) as {
      loadExtensions: (paths: string[], cwd: string) => Promise<{
        errors: unknown[]; extensions: Array<{ path: string; handlers: Map<string, Array<(event: unknown, ctx: unknown) => unknown>> }>;
        runtime: { getAllTools?: unknown; getActiveTools?: unknown; setActiveTools?: unknown };
      }>;
    };
    const loaded = await loadExtensions([permission], cwd);
    if (loaded.errors.length > 0) return { available: false, reason: `权限扩展加载失败：${loaded.errors.map(errorText).join("；")}` };
    permissionExtension = loaded.extensions.find((entry) => resolve(entry.path) === resolve(permission));
    if (!permissionExtension) return { available: false, reason: `权限扩展没有加载：${permission}` };
    const handlers = permissionExtension.handlers.get("tool_call") ?? [];
    if (handlers.length === 0) return { available: false, reason: "权限扩展没有 tool_call 处理器" };

    const toolsUrl = pathToFileURL(join(dist, "core", "tools", "index.js")).href;
    const sessionUrl = pathToFileURL(join(dist, "core", "session-manager.js")).href;
    const [{ createCodingToolDefinitions }, { SessionManager }] = await Promise.all([import(toolsUrl), import(sessionUrl)]) as [
      { createCodingToolDefinitions: (cwd: string) => unknown }, { SessionManager: { inMemory: (cwd: string) => unknown } },
    ];
    const definitions = createCodingToolDefinitions(cwd);
    let active = ["read", "edit", "write", "bash"];
    loaded.runtime.getAllTools = () => definitions;
    loaded.runtime.getActiveTools = () => active;
    loaded.runtime.setActiveTools = (names: unknown) => { if (Array.isArray(names)) active = names; };
    let prompts = 0;
    ctx = {
      cwd, hasUI: false, isProjectTrusted: () => trusted, isIdle: () => true, hasPendingMessages: () => false,
      sessionManager: SessionManager.inMemory(cwd),
      ui: { notify() {}, setStatus() {}, async select() { prompts += 1; throw new Error("出现非预期授权"); },
        async custom() { prompts += 1; throw new Error("出现非预期授权"); } },
    };
    for (const handler of permissionExtension.handlers.get("session_start") ?? []) await handler({ type: "session_start" }, ctx);

    const probePath = join(cwd, ".loop-permission-probe");
    const probes: Probe[] = [
      { name: "bash", toolName: "bash", input: { command: "loop-permission-check-probe" } },
      { name: "edit", toolName: "edit", input: { path: probePath, oldText: "probe", newText: "probe" } },
      { name: "write", toolName: "write", input: { path: probePath, content: "probe" } },
    ];
    for (const probe of probes) {
      for (const handler of handlers) {
        let outcome: unknown;
        try { outcome = await handler({ type: "tool_call", toolCallId: `loop-permission-${probe.name}`, toolName: probe.toolName, input: probe.input }, ctx); }
        catch (error) { return { available: true, ok: false, reason: `${probe.name} 检查失败：${errorText(error)}` }; }
        const blocked = outcome !== null && typeof outcome === "object" && (outcome as { block?: unknown }).block === true;
        if (blocked) {
          const reason = (outcome as { reason?: unknown }).reason;
          return { available: true, ok: false, reason: `${probe.name} 会询问或拒绝：${typeof reason === "string" && reason.trim() ? reason.trim() : "权限扩展返回 block"}` };
        }
      }
    }
    if (prompts > 0) return { available: true, ok: false, reason: `检查期间出现 ${prompts} 次授权询问` };
    return { available: true, ok: true };
  } catch (error) {
    return { available: true, ok: false, reason: `权限扩展检查失败：${errorText(error)}` };
  } finally {
    if (permissionExtension && ctx) {
      for (const handler of permissionExtension.handlers.get("session_shutdown") ?? []) {
        try { await handler({ type: "session_shutdown" }, ctx); } catch { /* 收尾失败不改变检查结论 */ }
      }
    }
    sandbox.restore();
  }
}

function actionOf(value: unknown): "allow" | "ask" | "deny" {
  if (typeof value === "string") return value === "allow" || value === "deny" ? value : "ask";
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const action = (value as { action?: unknown }).action;
    return action === "allow" || action === "deny" ? action : "ask";
  }
  return "ask";
}

function categoryAction(project: Record<string, unknown>, global: Record<string, unknown>, key: string): "allow" | "ask" | "deny" {
  const permissionOf = (data: Record<string, unknown>): Record<string, unknown> | undefined => {
    const permission = data.permission;
    return permission !== null && typeof permission === "object" && !Array.isArray(permission)
      ? permission as Record<string, unknown> : undefined;
  };
  const projectPermission = permissionOf(project), globalPermission = permissionOf(global);
  const value = projectPermission?.[key] ?? globalPermission?.[key];
  const direct = actionOf(value);
  if (direct === "allow" || direct === "deny") return direct;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const map = value as Record<string, unknown>;
    const wildcard = map["*"];
    if (wildcard !== undefined) return actionOf(wildcard);
  }
  return "ask";
}

/** 加载器不可用或扩展是测试替身时的保守判断：只看全局与项目配置里明确写出的 allow/deny。 */
function configCheck(cwd: string, trusted: boolean, agentDir: string): { ok: boolean; reason?: string } {
  const globalPath = join(agentDir, "extensions", "pi-permission-system", "config.json");
  const projectPath = join(cwd, ".pi", "extensions", "pi-permission-system", "config.json");
  const rawGlobal = existsSync(globalPath) ? readJson(globalPath) : undefined;
  if (existsSync(globalPath) && rawGlobal === undefined) return { ok: false, reason: `全局权限配置不是合法的 JSON 对象：${globalPath}` };
  const global = rawGlobal ?? {};
  const rawProject = trusted && existsSync(projectPath) ? readJson(projectPath) : undefined;
  if (trusted && existsSync(projectPath) && rawProject === undefined) return { ok: false, reason: `项目权限配置不是合法的 JSON 对象：${projectPath}` };
  const project = rawProject ?? {};
  const yolo = typeof project.yoloMode === "boolean" ? project.yoloMode : global.yoloMode === true;
  const problems: string[] = [];
  for (const key of ["bash", "edit", "write"]) {
    const action = categoryAction(project, global, key);
    if (action === "deny") problems.push(`${key} 被明确禁止`);
    else if (!yolo && action !== "allow") problems.push(`${key} 会询问（没有 yoloMode 且没有明确 allow）`);
  }
  return problems.length ? { ok: false, reason: problems.join("；") } : { ok: true };
}

function fail(reason: string): number {
  reportStartupFailure(reason);
  console.error(`pi-dev: 权限自动执行检查未通过：${reason}`);
  console.error("pi-dev: 请修改项目的 Pi 权限配置（或全局配置）让这三类工具自动执行；本检查不会改你的配置。");
  return 2;
}

async function main(): Promise<number> {
  const args = argsOf(process.argv.slice(2));
  const { fingerprint, components, record } = currentMethodsFingerprint(args.cwd, args.loopRoot);
  if (record?.permissionFingerprint === fingerprint) return 0;

  const agentDir = process.env.PI_CODING_AGENT_DIR ? resolve(process.env.PI_CODING_AGENT_DIR) : join(homedir(), ".pi", "agent");
  let trusted: boolean;
  try { trusted = trustDecision(args.cwd, args.trust, agentDir); }
  catch (error) { return fail(errorText(error)); }

  const native = await nativeCheck(args.cwd, args.pi, args.permission, trusted);
  const result = native.available ? { ok: native.ok, reason: native.reason } : configCheck(args.cwd, trusted, agentDir);
  if (!result.ok) return fail(result.reason ?? "开发会话不能不经询问执行 edit、write 和 bash");
  try { recordPermissionCheck(args.cwd, fingerprint, components); }
  catch (error) { return fail(`检查通过，但记录失败：${errorText(error)}`); }
  return 0;
}

main().then((code) => { process.exitCode = code; }).catch((error) => {
  process.exitCode = fail(errorText(error));
});

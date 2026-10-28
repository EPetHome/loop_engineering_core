/** 本机 Claude Code / Codex 开发入口；评审与验收仍由已安装的 Loop Hook 执行。 */
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { EXT_DIR, findProjectRoot, PERMISSION_EXT, PI_BIN } from "../config.ts";
import { endHostExperienceSessions, loadConfig } from "./hook.ts";

const HELP = `用法：bin/loop-dev <claude|codex> [任务文件] [选项] [-- 宿主参数…]
  --cwd <目录>       开发目录，默认当前目录
  --init             没有 .autoreview.json 时创建 {}，不覆盖已有配置
  --session <ID>     恢复指定开发会话，不自动选择最近会话
  --dry-run          核对本机接入并打印命令，不启动、不写配置
  --help            显示帮助
默认 Claude Code 使用 auto，Codex 使用自动审批；保留宿主 deny 和沙箱。
CLAUDE_BIN / CODEX_BIN 可指定程序；不安装、升级或修改全局配置。`;

type Host = "claude" | "codex";
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

export function launchArgs(host: Host, prompt?: string, session?: string, extra: string[] = []): string[] {
  const args = host === "claude"
    ? ["--permission-mode", "auto", ...(session ? ["--resume", session] : [])]
    : [...(session ? ["resume", session] : []), "--approve-for-me"];
  args.push(...extra);
  // 保留 @引用：文件里的“同意授权”不能变成亲手输入的授权。
  if (prompt) {
    if (/["\r\n]/.test(prompt)) throw new Error("任务文件路径不能含双引号或换行");
    args.push(`请读取并执行 @"${prompt}"`);
  }
  return args;
}

export function resolveHost(host: Host, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env[host === "claude" ? "CLAUDE_BIN" : "CODEX_BIN"];
  const candidates = explicit ? [explicit] : [host, ...(host === "codex" ? [
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
  ] : [])];
  for (const command of candidates) {
    const result = spawnSync(command, ["--version"], { env, encoding: "utf8", timeout: 5000 });
    if (result.status === 0) return command;
  }
  throw new Error(`没有可运行的 ${host}；请通过 ${host === "claude" ? "CLAUDE_BIN" : "CODEX_BIN"} 指定已安装程序`);
}

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 15000 });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} 失败：${result.error?.message ?? result.stderr}`);
  return result.stdout;
}

/** 只比较 Hook 定义，忽略各 checkout 的 hosts/hook.ts 绝对路径；路径另行要求指向当前检出。 */
function hookShape(value: unknown): string {
  const clone = value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const groupLists = Array.isArray(clone) ? [clone] : Object.values(clone ?? {});
  for (const groups of groupLists) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!Array.isArray(group?.hooks)) continue;
      for (const hook of group.hooks) {
        if (typeof hook?.command === "string") hook.command = hook.command.replace(/\S*\/hosts\/hook\.ts/g, "<hook>");
      }
    }
  }
  return JSON.stringify(clone);
}

export function checkPlugin(host: Host, listing: any, read = (path: string) => readFileSync(path, "utf8")): void {
  const items = host === "claude" ? listing : listing.installed;
  const plugin = Array.isArray(items) && items.find((p) => (p.id ?? p.pluginId) === "autoreview@autoreview-local" && p.enabled);
  if (!plugin) throw new Error(`${host} 未启用 autoreview@autoreview-local；按 README 的宿主接入步骤安装并启用`);
  const cached = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "plugins/cache/autoreview-local/autoreview", plugin.version ?? "");
  const root = host === "claude" ? plugin.installPath : existsSync(cached) ? cached : plugin.source?.path;
  if (!root) throw new Error("无法定位已安装的 Loop 插件");
  const actual = JSON.parse(read(join(root, "hooks/hooks.json")));
  const expected = JSON.parse(readFileSync(join(EXT_DIR, "plugins/autoreview/hooks/hooks.json"), "utf8"));
  for (const event of ["SessionStart", "UserPromptSubmit", "Stop"]) {
    if (hookShape(actual.hooks?.[event]) !== hookShape(expected.hooks[event])) {
      throw new Error(`${host} 的 ${event} Hook 与当前 Loop 不一致；更新插件后重新启动`);
    }
    const command = actual.hooks?.[event]?.[0]?.hooks?.[0]?.command;
    if (typeof command !== "string" || !command.includes(join(EXT_DIR, "hosts/hook.ts"))) {
      throw new Error("插件仍指向另一份 Loop；先更新 hooks/hooks.json 的本机 Node 与仓库路径");
    }
  }
}

/** 启动宿主时注入项目根；没有配置时（--init 尚未写入）就是启动目录。 */
export function hostEnv(cwd: string, root: string | undefined, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, AUTOREVIEW_DEV_ROOT: root ?? cwd };
}

export function main(argv = process.argv.slice(2)): void {
  const separator = argv.indexOf("--");
  const extra = separator < 0 ? [] : argv.slice(separator + 1);
  const { values, positionals } = parseArgs({
    args: separator < 0 ? argv : argv.slice(0, separator), allowPositionals: true,
    options: { cwd: { type: "string" }, session: { type: "string" }, init: { type: "boolean" }, "dry-run": { type: "boolean" }, help: { type: "boolean" } },
  });
  if (values.help) { console.log(HELP); return; }
  const [host, task] = positionals;
  if ((host !== "claude" && host !== "codex") || positionals.length > 2) throw new Error(HELP);
  const cwd = realpathSync(values.cwd ?? process.cwd());
  const prompt = task ? realpathSync(resolve(task.replace(/^@/, ""))) : undefined;
  if (prompt && (!statSync(prompt).isFile() || statSync(prompt).size > 200 * 1024 || readFileSync(prompt).includes(0))) {
    throw new Error("任务文件须为不超过 200KB 的文本文件（与 Hook 读取上限一致）");
  }
  const args = launchArgs(host, prompt, values.session, extra);
  const root = findProjectRoot(cwd);
  if (root) loadConfig(root);
  else if (!values.init) throw new Error("项目没有 .autoreview.json；首次接入加 --init，或先配置已有的门禁和验收方法");
  run("git", ["rev-parse", "--verify", "HEAD"], cwd);
  for (const path of [PI_BIN, PERMISSION_EXT]) if (!existsSync(path)) throw new Error(`现有评审引擎缺少：${path}`);
  const command = resolveHost(host);
  const help = run(command, ["--help"], cwd);
  if (!help.includes(host === "claude" ? '"auto"' : "--approve-for-me")) throw new Error(`${host} 当前版本不支持所需自动审批入口`);
  checkPlugin(host, JSON.parse(run(command, ["plugin", "list", ...(host === "codex" ? ["--marketplace", "autoreview-local"] : []), "--json"], cwd)));
  if (values["dry-run"]) {
    if (!root) console.log(`启动时将新建 ${join(cwd, ".autoreview.json")}（仅开启评审，门禁和验收未配置）`);
    const devRoot = root ?? cwd;
    // 无空格时打印成可直接核对的 KEY=值；有空格再按 shell 规则加引号。
    console.log(`cd ${quote(cwd)}\nAUTOREVIEW_DEV_ROOT=${/\s/.test(devRoot) ? quote(devRoot) : devRoot}\n${[command, ...args].map(quote).join(" ")}`);
    console.log("已核对程序、插件和配置；未启动模型，未验证实际自动审批。Codex 的 Hook 信任请在 /hooks 查看。");
    return;
  }
  if (!root) writeFileSync(join(cwd, ".autoreview.json"), "{}\n", { flag: "wx" });
  console.error(`[Loop] ${host} 开发宿主；评审与验收沿用 Pi 引擎。${host === "codex" ? "若提示 Hook 未信任，先在 /hooks 审阅并信任。" : ""}`);
  const runId = randomUUID();
  const child = spawn(command, args, { cwd, stdio: "inherit", env: { ...hostEnv(cwd, root), AUTOREVIEW_DEV_RUN_ID: runId } });
  child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
  child.on("exit", (code, signal) => {
    try { endHostExperienceSessions(root ?? cwd, host, runId); }
    catch (error) { console.error(`[Loop] 宿主退出后的经验活动登记未确认，批准保持阻挡：${(error as Error).message}`); }
    process.exitCode = code ?? (signal === "SIGINT" ? 130 : 1);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(`loop-dev: ${(error as Error).message}`); process.exitCode = 2; }
}

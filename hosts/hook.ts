/** 宿主 Hook 轻入口：PostToolUse 先筛动作，未命中不加载配置、批次或评审引擎。 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { productionAction, productionContext, resetProductionCard } from "../production-loop.ts";

export interface HookEvent {
  hook_event_name?: string;
  cwd?: string;
  session_id?: string;
  transcript_path?: string;
  last_assistant_message?: string;
  stop_hook_active?: boolean;
  prompt?: string;
  turn_id?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  [key: string]: unknown;
}

/** 两个宿主共用兼容环境变量，不能单凭 CLAUDE_PLUGIN_ROOT 判断。 */
export function detectHost(event: HookEvent, env: NodeJS.ProcessEnv = process.env): string {
  const forced = env.AUTOREVIEW_HOST?.trim();
  if (forced) return forced;
  if (event.turn_id !== undefined && event.turn_id !== null) return "codex";
  const transcript = typeof event.transcript_path === "string" ? event.transcript_path : "";
  if (transcript.includes("/.codex/")) return "codex";
  if (transcript.includes("/.claude/")) return "claude";
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT) return "claude";
  if (env.PLUGIN_ROOT) return "codex";
  return "claude";
}

/** 只适配宿主字段；路径/动作判断与指路内容都在 production-loop.ts。 */
export function touchedBy(event: HookEvent): { paths: string[]; command?: string } {
  const input = event.tool_input;
  if (!input || typeof input !== "object") return { paths: [] };
  if (event.tool_name === "apply_patch" && typeof input.command === "string") {
    return { paths: [...input.command.matchAll(/^\*\*\* (?:Add File|Update File|Move to): (.+)\r?$/gm)].map((match) => match[1].trim()) };
  }
  if (["Write", "Edit", "MultiEdit"].includes(event.tool_name ?? "") && typeof input.file_path === "string") {
    return { paths: [input.file_path] };
  }
  if (["Bash", "exec_command"].includes(event.tool_name ?? "") && typeof input.command === "string") {
    return { paths: [], command: input.command };
  }
  return { paths: [] };
}

export async function handleEvent(event: HookEvent, raw = JSON.stringify(event)): Promise<string | undefined> {
  if (event.hook_event_name === "PostToolUse") {
    // 采样保留原始字节（含空白），默认关闭；与命中与否无关。权限限制为本用户可读。
    try {
      const sample = process.env.AUTOREVIEW_PRODUCTION_SAMPLES;
      if (sample) {
        mkdirSync(sample, { recursive: true, mode: 0o700 });
        writeFileSync(join(sample, `${Date.now()}-${randomUUID()}.json`), raw, { mode: 0o600, flag: "wx" });
      }
    } catch { /* 采样失败不影响指路或工具结果。 */ }
    try {
      const action = productionAction(touchedBy(event), event.cwd);
      if (!action) return undefined;
      const text = await productionContext(action, detectHost(event), event.session_id);
      return text ? JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text } }) : undefined;
    } catch { return undefined; } // 生产辅助异常静默放行，不走开发会话的暂停/通知路径。
  }
  if (event.hook_event_name === "SessionStart" && event.source === "compact") {
    try { resetProductionCard(detectHost(event), event.session_id); } catch { /* 不影响原有 SessionStart。 */ }
  }
  return (await import("./review-hook.ts")).handleReviewEvent(event);
}

function readStdin(timeoutMs = 5000): Promise<string> {
  return new Promise((done) => {
    const chunks: Buffer[] = [];
    const finish = (): void => { clearTimeout(timer); done(Buffer.concat(chunks).toString("utf8")); };
    const timer = setTimeout(() => { process.stdin.destroy(); finish(); }, timeoutMs);
    if (process.stdin.isTTY) { finish(); return; }
    process.stdin.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
  });
}

export async function main(): Promise<void> {
  const raw = await readStdin();
  try {
    const event = JSON.parse(raw) as HookEvent;
    if (!event || typeof event !== "object" || Array.isArray(event)) return;
    if (process.env.AUTOREVIEW_DEBUG_EVENT) {
      try { appendFileSync(process.env.AUTOREVIEW_DEBUG_EVENT, `${raw.trim()}\n`); } catch { /* 调试不影响宿主。 */ }
    }
    if (process.env.AUTOREVIEW_DEBUG_ENV) {
      try { appendFileSync(process.env.AUTOREVIEW_DEBUG_ENV, `${JSON.stringify(Object.keys(process.env).filter((key) => /^(CLAUDE|CODEX)/.test(key)).sort())}\n`); } catch { /* 同上。 */ }
    }
    const output = await handleEvent(event, raw);
    if (output) process.stdout.write(`${output}\n`);
  } catch { /* 非法输入或辅助故障均退出 0，不污染宿主协议。 */ }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();

/** autoreview 的隔离夹具；只在调用时创建私有临时资源。 */
import "../test-env.ts";
import "./git-runtime.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import autoreview from "../../autoreview.ts";
import { createChildExec } from "../../hosts/review-hook.ts";
import type { Exec, ExecResult } from "../../git.ts";
import { readMergeQueue } from "../../merge-queue.ts";

export type Result = ExecResult;

export type Call = { command: string; args: string[]; options: Partial<Parameters<Exec>[2]> };

export type State = {
  enabled: boolean; phase: string; baseline?: string; baselineFingerprint?: string;
  lastSnapshot?: string; lastFingerprint?: string; unresolvedMustFix?: string;
  pauseReason?: string; repairs: number; rounds: { failed?: string; conclusion: string }[];
  acceptRun?: { result: string; trigger: string; round: number; exitCode?: number; detail?: string; logPath?: string; outputTail?: string };
};

export const result = (stdout = "", code = 0, stderr = "", killed = false): Result => ({ stdout, code, stderr, killed });

export const PASS = "## 结论：通过\n## 必修\n无\n## 小问题\n- 无\n## 需求疑问\n- 无\n## 上轮必修复查\n- 无\n";

export const FIX = "## 结论：需返修\n## 必修\n1. 位置：file.txt:1\n   问题：必修 X\n## 小问题\n- MINOR_SENTINEL\n## 需求疑问\n- QUESTION_SENTINEL\n## 上轮必修复查\n- 无\n";

export async function until(predicate: () => boolean, description: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) { for (let i = 0; i < 8; i += 1) await nextTurn(); return; }
    await new Promise((done) => setTimeout(done, 10));
  }
  assert.fail(`等待失败：${description}`);
}

export function harness(options: { empty?: boolean; restored?: Record<string, unknown>; flags?: Record<string, string>; stage?: string; subdir?: string; commands?: Array<{ name: string; source?: string }> | (() => Array<{ name: string; source?: string }>) } = {}) {
  const root = mkdtempSync(join(tmpdir(), "autoreview-unit-"));
  const repo = join(root, "repo");
  const home = join(root, "home");
  const pipelineDir = join(root, "pipeline");
  mkdirSync(repo); mkdirSync(home);
  const oldHome = process.env.HOME;
  const oldResources = process.env.AUTOREVIEW_RESOURCE_ROOT, oldQueueRoot = process.env.AUTOREVIEW_MERGE_QUEUE_ROOT;
  process.env.HOME = home;
  process.env.AUTOREVIEW_RESOURCE_ROOT = join(home, ".pi-autoreview", "resources");
  process.env.AUTOREVIEW_MERGE_QUEUE_ROOT = join(root, "queues");
  // 交付总表在 HOME 下；HOME 已固定到夹具目录，测试不会碰真实的 ~/.pi-autoreview/交付记录.md。
  const ledgerFile = join(home, ".pi-autoreview", "交付记录.md");
  // 流水线环境变量：只有指定了段名才设置，测完恢复。
  const pipelineEnv = ["AUTOREVIEW_PIPELINE_DIR", "AUTOREVIEW_STAGE", "AUTOREVIEW_PIPELINE_POLL_MS"] as const;
  const oldPipelineEnv = pipelineEnv.map((key) => process.env[key]);
  for (const key of pipelineEnv) delete process.env[key];
  if (options.stage) {
    process.env.AUTOREVIEW_PIPELINE_DIR = pipelineDir;
    process.env.AUTOREVIEW_STAGE = options.stage;
    process.env.AUTOREVIEW_PIPELINE_POLL_MS = "20";
  }
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  const git = (...args: string[]) => {
    const res = spawnSync("git", args, { cwd: repo, env, encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    return res.stdout.trim();
  };
  git("init", "-q"); git("config", "user.email", "unit@example.com"); git("config", "user.name", "unit");
  const workCwd = options.subdir ? join(repo, options.subdir) : repo;
  if (options.subdir) mkdirSync(workCwd, { recursive: true });
  const write = (path: string, text: string) => writeFileSync(join(repo, path), text);
  if (!options.empty) { write("file.txt", "base\n"); git("add", "file.txt"); git("commit", "-qm", "baseline"); }
  const entries: Record<string, any>[] = options.restored
    ? [{ type: "custom", customType: "autoreview-state", data: structuredClone(options.restored) }] : [];
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>();
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => any }>();
  const flags = new Map<string, string>();
  const calls: Call[] = [];
  const apiCalls: string[] = [];
  const notifications: string[] = [];
  const messages: string[] = [];
  const inputs: string[] = [];
  const accepts: Call[] = [];
  let inject: ((args: string[], call: Call) => Result | Promise<Result> | undefined) | undefined;
  let reviewer: (call: Call) => Result | Promise<Result> = () => result(PASS);
  let notifier: (call: Call) => Result | Promise<Result> = () => result();
  let acceptor: (call: Call) => Result | Promise<Result> = () => result("ACCEPT_OUTPUT_SENTINEL\n验收结论：通过\n");
  let externalExec: ((call: Call) => Result | Promise<Result> | undefined) | undefined;
  let failAppend = false;
  let failStatus = false;
  const pi = {
    on: (event: string, handler: any) => { handlers.set(event, handler); return () => handlers.delete(event); },
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerFlag: (name: string, flag: { default: string }) => flags.set(name, flag.default),
    getFlag: (name: string) => {
      apiCalls.push("getFlag");
      return options.flags?.[name] ?? (name === "autoreview-reviewer-cmd" ? "/fake-reviewer" : flags.get(name));
    },
    getCommands: () => {
      apiCalls.push("getCommands");
      const commands = options.commands ?? [{ name: "ponytail", source: "extension" }];
      return typeof commands === "function" ? commands() : commands;
    },
    appendEntry: (customType: string, data: unknown) => {
      apiCalls.push("appendEntry");
      if (failAppend) throw new Error("appendEntry 故意失败");
      entries.push({ type: "custom", customType, data: structuredClone(data) });
    },
    sendUserMessage: (text: string) => { apiCalls.push("sendUserMessage"); messages.push(text); },
    exec: async (command: string, args: string[], execOptions: Call["options"] = {}) => {
      apiCalls.push(`exec:${basename(command)}`);
      const call = { command, args, options: execOptions }; calls.push(call);
      const external = externalExec?.(call);
      if (external !== undefined) return external;
      if (basename(command) === "osascript") return notifier(call);
      if (command === "/fake-reviewer") { inputs.push(readFileSync(args[1], "utf8")); return reviewer(call); }
      if (command === "/bin/sh") { accepts.push(call); return acceptor(call); }
      if (command === "/usr/bin/env" || basename(command).startsWith("fake-")) {
        // 真正启动的替身必须复用受管执行器来停止独立工具组并提供释放证明，不能由测试自报已释放。
        return createChildExec(join(root, "fixture.procs.json"))(command, args, {
          ...execOptions, cwd: execOptions.cwd ?? workCwd, timeout: execOptions.timeout ?? 30_000,
        });
      }
      assert.equal(basename(command), "git");
      const plain = args[0] === "-c" ? args.slice(2) : args;
      const injected = inject?.(plain, call);
      if (injected) return injected;
      const res = spawnSync(command, args, { cwd: execOptions.cwd, env, encoding: "utf8" });
      return result(res.stdout || "", res.status ?? 1, res.stderr || "", Boolean(res.signal));
    },
  };
  const ctx = {
    abort: () => apiCalls.push("abort"),
    cwd: workCwd, isIdle: () => { apiCalls.push("isIdle"); return true; },
    ui: {
      notify: (message: string) => { apiCalls.push("notify"); notifications.push(message); },
      setStatus: () => { apiCalls.push("setStatus"); if (failStatus) throw new Error("setStatus 故意失败"); },
    },
    sessionManager: {
      getSessionId: () => { apiCalls.push("getSessionId"); return "unit-dev"; },
      getEntries: () => { apiCalls.push("getEntries"); return entries as SessionEntry[]; },
    },
  } as unknown as ExtensionContext;
  autoreview(pi as unknown as ExtensionAPI, pi.exec as any);
  const state = (): State => [...entries].reverse().find((entry) => entry.customType === "autoreview-state")?.data;
  const event = async (name: string, data: any = {}) => {
    assert.ok(handlers.has(name), `没有注册 ${name}`);
    // 与当前 Pi 相同：来源明确的 input 在 before_agent_start/展开资料之前触发。
    if (name === "before_agent_start" && data.messageType !== "custom" && typeof data.prompt === "string" && !data.skipInput) {
      const input = await handlers.get("input")!({ type: "input", source: data.inputSource ?? "interactive", text: data.prompt }, ctx);
      if (input?.action === "handled") return;
    }
    return await handlers.get(name)!({ type: name, ...data }, ctx);
  };
  const command = async (name = "review", args = "") => { await commands.get(name)!.handler(args, ctx); };
  const assistant = (text = "已完成\n【交付完成】") => entries.push({ type: "message", message: { role: "assistant", content: text } });
  const begin = async (prompt = "需求原文 ORIGINAL_REQUIREMENT") => {
    await event("before_agent_start", { prompt, systemPromptOptions: {} });
  };
  const terminal = async () => until(() => ["done", "paused"].includes(state()?.phase), "完成或暂停", 25_000);
  const accepted = async () => until(() => Boolean(state()?.acceptRun && state().acceptRun!.result !== "进行中"), "验收命令结束");
  return {
    root, repo, home, pipelineDir, ledgerFile, git, write, entries, calls, apiCalls, notifications, messages, inputs, accepts, state, event, command, assistant, begin, terminal, accepted,
    cwd: workCwd,
    setFlag: (name: string, value: string) => { options.flags ??= {}; options.flags[name] = value; },
    setCommands: (commands: NonNullable<typeof options.commands>) => { options.commands = commands; },
    set externalExec(fn: typeof externalExec) { externalExec = fn; },
    set inject(fn: typeof inject) { inject = fn; },
    set reviewer(fn: typeof reviewer) { reviewer = fn; },
    set notifier(fn: typeof notifier) { notifier = fn; },
    set acceptor(fn: typeof acceptor) { acceptor = fn; },
    set failAppend(value: boolean) { failAppend = value; },
    set failStatus(value: boolean) { failStatus = value; },
    summary: () => readFileSync(join(home, ".pi-autoreview", "repo", "unit-dev.md"), "utf8"),
    async close() {
      await event("session_shutdown", { reason: "quit" }).catch(() => {});
      for (let i = 0; i < 12; i += 1) await nextTurn();
      if (existsSync(join(root, "queues"))) {
        const queue = readMergeQueue(repo);
        if (queue) {
          const busy = () => existsSync(join(queue.dir, "worker.lock")) || readdirSync(queue.dir).some((file) => /^executor-[0-9a-f-]+\.json$/.test(file));
          const deadline = Date.now() + 15_000;
          while (busy() && Date.now() < deadline) await new Promise((done) => setTimeout(done, 25));
          assert.ok(!busy(), "释放队列执行器与已登记触发器后再删除临时仓库");
        }
      }
      if (oldQueueRoot === undefined) delete process.env.AUTOREVIEW_MERGE_QUEUE_ROOT; else process.env.AUTOREVIEW_MERGE_QUEUE_ROOT = oldQueueRoot;
      if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
      if (oldResources === undefined) delete process.env.AUTOREVIEW_RESOURCE_ROOT; else process.env.AUTOREVIEW_RESOURCE_ROOT = oldResources;
      pipelineEnv.forEach((key, index) => {
        const value = oldPipelineEnv[index];
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      });
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export const ACCEPT = { "autoreview-accept-cmd": "ACCEPT_CMD --all", "autoreview-accept-mode": "advisory" };

export const stageStatus = (h: { pipelineDir: string }, stage: string) => {
  const file = join(h.pipelineDir, `${stage}.status.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
};

export const sendInbox = (h: { pipelineDir: string }, stage: string, seq: number, mustFix: string) => {
  mkdirSync(h.pipelineDir, { recursive: true });
  writeFileSync(join(h.pipelineDir, `${stage}.inbox.json`), JSON.stringify({
    seq, message: `【整批验收返修 · 第 ${seq} 轮】\n${mustFix}\n修好后照常交付；不归你就写「A3：不归我：理由」`, mustFix,
  }));
};

export function paFixture(h: ReturnType<typeof harness>, t: test.TestContext) {
  const config = join(h.root, "pa.json"), file = join(h.root, "batch.json"), events = join(h.root, "events");
  const old = { LOOP_PA_CONFIG: process.env.LOOP_PA_CONFIG, AUTOREVIEW_BATCH_FILE: process.env.AUTOREVIEW_BATCH_FILE };
  process.env.LOOP_PA_CONFIG = config; process.env.AUTOREVIEW_BATCH_FILE = file;
  t.after(() => { for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  writeFileSync(config, JSON.stringify({ pa: { eventsDir: events, localNotify: false } }));
  h.write(".autoreview.json", JSON.stringify({ gate: { cmd: "true", timeoutMin: 1 } }));
  writeFileSync(file, JSON.stringify({ name: "PA测试", dir: h.pipelineDir, stages: { 甲: { workflow: "without-acceptance", cwd: h.repo, start: "fixture" } } }));
  const rows = () => existsSync(events) ? readdirSync(events).filter((file) => file.endsWith(".jsonl")).flatMap((file) => readFileSync(join(events, file), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))) : [];
  return { config, file, events, rows };
}

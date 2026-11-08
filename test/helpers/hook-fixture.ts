/** hook 的隔离夹具；只在调用时创建私有临时资源。 */
import "../test-env.ts";
import "./git-runtime.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { queueDir, readMergeQueue } from "../../merge-queue.ts";
import { readJson } from "../../pipeline-core.ts";

export const HOOK = fileURLToPath(new URL("../../hosts/hook.ts", import.meta.url));

export const FAKE = fileURLToPath(new URL(".././fake-reviewer.mjs", import.meta.url));

export const ACC_ENV = {
  AUTOREVIEW_ACCEPTANCE_CMD: fileURLToPath(new URL(".././fake-tester.mjs", import.meta.url)),
  AUTOREVIEW_CRITERIA_CMD: fileURLToPath(new URL(".././fake-drafter.mjs", import.meta.url)),
};

export function observeQueue(repo: string) {
  const dir = queueDir(repo);
  return { dir, read: () => readJson<NonNullable<ReturnType<typeof readMergeQueue>>>(join(dir, "queue.json")) };
}

export async function waitQueueIdle(repo: string): Promise<void> {
  const queue = readMergeQueue(repo);
  if (!queue) return;
  const busy = () => existsSync(join(queue.dir, "worker.lock")) || readdirSync(queue.dir).some((file) => /^executor-[0-9a-f-]+\.json$/.test(file));
  const deadline = Date.now() + 15_000;
  while (busy() && Date.now() < deadline) await sleep(30);
  assert.ok(!busy(), "队列执行器与已登记触发器全部释放后才能删除临时仓库");
}

export interface RunOptions {
  mode?: string;
  env?: Record<string, string>;
  cwd?: string;
  input?: string;
  session?: string;
  /** 默认按 bin/loop-dev 的开发会话运行；null 模拟直接打开的普通会话。 */
  devRoot?: string | null;
}

export function fixture(options: { marker?: string | null; maxRepairs?: number; files?: Record<string, string> } = {}) {
  const root = mkdtempSync(join(tmpdir(), "autoreview-hook-"));
  const repo = join(root, "repo");
  const home = join(root, "home");
  const bin = join(root, "bin");
  const osLog = join(root, "osascript.log");
  // 交付总表在夹具 HOME 下，不碰真实的 ~/.pi-autoreview/交付记录.md。
  const ledger = join(home, ".pi-autoreview", "交付记录.md");
  mkdirSync(repo); mkdirSync(home); mkdirSync(bin);
  const osa = join(bin, "osascript");
  writeFileSync(osa, `#!/bin/sh\necho "$@" >> "${osLog}"\n`);
  chmodSync(osa, 0o755);
  // 假 git：FAKE_GIT_FAIL=<子命令> 时对该子命令返回非零，其余转发给真实 git。
  const realGit = (() => {
    const res = spawnSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" });
    return (res.stdout || "").trim() || "/usr/bin/git";
  })();
  const fakeGit = join(bin, "git");
  writeFileSync(fakeGit, `#!/bin/sh\nif [ -n "$FAKE_GIT_FAIL" ]; then\n  case " $* " in\n    *" $FAKE_GIT_FAIL "*) echo "fake git failure" >&2; exit 1;;\n  esac\nfi\nexec "${realGit}" "$@"\n`);
  chmodSync(fakeGit, 0o755);
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  const git = (...args: string[]): string => {
    const res = spawnSync("git", args, { cwd: repo, env, encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    return res.stdout.trim();
  };
  git("init", "-q"); git("config", "user.email", "hook@example.com"); git("config", "user.name", "hook");
  const write = (path: string, text: string) => {
    const file = join(repo, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  write("file.txt", "base\n"); git("add", "file.txt"); git("commit", "-qm", "baseline");
  const marker = options.marker === undefined ? "{}" : options.marker;
  if (marker !== null) writeFileSync(join(repo, ".autoreview.json"), marker);
  for (const [path, text] of Object.entries(options.files ?? {})) write(path, text);

  const run = (event: Record<string, unknown> | string, runOptions: RunOptions = {}) => {
    const baseEnv = { ...env };
    for (const key of ["CLAUDECODE", "CLAUDE_PLUGIN_ROOT", "CLAUDE_CODE_ENTRYPOINT", "CODEX_THREAD_ID", "PLUGIN_ROOT", "AUTOREVIEW_HOST", "AUTOREVIEW_DEV_ROOT"]) delete baseEnv[key];
    const devRoot = runOptions.devRoot === undefined ? repo : runOptions.devRoot;
    const res = spawnSync(process.execPath, [HOOK], {
      input: typeof event === "string" ? event : JSON.stringify(event),
      cwd: runOptions.cwd ?? repo,
      env: {
        ...baseEnv,
        HOME: home,
        AUTOREVIEW_RESOURCE_ROOT: join(home, ".pi-autoreview", "resources"),
        PATH: `${bin}:${env.PATH}`,
        AUTOREVIEW_REVIEWER_CMD: FAKE,
        FAKE_MODE: runOptions.mode ?? "pass",
        FAKE_STATE_DIR: join(root, "fake"),
        FAKE_OSASCRIPT_LOG: osLog,
        ...(devRoot ? { AUTOREVIEW_DEV_ROOT: devRoot } : {}),
        ...runOptions.env,
      },
      encoding: "utf8",
    });
    return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
  };
  const statePath = (host = "claude", session = "s1") =>
    join(home, ".pi-autoreview", basename(repo), `${host}-${session}.state.json`);
  const readState = (host = "claude", session = "s1") => JSON.parse(readFileSync(statePath(host, session), "utf8"));
  const summary = (host = "claude", session = "s1") =>
    readFileSync(join(home, ".pi-autoreview", basename(repo), `${host}-${session}.md`), "utf8");
  const notifications = () => existsSync(osLog) ? readFileSync(osLog, "utf8") : "";
  const event = (name: string, extra: Record<string, unknown> = {}, session = "s1") =>
    ({ hook_event_name: name, cwd: repo, session_id: session, ...extra });
  const delivered = (extra: Record<string, unknown> = {}) =>
    event("Stop", { last_assistant_message: "已完成\n【交付完成】", ...extra });
  return {
    root, repo, home, ledger, write, git, run, event, delivered, statePath, readState, summary, notifications,
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

export function assertPauseOutput(result: { stdout: string }, reason: RegExp): void {
  const output = JSON.parse(result.stdout);
  assert.equal(output.decision, undefined, "暂停不伪造成产品返修 block");
  assert.match(output.systemMessage, reason);
  assert.match(output.systemMessage, /卡在哪：[\s\S]*需要你做：[\s\S]*原始现场：/);
}

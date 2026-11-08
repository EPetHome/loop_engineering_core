/** 新内核定向用例：真实临时 Git/bare origin，全部状态根及通知隔离，不连接模型。 */
import "../test-env.ts";
import "./git-runtime.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createKernelRun } from "../../kernel.ts";
import { readRun, updateRun } from "../../node-ledger.ts";
import { deliverCandidate } from "../../kernel-workspace.ts";
import type { Exec } from "../../git.ts";
import { processStartTime } from "../../procs.ts";
export const PASS = "## 结论：通过\n## 必修\n无\n";
export const reviewer = async () => ({ stdout: PASS, stderr: "", code: 0, killed: false, processesReleased: true });
export function fakeKernelLauncher(f: ReturnType<typeof kernelFixture>): void {
  const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  const agent = join(f.root, "agent"), permission = join(agent, "extensions/pi-permission-system"); mkdirSync(permission, { recursive: true });
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
  writeFileSync(join(permission, "config.json"), JSON.stringify({ yoloMode: true }));
  const pi = join(f.root, "fake-pi"), ponytail = join(f.root, "ponytail.js");
  writeFileSync(pi, `#!/bin/sh\nexec '${process.execPath}' '${join(root, "test/fake-kernel-pi.mjs")}' "$@"\n`, { mode: 0o755 });
  writeFileSync(ponytail, "export default function() {}\n");
  Object.assign(process.env, { PI_BIN: pi, PI_CODING_AGENT_DIR: agent, PONYTAIL_EXTENSION: ponytail,
    AUTOREVIEW_REVIEWER_CMD: join(root, "test/fake-reviewer.mjs"), FAKE_MODE: "pass", FAKE_STATE_DIR: join(f.root, "reviewer") });
}
export function kernelFixture(flow = ["开发评审", "测试"], command = "printf 'ok\\n'") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "loop-node-"))), repo = join(root, "项目 有空格'甲"), origin = join(root, "origin.git"), saved = { ...process.env };
  writeFileSync(join(root, "fixture-owner.json"), JSON.stringify({ pid: process.pid, started: processStartTime(process.pid), evidence: process.env.LOOP_STEP5_CLEANUP_EVIDENCE, test: process.argv[1], created: new Date().toISOString() }));
  mkdirSync(repo); mkdirSync(join(root, "home")); writeFileSync(join(root, "pa.json"), JSON.stringify({ pa: { localNotify: false } }));
  Object.assign(process.env, { HOME: join(root, "home"), AUTOREVIEW_MERGE_QUEUE_ROOT: join(root, "old-queues"), LOOP_PA_CONFIG: join(root, "pa.json"), AUTOREVIEW_KERNEL_ROOT: join(root, "kernel"), AUTOREVIEW_LOCAL_QUEUE_ROOT: join(root, "local-queue"),
    AUTOREVIEW_RESOURCE_ROOT: join(root, "resources"), AUTOREVIEW_PROJECTS_ROOT: join(root, "projects"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" });
  // 不把外层开发会话的受管身份带到临时模型/CLI。
  for (const key of ["AUTOREVIEW_KERNEL_LEDGER", "AUTOREVIEW_KERNEL_RUN", "AUTOREVIEW_KERNEL_REPAIR", "AUTOREVIEW_KERNEL_TASK", "AUTOREVIEW_KERNEL_LAUNCH", "AUTOREVIEW_KERNEL_NATIVE_BINDING", "AUTOREVIEW_DEV_ROOT", "AUTOREVIEW_SCOPE", "AUTOREVIEW_SCOPE_FILE"]) delete process.env[key];
  const git = (cwd: string, ...args: string[]): string => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" }); assert.equal(r.status, 0, r.stderr || r.stdout); return r.stdout.trim();
  };
  git(repo, "init", "-q", "-b", "dev"); git(repo, "config", "user.email", "test@example.com"); git(repo, "config", "user.name", "test");
  git(root, "init", "--bare", "-q", origin); git(repo, "remote", "add", "origin", origin);
  writeFileSync(join(repo, ".gitignore"), ".autoreview.json\nlocal.txt\n");
  writeFileSync(join(repo, ".autoreview.json"), JSON.stringify({ release: "dev", localFiles: ["local.txt"], acceptance: { start: "exit 93" } }));
  writeFileSync(join(repo, "local.txt"), "local only"); writeFileSync(join(repo, "file.txt"), "base\n"); writeFileSync(join(repo, "prompt.md"), "# 定向任务\n修改 file.txt\n");
  const file = join(repo, "开发卡.json"), card: any = { version: 1, name: "定向卡", nature: "开发", target: "dev", flow,
    tasks: [{ name: "甲", prompt: "prompt.md", scope: ["file.txt"], test: command }] };
  writeFileSync(file, JSON.stringify(card)); git(repo, "add", "."); git(repo, "commit", "-qm", "base");
  const exec: Exec = async (cmd, args, options) => {
    const r = spawnSync(cmd, args, { cwd: options.cwd, timeout: options.timeout, encoding: "utf8", env: { ...process.env, ...options.env } });
    return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "", killed: !!r.signal, processesReleased: true };
  };
  const start = () => createKernelRun(file, repo).path;
  const candidate = (path: string) => { const run = readRun(path); writeFileSync(join(run.worktree, "file.txt"), "delivered\n"); updateRun(path, (r) => { r.candidate = deliverCandidate(r); }); };
  const replacement = (mutate: (card: any) => void) => { const data = JSON.parse(readFileSync(file, "utf8")); mutate(data); const target = join(root, "替换卡.json"); writeFileSync(target, JSON.stringify(data)); return target; };
  const cleanup = () => {
    const evidence = process.env.LOOP_STEP5_CLEANUP_EVIDENCE;
    if (evidence) {
      const target = join(evidence, basename(root)); mkdirSync(target, { recursive: true });
      for (const name of ["kernel/runs", "resources", "local-queue"]) if (existsSync(join(root, name))) cpSync(join(root, name), join(target, name), { recursive: true });
      cpSync(join(root, "fixture-owner.json"), join(target, "fixture-owner.json"));
      writeFileSync(join(target, "fixture.json"), JSON.stringify({ root, repo, common: join(repo, ".git"), ended: new Date().toISOString() }));
    }
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); rmSync(root, { recursive: true, force: true });
  };
  return { root, repo, origin, file, card, git, exec, start, candidate, replacement, cleanup };
}

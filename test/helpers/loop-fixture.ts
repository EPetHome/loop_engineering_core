/** loop 的隔离夹具；只在调用时创建私有临时资源。 */
/** bin/loop 的开工、启动、状态、合入；测试仓库、worktree 和 methods.json 都建在系统临时目录。 */
import "./git-runtime.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after } from "node:test";

export const LOOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export const LOOP_BIN = join(LOOP_ROOT, "bin", "loop");

export const FAKE_STAGE = fileURLToPath(new URL(".././fake-stage.mjs", import.meta.url));

export const saved: Record<string, string | undefined> = {};

export const roots: string[] = [];

export function envSet(key: string, value: string): void {
  if (!(key in saved)) saved[key] = process.env[key];
  process.env[key] = value;
}

export function head(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "autoreview-loop-")));
  roots.push(root);
  const bin = join(root, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "osascript"), "#!/bin/sh\nexit 0\n"); chmodSync(join(bin, "osascript"), 0o755);
  const pi = join(root, "pi"); writeFileSync(pi, "#!/bin/sh\nprintf '## 结论：通过\\n## 必修\\n无\\n## 小问题\\n无\\n## 需求疑问\\n无\\n## 上轮必修复查\\n无\\n'\nexit 0\n"); chmodSync(pi, 0o755);
  for (const name of ["permission.ts", "ponytail.js", "autoreview.ts"]) writeFileSync(join(root, name), "");
  envSet("HOME", join(root, "home")); mkdirSync(join(root, "home"));
  envSet("AUTOREVIEW_PROJECTS_ROOT", join(root, "projects"));
  envSet("PI_BIN", pi);
  envSet("AUTOREVIEW_REVIEWER_CMD", fileURLToPath(new URL(".././fake-reviewer.mjs", import.meta.url)));
  envSet("PI_NODE_BIN", dirname(process.execPath));
  envSet("PERMISSION_EXTENSION", join(root, "permission.ts"));
  envSet("PONYTAIL_EXTENSION", join(root, "ponytail.js"));
  envSet("LOOP_DIR", LOOP_ROOT);
  envSet("PATH", `${bin}:${process.env.PATH ?? ""}`);
  return root;
}

after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

export function git(cwd: string, args: string[]): string {
  const res = spawnSync("git", ["-c", "core.quotePath=false", ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  assert.equal(res.status, 0, `${args.join(" ")}\n${res.stderr || res.stdout}`);
  return res.stdout.trim();
}

export interface Fixture { root: string; repo: string; worktree: string; batch: string; gateLog: string; selfLog: string; methods: string }

export function fixture(options: { gate?: boolean } = {}): Fixture {
  const root = head();
  const repo = join(root, "repo"); mkdirSync(repo);
  git(repo, ["init", "-q"]); git(repo, ["checkout", "-b", "main"]);
  git(repo, ["config", "user.email", "loop@example.com"]); git(repo, ["config", "user.name", "loop"]);
  const gateLog = join(root, "gate.log"), selfLog = join(root, "self.log");
  const methods = join(repo, "methods", "check.sh");
  mkdirSync(dirname(methods), { recursive: true });
  writeFileSync(methods, "echo method-v1\n");
  writeFileSync(join(repo, ".gitignore"), ".env.local\n");
  writeFileSync(join(repo, ".env.local"), "secret\n");
  writeFileSync(join(repo, "README.md"), "base\n");
  writeFileSync(join(repo, "prompt.md"), "做一件事\n");
  writeFileSync(join(repo, ".autoreview.json"), JSON.stringify({
    release: "main", acceptance: {},
    localFiles: [".env.local"],
    methods: { paths: ["methods"], selfCheck: `echo self >> ${JSON.stringify(selfLog)}`, probe: "true" },
    ...(options.gate === false ? {} : { gate: { cmd: `echo gate >> ${JSON.stringify(gateLog)}`, timeoutMin: 1 } }),
  }, null, 2));
  git(repo, ["add", "-A"]); git(repo, ["commit", "-qm", "init"]);
  const batch = join(repo, "batch.json");
  writeFileSync(batch, JSON.stringify({
    name: "测试批次", branch: "feat/测试",
    stages: { 甲: { prompt: "prompt.md", workspace: "dev分支" } },
    steps: [["甲"]],
  }, null, 2));
  git(repo, ["add", "batch.json"]); git(repo, ["commit", "-qm", "batch"]);
  return { root, repo, worktree: join(root, "repo-dev分支"), batch, gateLog, selfLog, methods };
}

export function loop(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(LOOP_BIN, args, { cwd, encoding: "utf8", env: process.env, timeout: 120_000 });
  return { status: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

export function jsonOf(run: { stdout: string; stderr: string }): Record<string, unknown> {
  assert.ok(run.stdout.trim(), `标准输出为空；stderr：${run.stderr}`);
  return JSON.parse(run.stdout) as Record<string, unknown>;
}

export const count = (path: string): number => existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").length : 0;

export function writeStage(base: string, stage: string): string {
  return `printf '${stage}\\n' > stage-${stage}.txt && '${process.execPath}' '${FAKE_STAGE}' fix`;
}

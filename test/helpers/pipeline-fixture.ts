/** pipeline 的隔离夹具；只在调用时创建私有临时资源。 */
import "../test-env.ts";
import "./git-runtime.ts";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after } from "node:test";
import { parsePlan, type PipelineIO, type Plan } from "../../pipeline.ts";

export const FAKE_STAGE = fileURLToPath(new URL(".././fake-stage.mjs", import.meta.url));

export const TESTER = fileURLToPath(new URL(".././fake-tester.mjs", import.meta.url));

export const CRITERIA = "需求：甲做接口，乙做页面\n\n## 验收标准\nA1. [甲] 操作：调接口\n    预期：返回 ok\nA2. [乙] 操作：打开页面\n    预期：显示 ok\n";

export const resourceRoot = mkdtempSync(join(tmpdir(), "autoreview-pipeline-resources-"));

process.env.AUTOREVIEW_RESOURCE_ROOT = resourceRoot;

after(() => rmSync(resourceRoot, { recursive: true, force: true }));

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "autoreview-pipeline-"));
}

export function gitRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  const git = (...args: string[]) => spawnSync("git", args, { cwd: dir, env, encoding: "utf8" });
  if (git("rev-parse", "--verify", "HEAD").status === 0) return dir;
  git("init", "-q"); git("config", "user.email", "t@example.com"); git("config", "user.name", "t");
  writeFileSync(join(dir, "README.md"), "x\n"); git("add", "README.md"); git("commit", "-qm", "init");
  return dir;
}

export interface Scene { root: string; plan: Plan; notes: string[]; events: (stage: string) => [number, string][]; close: () => void }

export function scene(options: {
  stages: Record<string, { mode?: string; cwd?: string }>;
  steps?: unknown[];
  criteria?: string;
  env?: Record<string, string>;
  maxRounds?: number;
}): Scene {
  const root = tempDir();
  writeFileSync(join(root, "验收.md"), options.criteria ?? CRITERIA);
  const saved: Record<string, string | undefined> = {};
  const vars = { AUTOREVIEW_ACCEPTANCE_CMD: TESTER, FAKE_STATE_DIR: join(root, "fake"), FAKE_STAGE_DELAY_MS: "80", ...options.env };
  for (const [key, value] of Object.entries(vars)) { saved[key] = process.env[key]; process.env[key] = value; }
  const stages = Object.fromEntries(Object.entries(options.stages).map(([name, value]) => {
    const cwd = value.cwd ?? gitRepo(join(root, `work-${name}`));
    mkdirSync(cwd, { recursive: true });
    return [name, { start: `"${process.execPath}" "${FAKE_STAGE}" ${value.mode ?? "fix"}`, cwd }];
  }));
  const plan = parsePlan({
    name: "test", dir: join(root, "pipeline"), stages, steps: options.steps,
    acceptance: { workDir: root, criteria: "验收.md", maxRounds: options.maxRounds },
  }, root, process.env);
  return {
    root, plan, notes: [],
    events: (stage) => {
      const file = join(plan.dir, `${stage}.events.log`);
      return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map((line) => {
        const [at, ...what] = line.split(" ");
        return [Number(at), what.join(" ")] as [number, string];
      }) : [];
    },
    close: () => {
      for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export function io(s: Scene, silenceMs = 30_000): PipelineIO {
  return {
    launch: (_stage, script) => { spawnSync("/bin/sh", ["-c", `(${script}) >/dev/null 2>&1 &`]); },
    notify: (message) => s.notes.push(message),
    log: () => {},
    pollMs: 20,
    silenceMs,
    preflightEnv: { playwright: () => true },
  };
}

export const at = (events: [number, string][], what: string): number => events.find(([, name]) => name === what)?.[0] ?? Number.NaN;

export const accCalls = (s: Scene): number => existsSync(join(s.root, "fake", "acc-calls.log"))
  ? readFileSync(join(s.root, "fake", "acc-calls.log"), "utf8").trim().split("\n").length : 0;

/** 本批 A1/A2/A4/A5：真实 CLI + 临时 git/worktree，模型和宿主全部替身。 */
import "./test-env.ts";
import "./helpers/git-runtime.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runAcceptanceStage } from "../acceptance.ts";
import { resolveProjectConfig } from "../config.ts";
import { createChildExec } from "../hosts/review-hook.ts";
import { validateProductionFile } from "../production-loop-validation.ts";

const LOOP = fileURLToPath(new URL("../bin/loop", import.meta.url));
const REVIEWER = fileURLToPath(new URL("./fake-reviewer.mjs", import.meta.url));
const TESTER = fileURLToPath(new URL("./fake-tester.mjs", import.meta.url));
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "loop-preflight-"))), repo = join(root, "repo"), workspace = join(root, "work"), home = join(root, "home");
  mkdirSync(repo); mkdirSync(home);
  const env = { ...process.env, HOME: home, AUTOREVIEW_RESOURCE_ROOT: join(root, "resources"), AUTOREVIEW_PROJECTS_ROOT: join(root, "projects"),
    AUTOREVIEW_REVIEWER_CMD: REVIEWER, FAKE_MODE: "pass", FAKE_STATE_DIR: join(root, "reviewer"),
    LOOP_PA_CONFIG: join(root, "pa.json"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  const git = (...args: string[]) => { const result = spawnSync("git", args, { cwd: repo, env, encoding: "utf8" }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  git("init", "-qb", "main"); git("config", "user.name", "test"); git("config", "user.email", "test@example.invalid");
  const config = { workspaces: { dev分支: workspace }, reviewerCmd: REVIEWER, gate: { cmd: "true" }, acceptance: {} };
  writeFileSync(join(repo, ".autoreview.json"), JSON.stringify(config));
  writeFileSync(join(repo, "a.py"), "a = 1\n"); writeFileSync(join(repo, "prompt.md"), "做本批开发\n");
  const batch = join(repo, "batch.json");
  writeFileSync(batch, JSON.stringify({ name: "空跑", branch: "fix/probe", dir: join(root, "pipeline"), stages: { 甲: { prompt: "prompt.md", scope: { allow: ["a.py"] } } } }));
  git("add", "."); git("commit", "-qm", "base");
  return { root, repo, workspace, batch, config, env, git,
    run: (extra: string[] = []) => spawnSync(LOOP, ["开工", batch, ...extra], { cwd: repo, env, encoding: "utf8", timeout: 30_000 }),
    close: () => rmSync(root, { recursive: true, force: true }) };
}

test("A1 写后核对与开工均列出缺少的副本；未创建开发空间或分支", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.repo, "AGENTS.md"), "改 `a.py` 必须同步改 `copies/*/a.py`\n");
    for (const name of ["一", "二"]) { mkdirSync(join(f.repo, "copies", name), { recursive: true }); writeFileSync(join(f.repo, "copies", name, "a.py"), "a = 1\n"); }
    f.git("add", "."); f.git("commit", "-qm", "declare sync");
    const branches = f.git("branch");
    const warnings = await validateProductionFile({ path: f.batch, kind: "batch", root: f.repo });
    assert.match(warnings.join("\n"), /copies\/一\/a.py/); assert.match(warnings.join("\n"), /copies\/二\/a.py/);
    for (const flags of [[], ["--dry-run"], ["--json"]]) {
      const run = f.run(flags); assert.notEqual(run.status, 0);
      assert.match(run.stdout + run.stderr, /copies\/一\/a.py/); assert.match(run.stdout + run.stderr, /copies\/二\/a.py/);
      assert.match(run.stdout + run.stderr, /scope.allow/); assert.equal(existsSync(f.workspace), false); assert.equal(f.git("branch"), branches);
    }
    const batch = JSON.parse(readFileSync(f.batch, "utf8")); batch.stages.甲.scope.allow.push("copies/"); writeFileSync(f.batch, JSON.stringify(batch));
    assert.deepEqual(await validateProductionFile({ path: f.batch, kind: "batch", root: f.repo }), []);
  } finally { f.close(); }
});

test("A4 正常开工输出四项空跑结论；预览不运行评审、不创建目录", () => {
  const f = fixture();
  try {
    const preview = f.run(["--dry-run", "--json"]); assert.equal(preview.status, 0, preview.stdout + preview.stderr);
    assert.equal(existsSync(f.workspace), false); assert.equal(existsSync(join(f.root, "reviewer")), false); assert.equal(existsSync(join(f.root, "pipeline")), false);
    const run = f.run(); assert.equal(run.status, 0, run.stdout + run.stderr);
    for (const name of ["越界检查", "评审能否启动", "验收前重置", "加载验收说明"]) assert.match(run.stdout, new RegExp(`开工空跑 · 甲 · ${name}：完成；`));
    assert.match(run.stdout, /真实越界检查已执行/); assert.match(run.stdout, /独立评审已启动/);
    assert.equal(readFileSync(join(f.root, "reviewer", "calls.log"), "utf8").trim().split("\n").length, 1);
    assert.equal(f.git("status", "--porcelain"), "");
  } finally { f.close(); }
});

test("A5 重置失败在开工暴露，带原始输出和改法；开发方未派发", () => {
  const f = fixture();
  try {
    const launched = join(f.root, "developer-ran");
    const batch = JSON.parse(readFileSync(f.batch, "utf8")); batch.stages.甲 = { start: `touch '${launched}'` }; writeFileSync(f.batch, JSON.stringify(batch));
    writeFileSync(join(f.repo, ".autoreview.json"), JSON.stringify({ ...f.config, acceptance: { reset: "printf 'RESET_ORIGINAL_FAILURE\\n' >&2; exit 19" } }));
    f.git("add", "."); f.git("commit", "-qm", "bad reset");
    const run = f.run(["--json"]); assert.equal(run.status, 1, run.stdout + run.stderr);
    const output = JSON.parse(run.stdout); assert.match(output.error, /验收前重置失败/); assert.match(output.error, /RESET_ORIGINAL_FAILURE/);
    assert.match(output.error, /检查 acceptance.reset/); assert.equal(existsSync(launched), false);
    assert.equal(output.rehearsal.length, 4, "失败也保留每项结论");
  } finally { f.close(); }
});

test("开工空跑／的启动、重置和清理使用测试库/端口，宿主同名环境不能覆盖配置", () => {
  const f = fixture();
  try {
    Object.assign(f.env, { DATABASE_URL: "host://must-not-reset", PORT: "49001", AUTOREVIEW_TEST_HOST_ONLY: "inherited" });
    const seen = join(f.root, "acceptance-env.jsonl"), probe = join(f.root, "env-probe.mjs");
    writeFileSync(probe, `import { appendFileSync } from 'node:fs';
const phase = process.argv[2];
appendFileSync(${JSON.stringify(seen)}, JSON.stringify({phase, database:process.env.DATABASE_URL, port:process.env.PORT, inherited:process.env.AUTOREVIEW_TEST_HOST_ONLY,
  base:process.env.AUTOREVIEW_BASE_REV, batch:process.env.AUTOREVIEW_BATCH_FILE, stage:process.env.AUTOREVIEW_STAGE, run:process.env.AUTOREVIEW_RUN_ID})+'\\n');
if (phase === 'start') { console.log('ENV_PROBE_READY'); setInterval(() => {}, 1000); }
`);
    const command = (phase: string) => [process.execPath, probe, phase].map((value) => JSON.stringify(value)).join(" ");
    writeFileSync(join(f.repo, ".autoreview.json"), JSON.stringify({ ...f.config, acceptance: {
      start: command("start"), readyLog: "ENV_PROBE_READY", reset: command("reset"), cleanup: command("cleanup"),
      env: { DATABASE_URL: "test://isolated", PORT: "39001" },
    } }));
    f.git("add", ".autoreview.json"); f.git("commit", "-qm", "isolated acceptance env");
    const run = f.run(["--json"]); assert.equal(run.status, 0, run.stdout + run.stderr);
    const rows = readFileSync(seen, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(rows.map((row) => row.phase), ["start", "reset", "cleanup"]);
    for (const row of rows) {
      assert.equal(row.database, "test://isolated", row.phase); assert.equal(row.port, "39001", row.phase);
      assert.equal(row.inherited, "inherited", "普通宿主环境仍可继承");
      assert.match(row.base, /^[a-f0-9]{40}$/); assert.equal(row.batch, join(f.workspace, "batch.json")); assert.equal(row.stage, "甲"); assert.ok(row.run);
    }
    assert.equal(new Set(rows.map((row) => row.run)).size, 1, "三步共用同一份资源身份");
  } finally { f.close(); }
});

test("开工资料／复用干净 worktree 时，localFiles 验收说明按计划复制核对，来源缺失仍拒绝", async (t) => {
  for (const local of ["deploy/acceptance/GUIDE.md", "deploy/acceptance"]) for (const sourceExists of [true, false]) {
    await t.test(`${local} · ${sourceExists ? "来源存在" : "来源缺失"}`, async () => {
      const f = fixture();
      try {
        const guide = "deploy/acceptance/GUIDE.md", target = join(f.workspace, guide);
        writeFileSync(join(f.repo, ".gitignore"), "deploy/acceptance\n");
        writeFileSync(join(f.repo, ".autoreview.json"), JSON.stringify({ ...f.config, localFiles: [local], acceptance: { guide } }));
        if (sourceExists) { mkdirSync(join(f.repo, "deploy/acceptance"), { recursive: true }); writeFileSync(join(f.repo, guide), "LOCAL_GUIDE_ORIGINAL\n"); }
        f.git("add", ".autoreview.json", ".gitignore"); f.git("commit", "-qm", "local acceptance guide");
        f.git("worktree", "add", "-b", "fix/probe", f.workspace);
        const head = f.git("rev-parse", "HEAD"), branches = f.git("branch");
        assert.equal(existsSync(target), false);
        const warnings = await validateProductionFile({ path: f.batch, kind: "batch", root: f.repo });
        if (sourceExists) assert.deepEqual(warnings, []);
        else assert.ok(warnings.some((warning) => warning.includes("GUIDE.md")));
        const preview = f.run(["--dry-run", "--json"]);
        assert.equal(preview.status, sourceExists ? 0 : 1, preview.stdout + preview.stderr);
        assert.equal(existsSync(target), false, "前置核对与 dry-run 都不复制");
        const run = f.run(["--json"]); assert.equal(run.status, sourceExists ? 0 : 1, run.stdout + run.stderr);
        const output = JSON.parse(run.stdout);
        if (sourceExists) {
          assert.deepEqual(output.workspaces[0].localFiles, [local]);
          assert.equal(readFileSync(target, "utf8"), "LOCAL_GUIDE_ORIGINAL\n");
          const loaded = output.rehearsal.find((check: { name: string }) => check.name === "甲 · 加载验收说明");
          assert.equal(loaded.ok, true); assert.ok(loaded.detail.includes(target));
        } else {
          assert.match(output.error, /配置核对失败[\s\S]*GUIDE.md/); assert.equal(existsSync(join(f.root, "reviewer")), false);
          assert.equal(f.git("rev-parse", "HEAD"), head); assert.equal(f.git("branch"), branches);
        }
      } finally { f.close(); }
    });
  }
});

test("开工资料／localFiles 目标目录已存在时，不虚报会复制缺少的子文件", () => {
  const f = fixture();
  try {
    const guide = "deploy/acceptance/GUIDE.md";
    writeFileSync(join(f.repo, ".gitignore"), "deploy/acceptance\n");
    writeFileSync(join(f.repo, ".autoreview.json"), JSON.stringify({ ...f.config, localFiles: ["deploy/acceptance"], acceptance: { guide } }));
    mkdirSync(join(f.repo, "deploy/acceptance"), { recursive: true }); writeFileSync(join(f.repo, guide), "source guide\n");
    f.git("add", ".autoreview.json", ".gitignore"); f.git("commit", "-qm", "local directory");
    f.git("worktree", "add", "-b", "fix/probe", f.workspace);
    mkdirSync(join(f.workspace, "deploy/acceptance"), { recursive: true });
    const run = f.run(["--json"]); assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(JSON.parse(run.stdout).error, /配置核对失败[\s\S]*GUIDE.md/);
    assert.equal(existsSync(join(f.workspace, guide)), false); assert.equal(existsSync(join(f.root, "reviewer")), false);
  } finally { f.close(); }
});

test("A2 两段的验收方 input.md 各自加载本段 guide，项目级及另一段不串入", async () => {
  const f = fixture(), oldResources = process.env.AUTOREVIEW_RESOURCE_ROOT;
  process.env.AUTOREVIEW_RESOURCE_ROOT = join(f.root, "resources");
  try {
    writeFileSync(join(f.repo, "project-guide.md"), "PROJECT_GUIDE_ONLY");
    writeFileSync(join(f.repo, ".autoreview.json"), JSON.stringify({ ...f.config, acceptance: { guide: "project-guide.md" } }));
    const stages: Record<string, unknown> = {};
    for (const name of ["甲", "乙"]) { writeFileSync(join(f.repo, `${name}.md`), `GUIDE_${name}_ONLY`); stages[name] = { start: "true", cwd: f.repo, acceptance: { guide: `${name}.md` } }; }
    writeFileSync(f.batch, JSON.stringify({ name: "分段说明", stages }));
    for (const name of ["甲", "乙"]) {
      const env = { ...f.env, AUTOREVIEW_BATCH_FILE: f.batch, AUTOREVIEW_STAGE: name, AUTOREVIEW_ACCEPTANCE_CMD: TESTER };
      const config = resolveProjectConfig(f.repo, { env }).acceptance!;
      const runDir = join(f.root, `accept-${name}`);
      const result = await runAcceptanceStage({ workDir: f.repo, devSessionId: `guide-${name}`, round: 1, deliveryNote: "", config,
        state: { requirement: "## 验收标准\nA1. 操作：运行命令\n    预期：ok" }, reviewerModel: "fake", reviewerThinking: "off",
        exec: createChildExec(join(f.root, `${name}.procs.json`)), runDir, procsFile: join(f.root, `${name}.procs.json`),
        deadline: Date.now() + 60_000, now: Date.now, previousFailed: [], saveState: () => {} });
      assert.equal(result.kind, "judged");
      const input = readFileSync(join(runDir, "input.md"), "utf8");
      assert.ok(input.includes(`GUIDE_${name}_ONLY`)); assert.ok(!input.includes(`GUIDE_${name === "甲" ? "乙" : "甲"}_ONLY`)); assert.ok(!input.includes("PROJECT_GUIDE_ONLY"));
    }
  } finally { if (oldResources === undefined) delete process.env.AUTOREVIEW_RESOURCE_ROOT; else process.env.AUTOREVIEW_RESOURCE_ROOT = oldResources; f.close(); }
});

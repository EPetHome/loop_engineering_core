/** 整批验收改名：真实 CLI + 临时 Git 仓库，段会话/验收方均为替身，不调用模型。 */
import "./helpers/git-runtime.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parsePlan, PlanError } from "../pipeline.ts";
import { parseAcceptanceConfig } from "../config.ts";

const PIPELINE = fileURLToPath(new URL("../pipeline.ts", import.meta.url));
const CORE = new URL("../pipeline-core.ts", import.meta.url).href;
const TESTER = fileURLToPath(new URL("./fake-tester.mjs", import.meta.url));
const criteria = "## 验收标准\nA1. [甲] 操作：检查输出\n    预期：通过\nA2. [乙] 操作：检查结果\n    预期：通过\n";

test("A1–A4 旧批次提示改写，新平铺批次结果一致；双写退出 3；两种续跑都不重启段", () => {
  const root = mkdtempSync(join(tmpdir(), "loop-acceptance-rename-"));
  try {
    const repo = join(root, "repo"), home = join(root, "home"), bin = join(root, "bin"), dir = join(root, "run");
    for (const path of [repo, home, bin]) mkdirSync(path);
    const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`,
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
      AUTOREVIEW_RESOURCE_ROOT: join(root, "resources"), AUTOREVIEW_MERGE_QUEUE_ROOT: join(root, "queues"),
      AUTOREVIEW_PIPELINE_POLL_MS: "20", AUTOREVIEW_ACCEPTANCE_CMD: TESTER, FAKE_STATE_DIR: join(root, "fake"),
      FAKE_ACC_MODE: "pass", FAKE_ACC_FAIL: "", FAKE_ACC_FAIL_ONCE: "", FAKE_ACC_UNKNOWN: "", FAKE_ACC_MANUAL: "" };
    const git = (...args: string[]) => {
      const result = spawnSync("git", args, { cwd: repo, env, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    };
    git("init", "-q"); git("config", "user.email", "test@example.test"); git("config", "user.name", "test");
    writeFileSync(join(repo, "base.txt"), "baseline\n"); git("add", "."); git("commit", "-qm", "baseline");
    writeFileSync(join(bin, "osascript"), "#!/bin/sh\nexit 0\n"); chmodSync(join(bin, "osascript"), 0o755);
    writeFileSync(join(root, "验收.md"), criteria);
    const stage = join(root, "stage.mjs"), starts = join(root, "starts.log");
    // 替身段写完 done 就退出，不留等待中的后台会话；在仓库外记录启动次数。
    writeFileSync(stage, `import { appendFileSync } from 'node:fs';
import { writeStageStatus } from ${JSON.stringify(CORE)};
const stage = process.env.AUTOREVIEW_STAGE;
appendFileSync(${JSON.stringify(starts)}, stage + '\\n');
writeStageStatus({dir: process.env.AUTOREVIEW_PIPELINE_DIR, stage}, {sessionId: 'fake-' + stage, summary: '', event: 'done', readyEpoch: 'ready-' + stage, inbox: 0});
`);
    const start = `"${process.execPath}" "${stage}"`;
    const base = { name: "改名验收", dir, stages: { 甲: { cwd: repo, start }, 乙: { cwd: repo, start } }, steps: [["甲"], ["乙"]] };
    const block = { workDir: repo, criteria: "验收.md", maxRounds: 2 };
    const config = { timeoutMin: 2, env: { RENAMED: "yes" } };
    const file = join(root, "批次.json");
    const run = (...args: string[]) => spawnSync(process.execPath, [PIPELINE, file, "--launcher", "background", ...args], {
      cwd: root, env, encoding: "utf8", timeout: 30_000,
    });
    const outcome = () => {
      // 兼容旧材料目录名：新配置仍使用同一位置。
      const result = JSON.parse(readFileSync(join(dir, "e2e", "r1", "result.json"), "utf8"));
      return { verdict: result.verdict, items: result.items.map(({ id, verdict }: { id: string; verdict: string }) => ({ id, verdict })) };
    };
    writeFileSync(file, JSON.stringify({ ...base, e2e: { ...block, acceptance: config } })); // 旧写法兼容。
    const legacy = run(); assert.equal(legacy.status, 0, legacy.stdout + legacy.stderr);
    assert.match(legacy.stderr, /e2e 是旧写法，建议改成 acceptance/);
    assert.match(legacy.stdout, /整批验收全部通过/);
    const previous = outcome(); assert.equal(previous.verdict, "通过");
    writeFileSync(file, JSON.stringify({ ...base, acceptance: { ...block, ...config } }));
    const current = run(); assert.equal(current.status, 0, current.stdout + current.stderr);
    assert.doesNotMatch(current.stdout + current.stderr, /旧写法|建议改成/);
    assert.deepEqual(outcome(), previous);
    const launched = readFileSync(starts, "utf8");
    for (const from of ["验收", "e2e"]) { // 兼容旧续跑参数。
      const resumed = run("--from", from);
      assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
      assert.match(readFileSync(join(dir, "report.md"), "utf8"), /从整批验收接着跑/);
      assert.deepEqual(outcome(), previous);
      assert.equal(readFileSync(starts, "utf8"), launched, "续跑不能重新启动段会话");
    }
    writeFileSync(file, JSON.stringify({ ...base, acceptance: { ...block, ...config }, e2e: { ...block, acceptance: config } })); // 双写兼容边界。
    const both = run(); assert.equal(both.status, 3, both.stdout + both.stderr);
    assert.match(both.stdout, /acceptance 和 e2e 只能写一个/);
    assert.equal(readFileSync(starts, "utf8"), launched, "计划错误不能启动段");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("平铺字段复用项目验收的全部类型/默认值/相对路径，旧嵌套配置归一化后相同", (t) => {
  const root = mkdtempSync(join(tmpdir(), "loop-acceptance-config-"));
  const warnings = t.mock.method(console, "error", () => {});
  try {
    writeFileSync(join(root, "验收.md"), criteria);
    const base = { name: "字段", stages: { 甲: { start: "true" }, 乙: { start: "true" } } };
    const block = { workDir: ".", criteria: "验收.md", maxRounds: 4 };
    for (const config of [{}, { start: "node app.js", readyUrl: "http://127.0.0.1:38081/", readyLog: "ready", readyTimeoutSec: 7,
      reset: "sh reset.sh", cleanup: "sh cleanup.sh", resetTimeoutSec: 8, logs: ["system.log"], errorPatterns: ["BAD"], ignorePatterns: ["ignore"],
      guide: "guide.md", actions: "actions", model: "test/model", thinking: "high", strongModel: "test/strong", idleTimeoutSec: 9,
      timeoutMin: 2, env: { TEST: "true" } }]) {
      const flat = parsePlan({ ...base, acceptance: { ...block, ...config } }, root, {});
      assert.deepEqual(flat.acceptance!.acceptance, parseAcceptanceConfig(config, root, {}));
      const legacy = parsePlan({ ...base, e2e: { ...block, acceptance: config } }, root, {}); // 兼容旧嵌套字段。
      assert.deepEqual(flat, legacy);
    }
    assert.equal(warnings.mock.calls.length, 2, "仅旧写法提示迁移");
    for (const value of [null, [], true, "bad"]) {
      assert.throws(() => parsePlan({ ...base, acceptance: value }, root, {}), PlanError);
      assert.throws(() => parsePlan({ ...base, acceptance: value, e2e: {} }, root, {}), /只能写一个/); // 兼容边界优先拒绝双写。
    }
    for (const invalid of [{ readyUrl: "ftp://bad" }, { timeoutMin: 0 }, { env: { X: 1 } }, { logs: [1] }, { actions: "../outside" }]) {
      assert.throws(() => parsePlan({ ...base, acceptance: { ...block, ...invalid } }, root, {}), PlanError);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

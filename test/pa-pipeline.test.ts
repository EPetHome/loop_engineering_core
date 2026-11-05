import "./test-env.ts";
import "./helpers/git-runtime.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { batchInfo, phasePath, writePhase } from "../events.ts";
import { workingTree } from "../commit-batch.ts";
import { readMergeQueue, registerQueueBatch } from "../merge-queue.ts";
import { parsePlan, runPipeline } from "../pipeline.ts";
import { writeStageStatus } from "../pipeline-core.ts";
import { queryBatches } from "../query.ts";

const TESTER = fileURLToPath(new URL("./fake-tester.mjs", import.meta.url));
test("A10：整批联调准备失败 next=resume，开跑前检查失败 next=manual；授权待答复 next=grant", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "loop-pa-pipeline-")), home = join(root, "home"), repo = join(root, "repo"), events = join(root, "received");
  mkdirSync(repo); mkdirSync(home); mkdirSync(events);
  const keys = ["HOME", "LOOP_PA_CONFIG", "AUTOREVIEW_RESOURCE_ROOT"] as const, old = keys.map((key) => process.env[key]);
  process.env.HOME = home; process.env.LOOP_PA_CONFIG = join(root, "pa.json"); process.env.AUTOREVIEW_RESOURCE_ROOT = join(root, "resources");
  t.after(() => { keys.forEach((key, index) => { if (old[index] === undefined) delete process.env[key]; else process.env[key] = old[index]; }); rmSync(root, { recursive: true, force: true }); });
  writeFileSync(process.env.LOOP_PA_CONFIG, JSON.stringify({ pa: { eventsDir: events, localNotify: false } }));
  const git = (...args: string[]) => { const res = spawnSync("git", args, { cwd: repo, encoding: "utf8" }); assert.equal(res.status, 0, res.stderr); };
  git("init", "-qb", "main"); git("config", "user.email", "pa@example.com"); git("config", "user.name", "pa");
  writeFileSync(join(repo, "file"), "base"); git("add", "."); git("commit", "-qm", "base");
  const rows = () => readdirSync(events).flatMap((name) => readFileSync(join(events, name), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)));
  for (const next of ["resume", "manual", "grant"]) {
    const file = join(root, `${next}.json`), dir = join(home, ".pi-autoreview", "pipelines", next), criteria = join(root, `${next}.md`);
    writeFileSync(criteria, `## 验收标准\nA1. ${next === "grant" ? "[授权] " : ""}操作：调命令\n    预期：成功\n`);
    const raw = { name: next, dir, stages: { 甲: { cwd: next === "manual" ? join(root, "missing") : repo, start: "never run" } }, prepare: "exit 75", acceptance: { workDir: repo, criteria, maxRounds: 1 } };
    writeFileSync(file, JSON.stringify(raw));
    const plan = parsePlan(raw, root, { ...process.env, AUTOREVIEW_ACCEPTANCE_CMD: TESTER }, { batchFile: file });
    if (next === "resume") writeStageStatus({ dir, stage: "甲" }, { event: "done", readyEpoch: "fake-ready", sessionId: "fake", summary: "", inbox: 0 });
    const code = await runPipeline(plan, { launch: () => assert.fail("不应启动会话"), notify: () => {}, log: () => {}, pollMs: 10, silenceMs: 1000 }, { fromAcceptance: next === "resume" });
    assert.equal(code, 2);
    const event = rows().filter((event) => event.batch.name === next).at(-1), phase = JSON.parse(readFileSync(phasePath(dir, null), "utf8"));
    assert.equal(event.status, "paused"); assert.equal(event.stage, null); assert.equal(event.detail.next, next);
    assert.equal(phase.next, next); assert.equal(phase.text, event.reason.text); assert.equal(phase.category, event.reason.category);
    const batch: any = queryBatches(file).batches[0]; assert.equal(batch.next, next); assert.equal(batch.pause.text, event.reason.text);
    if (next === "resume") { assert.equal(event.reason.category, "环境"); assert.ok(event.evidence.log.endsWith("prepare.log")); }
  }
});

test("PA 多段：逐段提交后各发一次段 done，压缩为一个真实批次提交后再发整批 done", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "loop-pa-multi-")), home = join(root, "home"), repo = join(root, "runtime"), dev = join(root, "dev"), events = join(root, "received"), file = join(root, "batch.json"), dir = join(home, ".pi-autoreview", "pipelines", "multi");
  mkdirSync(repo); mkdirSync(home); mkdirSync(events);
  const keys = ["HOME", "LOOP_PA_CONFIG", "AUTOREVIEW_RESOURCE_ROOT", "AUTOREVIEW_MERGE_QUEUE_ROOT"] as const, old = keys.map((key) => process.env[key]);
  process.env.HOME = home; process.env.LOOP_PA_CONFIG = join(root, "pa.json"); process.env.AUTOREVIEW_RESOURCE_ROOT = join(root, "resources"); process.env.AUTOREVIEW_MERGE_QUEUE_ROOT = join(root, "queues");
  const git = (cwd: string, ...args: string[]): string => { const res = spawnSync("git", args, { cwd, encoding: "utf8" }); assert.equal(res.status, 0, res.stderr); return res.stdout.trim(); };
  try {
    writeFileSync(process.env.LOOP_PA_CONFIG, JSON.stringify({ pa: { eventsDir: events, localNotify: false } }));
    git(repo, "init", "-qb", "main"); git(repo, "config", "user.email", "pa@example.com"); git(repo, "config", "user.name", "pa");
    writeFileSync(join(repo, ".autoreview.json"), JSON.stringify({ gate: { cmd: "true", timeoutMin: 1 } })); writeFileSync(join(repo, "file"), "base"); git(repo, "add", "."); git(repo, "commit", "-qm", "base");
    const base = git(repo, "rev-parse", "HEAD"); git(repo, "worktree", "add", "-b", "feat/multi", dev, "main");
    const raw = { name: "multi", dir, branch: "feat/multi", stages: { 甲: { cwd: dev, start: "fake" }, 乙: { cwd: dev, start: "fake" } }, steps: [["甲"], ["乙"]] };
    writeFileSync(file, JSON.stringify(raw));
    registerQueueBatch(repo, { name: "multi", file, dir, project: repo, release: "main", acceptance: false, steps: raw.steps,
      stages: ["甲", "乙"].map((name) => ({ name, cwd: dev, branch: "feat/multi", start: "fake" })) });
    const plan = parsePlan(raw, root, process.env, { batchFile: file });
    assert.equal(await runPipeline(plan, { launch: (stage) => {
      writeFileSync(join(dev, `${stage.name}.txt`), `checked-${stage.name}`);
      const detail = { gate: "通过", review: { verdict: "通过", mustFix: 0, suggestions: 1 }, acceptance: { verdict: "未配置", failed: [], partial: [], manual: [] } };
      writePhase(batchInfo(file, repo, dir), stage.name, "done", { status: "done", detail });
      writeStageStatus({ dir, stage: stage.name }, { event: "done", readyEpoch: stage.name, sessionId: `fake-${stage.name}`, summary: "", inbox: 0, candidate: workingTree(dev, dir).tree,
        checks: { gate: "通过", review: "通过", acceptance: "未配置" }, acceptance: { failed: [], partial: [], manual: [] } });
    }, notify: () => {}, log: () => {}, pollMs: 10, silenceMs: 1000 }), 0);
    const rows = readdirSync(events).flatMap((name) => readFileSync(join(events, name), "utf8").trim().split("\n").map((line) => JSON.parse(line))), done = rows.filter((row) => row.status === "done");
    assert.deepEqual(done.map((row) => [row.stage, row.detail.scope]), [["甲", "段"], ["乙", "段"], [null, "整批"]]);
    assert.equal(done[2].detail.commit, git(dev, "rev-parse", "feat/multi")); assert.equal(git(dev, "rev-list", "--count", `${base}..feat/multi`), "1");
    assert.equal(git(dev, "show", `${done[2].detail.commit}:甲.txt`), "checked-甲"); assert.equal(git(dev, "show", `${done[2].detail.commit}:乙.txt`), "checked-乙");
    assert.ok(done[0].seq < done[2].seq && done[1].seq < done[2].seq);
  } finally {
    const queue = readMergeQueue(repo), deadline = Date.now() + 20_000;
    if (queue) {
      const busy = () => readdirSync(queue.dir).some((name) => name === "worker.lock" || /^executor-.*\.json$/.test(name));
      while (busy() && Date.now() < deadline) await new Promise((done) => setTimeout(done, 25));
      assert.equal(busy(), false, "释放本测试拥有的队列执行器后再删除夹具");
    }
    keys.forEach((key, index) => { if (old[index] === undefined) delete process.env[key]; else process.env[key] = old[index]; }); rmSync(root, { recursive: true, force: true });
  }
});

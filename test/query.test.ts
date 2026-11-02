import "./test-env.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { batchInfo, eventReason, phasePath, pushEvent, writePhase } from "../events.ts";
import { queryBatches } from "../query.ts";
import { processStartTime } from "../procs.ts";
import { writeStageStatus } from "../pipeline-core.ts";

const LOOP = fileURLToPath(new URL("../loop.ts", import.meta.url));
const snapshot = (path: string): unknown[] => {
  const stat = statSync(path);
  return [[path, stat.mtimeMs, stat.size, stat.isFile() ? readFileSync(path).toString("base64") : ""], ...(stat.isDirectory() ? readdirSync(path).sort().flatMap((name) => snapshot(join(path, name))) : [])];
};

test("A3/A8：查询暂停、队列、提交及预留字段；实际 CLI 完全只读，不需要 Git 仓库", (t) => {
  const root = mkdtempSync(join(tmpdir(), "loop-pa-query-")), home = join(root, "home"), file = join(root, "批次.json"), dir = join(home, ".pi-autoreview", "pipelines", "batch");
  const old = { HOME: process.env.HOME, LOOP_PA_CONFIG: process.env.LOOP_PA_CONFIG, AUTOREVIEW_MERGE_QUEUE_ROOT: process.env.AUTOREVIEW_MERGE_QUEUE_ROOT };
  process.env.HOME = home; delete process.env.AUTOREVIEW_MERGE_QUEUE_ROOT;
  process.env.LOOP_PA_CONFIG = join(root, "pa.json");
  t.after(() => { for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } rmSync(root, { recursive: true, force: true }); });
  writeFileSync(process.env.LOOP_PA_CONFIG, JSON.stringify({ pa: { eventsDir: join(root, "received"), localNotify: false } }));
  writeFileSync(file, JSON.stringify({ name: "batch", dir, branch: "feat/query", stages: { 甲: { start: "never run", cwd: root } } }));
  const info = batchInfo(file, root, dir), reason = eventReason("门禁环境阻塞", "environment"), summary = join(root, "summary.md"), log = join(root, "gate.log");
  writeFileSync(summary, "summary"); writeFileSync(log, "environment evidence");
  const session = { host: "pi", id: "fake", pid: process.pid, processStarted: processStartTime(process.pid), log };
  writeStageStatus({ dir, stage: "甲" }, { host: "pi", sessionId: "fake", summary, event: "paused", pauseReason: reason.text, inbox: 0 });
  writePhase(info, "甲", "paused", { status: "paused", ...reason, round: 3, repairs: 1, session, evidence: { summary, log }, next: "send", detail: { next: "send", failureKind: "environment" } });
  pushEvent(info, "甲", "paused", reason, { summary, log }, { next: "send", failureKind: "environment" });
  const queueDir = join(home, ".pi-autoreview", "merge-queues", "fixture"); mkdirSync(queueDir, { recursive: true });
  writeFileSync(join(queueDir, "queue.json"), JSON.stringify({ version: 1, repo: join(root, "not-a-repository"),
    batches: [{ id: "b", file: info.batch.file, dir, name: "batch", stages: [{ name: "甲", cwd: root, branch: "feat/query" }], commits: [{ branch: "feat/query", commit: "abc", pushed: "abc" }] }],
    entries: [{ id: "old", batch: "b", status: "returned", order: 1 }, { id: "current", batch: "b", status: "testing", order: 2, returnCount: 1, reason: "中断待恢复", log }] }));
  const before = snapshot(root), started = performance.now(), result = queryBatches(file), batch: any = result.batches[0];
  assert.ok(performance.now() - started < 1000); assert.equal(result.v, 1);
  assert.equal(batch.branch, "feat/query"); assert.equal(batch.commit, "abc"); assert.equal(batch.pushed, "abc");
  assert.equal(batch.stages[0].state, "paused"); assert.equal(batch.stages[0].next, "send"); assert.deepEqual({ category: batch.stages[0].pause.category, text: batch.stages[0].pause.text }, reason);
  assert.equal(batch.stages[0].session.alive, true); assert.equal(batch.stages[0].round, 3); assert.equal(batch.stages[0].repairs, 1);
  assert.equal(batch.queue.status, "testing"); assert.equal(batch.queue.position, 1); assert.equal(batch.events.lastSeq, 1);
  assert.deepEqual(batch.batch.paGrants, []); assert.deepEqual(batch.stages[0].paRelays, []);
  for (const args of [[file], ["--all"], []]) {
    const child = spawnSync(process.execPath, [LOOP, "查询", ...args, "--json"], { cwd: root, env: process.env, encoding: "utf8", timeout: 3000 });
    assert.equal(child.status, 0, child.stdout + child.stderr); const output = JSON.parse(child.stdout);
    assert.equal(output.v, 1); assert.equal(output.batches[0].events.lastSeq, 1); assert.equal(output.batches[0].queue.status, "testing");
  }
  assert.deepEqual(snapshot(root), before, "查询前后所有文件内容、大小和修改时间不变");
  writePhase(info, "甲", "reviewing", { session: { ...session, processStarted: "different process" } });
  const reviewing: any = queryBatches(file).batches[0]; assert.equal(reviewing.stages[0].state, "running"); assert.equal(reviewing.stages[0].session.alive, false);
  assert.equal(reviewing.stages[0].pause, null, "恢复/评审中的 phase 不能回填旧 status 的暂停原因");
  assert.equal(reviewing.stages[0].next, undefined);
  assert.ok(phasePath(dir, "甲").endsWith("甲.phase.json"));
});

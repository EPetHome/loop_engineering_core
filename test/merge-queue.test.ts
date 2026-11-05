/** merge-queue：独立进程隔离环境，保持全部场景与断言。 */
import "./test-env.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { mergeQueuedBatch, queueBatchComplete, queueBatchRecheck, queueDir, queueReviewedResult, registerQueueBatch } from "../merge-queue.ts";
import { inboxPath, queueAcceptance, readJson, statusPath, writeJsonAtomic, type InboxMessage, type StageStatus } from "../pipeline-core.ts";
import { processStartTime } from "../procs.ts";
import { captureProjectConfigOverrides, parseMergeConfig } from "../config.ts";
import { loadContext, refreshContext } from "../project-context.ts";
import type { AcceptanceRecord } from "../acceptance-core.ts";
import { queueStageEvent, fixture, repeatableMulti, autoConfig, autoComplete, automaticMerged, notification, multiReady } from "./helpers/merge-queue-fixture.ts";

test("队列配置／资格复核和独立队列门禁使用原段覆盖，仍拒绝不足预算", async () => {
  const f = fixture(1);
  try {
    const batch = f.batches[0], marker = JSON.parse(readFileSync(join(f.repo, ".autoreview.json"), "utf8"));
    const configured = { ...marker, gate: { ...marker.gate, timeoutMin: 20 }, acceptance: { timeoutMin: 60 }, context: { sources: ["prompt.md"] } };
    writeFileSync(join(f.repo, ".autoreview.json"), JSON.stringify(configured));
    f.git(f.repo, "add", ".autoreview.json"); f.git(f.repo, "commit", "-qm", "budget configuration");
    f.write(0, ".autoreview.json", JSON.stringify(configured));
    f.write(0, "src/a.txt", "reviewed\n");
    const overrides = captureProjectConfigOverrides({ reviewTimeoutMin: "120" }, {});
    const sourceInputs = refreshContext(loadContext(batch.cwd, overrides)!).snapshot.inputsFingerprint;
    queueStageEvent({ cwd: batch.cwd, file: batch.file, stage: "甲", status: { sessionId: "config-overrides", host: "pi", event: "done", readyEpoch: "config-ready", summary: "", inbox: 0,
      configOverrides: overrides, sourceInputs, acceptance: queueAcceptance() } });
    await f.ready(0);
    assert.equal(f.queue().entries[0].gate?.timeoutMin, 20, "独立队列执行器实际读取门禁并通过");
    const registration = f.queue().batches[0];
    const readOnly = () => mergeQueuedBatch(f.repo, registration, true, () => assert.fail("只读核对不能发布"));
    assert.equal((await readOnly()).status, "ready");
    const path = statusPath(batch.dir, "甲"), status = readJson<StageStatus>(path)!;
    writeJsonAtomic(path, { ...status, configOverrides: captureProjectConfigOverrides({ reviewTimeoutMin: "60" }, {}) });
    await assert.rejects(readOnly(), /必须小于一轮总预算/);
    writeJsonAtomic(path, status);
  } finally { await f.close(); }
});

test("兼容旧队列开关：只读归一化，保留 integrationEpoch 和其他历史材料", async () => {
  const f = fixture(1);
  try {
    const multi = repeatableMulti(f, { acceptance: true }), queue = f.queue();
    const batch = queue.batches.find((item) => item.file === multi.file)!;
    delete batch.acceptance; batch.e2e = true; batch.integrationEpoch = "legacy-epoch"; // 旧状态兼容。
    const path = join(queue.dir, "queue.json"); writeJsonAtomic(path, queue);
    const before = readFileSync(path);
    const loaded = f.queue().batches.find((item) => item.file === multi.file)!;
    assert.equal(loaded.acceptance, true); assert.equal(loaded.e2e, undefined); // 旧字段只在读取边界使用。
    assert.equal(loaded.integrationEpoch, "legacy-epoch");
    assert.deepEqual(readFileSync(path), before, "只读状态查询不迁移磁盘记录");
  } finally { await f.close(); }
});

test("dry-run 不启动执行器、不写队列；未开工项目的完成事件和非 git 项目不接入", async () => {
  const f = fixture(1);
  try {
    const state = readFileSync(join(queueDir(f.repo), "queue.json"), "utf8");
    assert.equal(f.cli("状态", "--dry-run").ok, true); assert.equal(f.cli("合入", f.batches[0].file, "--dry-run").ok, true);
    assert.equal(readFileSync(join(queueDir(f.repo), "queue.json"), "utf8"), state); assert.ok(!existsSync(f.queue().workspace));
    queueStageEvent({ cwd: f.repo, file: join(f.root, "not-opened.json"), stage: "甲", status: { sessionId: "other", event: "done", readyEpoch: "x", summary: "", inbox: 0 } });
    const nonGit = join(f.root, "non-git"); mkdirSync(nonGit); queueBatchComplete(nonGit, "anything", true);
    assert.equal(f.queue().entries.length, 0);
  } finally { await f.close(); }
});

test("旧自动配置已停用且字段值忽略；人工与部分验证分开记录", () => {
  assert.deepEqual(parseMergeConfig(undefined), { auto: false, push: false });
  assert.deepEqual(parseMergeConfig({}), { auto: false, push: false });
  assert.deepEqual(parseMergeConfig({ auto: true }), { auto: false, push: false });
  assert.deepEqual(parseMergeConfig({ auto: "true", push: 1 }), { auto: false, push: false });
  for (const raw of [null, [], true]) assert.throws(() => parseMergeConfig(raw), /merge/);
  const record: AcceptanceRecord = { verdict: "部分验证", items: [
    { id: "A1", text: "人工确认布局", verdict: "需人工", detail: "主观判断" },
    { id: "A2", text: "自动操作", verdict: "无法验证", detail: "任何原因都挡住" },
  ], logErrors: [], extra: [], runDir: "", durationMs: 0 };
  assert.equal(queueAcceptance(record).manual.length, 1); assert.equal(queueAcceptance(record).partial.length, 1);
});

test("自动 A2：任意部分验证、不通过或旧状态缺结论均停在可合入；未配置 merge 的既有行为保持", async (t) => {
  for (const kind of ["partial", "failed", "legacy", "off"]) await t.test(kind, async () => {
    const f = fixture(1);
    try {
      if (kind !== "off") autoConfig(f);
      const base = f.git(f.repo, "rev-parse", "HEAD"); f.write(0, "src/a.txt", "a\n");
      const acceptance = queueAcceptance();
      if (kind === "partial" || kind === "failed") acceptance[kind].push({ id: "A7", text: "具体验收条目", detail: "环境或权限或标准含糊均不能放行" });
      if (kind === "legacy") f.complete(0); else autoComplete(f, 0, acceptance);
      await f.ready(0); const entry = f.queue().entries[0]; assert.equal(f.git(f.repo, "rev-parse", "HEAD"), base);
      assert.match(notification(f, entry.id), /可合入/);
      assert.equal(entry.automatic, undefined, "无论旧 merge 开关与验收欠项，均不能自动合入");
      assert.deepEqual(entry.qualification[0].acceptance, kind === "legacy" ? undefined : acceptance);
    } finally { await f.close(); }
  });
});

test("自动 A5：开工 scope.allow 重叠仅提示建议串行，照常开工", async () => {
  const f = fixture(2, 1);
  try {
    const result = f.cli("开工", f.batches[1].file); assert.equal(result.ok, true, JSON.stringify(result));
    assert.match(result.lines.join("\n"), /批次0[\s\S]*建议改为串行/); assert.ok(existsSync(f.batches[1].cwd));
  } finally { await f.close(); }
});

test("自动 A9 兜底边界：同树不同提交、脏工作树、未登记批次均不豁免", async () => {
  const f = fixture(1);
  try {
    f.write(0, "src/a.txt", "a\n"); autoComplete(f, 0); await f.ready(0);
    const entry = f.queue().entries[0], dev = f.batches[0].cwd, env = { AUTOREVIEW_BATCH_FILE: f.batches[0].file, AUTOREVIEW_STAGE: "甲" };
    const snapshot = () => ({ ref: f.git(dev, "rev-parse", "HEAD"), head: f.git(dev, "rev-parse", "HEAD"), tree: f.git(dev, "rev-parse", "HEAD^{tree}"), untracked: [], fingerprint: "fixture" });
    f.git(dev, "reset", "--hard", entry.result!); assert.ok(queueReviewedResult(dev, snapshot(), env));
    f.git(dev, "commit", "--allow-empty", "-qm", "same tree different commit"); assert.equal(queueReviewedResult(dev, snapshot(), env), undefined);
    f.git(dev, "reset", "--hard", entry.result!); f.write(0, "shared.txt", "dirty\n"); assert.equal(queueReviewedResult(dev, snapshot(), env), undefined);
    f.git(dev, "restore", "shared.txt"); assert.equal(queueReviewedResult(dev, snapshot(), { ...env, AUTOREVIEW_BATCH_FILE: join(f.root, "unregistered.json") }), undefined);
  } finally { await f.close(); }
});

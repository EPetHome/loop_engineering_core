/** batch-queue-completion：独立进程隔离环境，保持全部场景与断言。 */
import "./test-env.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { queueBatchComplete, queueBatchRecheck, queueDir, queueStageEvent as realQueueStageEvent, registerQueueBatch } from "../merge-queue.ts";
import { inboxPath, queueAcceptance, readJson, statusPath, writeJsonAtomic, type InboxMessage, type StageStatus } from "../pipeline-core.ts";
import { processStartTime } from "../procs.ts";
import { parsePlan, runPipeline } from "../pipeline.ts";
import { createGitEvidence } from "../git.ts";
import { phasePath, type PhaseRecord } from "../events.ts";
import { queryBatches } from "../query.ts";
import { materialSession, recordMaterialSession, registerAcceptanceMaterials, slimCompletedSession } from "../materials.ts";
import type { AcceptanceRecord } from "../acceptance-core.ts";
import { queueStageEvent, ROOT, keys, fixture, paEvents, repeatableMulti, fakeAcceptance, autoConfig, multiReady } from "./helpers/merge-queue-fixture.ts";

test("整批完成／无整批验收多段退出后再次完成，ready/blocked 均自动重压；停止排队仍只提交", async (t) => {
  for (const phase of ["ready", "blocked", "stopped"]) await t.test(phase, async () => {
    const f = fixture(1);
    try {
      const multi = repeatableMulti(f); f.write(0, "src/a.txt", "first\n");
      await multi.done("甲", "a1"); await multi.done("乙", "b1");
      assert.equal(await runPipeline(multi.plan(), multi.io, { fromAcceptance: true }), 0);
      await f.until(() => f.queue().entries[0]?.status === "ready"); await f.idle();
      const old = f.queue().entries[0].sources[0].commit;
      if (phase === "blocked") {
        const status = readJson<StageStatus>(statusPath(multi.dir, "甲"))!;
        realQueueStageEvent({ cwd: multi.dev, file: multi.file, stage: "甲", status: { ...status, event: "started", readyEpoch: undefined } });
        await f.until(() => f.queue().entries[0]?.status === "blocked"); await f.idle();
      } else if (phase === "stopped") {
        const queue = f.queue(); Object.assign(queue.entries[0], { status: "stopped", autoStopped: true, returnCount: 3 }); writeJsonAtomic(join(queue.dir, "queue.json"), queue);
      }
      f.write(0, "src/a.txt", "again\n"); await multi.done("甲", "a2");
      f.cli("状态"); f.cli("状态");
      await f.until(() => f.queue().batches.find((batch) => batch.file === multi.file)!.commits![0].commit !== old); await f.idle();
      const batch = f.queue().batches.find((item) => item.file === multi.file)!;
      assert.equal(f.git(multi.dev, "status", "--porcelain"), ""); assert.equal(f.git(multi.dev, "rev-list", "--count", "main..HEAD"), "1");
      assert.equal(f.queue().entries.length, phase === "stopped" ? 1 : 2); assert.equal(f.queue().entries.at(-1)!.status, phase === "stopped" ? "stopped" : "ready");
      assert.equal(batch.commits![0].preSquash.length, 2, "重复触发不能重压或重新排队多次");
    } finally { await f.close(); }
  });
});

test("整批完成／有整批验收多段再次完成先重验；运行中状态查询和直接启动都不能重复验收", async () => {
  const f = fixture(1), resume = join(f.root, "resume-acceptance");
  try { await fakeAcceptance(f, async (state) => {
    const reset = join(f.root, "repeat-reset.mjs"), entered = join(f.root, "reset-entered"), hold = join(f.root, "hold-reset"), resets = join(f.root, "resets");
    writeFileSync(reset, `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(resets)}, 'reset\\n'); if(fs.existsSync(${JSON.stringify(hold)})){fs.writeFileSync(${JSON.stringify(entered)}, 'entered'); while(!fs.existsSync(${JSON.stringify(resume)})) await new Promise(r=>setTimeout(r,20));}`);
    const rows = paEvents(f), multi = repeatableMulti(f, { acceptance: true, reset: `${process.execPath} ${reset}` });
    f.write(0, "src/a.txt", "first\n"); await multi.done("甲", "a1"); await multi.done("乙", "b1");
    assert.equal(await runPipeline(multi.plan(), multi.io, { fromAcceptance: true }), 0);
    await f.until(() => f.queue().entries[0]?.status === "ready"); await f.idle();
    const old = f.queue().entries[0].sources[0].commit;
    writeFileSync(hold, "hold"); f.write(0, "src/a.txt", "again\n"); await multi.done("甲", "a2");
    await f.until(() => existsSync(entered), "重复完成已自动启动整批重验");
    const activeBatch = f.queue().batches.find((batch) => batch.file === multi.file)!;
    assert.equal(activeBatch.integrationCheck?.owner.token, readJson<any>(join(queueDir(f.repo), `integration-${activeBatch.id}.lock`))!.token, "实际验收（含 reset）单独登记检查身份");
    f.cli("状态"); f.cli("状态");
    const phaseFile = phasePath(multi.dir, null), beforePhase = readFileSync(phaseFile), beforeTime = statSync(phaseFile).mtimeMs;
    const lifecycle = () => rows().filter((event) => event.batch.file === multi.file && event.stage === null && event.status !== "queue");
    const beforeEvents = lifecycle(); assert.equal(JSON.parse(beforePhase.toString()).phase, "running");
    assert.equal(await runPipeline(multi.plan(), multi.io, { fromAcceptance: true }), 2, "活动流水线不得再启动第二份");
    assert.deepEqual(readFileSync(phaseFile), beforePhase, "PA 返修2：未取得运行权不能覆盖活动 phase 或进程身份"); assert.equal(statSync(phaseFile).mtimeMs, beforeTime);
    const rejected = f.cli("启动", multi.file, "--launcher", "background"); assert.equal(rejected.ok, false); assert.equal(rejected.exitCode, 2);
    assert.deepEqual(readFileSync(phaseFile), beforePhase, "loop 启动也不能在运行锁之前写 started"); assert.equal(statSync(phaseFile).mtimeMs, beforeTime);
    assert.deepEqual(lifecycle(), beforeEvents, "重复启动不应产生虚假 started/resumed/paused 事件");
    const queried: any = queryBatches(multi.file).batches[0]; assert.equal(queried.state, "running"); assert.equal(queried.pause, null);
    assert.equal(f.git(multi.dev, "rev-parse", "HEAD"), old, "本轮验收通过前不能提交");
    assert.equal(readFileSync(join(state, "acc-count"), "utf8"), "1");
    writeFileSync(resume, "go"); await f.until(() => f.queue().entries.length === 2 && f.queue().entries[1].status === "ready"); await f.idle();
    assert.equal(readFileSync(join(state, "acc-count"), "utf8"), "2"); assert.equal(readFileSync(resets, "utf8"), "reset\nreset\n");
    assert.equal(f.queue().batches.find((batch) => batch.id === activeBatch.id)!.integrationCheck, undefined, "验收收尾后撤销活动登记");
    assert.notEqual(f.git(multi.dev, "rev-parse", "HEAD"), old);
  }); } finally { writeFileSync(resume, "go"); await f.close(); }
});

test("整批提交／同分支根目录与 front 子目录串行，末段真实 Snapshot 的新增文件按原 cwd 提交", async () => {
  const f = fixture(1), pending: Promise<unknown>[] = [];
  try {
    const multi = repeatableMulti(f, { front: true });
    let lastCandidate: Awaited<ReturnType<ReturnType<typeof createGitEvidence>["snapshot"]>> | undefined;
    const code = await runPipeline(multi.plan(), { ...multi.io, launch: (stage) => {
      if (stage.name === "甲") f.write(0, "src/a.txt", "root checked\n"); else writeFileSync(join(multi.front, "new.ts"), "export const checked = true;\n");
      pending.push(multi.done(stage.name as "甲" | "乙", stage.name).then((candidate) => { if (stage.name === "乙") lastCandidate = candidate; }));
    } });
    await Promise.all(pending); assert.equal(code, 0, readFileSync(join(multi.dir, "report.md"), "utf8"));
    assert.deepEqual(lastCandidate!.untracked.map((file) => file.path), ["new.ts"]);
    await f.until(() => f.queue().entries[0]?.status === "ready"); await f.idle();
    assert.equal(f.git(multi.dev, "show", "HEAD:front/new.ts"), "export const checked = true;");
    assert.equal(f.git(multi.dev, "rev-list", "--count", "main..HEAD"), "1"); assert.equal(f.git(multi.dev, "status", "--porcelain"), "");
    assert.equal(f.queue().entries[0].sources[0].cwd, multi.front, "候选与会话路径基准必须一起保留");
  } finally { await Promise.all(pending); await f.close(); }
});

test("整批资格／整批验收通过→部分验证→通过替换旧资格，同一完成事件保持幂等", async (t) => {
  for (const versioned of [false, true]) await t.test(versioned ? "按流水线验收代次" : "兼容直接传验收记录", async () => {
    const f = fixture(1);
    try {
      const rows = paEvents(f);
      autoConfig(f); f.write(0, "src/a.txt", "candidate\n"); mkdirSync(join(f.repo, "src")); writeFileSync(join(f.repo, "src/a.txt"), "runtime overlap\n");
      const { file, passed, partial } = multiReady(f), base = f.git(f.repo, "rev-parse", "HEAD");
      const firstEpoch = versioned ? queueBatchRecheck(f.repo, file) : undefined;
      queueBatchComplete(f.repo, file, true, passed, firstEpoch);
      await f.until(() => f.queue().entries[0]?.status === "ready" && Boolean(f.queue().entries[0].notified)); await f.idle();
      assert.equal(f.cli("合入", file).ok, false, "重叠脏文件仍阻止用户合入");
      const first = f.queue().entries[0];
      const doneEvents = () => rows().filter((event) => event.batch.file === file && event.stage === null && event.status === "done");
      assert.equal(doneEvents().length, 1);
      queueBatchComplete(f.repo, file, true, passed, firstEpoch); await f.idle(); assert.equal(f.queue().entries.length, 1, "相同结论与代次不重复进队");
      assert.equal(doneEvents().length, 1, "同一次完成的重放不能重复通知");
      const secondEpoch = versioned ? queueBatchRecheck(f.repo, file) : undefined;
      rmSync(join(f.repo, "src/a.txt"));
      if (versioned) {
        queueBatchComplete(f.repo, file, true, passed, firstEpoch); await f.idle();
        assert.equal(f.queue().entries.length, 1); assert.equal(f.queue().entries[0].status, "blocked", "新一轮未结束，旧完成事件不能复活通过资格");
        assert.equal(f.git(f.repo, "rev-parse", "HEAD"), base);
      }
      queueBatchComplete(f.repo, file, false, partial, secondEpoch); await f.idle();
      assert.equal(f.queue().entries.length, 1); assert.equal(f.queue().entries[0].status, "blocked");
      assert.notEqual(f.queue().batches.find((batch) => batch.file === file)!.integrationEpoch, first.integrationEpoch);
      assert.equal(f.git(f.repo, "rev-parse", "HEAD"), base);
      queueBatchComplete(f.repo, file, false, partial, secondEpoch); await f.idle(); assert.equal(f.queue().entries.length, 1);
      const thirdEpoch = versioned ? queueBatchRecheck(f.repo, file) : undefined;
      queueBatchComplete(f.repo, file, true, passed, thirdEpoch); // 与第一次完全相同的记录，不能被历史去重吞掉。
      await f.until(() => f.queue().entries.at(-1)?.status === "ready" && Boolean(f.queue().entries.at(-1)?.notified)); await f.idle();
      assert.equal(doneEvents().length, 2, "PA 返修3：同一提交在部分验证后重新通过，必须产生新的 done");
      assert.equal(doneEvents()[1].detail.commit, doneEvents()[0].detail.commit, "该场景确实复用相同提交号");
      const published = f.cli("合入", file); assert.equal(published.ok, true, JSON.stringify(published)); await f.idle();
      const merged = f.queue().entries.at(-1)!;
      assert.equal(f.queue().entries.length, 2); assert.equal(merged.status, "merged"); assert.deepEqual(merged.integration, queueAcceptance(passed));
      assert.equal(f.git(f.repo, "rev-parse", "HEAD"), merged.result);
      queueBatchComplete(f.repo, file, true, passed, thirdEpoch); await f.idle(); assert.equal(f.queue().entries.length, 2);
      assert.equal(doneEvents().length, 2, "新完成的后续重放同样不重复通知");
    } finally { await f.close(); }
  });
});

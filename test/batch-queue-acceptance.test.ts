/** batch-queue-acceptance：独立进程隔离环境，保持全部场景与断言。 */
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

test("整批验收／开工后新增整批验收，部分验证不提交、不进队，通过后才提交", async () => {
  const f = fixture(1);
  try { await fakeAcceptance(f, async () => {
    const rows = paEvents(f), multi = repeatableMulti(f);
    assert.equal(f.queue().batches.find((batch) => batch.file === multi.file)!.acceptance, false);
    writeFileSync(multi.file, JSON.stringify({ ...multi.raw, acceptance: multi.acceptance }));
    f.write(0, "src/a.txt", "checked\n"); await multi.done("甲", "a1"); await multi.done("乙", "b1");
    const head = f.git(multi.dev, "rev-parse", "HEAD"); process.env.FAKE_ACC_UNKNOWN = "A1";
    assert.equal(await runPipeline(multi.plan(), multi.io, { fromAcceptance: true }), 2, "自动条目未通过必须返回暂停，不是成功");
    assert.match(readFileSync(join(multi.dir, "report.md"), "utf8"), /部分验证/);
    assert.equal(f.queue().entries.length, 0); assert.equal(f.git(multi.dev, "rev-parse", "HEAD"), head);
    assert.equal(f.queue().batches.find((batch) => batch.file === multi.file)!.acceptance, true, "按本轮实际配置同步，不沿用开工时的 false");
    const phase = readJson<PhaseRecord>(phasePath(multi.dir, null))!;
    assert.equal(phase.phase, "paused", "PA 返修1：未提交的部分验证不能发布整批 done");
    assert.equal(phase.next, "resume"); assert.match(phase.text, /完整验收仍有自动条目未通过（A1）/);
    assert.ok(existsSync(phase.evidence.acceptance));
    const conclusion: AcceptanceRecord = JSON.parse(readFileSync(join(phase.evidence.acceptance, "result.json"), "utf8"));
    assert.equal(conclusion.verdict, "部分验证"); assert.equal(conclusion.items.find((item) => item.id === "A1")?.verdict, "无法验证");
    const queried: any = queryBatches(multi.file).batches[0]; assert.equal(queried.state, "paused"); assert.equal(queried.commit, null); assert.equal(queried.pause.text, phase.text);
    assert.equal(rows().filter((event) => event.status === "done" && event.stage === null).length, 0);
    const summary = join(process.env.HOME!, ".pi-autoreview", "material-test", "fake.md"); mkdirSync(dirname(summary), { recursive: true }); writeFileSync(summary, "材料保护替身\n");
    const session = materialSession("fake", multi.dev, summary, "done"); session.batch = { file: multi.file, dir: multi.dir };
    const runDir = join(session.acceptanceDir, "r1"), large = join(runDir, "node_modules", "large.bin"); mkdirSync(dirname(large), { recursive: true }); writeFileSync(large, Buffer.alloc(256 * 1024 + 1));
    recordMaterialSession(session); registerAcceptanceMaterials(session.sessionId, session.workDir, runDir, session.procsFile);
    assert.match(slimCompletedSession(session), /整批证据保留/); assert.ok(existsSync(large), "整批未完成时已完成段的材料仍保留");
    process.env.FAKE_ACC_UNKNOWN = "";
    assert.equal(await runPipeline(multi.plan(), multi.io, { fromAcceptance: true }), 0);
    await f.until(() => f.queue().entries.at(-1)?.status === "ready"); await f.idle();
    assert.notEqual(f.git(multi.dev, "rev-parse", "HEAD"), head); assert.equal(f.queue().entries.length, 1);
    assert.equal(readJson<PhaseRecord>(phasePath(multi.dir, null))!.phase, "done");
    assert.equal(rows().filter((event) => event.status === "done" && event.stage === null).length, 1);
    slimCompletedSession(session); assert.equal(existsSync(large), false, "实际提交完成后才恢复原有瘦身资格");
  }); } finally { await f.close(); }
});

test("多段完成事件不提前进队；必须整批验收通过；失败文件按 scope 路由，未定位时说明退回最后一段", async () => {
  const f = fixture(1);
  try {
    const first = f.batches[0], multi = join(f.root, "multi.json"), dir = join(f.root, "multi-pipeline");
    writeFileSync(multi, "{}");
    registerQueueBatch(f.repo, { name: "多段", file: multi, dir, project: f.repo, release: "main", steps: [["甲"], ["乙"]], stages: [
      { name: "甲", cwd: first.cwd, branch: first.branch, start: "true", scope: { allow: ["src/a.txt"] } },
      { name: "乙", cwd: first.cwd, branch: first.branch, start: "true", scope: { allow: ["src/b.txt"] } },
    ] });
    f.write(0, "src/a.txt", "a\n"); f.conflict();
    for (const stage of ["甲", "乙"]) queueStageEvent({ cwd: first.cwd, file: multi, stage, status: { sessionId: `multi-${stage}`, event: "done", readyEpoch: stage, summary: "", inbox: 0, pid: process.pid, processStarted: processStartTime(process.pid) } });
    assert.equal(f.queue().entries.length, 0);
    queueBatchComplete(f.repo, multi, false); assert.equal(f.queue().entries.length, 1, "没有整批验收标准时跳过验收并进队");
    queueBatchComplete(f.repo, multi, true);
    await f.until(() => f.queue().entries[0]?.status === "returned");
    assert.ok(readJson<InboxMessage>(inboxPath(dir, "甲"))); assert.equal(readJson<InboxMessage>(inboxPath(dir, "乙")), undefined);
    assert.match(readJson<InboxMessage>(inboxPath(dir, "甲"))!.message, /src\/a.txt/);
  } finally { await f.close(); }
});

test("冲突文件不属于任何段时，明确说明原因并退回最后一段", async () => {
  const f = fixture(1);
  try {
    const file = join(f.root, "fallback.json"), dir = join(f.root, "fallback-pipeline"), dev = f.batches[0];
    writeFileSync(file, "{}");
    registerQueueBatch(f.repo, { name: "无法定位", file, dir, project: f.repo, release: "main", steps: [["甲"], ["乙"]],
      stages: ["甲", "乙"].map((name) => ({ name, cwd: dev.cwd, branch: dev.branch, start: "true", scope: { allow: [`src/${name}`] } })) });
    f.write(0, "src/other.txt", "bad\n"); f.conflict("src/other.txt");
    for (const stage of ["甲", "乙"]) queueStageEvent({ cwd: dev.cwd, file, stage, status: { sessionId: stage, event: "done", readyEpoch: stage, summary: "", inbox: 0, pid: process.pid, processStarted: processStartTime(process.pid) } });
    queueBatchComplete(f.repo, file, true); await f.until(() => f.queue().entries[0]?.status === "returned");
    assert.equal(readJson(inboxPath(dir, "甲")), undefined);
    assert.match(readJson<InboxMessage>(inboxPath(dir, "乙"))!.message, /src\/other.txt[\s\S]*无法唯一确定文件归属，退回最后一段「乙」/);
  } finally { await f.close(); }
});

test("多段完整接线：整批验收后自动进队；队列退回原段修好后自动重跑验收并重新进队", async () => {
  const f = fixture(1);
  const variables = { AUTOREVIEW_ACCEPTANCE_CMD: join(ROOT, "test", "fake-tester.mjs"), FAKE_STATE_DIR: join(f.root, "tester-state") };
  const old = Object.fromEntries(Object.keys(variables).map((key) => [key, process.env[key]]));
  Object.assign(process.env, variables);
  try {
    const file = join(f.root, "integration-batch.json"), criteria = join(f.root, "criteria.md"), dir = join(f.root, "integration-pipeline");
    writeFileSync(criteria, "## 验收标准\nA1. [甲] 操作：替身项目检查\n    预期：通过\n");
    const raw = { name: "多段整合", branch: f.batches[0].branch, dir, stages: {
      甲: { workflow: "without-acceptance", cwd: f.batches[0].cwd, start: "true", scope: { allow: ["src/a.txt"] } },
      乙: { workflow: "without-acceptance", cwd: f.batches[0].cwd, start: "true", scope: { allow: ["src/b.txt"] } },
    }, steps: [["甲"], ["乙"]], acceptance: { workDir: f.batches[0].cwd, criteria, timeoutMin: 2 } };
    writeFileSync(file, JSON.stringify(raw)); assert.equal(f.cli("开工", file).ok, true);
    f.write(0, "src/a.txt", "bad\n"); f.write(0, "src/b.txt", "b\n");
    const done = (stage: string, epoch: string, inbox = 0) => queueStageEvent({ cwd: f.batches[0].cwd, file, stage, status: {
      sessionId: `integration-original-${stage}`, event: "done", readyEpoch: epoch, inbox, summary: "", pid: process.pid, processStarted: processStartTime(process.pid),
    } });
    done("甲", "initial-a"); done("乙", "initial-b"); assert.equal(f.queue().entries.length, 0);
    const plan = parsePlan(raw, f.root, process.env, { batchFile: file, projectRoot: f.repo });
    f.conflict();
    const code = await runPipeline(plan, { launch: () => { throw new Error("不应新开开发会话"); }, notify: () => {}, log: () => {}, pollMs: 20, silenceMs: 1000,
      preflightEnv: { pi: process.env.PI_BIN, permission: process.env.PERMISSION_EXTENSION, autoreview: join(ROOT, "autoreview.ts"), playwright: () => true } }, { fromAcceptance: true });
    assert.equal(code, 0, `${readFileSync(join(dir, "report.md"), "utf8")}\n${readFileSync(join(dir, "e2e", "r1", "result.json"), "utf8")}`); await f.until(() => f.queue().entries[0]?.status === "returned"); // 兼容旧材料目录。
    const inbox = readJson<InboxMessage>(inboxPath(dir, "甲"))!; assert.ok(inbox); assert.equal(readJson(inboxPath(dir, "乙")), undefined);
    f.git(f.batches[0].cwd, "merge", "-s", "ours", "main", "--no-edit");
    f.write(0, "src/a.txt", "fixed\n"); done("甲", "repaired-a", inbox.seq);
    await f.until(() => f.queue().entries.length === 2 && f.queue().entries[1].status === "ready"); await f.idle();
    const batch = f.queue().batches.find((item) => item.name === "多段整合")!;
    await f.until(() => !existsSync(join(queueDir(f.repo), `integration-${batch.id}.lock`)), "整合编排释放执行锁");
    assert.equal(readFileSync(join(variables.FAKE_STATE_DIR, "acc-count"), "utf8"), "2", "队列自己不运行 LLM，返修只由整合流水线再验一次");
    assert.equal(f.queue().entries[0].status, "returned");
  } finally {
    for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await f.close();
  }
});

test("整批验收／提交与入队资格：欠项原样保留，必需验收通过后才提交", async (t) => {
  for (const partial of ["none", "stage", "acceptance", "configured"] as const) await t.test(partial, async () => {
    const f = fixture(1), configured = partial === "configured";
    try {
      if (!configured) autoConfig(f);
      f.write(0, "src/a.txt", "multi\n");
      const dev = f.batches[0].cwd, file = join(f.root, "required-multi.json"), dir = join(f.root, "required-multi");
      writeFileSync(file, JSON.stringify(configured ? { acceptance: {} } : {}));
      registerQueueBatch(f.repo, { name: "验收入队", file, dir, project: f.repo, release: "main", ...(configured ? { acceptance: true } : {}),
        steps: [["甲"], ["乙"]], stages: ["甲", "乙"].map((name) => ({ name, cwd: dev, branch: f.batches[0].branch, start: "true" })) });
      for (const stage of ["甲", "乙"]) {
        const acceptance = queueAcceptance(); acceptance.manual.push({ id: "A1", text: `${stage}人工确认`, detail: "未验" });
        if (stage === "乙" && partial === "stage") acceptance.partial.push({ id: "A2", text: "段部分验证", detail: "方法含糊" });
        queueStageEvent({ cwd: dev, file, stage, status: { sessionId: stage, event: "done", readyEpoch: stage, inbox: 0, summary: "",
          ...(configured ? {} : { acceptance, pid: process.pid, processStarted: processStartTime(process.pid) }) } });
      }
      assert.equal(f.queue().entries.length, 0);
      const record: AcceptanceRecord = { verdict: "部分验证", items: configured
        ? [{ id: "A1", text: "尚未验完", verdict: "无法验证", detail: "缺证据" }]
        : [{ id: "A3", text: "整合人工确认", verdict: "需人工", detail: "未验" }], runDir: dir, durationMs: 0, extra: [], logErrors: [] };
      if (partial === "acceptance") record.items.push({ id: "A4", text: "整合部分验证", verdict: "无法验证", detail: "权限不足" });
      const head = f.git(dev, "rev-parse", "HEAD");
      if (configured) queueBatchComplete(f.repo, file, false);
      queueBatchComplete(f.repo, file, false, record); await f.idle();
      assert.equal(f.queue().entries.length, 0, "不能用未完成或旧的未配置标记放行");
      assert.equal(f.git(dev, "rev-parse", "HEAD"), head);
      if (configured) {
        queueBatchComplete(f.repo, file, true);
        await f.until(() => f.queue().entries[0]?.status === "ready"); await f.idle();
        assert.notEqual(f.git(dev, "rev-parse", "HEAD"), head);
      } else {
        assert.equal(queueAcceptance(record).manual[0].id, "A3");
        assert.equal(queueAcceptance(record).partial.length, partial === "acceptance" ? 1 : 0);
        const stage = readJson<StageStatus>(statusPath(dir, "乙"))!;
        assert.equal(stage.acceptance!.manual[0].text, "乙人工确认");
        assert.equal(stage.acceptance!.partial.length, partial === "stage" ? 1 : 0);
      }
    } finally { await f.close(); }
  });
});

/** autoreview／queue：按功能独立运行，夹具与状态不跨测试进程共享。 */
import "./test-env.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { applyQueuedResult } from "../loop.ts";
import { mergeQueuedBatch, queueDir, readMergeQueue, registerQueueBatch } from "../merge-queue.ts";
import { statusPath, writeJsonAtomic } from "../pipeline-core.ts";
import { result, until, harness, stageStatus, sendInbox } from "./helpers/autoreview-fixture.ts";

test("G13 流水线：不带环境变量时完全不动；带了就报 started / done / paused", async (t) => {
  await t.test("普通会话：不写状态文件、不看收件箱", async () => {
    const h = harness();
    try {
      await h.event("session_start"); await h.begin(); h.write("file.txt", "base\nA\n");
      sendInbox(h, "乙", 1, "A3. 不该被发出去");
      await h.command(); await h.terminal();
      for (let i = 0; i < 30; i += 1) await new Promise((r) => setTimeout(r, 5));
      assert.equal(existsSync(join(h.pipelineDir, "乙.status.json")), false);
      assert.deepEqual(h.messages, []);
    } finally { await h.close(); }
  });
  await t.test("段会话：开会话、评审完成、暂停各报一次，序号递增", async () => {
    const h = harness({ stage: "乙" });
    try {
      await h.event("session_start");
      assert.equal(stageStatus(h, "乙").event, "started");
      await h.begin(); h.write("file.txt", "base\nA\n");
      await h.command(); await h.terminal();
      const done = stageStatus(h, "乙");
      assert.deepEqual([done.event, done.seq, done.inbox, done.sessionId], ["done", 2, 0, "unit-dev"]);
      assert.match(done.summary, /unit-dev\.md$/);
      h.assistant("卡住了\n【需要你决定】"); await h.event("agent_settled");
      const paused = stageStatus(h, "乙");
      assert.deepEqual([paused.event, paused.seq, paused.pauseReason], ["paused", 3, "开发方需要你决定"]);
    } finally { await h.close(); }
  });
});

test("G13 流水线收件箱：空闲时发给开发方；评审只看这次的改动，整批验收条目当上一轮必修复查", async (t) => {
  await t.test("修了：评审完成后报 done，带收件箱序号", async () => {
    const h = harness({ stage: "乙" });
    try {
      await h.event("session_start"); await h.begin(); h.write("file.txt", "base\nA\n");
      await h.command(); await h.terminal();
      assert.equal(stageStatus(h, "乙").event, "done");
      // 同一仓库里别的段在乙完成之后的改动，不该算进乙的返修评审。
      h.write("other-stage.txt", "甲的改动\n");
      sendInbox(h, "乙", 1, "A3. [乙] 打开需求现状页\n    实际：MUSTFIX_SENTINEL");
      await until(() => h.messages.length === 1, "收件箱的返修发给了开发方");
      assert.match(h.messages[0], /^【整批验收返修 · 第 1 轮】/);
      assert.deepEqual([h.state().phase, (h.state() as any).inboxHandled, (h.state() as any).awaitingInbox], ["idle", 1, 1]);
      h.write("file.txt", "base\nA\nFIX_ACCEPTANCE\n"); h.assistant("A3：已修");
      await h.event("agent_settled");
      await until(() => stageStatus(h, "乙")?.seq === 4 && stageStatus(h, "乙")?.event === "done", "返修评审完成");
      const status = stageStatus(h, "乙");
      assert.deepEqual([status.event, status.inbox], ["done", 1]);
      const input = h.inputs.at(-1)!;
      assert.match(input, /## 上一轮必修\n+A3\. \[乙\] 打开需求现状页[\s\S]*MUSTFIX_SENTINEL/);
      assert.match(input, /\+FIX_ACCEPTANCE/);
      assert.doesNotMatch(input, /other-stage\.txt/, "收到返修之前别的段的改动不算这一段的");
      for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 5));
      assert.equal(h.messages.length, 1, "同一条收件箱不会重复发");
    } finally { await h.close(); }
  });
  await t.test("没改代码：报 no-change 并带回复，不评审", async () => {
    const h = harness({ stage: "乙" });
    try {
      await h.event("session_start"); await h.begin(); h.write("file.txt", "base\nA\n");
      await h.command(); await h.terminal();
      const reviews = h.inputs.length;
      sendInbox(h, "乙", 1, "A3. [乙] 打开需求现状页");
      await until(() => h.messages.length === 1, "收件箱的返修发给了开发方");
      h.assistant("A3：不归我：页面拿到的接口数据就是错的，是后端的问题\n【交付完成】");
      await h.event("agent_settled");
      const status = stageStatus(h, "乙");
      assert.deepEqual([status.event, status.inbox], ["no-change", 1]);
      assert.match(status.reply, /不归我/);
      assert.equal(h.inputs.length, reviews, "没改动就不评审");
      assert.equal((h.state() as any).awaitingInbox, undefined);
    } finally { await h.close(); }
  });
  await t.test("返修还没处理完时会话重开：只报 started，不让编排程序误以为修好了", async () => {
    const h = harness({ stage: "乙", restored: { enabled: true, rounds: [], repairs: 0, phase: "done", inboxHandled: 1, awaitingInbox: 1 } });
    try {
      await h.event("session_start");
      assert.deepEqual([stageStatus(h, "乙").event, stageStatus(h, "乙").inbox], ["started", 1]);
    } finally { await h.close(); }
  });
});

test("G13 总结记录开发方在基线之后新增的提交", async () => {
  const h = harness();
  try {
    await h.event("session_start"); await h.begin();
    h.write("file.txt", "base\nCOMMITTED\n"); h.git("commit", "-qam", "开发方自己提交了");
    h.write("file.txt", "base\nCOMMITTED\nMORE\n");
    await h.command(); await h.terminal();
    assert.match(h.summary(), /^- 开发方新增提交：1 个（基线之后，只记录不评判）$/m);
  } finally { await h.close(); }
});

test("已完成段的整合返修经过自动重评审仍保留已用业务次数", async () => {
  const h = harness({ stage: "乙", restored: { enabled: true, phase: "idle", rounds: [], repairs: 2 } });
  try {
    await h.event("session_start"); await h.begin(); h.assistant();
    await h.event("agent_settled"); await h.terminal();
    assert.equal(h.state().repairs, 2);
    sendInbox(h, "乙", 1, "A1. [乙] fix integration");
    await until(() => h.messages.length === 1, "收到机器返修");
    h.write("file.txt", "base\nfix\n"); h.assistant();
    await h.event("agent_settled"); await until(() => (h.state() as any).awaitingInbox === undefined, "返修评审完成");
    assert.equal(h.state().phase, "done"); assert.equal(h.state().repairs, 2);
  } finally { await h.close(); }
});

test("合入队列：Pi 完成提交后自动进队，压缩不触发评审，恢复保留完成资格", async () => {
  const h = harness({ stage: "甲" });
  try {
    h.write(".autoreview.json", JSON.stringify({ gate: { cmd: "true", timeoutMin: 1 } }));
    h.git("add", ".autoreview.json"); h.git("commit", "-qm", "gate config");
    const runtime = join(h.root, "runtime"), file = join(h.root, "batch.json");
    writeFileSync(file, JSON.stringify({ stages: { 甲: { workflow: "without-acceptance" } } })); h.git("worktree", "add", "-b", "release", runtime, "HEAD");
    h.git("branch", "-m", "feat/pi-batch");
    const original = h.git("rev-parse", "HEAD"), branch = h.git("branch", "--show-current");
    registerQueueBatch(runtime, { name: "Pi完成", file, dir: h.pipelineDir, project: runtime, release: "release", steps: [["甲"]],
      stages: [{ name: "甲", cwd: h.repo, branch, start: "true" }] });
    const old = process.env.AUTOREVIEW_BATCH_FILE; process.env.AUTOREVIEW_BATCH_FILE = file;
    try {
      await h.event("session_start"); await h.begin("单段需求"); h.write("file.txt", "reviewed\n"); h.assistant(); await h.event("agent_settled"); await h.terminal();
      await until(() => readMergeQueue(runtime)?.entries[0]?.status === "ready", "Pi 完成自动进队并通过门禁", 25_000);
      await until(() => !existsSync(join(queueDir(runtime), "worker.lock")), "队列释放执行锁", 25_000);
      assert.notEqual(h.git("rev-parse", "HEAD"), original, "完成后由程序提交开发分支");
      assert.match(h.summary(), /部署：未开启/, "段完成总结保留默认部署结论");
      assert.equal(h.git("rev-list", "--count", `${original}..HEAD`), "1"); assert.equal(h.git("status", "--porcelain"), "");
      const calls = h.inputs.length, epoch = JSON.parse(readFileSync(statusPath(h.pipelineDir, "甲"), "utf8")).readyEpoch;
      h.reviewer = () => { throw new Error("压缩不能启动新评审"); };
      await h.event("agent_settled"); await h.event("session_shutdown"); await h.event("session_start");
      assert.equal(h.state().phase, "done", h.summary()); assert.equal(h.inputs.length, calls);
      assert.equal(JSON.parse(readFileSync(statusPath(h.pipelineDir, "甲"), "utf8")).readyEpoch, epoch);
    } finally { if (old === undefined) delete process.env.AUTOREVIEW_BATCH_FILE; else process.env.AUTOREVIEW_BATCH_FILE = old; }
  } finally { await h.close(); }
});

test("自动 A9：Pi 共用入口识别本批已测提交和完整树，不再调用评审，总结说明原因", async () => {
  const h = harness({ stage: "甲" });
  const old = process.env.AUTOREVIEW_BATCH_FILE;
  try {
    h.write(".autoreview.json", JSON.stringify({ release: "release", gate: { cmd: "true", timeoutMin: 1 } }));
    h.git("add", ".autoreview.json"); h.git("commit", "-qm", "gate config");
    const runtime = join(h.root, "runtime"), file = join(h.root, "batch.json"); writeFileSync(file, JSON.stringify({ stages: { 甲: { workflow: "without-acceptance" } } }));
    h.git("worktree", "add", "-b", "release", runtime, "HEAD");
    h.git("branch", "-m", "feat/pi-fallback");
    registerQueueBatch(runtime, { name: "Pi兜底", file, dir: h.pipelineDir, project: runtime, release: "release", steps: [["甲"]], stages: [{ name: "甲", cwd: h.repo, branch: h.git("branch", "--show-current"), start: "true" }] });
    process.env.AUTOREVIEW_BATCH_FILE = file;
    await h.event("session_start"); await h.begin(); h.write("file.txt", "reviewed\n"); h.assistant(); await h.event("agent_settled"); await h.terminal();
    await until(() => readMergeQueue(runtime)?.entries[0]?.status === "merged" && !existsSync(join(queueDir(runtime), "worker.lock")), "队列自动提交测试过的结果", 25_000);
    const queue = readMergeQueue(runtime)!, entry = queue.entries[0]; assert.deepEqual(entry.qualification[0].acceptance, { failed: [], partial: [], manual: [] });
    await mergeQueuedBatch(runtime, queue.batches[0], false, (candidate, save) => applyQueuedResult(runtime, "release", candidate, save));
    h.git("reset", "--hard", entry.result!);
    const calls = h.inputs.length; h.reviewer = () => { throw new Error("不该再次调用评审"); };
    await h.command("review"); await h.terminal(); assert.equal(h.state().phase, "done", h.summary()); assert.equal(h.inputs.length, calls);
    assert.match(h.summary(), /不再评审：工作区提交和树与本批合入队列测过的合并结果完全相同/);
    await until(() => !existsSync(join(queueDir(runtime), "worker.lock")), "队列释放", 25_000);
    assert.equal(readMergeQueue(runtime)!.entries.length, 1, "兜底完成不把同一已合入结果再次进队");
  } finally { if (old === undefined) delete process.env.AUTOREVIEW_BATCH_FILE; else process.env.AUTOREVIEW_BATCH_FILE = old; await h.close(); }
});

test("Pi队列／历史未知验收经过 A9 兜底仍不授予自动合入资格", async () => {
  const h = harness({ stage: "甲" });
  const old = process.env.AUTOREVIEW_BATCH_FILE;
  try {
    h.write(".autoreview.json", JSON.stringify({ release: "release", gate: { cmd: "true", timeoutMin: 1 } }));
    h.git("add", ".autoreview.json"); h.git("commit", "-qm", "gate config");
    const runtime = join(h.root, "runtime"), file = join(h.root, "batch.json"); writeFileSync(file, JSON.stringify({ stages: { 甲: { workflow: "without-acceptance" } } }));
    h.git("worktree", "add", "-b", "release", runtime, "HEAD");
    h.git("branch", "-m", "feat/pi-legacy");
    registerQueueBatch(runtime, { name: "Pi历史未知", file, dir: h.pipelineDir, project: runtime, release: "release", steps: [["甲"]], stages: [{ name: "甲", cwd: h.repo, branch: h.git("branch", "--show-current"), start: "true" }] });
    process.env.AUTOREVIEW_BATCH_FILE = file;
    await h.event("session_start"); await h.begin(); h.write("file.txt", "reviewed\n"); h.assistant(); await h.event("agent_settled"); await h.terminal();
    await until(() => readMergeQueue(runtime)?.entries[0]?.status === "merged" && !existsSync(join(queueDir(runtime), "worker.lock")), "队列完成", 25_000);
    const queue = readMergeQueue(runtime)!, entry = queue.entries[0];
    // 构造升级前尚未合入的历史 ready；新完成已默认自动提交，不能再等它停在 ready。
    assert.equal(spawnSync("git", ["reset", "--hard", entry.base!], { cwd: runtime }).status, 0);
    Object.assign(entry, { status: "ready", automatic: false, autoVersion: undefined, mergeNotified: undefined, deployment: undefined });
    delete entry.qualification[0].acceptance;
    const status = JSON.parse(readFileSync(statusPath(h.pipelineDir, "甲"), "utf8")); delete status.acceptance;
    writeJsonAtomic(statusPath(h.pipelineDir, "甲"), status); writeJsonAtomic(join(queueDir(runtime), "queue.json"), queue);
    const marker = JSON.parse(readFileSync(join(runtime, ".autoreview.json"), "utf8")); writeFileSync(join(runtime, ".autoreview.json"), JSON.stringify({ ...marker, merge: { auto: true } }));
    h.git("reset", "--hard", entry.result!); const calls = h.inputs.length; h.reviewer = () => { throw new Error("不该再次静态评审"); };
    await h.command("review"); await h.terminal(); assert.equal(h.state().phase, "done", h.summary()); assert.equal(h.inputs.length, calls);
    await until(() => readMergeQueue(runtime)!.entries.length === 2 && Boolean(readMergeQueue(runtime)!.entries[1].notified) && !existsSync(join(queueDir(runtime), "worker.lock")), "未知结论停在可合入", 25_000);
    const next = readMergeQueue(runtime)!.entries[1]; assert.equal(next.status, "ready"); assert.equal(next.qualification[0].acceptance, undefined); assert.match(next.reason!, /等待用户执行 loop 合入/);
    assert.equal(spawnSync("git", ["rev-parse", "HEAD"], { cwd: runtime, encoding: "utf8" }).stdout.trim(), entry.base);
    assert.match(h.summary(), /历史队列缺少验收结论/);
  } finally { if (old === undefined) delete process.env.AUTOREVIEW_BATCH_FILE; else process.env.AUTOREVIEW_BATCH_FILE = old; await h.close(); }
});

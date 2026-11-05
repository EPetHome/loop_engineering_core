/** batch-queue-publish-locks：独立进程隔离环境，保持全部场景与断言。 */
import "./test-env.ts";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { queueBatchComplete, queueBatchRecheck, queueDir } from "../merge-queue.ts";
import { readJson, writeJsonAtomic } from "../pipeline-core.ts";
import { processStartTime } from "../procs.ts";
import { ROOT, fixture, autoConfig, autoComplete, automaticMerged, multiReady } from "./helpers/merge-queue-fixture.ts";

test("发布竞争／最终资格检查后、取得发布资格前发生整合重验，旧执行器不能发布", async (t) => {
  for (const completed of [false, true]) await t.test(completed ? "重验已提交部分验证" : "重验尚未结束", async () => {
    const f = fixture(1), resume = join(f.root, "resume-final-check");
    try {
      f.write(0, "src/a.txt", "candidate\n"); const { file, passed, partial } = multiReady(f);
      const epoch = queueBatchRecheck(f.repo, file); queueBatchComplete(f.repo, file, true, passed, epoch);
      await f.until(() => f.queue().entries[0]?.status === "ready" && Boolean(f.queue().entries[0].notified)); await f.idle();
      const entry = f.queue().entries[0], base = f.git(f.repo, "rev-parse", "HEAD"), paused = join(f.root, "after-final-check"), attempts = join(f.root, "publish-attempts");
      const realGit = spawnSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
      const wrapper = join(f.root, "bin", "git");
      writeFileSync(wrapper, `#!/bin/sh\ncase " $* " in\n *" rev-parse refs/loop/queue/${entry.id}/result "*) if [ ! -f '${paused}' ]; then : > '${paused}'; while [ ! -f '${resume}' ]; do sleep 0.02; done; fi;;\n *" update-ref refs/heads/main "*) echo "$*" >> '${attempts}';;\nesac\nexec '${realGit}' "$@"\n`); chmodSync(wrapper, 0o755);
      autoConfig(f); const merging = f.cliAsync("合入", file); await f.until(() => existsSync(paused), "用户合入已越过资格检查，停在测过结果的身份查询");
      assert.equal(f.queue().entries[0].status, "ready");
      const nextEpoch = queueBatchRecheck(f.repo, file);
      if (completed) queueBatchComplete(f.repo, file, false, partial, nextEpoch);
      assert.equal(f.queue().entries[0].status, "blocked", "撤销确已先于发布取得资格完成");
      assert.equal(f.git(f.repo, "rev-parse", "HEAD"), base);
      writeFileSync(resume, "resume"); assert.equal((await merging).ok, false);
      await f.idle();
      assert.equal(f.queue().entries[0].status, "blocked", "旧执行器不得用旧快照覆盖撤销状态");
      assert.equal(f.git(f.repo, "rev-parse", "HEAD"), base, "不发布旧的通过结果"); assert.ok(!existsSync(attempts), "不能尝试发布指针 CAS");
      assert.equal(f.queue().entries.length, 1, "未结束或部分验证都不得产生新候选");
    } finally { writeFileSync(resume, "resume"); await f.close(); }
  });
});

test("发布竞争／已经取得发布资格后，整合重验须等待发布事务收尾", async () => {
  const f = fixture(1), resume = join(f.root, "resume-publish");
  let rechecking: Promise<number | null> | undefined, childOutput = "";
  try {
    f.write(0, "src/a.txt", "candidate\n"); const { file, passed, partial } = multiReady(f);
    const epoch = queueBatchRecheck(f.repo, file); queueBatchComplete(f.repo, file, true, passed, epoch);
    await f.until(() => f.queue().entries[0]?.status === "ready" && Boolean(f.queue().entries[0].notified)); await f.idle();
    const entry = f.queue().entries[0], paused = join(f.root, "before-ref-cas"), started = join(f.root, "recheck-started"), completed = join(f.root, "recheck-completed.json");
    const realGit = spawnSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim(), wrapper = join(f.root, "bin", "git");
    writeFileSync(wrapper, `#!/bin/sh\ncase " $* " in\n *" update-ref refs/heads/main "*) if [ ! -f '${paused}' ]; then : > '${paused}'; while [ ! -f '${resume}' ]; do sleep 0.02; done; fi;;\nesac\nexec '${realGit}' "$@"\n`); chmodSync(wrapper, 0o755);
    autoConfig(f); const merging = f.cliAsync("合入", file); await f.until(() => existsSync(paused), "用户已取得发布资格，停在实际发布 CAS 前");
    assert.equal(f.queue().entries[0].status, "merging");
    const publisher = readJson<{ pid: number; started: string }>(join(queueDir(f.repo), "publish.lock"))!;
    assert.equal(publisher.pid, readJson<{ pid: number }>(f.workerLock())!.pid); assert.equal(processStartTime(publisher.pid), publisher.started);
    const script = join(f.root, "recheck-during-publish.mjs");
    writeFileSync(script, `import fs from 'node:fs'; import cp from 'node:child_process';
import { queueBatchRecheck, queueBatchComplete, readMergeQueue } from ${JSON.stringify(join(ROOT, "merge-queue.ts"))};
fs.writeFileSync(${JSON.stringify(started)}, 'started');
const epoch = queueBatchRecheck(${JSON.stringify(f.repo)}, ${JSON.stringify(file)});
const published = readMergeQueue(${JSON.stringify(f.repo)}).entries[0].status;
const head = cp.execFileSync('git', ['rev-parse', 'HEAD'], {cwd:${JSON.stringify(f.repo)}, encoding:'utf8'}).trim();
queueBatchComplete(${JSON.stringify(f.repo)}, ${JSON.stringify(file)}, false, ${JSON.stringify(partial)}, epoch);
fs.writeFileSync(${JSON.stringify(completed)}, JSON.stringify({epoch, published, head}));\n`);
    const child = spawn(process.execPath, [script], { cwd: f.root, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (data) => { childOutput += data; }); child.stderr.on("data", (data) => { childOutput += data; });
    rechecking = new Promise((done, fail) => { child.once("error", fail); child.once("exit", done); });
    await f.until(() => existsSync(started)); await sleep(100);
    assert.ok(!existsSync(completed), "重验不能在发布锁内抢先改代次或写入部分验证");
    assert.equal(f.queue().batches.find((batch) => batch.file === file)!.integrationEpoch, epoch);
    writeFileSync(resume, "resume"); assert.equal((await merging).ok, true); assert.equal(await rechecking, 0, childOutput);
    await f.idle(); assert.equal(f.queue().entries.length, 1, "后到的部分验证不进队");
    const observed = readJson<{ published: string; head: string }>(completed)!;
    assert.equal(observed.published, "merged"); assert.equal(observed.head, entry.result);
    assert.equal(f.queue().entries[0].status, "merged"); assert.equal(f.git(f.repo, "rev-parse", "HEAD"), entry.result);
    assert.equal(f.queue().batches.find((batch) => batch.file === file)!.integrationEpoch, readJson<{ epoch: string }>(completed)!.epoch);
  } finally { writeFileSync(resume, "resume"); try { await rechecking; } finally { await f.close(); } }
});

test("发布竞争／标记 merging 后首次运行版 HEAD 检查前有外部提交，确认未发布后自动重测并继续队列", async () => {
  const f = fixture(), resume = join(f.root, "resume-runtime-head");
  try {
    f.write(0, "src/a.txt", "A candidate\n"); f.write(1, "src/b.txt", "B candidate\n"); autoComplete(f, 0); autoComplete(f, 1); await f.ready(0);
    const paused = join(f.root, "before-runtime-head"), realGit = spawnSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim(), wrapper = join(f.root, "bin", "git");
    writeFileSync(wrapper, `#!/bin/sh\ncase " $* " in\n *" rev-parse HEAD "*) if [ "$PWD" = '${f.repo}' ] && [ ! -f '${paused}' ]; then : > '${paused}'; while [ ! -f '${resume}' ]; do sleep 0.02; done; fi;;\nesac\nexec '${realGit}' "$@"\n`); chmodSync(wrapper, 0o755);
    autoConfig(f); const merging = f.cliAsync("合入", f.batches[0].file); await f.until(() => existsSync(paused), "用户发布已登记意图，停在首次运行版 HEAD 检查前");
    assert.equal(f.queue().entries[0].status, "merging"); assert.equal(f.queue().entries[0].runtimeStash, undefined); assert.equal(f.queue().entries[0].runtimePublication, "prepared");
    writeFileSync(join(f.repo, "unrelated.txt"), "external release\n"); f.git(f.repo, "add", "unrelated.txt"); f.git(f.repo, "commit", "-qm", "feat: external release advances before runtime check");
    const external = f.git(f.repo, "rev-parse", "HEAD"); writeFileSync(resume, "resume"); assert.equal((await merging).ok, false); await f.idle();
    await automaticMerged(f, 0); await automaticMerged(f, 1);
    const [first, second] = f.queue().entries;
    assert.equal(first.status, "merged", "无发布或待归还副作用的过期基线必须重测，不能永久 merging");
    assert.equal(first.base, external); assert.ok(first.attempt >= 2); assert.equal(second.status, "merged", "后续批次仍可自动处理");
    assert.equal(f.git(f.repo, "rev-parse", "HEAD"), second.result); f.git(f.repo, "merge-base", "--is-ancestor", external, second.result!);
    assert.equal(readFileSync(join(f.repo, "unrelated.txt"), "utf8"), "external release\n"); assert.equal(readFileSync(join(f.repo, "src/a.txt"), "utf8"), "A candidate\n"); assert.equal(readFileSync(join(f.repo, "src/b.txt"), "utf8"), "B candidate\n");
  } finally { writeFileSync(resume, "resume"); await f.close(); }
});

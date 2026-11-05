/** merge-queue-recovery：独立进程隔离环境，保持全部场景与断言。 */
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

test("合入指针比较交换与工作树更新之间中断：后台不修运行版，用户重试补齐且恢复暂存状态", async () => {
  const f = fixture(1);
  try {
    f.write(0, "src/a.txt", "a\n"); f.complete(0); await f.ready(0);
    const state = f.queue(), entry = state.entries[0];
    writeFileSync(join(f.repo, "unrelated.txt"), "staged\n"); f.git(f.repo, "add", "unrelated.txt"); writeFileSync(join(f.repo, "unrelated.txt"), "unstaged\n");
    const hash = f.git(f.repo, "stash", "create"), ref = `refs/loop/merge-stash/${entry.id}`;
    f.git(f.repo, "update-ref", ref, hash);
    entry.status = "merging"; entry.runtimeStash = { ref, hash }; writeJsonAtomic(join(state.dir, "queue.json"), state);
    // 模拟用户合入已保存 stash、发布 CAS 成功，但还没更新工作树就被杀。
    f.git(f.repo, "read-tree", "--reset", "-u", "HEAD"); f.git(f.repo, "update-ref", "refs/heads/main", entry.result!, entry.base!);
    assert.equal(f.cli("状态").ok, true); await f.idle();
    assert.ok(!existsSync(join(f.repo, "src/a.txt")), "后台恢复不改运行版");
    const result = f.cli("合入", f.batches[0].file); assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(f.git(f.repo, "rev-parse", "HEAD"), entry.result); assert.equal(readFileSync(join(f.repo, "src/a.txt"), "utf8"), "a\n");
    assert.equal(readFileSync(join(f.repo, "unrelated.txt"), "utf8"), "unstaged\n"); assert.equal(f.git(f.repo, "show", ":unrelated.txt"), "staged");
    await f.idle(); assert.equal(f.cli("合入", f.batches[0].file).ok, true); assert.equal(f.git(f.repo, "rev-parse", "HEAD"), entry.result);
  } finally { await f.close(); }
});

test("发布恢复／已实际发布的旧事务可在新一轮部分验证到达后按原 ID 恢复收尾", async () => {
  const f = fixture(1);
  try {
    f.write(0, "src/a.txt", "candidate\n"); const { file, passed, partial } = multiReady(f);
    const epoch = queueBatchRecheck(f.repo, file); queueBatchComplete(f.repo, file, true, passed, epoch);
    await f.until(() => f.queue().entries[0]?.status === "ready" && Boolean(f.queue().entries[0].notified)); await f.idle();
    autoConfig(f); f.git(f.repo, "add", ".autoreview.json"); f.git(f.repo, "commit", "-qm", "chore: authorize automatic merge");
    const realGit = spawnSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim(), wrapper = join(f.root, "bin", "git"), failed = join(f.root, "publish-checkout-failed"), attempts = join(f.root, "publish-attempts");
    writeFileSync(wrapper, `#!/bin/sh\ncase " $* " in\n *" update-ref refs/heads/main "*) echo "$*" >> '${attempts}';;\n *" read-tree -m -u "*) if [ "$PWD" = '${f.repo}' ] && [ ! -f '${failed}' ]; then : > '${failed}'; echo PUBLISHED_CHECKOUT_INTERRUPTED >&2; exit 1; fi;;\nesac\nexec '${realGit}' "$@"\n`); chmodSync(wrapper, 0o755);
    f.cli("状态"); await f.until(() => f.queue().entries[0]?.status === "ready"); await f.idle();
    assert.equal(f.cli("合入", file).ok, false); await f.idle();
    assert.ok(existsSync(failed));
    const published = f.queue().entries[0]; assert.equal(f.git(f.repo, "rev-parse", "HEAD"), published.result); assert.ok(!existsSync(join(f.repo, "src/a.txt")), "发布指针已更新而 checkout 尚未收尾");
    // 模拟升级前留下的已发布自动事务，只允许恢复 checkout，不允许再次发布。
    const interrupted = f.queue(); interrupted.entries[0].automatic = true; writeJsonAtomic(join(queueDir(f.repo), "queue.json"), interrupted);
    const nextEpoch = queueBatchRecheck(f.repo, file); queueBatchComplete(f.repo, file, false, partial, nextEpoch);
    await f.until(() => f.queue().entries[0]?.status === "merged" && Boolean(f.queue().entries[0].mergeNotified)); await f.idle();
    assert.equal(f.queue().entries[0].id, published.id); assert.equal(f.git(f.repo, "rev-parse", "HEAD"), published.result);
    assert.equal(readFileSync(join(f.repo, "src/a.txt"), "utf8"), "candidate\n"); assert.equal(f.git(f.repo, "status", "--porcelain"), "");
    assert.equal(readFileSync(attempts, "utf8").trim().split("\n").length, 1, "已发布恢复只收尾，不再移动发布指针");
    assert.match(readFileSync(f.queue().entries[0].ledger!, "utf8"), new RegExp(`已合入 ${published.result}`));
    assert.equal(f.queue().entries.length, 1, "部分验证不能新进队，但不遗忘已发布旧事务的收尾");
  } finally { await f.close(); }
});

test("发布恢复／重启恢复 prepared 意图时 release 已前进，无副作用的旧事务仍能重测", async () => {
  const f = fixture(1);
  try {
    f.write(0, "src/a.txt", "candidate\n"); autoComplete(f, 0); await f.ready(0); autoConfig(f);
    const queue = f.queue(); Object.assign(queue.entries[0], { status: "merging", automatic: true, runtimePublication: "prepared" }); writeJsonAtomic(join(queueDir(f.repo), "queue.json"), queue);
    writeFileSync(join(f.repo, "unrelated.txt"), "external release\n"); f.git(f.repo, "add", "unrelated.txt"); f.git(f.repo, "commit", "-qm", "feat: external advance after prepared intent"); const external = f.git(f.repo, "rev-parse", "HEAD");
    f.cli("状态"); await f.ready(0); assert.equal(f.git(f.repo, "rev-parse", "HEAD"), external, "旧意图只转回可合入，不自动发布");
    const merged = await automaticMerged(f, 0);
    assert.equal(merged.base, external); assert.ok(merged.attempt >= 2); assert.equal(merged.runtimePublication, "published");
    f.git(f.repo, "merge-base", "--is-ancestor", external, merged.result!); assert.equal(readFileSync(join(f.repo, "src/a.txt"), "utf8"), "candidate\n");
  } finally { await f.close(); }
});

test("发布恢复／CAS 已成功后 release 又前进，不能把已发布收尾责任误当成未发布重测", async () => {
  const f = fixture(1), resume = join(f.root, "resume-published-checkout");
  try {
    f.write(0, "src/a.txt", "candidate\n"); autoComplete(f, 0); await f.ready(0);
    const paused = join(f.root, "after-publication-cas"), attempts = join(f.root, "publish-attempts"), realGit = spawnSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim(), wrapper = join(f.root, "bin", "git");
    writeFileSync(wrapper, `#!/bin/sh\ncase " $* " in\n *" update-ref refs/heads/main "*) echo "$*" >> '${attempts}';;\n *" read-tree -m -u "*) if [ "$PWD" = '${f.repo}' ] && [ ! -f '${paused}' ]; then : > '${paused}'; while [ ! -f '${resume}' ]; do sleep 0.02; done; fi;;\nesac\nexec '${realGit}' "$@"\n`); chmodSync(wrapper, 0o755);
    autoConfig(f); const merging = f.cliAsync("合入", f.batches[0].file); await f.until(() => existsSync(paused), "用户 CAS 已成功，停在 checkout 前");
    const published = f.queue().entries[0]; assert.equal(published.runtimePublication, "published"); assert.equal(f.git(f.repo, "rev-parse", "HEAD"), published.result);
    const tree = f.git(f.repo, "rev-parse", `${published.result}^{tree}`), external = f.git(f.repo, "commit-tree", tree, "-p", published.result!, "-m", "external release after publication");
    const advanced = spawnSync(realGit, ["update-ref", "refs/heads/main", external, published.result!], { cwd: f.repo, encoding: "utf8" }); assert.equal(advanced.status, 0, advanced.stderr);
    writeFileSync(resume, "resume"); assert.equal((await merging).ok, false); await f.idle();
    assert.equal(f.queue().entries[0].status, "merging"); assert.equal(f.queue().entries[0].runtimePublication, "published"); assert.equal(f.git(f.repo, "rev-parse", "HEAD"), external);
    const before = f.evidence(f.repo); f.cli("状态"); await f.idle();
    assert.equal(f.queue().entries[0].status, "merging"); assert.equal(f.queue().entries[0].attempt, published.attempt); assert.deepEqual(f.evidence(f.repo), before);
    assert.equal(readFileSync(attempts, "utf8").trim().split("\n").length, 1, "不重复发布，也不退回或覆盖外部提交");
  } finally { writeFileSync(resume, "resume"); await f.close(); }
});

test("发布恢复／手动恢复失败时保留私有 stash 和意图，归还成功前不能清除资格或遗失数据", async () => {
  const f = fixture(1);
  try {
    f.write(0, "src/a.txt", "candidate\n"); const { file, dir, passed } = multiReady(f);
    writeFileSync(file, JSON.stringify({ name: "重验多段", branch: f.batches[0].branch, dir, stages: Object.fromEntries(["甲", "乙"].map((name) => [name, { cwd: f.batches[0].cwd, start: "true" }])), steps: [["甲"], ["乙"]] }));
    const epoch = queueBatchRecheck(f.repo, file); queueBatchComplete(f.repo, file, true, passed, epoch);
    await f.until(() => f.queue().entries[0]?.status === "ready" && Boolean(f.queue().entries[0].notified)); await f.idle();
    writeFileSync(join(f.repo, "unrelated.txt"), "staged\n"); f.git(f.repo, "add", "unrelated.txt"); writeFileSync(join(f.repo, "unrelated.txt"), "unstaged\n");
    const stash = f.git(f.repo, "stash", "create"), ref = "refs/loop/merge-stash/manual-restore-failure"; f.git(f.repo, "update-ref", ref, stash); f.git(f.repo, "read-tree", "--reset", "-u", "HEAD");
    const queue = f.queue(), entry = queue.entries[0]; Object.assign(entry, { status: "merging", automatic: false, runtimePublication: "prepared", runtimeStash: { ref, hash: stash } }); writeJsonAtomic(join(queueDir(f.repo), "queue.json"), queue);
    queueBatchRecheck(f.repo, file); writeFileSync(join(f.repo, "unrelated.txt"), "new runtime work\n");
    const failed = f.cli("合入", file); await f.idle(); assert.equal(failed.ok, false); assert.equal(failed.restoreStashFailed, true, JSON.stringify(failed));
    assert.equal(f.queue().entries[0].status, "merging"); assert.deepEqual(f.queue().entries[0].runtimeStash, { ref, hash: stash }); assert.equal(f.git(f.repo, "rev-parse", ref), stash);
    assert.equal(readFileSync(join(f.repo, "unrelated.txt"), "utf8"), "new runtime work\n"); assert.equal(f.git(f.repo, "rev-parse", "HEAD"), entry.base); assert.ok(!existsSync(join(f.repo, "src/a.txt")));
    // 只清除本测试新增的冲突工作副本；原暂存/未暂存数据仍由已核对的私有 ref 保留。
    f.git(f.repo, "read-tree", "--reset", "-u", "HEAD"); const recovered = f.cli("合入", file); await f.idle(); assert.equal(recovered.ok, false); assert.match(recovered.error, /完成资格已变化/);
    assert.equal(f.queue().entries[0].status, "blocked"); assert.equal(f.queue().entries[0].runtimeStash, undefined);
    assert.equal(readFileSync(join(f.repo, "unrelated.txt"), "utf8"), "unstaged\n"); assert.equal(f.git(f.repo, "show", ":unrelated.txt"), "staged");
  } finally { await f.close(); }
});

test("历史自动事务：publishing 意图在 base 且无副作用时安全退出，仍服从资格撤销", async () => {
  const f = fixture(1);
  try {
    f.write(0, "src/a.txt", "candidate\n"); const { file, passed } = multiReady(f), epoch = queueBatchRecheck(f.repo, file); queueBatchComplete(f.repo, file, true, passed, epoch);
    await f.until(() => f.queue().entries[0]?.status === "ready" && Boolean(f.queue().entries[0].notified)); await f.idle(); autoConfig(f);
    const queue = f.queue(), entry = queue.entries[0]; Object.assign(entry, { status: "merging", automatic: true, runtimePublication: "publishing" }); writeJsonAtomic(join(queueDir(f.repo), "queue.json"), queue);
    queueBatchRecheck(f.repo, file); const before = f.evidence(f.repo); f.cli("状态"); await f.idle();
    assert.equal(f.queue().entries[0].status, "blocked"); assert.equal(f.queue().entries[0].runtimePublication, "prepared"); assert.equal(f.queue().entries[0].attempt, entry.attempt);
    assert.deepEqual(f.evidence(f.repo), before); assert.equal(f.git(f.repo, "rev-parse", "HEAD"), entry.base); assert.ok(!existsSync(join(f.repo, "src/a.txt")));
  } finally { await f.close(); }
});

/** batch-queue-stash：独立进程隔离环境，保持全部场景与断言。 */
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

test("发布恢复／事务状态矩阵：先归还stash，已发布只收尾，旧推送意图不执行", async (t) => {
  const cases = [
    { name: "撤销历史自动事务", manual: false, revoked: true, published: false, stash: true, legacyPush: false },
    { name: "撤销手动事务／未发布", manual: true, revoked: true, published: false, stash: true, legacyPush: false },
    { name: "撤销手动事务／已发布", manual: true, revoked: true, published: true, stash: true, legacyPush: false },
    { name: "归还配置后等待手动合入", manual: false, revoked: false, published: false, stash: true, legacyPush: false },
    { name: "旧推送意图／未发布", manual: false, revoked: false, published: false, stash: false, legacyPush: true },
    { name: "旧推送意图／已发布", manual: false, revoked: false, published: true, stash: false, legacyPush: true },
  ];
  for (const item of cases) await t.test(item.name, async () => {
    // 恢复场景会破坏运行版、私有引用及事务状态，不能共享可变仓库。
    const f = fixture(1);
    try {
      const content = !item.revoked && item.stash ? "a\n" : "candidate\n"; f.write(0, "src/a.txt", content);
      const multi = item.revoked ? multiReady(f) : undefined, file = multi?.file ?? f.batches[0].file;
      if (multi) { const epoch = queueBatchRecheck(f.repo, file); queueBatchComplete(f.repo, file, true, multi.passed, epoch); }
      else if (item.legacyPush) f.complete(0);
      else autoComplete(f, 0);
      await f.until(() => f.queue().entries[0]?.status === "ready" && Boolean(f.queue().entries[0].notified)); await f.idle();
      if (item.stash && !item.manual) autoConfig(f);
      if (item.manual) assert.equal(JSON.parse(readFileSync(join(f.repo, ".autoreview.json"), "utf8")).merge, undefined);
      const remote = join(f.root, "remote.git");
      if (item.legacyPush) {
        f.git(f.root, "init", "--bare", "-q", remote); f.git(f.repo, "remote", "add", "origin", remote);
        f.git(f.repo, "config", "branch.main.remote", "origin"); f.git(f.repo, "config", "branch.main.merge", "refs/heads/main");
      }
      if (item.stash) {
        writeFileSync(join(f.repo, "unrelated.txt"), "staged\n"); f.git(f.repo, "add", "unrelated.txt"); writeFileSync(join(f.repo, "unrelated.txt"), "unstaged\n");
      }
      const before = f.evidence(f.repo), ref = "refs/loop/merge-stash/recovery-matrix";
      const stash = item.stash ? f.git(f.repo, "stash", "create") : undefined;
      if (stash) { f.git(f.repo, "update-ref", ref, stash); f.git(f.repo, "read-tree", "--reset", "-u", "HEAD"); }
      const queue = f.queue(), entry = queue.entries[0];
      Object.assign(entry, { status: "merging", automatic: !item.manual,
        ...(item.manual ? {} : { pushRequested: item.legacyPush }),
        ...(stash ? { runtimeStash: { ref, hash: stash } } : {}),
        ...(item.legacyPush ? { runtimePublication: item.published ? "publishing" : "prepared" } : {}) });
      writeJsonAtomic(join(queueDir(f.repo), "queue.json"), queue);
      if (item.published) f.git(f.repo, "update-ref", "refs/heads/main", entry.result!, entry.base!);
      const nextEpoch = item.revoked ? queueBatchRecheck(f.repo, file) : undefined;
      const recovered = f.cli(item.manual ? "合入" : "状态", ...(item.manual ? [file] : []));
      await f.until(() => f.queue().entries[0]?.status === (item.published ? "merged" : item.revoked ? "blocked" : "ready")); await f.idle();
      if (item.manual) assert.equal(recovered.ok, item.published, JSON.stringify(recovered));
      assert.equal(f.queue().entries[0].id, entry.id); assert.equal(f.queue().entries.length, 1);
      assert.equal(f.git(f.repo, "rev-parse", "HEAD"), item.published ? entry.result : entry.base);
      assert.equal(existsSync(join(f.repo, "src/a.txt")), item.published);
      if (stash) {
        assert.equal(f.queue().entries[0].runtimeStash, undefined);
        assert.equal(spawnSync("git", ["show-ref", "--verify", "--quiet", ref], { cwd: f.repo }).status, 1);
        assert.equal(readFileSync(join(f.repo, "unrelated.txt"), "utf8"), "unstaged\n"); assert.equal(f.git(f.repo, "show", ":unrelated.txt"), "staged");
        assert.equal(f.git(f.repo, "diff", "--cached", "--binary"), before.cached); assert.equal(f.git(f.repo, "diff", "--binary"), before.diff);
      }
      if (item.legacyPush) {
        assert.equal(f.git(remote, "for-each-ref", "--format=%(refname)", "refs/heads"), "", "不执行旧release推送意图");
        if (!item.published) assert.equal(f.queue().entries[0].automatic, false);
      } else if (item.revoked && !item.published && !item.manual) {
        assert.deepEqual(f.evidence(f.repo), before);
        queueBatchComplete(f.repo, file, false, multi!.partial, nextEpoch); await f.idle();
        assert.deepEqual(f.evidence(f.repo), before); assert.equal(f.queue().entries[0].status, "blocked"); assert.equal(f.queue().entries.length, 1);
      } else if (!item.published) {
        if (item.manual) {
          assert.match(recovered.error, /完成资格已变化/); assert.deepEqual(f.evidence(f.repo), before);
          queueBatchComplete(f.repo, file, true, multi!.passed, nextEpoch);
          await f.until(() => f.queue().entries[1]?.status === "ready" && Boolean(f.queue().entries[1].notified)); await f.idle();
          const merged = f.cli("合入", file); assert.equal(merged.ok, true, JSON.stringify(merged)); await f.idle();
          assert.equal(f.queue().entries[1].status, "merged");
        } else {
          const merged = await automaticMerged(f, 0); assert.equal(f.git(f.repo, "rev-parse", "HEAD"), merged.result);
          assert.equal(JSON.parse(readFileSync(join(f.repo, ".autoreview.json"), "utf8")).merge.auto, true);
        }
        assert.equal(f.git(f.repo, "diff", "--cached", "--binary"), before.cached);
        assert.equal(readFileSync(join(f.repo, "unrelated.txt"), "utf8"), "unstaged\n"); assert.equal(f.git(f.repo, "show", ":unrelated.txt"), "staged");
      } else if (item.stash) assert.equal(readFileSync(join(f.repo, "src/a.txt"), "utf8"), content);
    } finally { await f.close(); }
  });
});

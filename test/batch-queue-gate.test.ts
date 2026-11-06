/** 停用旧 gate；合并冲突的返修和第三次停止规则仍然保留。 */
import "./test-env.ts";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { inboxPath, readJson, type InboxMessage } from "../pipeline-core.ts";
import { fixture, autoComplete, notification } from "./helpers/merge-queue-fixture.ts";

test("队列忽略旧 gate 的失败、写文件及挂起命令，不生成测试结果或退回", async (t) => {
  for (const mode of ["fail-dirty-untracked", "fail-dirty-tracked", "timeout"]) await t.test(mode, async () => {
    const f = fixture();
    try {
      f.write(0, "src/a.txt", "a\n"); f.write(1, "src/b.txt", "b\n");
      const runtime = f.evidence(f.repo), developers = f.batches.map((batch) => f.devEvidence(batch.cwd));
      f.mode(mode); f.complete(0); f.complete(1);
      await f.ready(0);
      assert.equal(f.cli("合入", f.batches[0].file).ok, true);
      await f.ready(1);
      assert.equal(existsSync(join(f.root, "gate-executed")), false);
      for (const [index, entry] of f.queue().entries.entries()) {
        assert.equal(entry.testConclusion, "Loop 未运行测试");
        assert.equal(Object.hasOwn(entry, "gate"), false);
        assert.equal(Object.hasOwn(entry, "log"), false);
        assert.equal(existsSync(inboxPath(f.batches[index].dir, "甲")), false);
        assert.match(notification(f, entry.id), /Loop 未运行测试/);
        assert.doesNotMatch(notification(f, entry.id), /门禁通过|测试通过|沿用测试/);
      }
      assert.equal(f.git(f.queue().workspace, "status", "--porcelain"), "");
      assert.equal(existsSync(join(f.queue().workspace, "diagnostic.txt")), false);
      assert.deepEqual(f.batches.map((batch) => f.devEvidence(batch.cwd)), developers);
      assert.equal(readFileSync(join(f.repo, "shared.txt"), "utf8"), "base\n");
      assert.equal(runtime.local, f.evidence(f.repo).local);
    } finally { await f.close(); }
  });
});

test("真实文本冲突第三次退回停止自动排队；后续正常交付仍提交记录", async () => {
  const f = fixture(1);
  try {
    for (let count = 1; count <= 3; count += 1) {
      f.write(0, "shared.txt", `candidate-${count}\n`);
      writeFileSync(join(f.repo, "shared.txt"), `target-${count}\n`);
      f.git(f.repo, "add", "shared.txt"); f.git(f.repo, "commit", "-qm", `target-${count}`);
      autoComplete(f, 0);
      await f.until(() => f.queue().entries.at(-1)?.status === (count === 3 ? "stopped" : "returned")); await f.idle();
      const entry = f.queue().entries.at(-1)!;
      assert.equal(entry.returnCount, count); assert.equal(entry.conflictKind, "text");
      assert.match(readJson<InboxMessage>(inboxPath(f.batches[0].dir, "甲"))!.message, /合并冲突[\s\S]*shared.txt/);
    }
    const stopped = f.queue().entries.at(-1)!;
    assert.match(notification(f, stopped.id), /第 3 次退回，停止自动排队/);
    const length = f.queue().entries.length, previous = f.queue().batches[0].commits![0].commit;
    f.write(0, "shared.txt", "new delivery after stop\n"); autoComplete(f, 0); await f.idle();
    assert.equal(f.queue().entries.length, length);
    assert.notEqual(f.queue().batches[0].commits![0].commit, previous);
  } finally { await f.close(); }
});

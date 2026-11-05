/** merge-queue／withdraw：按功能独立运行，夹具与状态不跨测试进程共享。 */
import "./test-env.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fixture, autoConfig, autoComplete, automaticMerged } from "./helpers/merge-queue-fixture.ts";

test("自动 A7：撤回只反向 CAS 本批提交；后面已有批次合入时 release 不动", async () => {
  const f = fixture();
  try {
    autoConfig(f); f.write(0, "src/a.txt", "a\n"); autoComplete(f, 0); const first = await automaticMerged(f, 0);
    const preview = f.cli("撤回", f.batches[0].file, "--dry-run"); assert.equal(preview.ok, true); assert.equal(f.git(f.repo, "rev-parse", "HEAD"), first.result);
    const result = f.cli("撤回", f.batches[0].file); assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(f.git(f.repo, "rev-parse", "HEAD"), first.base);
    assert.equal(f.queue().entries[0].status, "withdrawn"); assert.ok(!existsSync(join(f.repo, "src/a.txt")));
    // 用户显式重新取得资格后再合入；不抹掉撤回历史。
    autoComplete(f, 0); await automaticMerged(f, 0);
    f.write(1, "src/b.txt", "b\n"); autoComplete(f, 1); const second = await automaticMerged(f, 1);
    const denied = f.cli("撤回", f.batches[0].file); assert.equal(denied.ok, false); assert.match(denied.error, /之后已有其他提交或批次合入/);
    assert.equal(f.git(f.repo, "rev-parse", "HEAD"), second.result);
  } finally { await f.close(); }
});

test("撤回保护／重叠改动拒绝撤回不留下事务；用户提交后 release 前进，后续批次仍自动合入", async () => {
  const f = fixture();
  try {
    autoConfig(f); f.write(0, "shared.txt", "A merged\n"); autoComplete(f, 0); const first = await automaticMerged(f, 0);
    writeFileSync(join(f.repo, "shared.txt"), "user staged\n"); f.git(f.repo, "add", "shared.txt"); writeFileSync(join(f.repo, "shared.txt"), "user unstaged\n");
    const before = f.evidence(f.repo), denied = f.cli("撤回", f.batches[0].file);
    assert.equal(denied.ok, false); assert.match(denied.error, /未提交改动[\s\S]*同一个文件/);
    assert.equal(f.queue().entries[0].status, "merged"); assert.equal(f.queue().entries[0].runtimeStash, undefined); assert.deepEqual(f.evidence(f.repo), before, "只读拒绝不改索引、工作树或发布指针");
    f.git(f.repo, "commit", "-qm", "feat: user commits staged changes"); const advanced = f.git(f.repo, "rev-parse", "HEAD"); assert.notEqual(advanced, first.result);
    const retry = f.cli("撤回", f.batches[0].file); assert.equal(retry.ok, false); assert.match(retry.error, /之后已有其他提交或批次合入/);
    assert.equal(f.queue().entries[0].status, "merged"); assert.equal(f.git(f.repo, "rev-parse", "HEAD"), advanced);
    f.cli("状态"); await f.idle();
    f.write(1, "src/b.txt", "B merged\n"); autoComplete(f, 1); const second = await automaticMerged(f, 1);
    assert.equal(f.git(f.repo, "rev-parse", "HEAD"), second.result); f.git(f.repo, "merge-base", "--is-ancestor", advanced, second.result!);
    assert.equal(f.git(f.repo, "show", "HEAD:shared.txt"), "user staged"); assert.equal(readFileSync(join(f.repo, "shared.txt"), "utf8"), "user unstaged\n");
    assert.equal(f.git(f.repo, "diff", "--cached"), ""); assert.equal(readFileSync(join(f.repo, "src/b.txt"), "utf8"), "B merged\n");
  } finally { await f.close(); }
});

test("撤回恢复／CAS 已成功但工作树收尾失败，保留真实事务并由同一命令恢复", async () => {
  const f = fixture(1);
  try {
    autoConfig(f); f.write(0, "src/a.txt", "A merged\n"); autoComplete(f, 0); const first = await automaticMerged(f, 0);
    f.git(f.repo, "restore", "--", ".autoreview.json"); // 本次只验证发布与 checkout 的事务边界，运行版干净。
    const realGit = spawnSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim(), marker = join(f.root, "checkout-failed");
    const wrapper = join(f.root, "bin", "git");
    writeFileSync(wrapper, `#!/bin/sh\ncase " $* " in\n *" read-tree -m -u "*) if [ "$PWD" = '${f.repo}' ] && [ ! -f '${marker}' ]; then : > '${marker}'; echo CHECKOUT_INTERRUPTED >&2; exit 1; fi;;\nesac\nexec '${realGit}' "$@"\n`); chmodSync(wrapper, 0o755);
    const interrupted = f.cli("撤回", f.batches[0].file); assert.equal(interrupted.ok, false); assert.match(interrupted.error, /CHECKOUT_INTERRUPTED/);
    assert.equal(f.queue().entries[0].status, "withdrawing"); assert.equal(f.git(f.repo, "rev-parse", "HEAD"), first.base);
    assert.ok(existsSync(join(f.repo, "src/a.txt")), "CAS 完成后 checkout 尚未完成的现场保留");
    f.cli("状态"); await f.idle(); assert.equal(f.queue().entries[0].status, "withdrawing", "后台不能丢弃实际未收尾的意图");
    const recovered = f.cli("撤回", f.batches[0].file); assert.equal(recovered.ok, true, JSON.stringify(recovered));
    assert.equal(f.queue().entries[0].status, "withdrawn"); assert.equal(f.git(f.repo, "rev-parse", "HEAD"), first.base); assert.ok(!existsSync(join(f.repo, "src/a.txt")));
    assert.equal(f.git(f.repo, "status", "--porcelain"), "");
  } finally { await f.close(); }
});

test("撤回竞争／CAS 竞争失败且无副作用时退出意图，不阻塞后续队列", async () => {
  const f = fixture(1);
  try {
    autoConfig(f); f.write(0, "src/a.txt", "A merged\n"); autoComplete(f, 0); const first = await automaticMerged(f, 0); f.git(f.repo, "restore", "--", ".autoreview.json");
    const tree = f.git(f.repo, "rev-parse", "HEAD^{tree}"), external = f.git(f.repo, "commit-tree", tree, "-p", first.result!, "-m", "concurrent user release");
    const realGit = spawnSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim(), marker = join(f.root, "withdraw-race");
    const wrapper = join(f.root, "bin", "git");
    writeFileSync(wrapper, `#!/bin/sh\ncase " $* " in\n *" update-ref refs/heads/main "*) if [ ! -f '${marker}' ]; then : > '${marker}'; '${realGit}' update-ref refs/heads/main '${external}' '${first.result}'; fi;;\nesac\nexec '${realGit}' "$@"\n`); chmodSync(wrapper, 0o755);
    const denied = f.cli("撤回", f.batches[0].file); assert.equal(denied.ok, false); assert.match(denied.error, /发布分支已经变化/);
    assert.equal(f.queue().entries[0].status, "merged"); assert.equal(f.git(f.repo, "rev-parse", "HEAD"), external); assert.equal(f.git(f.repo, "status", "--porcelain"), "");
    f.cli("状态"); await f.idle(); assert.equal(f.queue().entries[0].status, "merged");
  } finally { await f.close(); }
});

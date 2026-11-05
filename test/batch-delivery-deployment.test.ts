/** batch-delivery-deployment：独立进程隔离环境，保持全部场景与断言。 */
import "./test-env.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { completionTest } from "../pipeline-core.ts";
import { parseDeploymentConfig } from "../config.ts";
import { beginQueueAcceptance, endQueuePipeline, queueDir, recoverMergeQueue } from "../merge-queue.ts";
import { batchInfo, writePhase } from "../events.ts";
import { ownedProcessGroupAlive, readProcs } from "../procs.ts";
import { fixture, backgroundPipeline } from "./helpers/batch-delivery-fixture.ts";

test("部署配置：默认关闭，开启必须同时提供部署和检查命令，时限为正整数", () => {
  assert.deepEqual(parseDeploymentConfig(undefined), { enabled: false, timeoutMin: 10 });
  assert.equal(parseDeploymentConfig({ cmd: "deploy", check: "check" }).enabled, false);
  assert.deepEqual(parseDeploymentConfig({ enabled: true, cmd: "deploy", check: "check" }), { enabled: true, cmd: "deploy", check: "check", timeoutMin: 10 });
  for (const raw of [null, [], true, { enabled: "true" }, { enabled: true }, { enabled: true, cmd: "deploy" }, { enabled: true, cmd: " ", check: "check" }, { timeoutMin: 0 }, { timeoutMin: 0.1 }]) assert.throws(() => parseDeploymentConfig(raw), /deployment/);
  assert.equal(completionTest(undefined), undefined);
});

test("停止待执行部署：开发会话已退出也能取消，dry-run 只读，恢复不再派发或回退", async () => {
  const f = fixture({ count: 2, deployment: { enabled: true } });
  try {
    const other = f.batches[1]; writePhase(batchInfo(other.file, f.repo, other.dir), "dev", "reviewing");
    writeFileSync(join(f.batches[0].cwd, "code.txt"), "checked\n"); f.complete();
    await f.until(() => Boolean(f.queue().entries[0]?.deployment?.reason));
    const entry = f.queue().entries[0], before = readFileSync(join(queueDir(f.repo), "queue.json"), "utf8");
    assert.equal(f.stop(0, true).ok, true); assert.equal(readFileSync(join(queueDir(f.repo), "queue.json"), "utf8"), before);
    const stopped = f.stop(); assert.equal(stopped.ok, true, JSON.stringify(stopped)); await f.idle();
    assert.equal(f.queue().entries[0].status, "merged", "保留已合入历史"); assert.equal(f.queue().entries[0].deployment?.status, "stopped");
    writePhase(batchInfo(other.file, f.repo, other.dir), "dev", "done"); recoverMergeQueue(f.repo); await f.idle();
    assert.deepEqual(f.deployments(), []); assert.equal(f.git(f.repo, "rev-parse", "HEAD"), entry.result);
    assert.equal(f.git(f.batches[0].cwd, "rev-parse", "HEAD"), entry.sources[0].commit); assert.match(f.notice(), /已停止/);
  } finally { await f.close(); }
});

test("停止已启动部署动作：按身份释放命令，执行结果未确认，不再检查或自动回退", async (t) => {
  for (const action of ["deploy", "check"]) await t.test(action, async () => {
    const f = fixture({ deployment: { enabled: true } });
    try {
      writeFileSync(join(f.root, `hold-${action}`), "hold"); writeFileSync(join(f.root, "fail-check"), "fail");
      writeFileSync(join(f.batches[0].cwd, "code.txt"), "checked\n"); f.complete();
      await f.until(() => f.deployments().some((item) => item.action === action));
      const entry = f.queue().entries[0], consumers = readProcs(entry.deployment!.procs!);
      assert.equal(consumers.length, 1, "启动命令在停止边界前已经登记");
      const stopped = f.stop(); assert.equal(stopped.ok, false, "外部动作结果不明不能报停止成功");
      assert.match(JSON.stringify(stopped.skipped), /执行结果未确认/); assert.match(stopped.lines[0], /停止未完全确认/);
      await f.idle();
      for (const proc of consumers) assert.equal(ownedProcessGroupAlive({ pid: proc.pgid, processStarted: proc.started, token: proc.token! }), false);
      assert.equal(readProcs(entry.deployment!.procs!).length, 0); assert.ok(existsSync(entry.deployment!.log!));
      assert.equal(f.queue().entries[0].deployment?.status, "blocked"); assert.equal(f.queue().entries[0].deployment?.stopRequested, true);
      recoverMergeQueue(f.repo); await f.idle();
      assert.deepEqual(f.deployments().map((item) => item.action), action === "deploy" ? ["deploy"] : ["deploy", "check"]);
      assert.equal(f.git(f.repo, "rev-parse", "HEAD"), entry.result, "停止后不能因检查失败撤回已合入提交");
    } finally { await f.close(); }
  });
});

test("部署检查失败：比较交换撤回目标分支并重新部署上一版，通知检查原因和已回退", async () => {
  const f = fixture({ deployment: { enabled: true } });
  try {
    writeFileSync(join(f.root, "fail-check"), "fail"); writeFileSync(join(f.batches[0].cwd, "code.txt"), "checked\n"); f.complete();
    await f.until(() => f.queue().entries[0]?.deployment?.status === "rolled-back"); await f.idle();
    const entry = f.queue().entries[0]; assert.equal(entry.status, "withdrawn"); assert.equal(f.git(f.repo, "rev-parse", "HEAD"), f.base);
    assert.deepEqual(f.deployments().map((item) => [item.action, item.head]), [["deploy", entry.result], ["check", entry.result], ["deploy", f.base]]);
    assert.match(f.notice(), /部署后检查失败[\s\S]*HEALTH_CHECK_FAILED[\s\S]*已回退[\s\S]*已重新部署上一版/);
    assert.equal(f.git(f.remote, "rev-parse", f.release), f.base);
    recoverMergeQueue(f.repo); await f.idle(); assert.equal(f.deployments().length, 3, "恢复不重复执行部署或回退");
  } finally { await f.close(); }
});

test("部署回退保护：检查失败时目标已前进则只通知，不改指针、不再执行部署", async () => {
  const f = fixture({ deployment: { enabled: true } });
  try {
    // 替身检查自己制造外部提交，验证回退不能覆盖目标的新提交。
    for (const cwd of [f.repo, f.batches[0].cwd]) writeFileSync(join(cwd, "check.mjs"), "import cp from 'node:child_process'; console.log('HEALTH_CHECK_FAILED_NEW_HEAD'); cp.execFileSync('git',['commit','--allow-empty','-qm','external advance']); process.exit(1);\n");
    f.git(f.repo, "add", "check.mjs"); f.git(f.repo, "commit", "-qm", "check fixture");
    f.git(f.batches[0].cwd, "add", "check.mjs"); f.git(f.batches[0].cwd, "commit", "-qm", "check fixture");
    writeFileSync(join(f.batches[0].cwd, "code.txt"), "checked\n"); f.complete();
    await f.until(() => f.queue().entries[0]?.deployment?.status === "blocked"); await f.idle();
    const entry = f.queue().entries[0], head = f.git(f.repo, "rev-parse", "HEAD"); assert.notEqual(head, entry.result); assert.notEqual(head, entry.base);
    assert.equal(f.deployments().filter((item) => item.action === "deploy").length, 1); assert.match(f.notice(), /回退失败[\s\S]*未再执行部署/);
  } finally { await f.close(); }
});

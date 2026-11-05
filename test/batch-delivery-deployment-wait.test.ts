/** batch-delivery-deployment-wait：独立进程隔离环境，保持全部场景与断言。 */
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

test("部署／等待实际检查活动：评审及整批验收结束即放行，不等待开发或暂停中的流水线", async (t) => {
  for (const kind of ["段评审", "流水线开发", "流水线暂停", "整批验收"] as const) await t.test(kind, async () => {
    const f = fixture({ count: 2, deployment: { enabled: true } });
    const background = kind === "段评审" ? undefined : backgroundPipeline(f, kind === "整批验收");
    const info = background?.info ?? batchInfo(f.batches[1].file, f.repo, f.batches[1].dir);
    let releaseCheck = background && kind === "整批验收" ? beginQueueAcceptance(background.run) : () => {};
    try {
      if (background) writePhase(info, null, "running");
      if (kind !== "整批验收") writePhase(info, "dev", "reviewing");
      writeFileSync(join(f.batches[0].cwd, "code.txt"), "checked\n"); f.complete();
      await f.until(() => f.queue().entries[0]?.status === "merged" && f.queue().entries[0].deployment?.status === "waiting");
      await sleep(150); assert.deepEqual(f.deployments(), []);
      assert.ok(!existsSync(join(queueDir(f.repo), "worker.lock")), "等待检查不占队列执行锁");
      if (background && kind === "整批验收") {
        assert.equal(f.queue().batches.find((batch) => batch.id === background.run.batch)!.integrationCheck?.owner.token, background.run.token);
        releaseCheck(); releaseCheck = () => {};
      }
      writePhase(info, "dev", kind === "段评审" ? "done" : kind === "流水线开发" ? "running" : "paused");
      await f.until(() => f.queue().entries[0]?.deployment?.status === "succeeded"); await f.idle();
      assert.deepEqual(f.deployments().map((item) => item.action), ["deploy", "check"]);
      assert.match(f.notice(), /已部署[\s\S]*检查通过/);
      if (background) {
        assert.ok(existsSync(join(queueDir(f.repo), `integration-${background.run.batch}.lock`)), "全程运行锁仍在，不再是检查活动");
        if (kind === "整批验收") assert.equal(f.queue().batches.find((batch) => batch.id === background.run.batch)!.integrationCheck, undefined);
      }
    } finally {
      releaseCheck();
      if (background) { writePhase(info, "dev", "paused"); endQueuePipeline(background.run); }
      await f.close();
    }
  });
});

test("部署启动边界：另一流水线从开发转入整批验收时重新等待，验收结束后才启动", async () => {
  const f = fixture({ count: 2, deployment: { enabled: true } }), background = backgroundPipeline(f, true);
  const paused = join(f.root, "deployment-version-check"), resume = join(f.root, "resume-deployment-version-check");
  const wrapper = join(f.root, "bin", "git"), realGit = spawnSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  let releaseCheck = () => {};
  try {
    writePhase(background.info, null, "running"); writePhase(background.info, "dev", "running");
    // 只暂停本次部署监督进程：两次“无检查”核对已过，但命令尚未取得最终启动资格。
    writeFileSync(wrapper, `#!/bin/sh\ncase " $* " in\n *" rev-parse HEAD "*) if [ -n "$AUTOREVIEW_QUEUE_EXECUTOR_ID" ] && [ "$AUTOREVIEW_PROCESS_OWNER" = "$AUTOREVIEW_QUEUE_EXECUTOR_ID" ] && [ "$PWD" = '${f.repo}' ] && [ ! -f '${paused}' ]; then : > '${paused}'; while [ ! -f '${resume}' ]; do sleep 0.02; done; fi;;\nesac\nexec '${realGit}' "$@"\n`); chmodSync(wrapper, 0o755);
    writeFileSync(join(f.batches[0].cwd, "code.txt"), "checked\n"); f.complete();
    await f.until(() => existsSync(paused)); assert.ok(existsSync(join(queueDir(f.repo), "worker.lock")));
    assert.deepEqual(f.deployments(), []);
    releaseCheck = beginQueueAcceptance(background.run);
    assert.equal(f.queue().batches.find((batch) => batch.id === background.run.batch)!.integrationCheck?.owner.token, background.run.token);
    writeFileSync(resume, "resume");
    await f.until(() => f.queue().entries[0]?.deployment?.status === "succeeded"
      || (Boolean(f.queue().entries[0]?.deployment?.reason) && !existsSync(join(queueDir(f.repo), "worker.lock"))));
    assert.deepEqual(f.deployments(), [], "启动前登记的新验收不能被先前的无检查快照越过");
    assert.equal(f.queue().entries[0].deployment?.status, "waiting", "应继续等待，而不是阻塞失败或执行命令");
    assert.ok(!existsSync(join(queueDir(f.repo), "worker.lock")), "重新等待时释放队列锁");
    releaseCheck(); releaseCheck = () => {}; writePhase(background.info, "dev", "paused");
    await f.until(() => f.queue().entries[0]?.deployment?.status === "succeeded"); await f.idle();
    assert.deepEqual(f.deployments().map((item) => item.action), ["deploy", "check"]);
    assert.ok(existsSync(join(queueDir(f.repo), `integration-${background.run.batch}.lock`)), "验收结束后不再等待整条流水线退出");
  } finally {
    writeFileSync(resume, "resume"); releaseCheck(); writePhase(background.info, "dev", "paused");
    endQueuePipeline(background.run); await f.close();
  }
});

test("部署待办接棒：等待期间又合入一批时只部署最新版本，不丢后续部署", async () => {
  const f = fixture({ count: 2, deployment: { enabled: true } });
  try {
    // 放大“先派发后一个部署、先前等待者随后退出”的并发窗口。
    process.env.AUTOREVIEW_PIPELINE_POLL_MS = "5000";
    const other = f.batches[1]; writePhase(batchInfo(other.file, f.repo, other.dir), "dev", "reviewing");
    writeFileSync(join(f.batches[0].cwd, "code.txt"), "first\n"); f.complete();
    await f.until(() => Boolean(f.queue().entries[0]?.deployment?.reason));
    writeFileSync(join(f.batches[1].cwd, "extra.txt"), "second\n"); f.complete(1);
    await f.until(() => f.queue().entries[1]?.status === "merged");
    writePhase(batchInfo(other.file, f.repo, other.dir), "dev", "done");
    await f.until(() => f.queue().entries[1]?.deployment?.status === "succeeded"); await f.idle();
    assert.equal(f.queue().entries[0].deployment?.status, "blocked");
    const latest = f.queue().entries[1].result;
    assert.deepEqual(f.deployments().map((item) => [item.action, item.head]), [["deploy", latest], ["check", latest]]);
  } finally { await f.close(); }
});

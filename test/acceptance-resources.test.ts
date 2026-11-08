/** acceptance／resources：按功能独立运行，夹具与状态不跨测试进程共享。 */
/** 自动验收：纯函数（取标准、解析、判定、消息）与一轮验收流程（真起被测系统）；产物只写 os.tmpdir()。 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runAcceptanceOnce as runAcceptanceStage } from "../acceptance.ts";
import { createChildExec } from "../hosts/review-hook.ts";
import { readProcs, reapProcs } from "../procs.ts";
import { STALLED_TESTER, criteriaItems, block, harness } from "./helpers/acceptance-fixture.ts";

test("A27 Hook 的子进程被取消时连同后代一起杀掉（验收方起的子进程不留下）", async () => {
  const root = mkdtempSync(join(tmpdir(), "autoreview-abort-"));
  const pidFile = join(root, "child.pid");
  const controller = new AbortController();
  try {
    const exec = createChildExec()("/bin/sh", ["-c", `sleep 30 & echo $! > ${pidFile}; wait`], { cwd: root, timeout: 60_000, signal: controller.signal });
    for (let i = 0; i < 50 && !existsSync(pidFile); i += 1) await new Promise((r) => setTimeout(r, 50));
    const grandchild = Number(readFileSync(pidFile, "utf8"));
    controller.abort();
    const result = await exec;
    assert.equal(result.killed, true);
    // 被杀掉的孙进程可能还是僵尸（等 init 回收），只看它是不是还在运行。
    const running = (): boolean => {
      const res = spawnSync("ps", ["-o", "stat=", "-p", String(grandchild)], { encoding: "utf8" });
      return res.status === 0 && !res.stdout.trim().startsWith("Z");
    };
    for (let i = 0; i < 20 && running(); i += 1) await new Promise((r) => setTimeout(r, 50));
    assert.equal(running(), false, "后台的 sleep 也被杀掉");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("A33 项目释放脚本始终运行，失败不能发布成功", async () => {
  const h = await harness({ cleanup: 'echo "$AUTOREVIEW_RUN_ID"; echo release-failed >&2; exit 75', env: { AUTOREVIEW_RUN_ID: "foreign-task", AUTOREVIEW_RUN_DIR: "/not-this-run" } });
  try {
    const outcome = await runAcceptanceStage(h.deps());
    assert.equal(outcome.kind, "judged");
    if (outcome.kind !== "judged") return;
    assert.equal(outcome.record.verdict, "无法验收");
    assert.equal(outcome.record.failureKind, "environment");
    assert.match(readFileSync(join(outcome.record.runDir, "cleanup.log"), "utf8"), /release-failed/);
    assert.match(outcome.record.cleanup!.join("\n"), /资源释放未确认/);
    const identity = JSON.parse(readFileSync(join(outcome.record.runDir, "cleanup-task.json"), "utf8"));
    assert.equal(identity.status, "failed");
    const log = readFileSync(join(outcome.record.runDir, "cleanup.log"), "utf8");
    assert.ok(log.includes(identity.runId)); assert.doesNotMatch(log, /foreign-task/);
  } finally { h.close(); }
});

test("验收／释放证明必须确认：执行失败、取消 reject 及正常返回缺证明均不能完成", async (t) => {
  for (const kind of ["释放失败", "取消reject", "正常返回缺证明"] as const) await t.test(kind, async () => {
    const h = await harness(kind === "取消reject" ? { idleTimeoutSec: 1 } : {}, kind === "释放失败" ? { FAKE_ACC_MODE: "checkpoint-all" } : {});
    try {
      let calls = 0;
      const deps = h.deps(), execute = deps.exec;
      if (kind === "取消reject") deps.config = { ...deps.config, testerCmd: "" };
      deps.exec = async (command, args, options) => {
        calls++; assert.equal(calls, 1, "释放未确认不能启动补判或重复实测");
        if (kind === "释放失败") {
          const result = await execute(command, args, options);
          return { ...result, code: 75, stderr: "AUTOREVIEW_FAILURE=environment 子进程释放未确认，登记已保留" };
        }
        for (const { id } of criteriaItems) writeFileSync(join(options.cwd, "evidence", `${id}.txt`), block(id, "已完成"));
        if (kind === "取消reject") return new Promise((_resolve, reject) => options.signal?.addEventListener("abort", () => reject(new Error("AbortError")), { once: true }));
        return { stdout: "## 逐条结果\nA1：通过\n- 证据摘录：已完成\nA2：通过\n- 证据摘录：已完成", stderr: "", code: 0, killed: false };
      };
      const stage = await runAcceptanceStage(deps);
      assert.equal(stage.kind, "judged"); if (stage.kind !== "judged") return;
      assert.equal(calls, 1); assert.equal(stage.record.verdict, "无法验收");
      assert.equal(stage.record.failureKind, "environment"); assert.match(stage.record.reason!, /子进程释放未确认/);
      assert.equal(stage.record.recovery, undefined);
      assert.ok(stage.record.items.every((item) => item.verdict === (kind === "取消reject" ? "无法验证" : "通过")), "保留已取得的逐项业务证据");
      if (kind === "释放失败") assert.equal(h.calls().length, 1);
    } finally { h.close(); }
  });
});

test("验收资源／空闲中止后独立进程组的工具子进程必须真实停止，不能仅看登记为空", async () => {
  const h = await harness({ idleTimeoutSec: 2 }, { AUTOREVIEW_ACCEPTANCE_CMD: STALLED_TESTER, FAKE_ACC_MODE: "stall-detached" });
  let detached: { pid: number; token: string } | undefined;
  const running = (pid: number): boolean => {
    const result = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
    return result.status === 0 && !result.stdout.trim().startsWith("Z");
  };
  try {
    const stage = await runAcceptanceStage(h.deps());
    assert.equal(stage.kind, "judged"); if (stage.kind !== "judged") return;
    detached = JSON.parse(readFileSync(join(stage.record.runDir, "detached.json"), "utf8"));
    assert.equal(stage.record.verdict, "通过");
    assert.equal(running(detached!.pid), false, "原 Pi 进程组外的工具仍在运行时不得发布完成");
    const writes = join(stage.record.runDir, "detached-writes");
    const before = readFileSync(writes, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(readFileSync(writes, "utf8"), before, "完成之后脚本不能继续写数据");
    assert.deepEqual(readProcs(h.procsFile), []);
  } finally {
    if (detached && running(detached.pid)) {
      const env = spawnSync("ps", ["eww", "-p", String(detached.pid), "-o", "command="], { encoding: "utf8" });
      if (env.stdout.split(/\s+/).includes(`AUTOREVIEW_PROCESS_OWNER=${detached.token}`)) process.kill(detached.pid, "SIGKILL");
    }
    h.close();
  }
});

test("验收资源／跨组进程扫描失败时保留登记并暂停，已有全部通过检查点也不能补判放行", async () => {
  const h = await harness({ idleTimeoutSec: 2 }, { AUTOREVIEW_ACCEPTANCE_CMD: STALLED_TESTER, FAKE_ACC_MODE: "stall-detached", FAKE_FAIL_PROCESS_SCAN: "1" });
  const path = process.env.PATH;
  try {
    const deps = h.deps(), execute = deps.exec;
    deps.exec = (command, args, options) => execute(command, args, { ...options, onOutput: (text) => {
      options.onOutput?.(text);
      if (text.includes("PROCESS_SCAN_READY")) process.env.PATH = join(h.root, "no-ps-here");
    } });
    const stage = await runAcceptanceStage(deps);
    assert.equal(stage.kind, "judged"); if (stage.kind !== "judged") return;
    assert.ok(stage.record.items.every((item) => item.verdict === "通过"));
    assert.equal(stage.record.verdict, "无法验收");
    assert.equal(stage.record.failureKind, "environment");
    assert.match(stage.record.reason!, /资源释放|归属/);
    assert.ok(readProcs(h.procsFile).length > 0, "不能因原组消失就注销，须留待按身份补偿");
    assert.equal(h.calls().length, 1, "清理失败不能转入强模型补判");
  } finally {
    if (path === undefined) delete process.env.PATH; else process.env.PATH = path;
    reapProcs(h.procsFile, { ownerPid: process.pid });
    assert.deepEqual(readProcs(h.procsFile), [], "恢复查询后按保留的身份清理独立子进程");
    h.close();
  }
});

test("共享执行器实时上报 stdout/stderr 活动，不等到进程结束", async () => {
  const root = mkdtempSync(join(tmpdir(), "autoreview-output-"));
  try {
    const chunks: string[] = [];
    const result = await createChildExec()(process.execPath, ["-e", 'console.log("stdout pulse"); console.error("stderr pulse"); setTimeout(() => {}, 50)'],
      { cwd: root, timeout: 5000, onOutput: (chunk) => chunks.push(chunk) });
    assert.equal(result.code, 0);
    assert.match(chunks.join(""), /stdout pulse/);
    assert.match(chunks.join(""), /stderr pulse/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

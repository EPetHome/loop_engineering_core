/** hook／process：按功能独立运行，夹具与状态不跨测试进程共享。 */
import "./test-env.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { childExec } from "../hosts/review-hook.ts";
import { HOOK, FAKE, fixture } from "./helpers/hook-fixture.ts";

test("H6 锁属于已死进程：记「评审被中断」暂停并通知", () => {
  const h = fixture();
  try {
    h.run(h.event("SessionStart"));
    const lock = h.statePath().replace(/\.state\.json$/, ".lock");
    mkdirSync(join(h.home, ".pi-autoreview", basename(h.repo)), { recursive: true });
    writeFileSync(lock, JSON.stringify({ pid: 999999, startedAt: "2026-01-01T00:00:00Z" }));
    const res = h.run(h.delivered());
    assert.equal(res.code, 0);
    assert.equal(res.stdout, "");
    const state = h.readState();
    assert.equal(state.phase, "paused");
    assert.match(state.pauseReason, /评审被中断/);
    assert.match(h.notifications(), /评审被中断/);
    assert.ok(!existsSync(lock), "死锁已清理");
  } finally { h.close(); }
});

test("Hook进程／childExec 超时杀进程组并有界返回", async () => {
  const holder = fileURLToPath(new URL("./descendant-holder.mjs", import.meta.url));
  const started = Date.now();
  const res = await childExec(process.execPath, [holder], { cwd: tmpdir(), timeout: 200 });
  const elapsed = Date.now() - started;
  assert.equal(res.killed, true);
  assert.ok(elapsed < 3000, `应在有界时间返回，实际 ${elapsed}ms`);
});

test("H10 Stop Hook 被宿主杀掉：评审子进程不留孤儿", async (t) => {
  const alive = (pid: number): boolean => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  };
  const waitFor = async (predicate: () => boolean, ms: number, what: string): Promise<void> => {
    const deadline = Date.now() + ms;
    while (!predicate() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.ok(predicate(), `等待失败：${what}`);
  };
  /** 异步起 Stop Hook（假评审睡 30 秒），等评审进程起来后返回 Hook 子进程和评审 pid。 */
  const startSlowStop = async (h: ReturnType<typeof fixture>) => {
    h.run(h.event("SessionStart"));
    h.run(h.event("UserPromptSubmit", { prompt: "需求" }));
    h.write("file.txt", "base\nA\n");
    const env: Record<string, string | undefined> = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
    for (const key of ["CLAUDECODE", "CLAUDE_PLUGIN_ROOT", "CLAUDE_CODE_ENTRYPOINT", "AUTOREVIEW_HOST"]) delete env[key];
    const hook = spawn(process.execPath, [HOOK], {
      cwd: h.repo, stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...env, HOME: h.home, PATH: `${join(h.root, "bin")}:${process.env.PATH}`,
        AUTOREVIEW_DEV_ROOT: h.repo,
        AUTOREVIEW_REVIEWER_CMD: FAKE, FAKE_MODE: "pass", FAKE_SLEEP_SECONDS: "30",
        FAKE_STATE_DIR: join(h.root, "fake"),
      },
    });
    hook.stdin.end(JSON.stringify(h.delivered()));
    const pidFile = join(h.root, "fake", "reviewer.pid");
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "", 10_000, "假评审启动");
    const reviewer = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
    const procs = h.statePath().replace(/\.state\.json$/, ".procs.json");
    await waitFor(() => existsSync(procs), 5000, "评审进程已登记");
    const exited = new Promise<void>((resolveExit) => hook.on("exit", () => resolveExit()));
    return { hook, reviewer, procs, exited };
  };
  await t.test("SIGTERM：Hook 先杀评审进程组，状态记「评审被中断」并释放锁", async () => {
    const h = fixture();
    try {
      const { hook, reviewer, procs, exited } = await startSlowStop(h);
      assert.ok(alive(reviewer));
      hook.kill("SIGTERM");
      await exited;
      await waitFor(() => !alive(reviewer), 3000, "评审进程随 Hook 一起结束");
      const state = h.readState();
      assert.equal(state.phase, "paused");
      assert.match(state.pauseReason, /评审被中断/);
      assert.ok(!existsSync(h.statePath().replace(/\.state\.json$/, ".lock")), "锁已释放");
      assert.ok(!existsSync(procs), "登记已清空");
    } finally { h.close(); }
  });
  await t.test("SIGKILL：评审进程残留，下一次提交消息先清掉再恢复", async () => {
    const h = fixture();
    let reviewerPid = 0;
    try {
      const { hook, reviewer, procs, exited } = await startSlowStop(h);
      reviewerPid = reviewer;
      hook.kill("SIGKILL");
      await exited;
      await new Promise((r) => setTimeout(r, 200));
      assert.ok(alive(reviewer), "SIGKILL 拦不住：评审进程还在（这正是要清理的孤儿）");
      const res = h.run(h.event("UserPromptSubmit", { prompt: "继续" }));
      assert.match(res.stderr, /已清理残留进程：评审/);
      await waitFor(() => !alive(reviewer), 3000, "孤儿评审被清理");
      assert.ok(!existsSync(procs), "登记已清空");
      assert.equal(h.readState().phase, "idle");
    } finally {
      if (reviewerPid && alive(reviewerPid)) try { process.kill(-reviewerPid, "SIGKILL"); } catch { /* 已退出 */ }
      h.close();
    }
  });
});

test("Hook 验收中收到可捕获信号，等待外部资源 cleanup 后再退出", async (t) => {
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) await t.test(signal, async () => {
    const h = fixture({ marker: JSON.stringify({ acceptance: { cleanup: `node -e 'setTimeout(() => require("fs").writeFileSync(process.env.AUTOREVIEW_RUN_DIR + "/released", process.env.AUTOREVIEW_RUN_ID), 100)'` } }) });
    let child: ReturnType<typeof spawn> | undefined;
    try {
      const tester = join(h.root, "slow-tester.mjs"), ready = join(h.root, "tester-ready");
      writeFileSync(tester, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(ready)}, 'ready'); setTimeout(()=>{},30000);\n`);
      chmodSync(tester, 0o755);
      h.run(h.event("SessionStart"));
      h.run(h.event("UserPromptSubmit", { prompt: "requirement\n## 验收标准\n1. 操作：检查\n预期：ok" }));
      h.write("file.txt", "base\nchange\n");
      child = spawn(process.execPath, [HOOK], { cwd: h.repo, stdio: ["pipe", "pipe", "pipe"], env: {
        ...process.env, HOME: h.home, AUTOREVIEW_HOST: "claude", PATH: `${join(h.root, "bin")}:${process.env.PATH}`,
        AUTOREVIEW_DEV_ROOT: h.repo,
        AUTOREVIEW_REVIEWER_CMD: FAKE, FAKE_MODE: "pass", FAKE_STATE_DIR: join(h.root, "fake"), AUTOREVIEW_ACCEPTANCE_CMD: tester,
      } });
      let stderr = ""; child.stderr!.on("data", (chunk) => { stderr += chunk; });
      const exited = new Promise<number | null>((resolve) => child!.on("exit", resolve));
      child.stdin!.end(JSON.stringify(h.delivered()));
      for (let i = 0; i < 200 && !existsSync(ready) && child.exitCode === null; i++) await new Promise((r) => setTimeout(r, 50));
      assert.ok(existsSync(ready), stderr);
      child.kill(signal);
      const code = await exited;
      assert.equal(code, signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143, stderr);
      const runDir = join(h.home, ".pi-autoreview", "repo", "acceptance", "claude-s1", "r1");
      const record = JSON.parse(readFileSync(join(runDir, "cleanup-task.json"), "utf8"));
      assert.equal(record.status, "released");
      assert.equal(readFileSync(join(runDir, "released"), "utf8"), record.runId);
      assert.equal(h.readState().phase, "paused");
      assert.match(h.summary(), /外部资源释放：released/);
      assert.ok(!existsSync(h.statePath().replace(/\.state\.json$/, ".lock")));
    } finally { if (child?.exitCode === null) child.kill("SIGKILL"); h.close(); }
  });
});

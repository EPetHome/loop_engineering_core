/** 第一次返修：批次归属隔离、正式启动链的组归属、无名称只评审的停止/查询。 */
import "./test-env.ts";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { batchInfo, batchInfoPath, phasePath, recordBatchInfo, writePhase } from "../events.ts";
import { launchPath, type BatchLaunch } from "../launch.ts";
import { createChildExec } from "../hosts/review-hook.ts";
import { queueDir, queueStageEvent, readMergeQueue, registerQueueBatch, stopQueueBatch } from "../merge-queue.ts";
import { readJson, statusPath, writeStageStatus } from "../pipeline-core.ts";
import { parsePlan } from "../pipeline.ts";
import { workingTree } from "../commit-batch.ts";
import { ownedProcessGroupAlive, processGroup, processStartTime, registerProc, releaseProc, releaseProcessTree } from "../procs.ts";
import { createRunResource } from "../resources.ts";
import { resumeBatch } from "../pa-resume.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url)), LOOP = join(ROOT, "loop.ts");
const FAKE = join(ROOT, "test/fake-stop-session.mjs");
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "loop-stop-safety-"))), home = join(root, "home"), repo = join(root, "repo");
  mkdirSync(home); mkdirSync(repo);
  const env = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", LOOP_PA_CONFIG: join(root, "pa.json"),
    AUTOREVIEW_MERGE_QUEUE_ROOT: join(root, "queues"), AUTOREVIEW_PROJECTS_ROOT: join(root, "projects"), AUTOREVIEW_RESOURCE_ROOT: join(root, "resources"),
    AUTOREVIEW_PIPELINE_POLL_MS: "30", STOP_FIXTURE_DIR: join(root, "sessions"), PI_NODE_BIN: dirname(process.execPath), LOOP_DIR: ROOT };
  writeFileSync(env.LOOP_PA_CONFIG, JSON.stringify({ pa: { eventsDir: join(root, "events"), localNotify: false } }));
  const git = (cwd: string, ...args: string[]): string => { const r = spawnSync("git", args, { cwd, env, encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  const init = (path: string): void => {
    mkdirSync(path, { recursive: true }); git(path, "init", "-q", "-b", "main"); git(path, "config", "user.email", "test@example.com"); git(path, "config", "user.name", "test");
    writeFileSync(join(path, ".autoreview.json"), "{}"); writeFileSync(join(path, "file.txt"), "base\n");
    git(path, "add", "."); git(path, "commit", "-qm", "base");
  };
  init(repo);
  const cli = (...args: string[]) => {
    const r = spawnSync(process.execPath, [LOOP, ...args, "--json"], { cwd: repo, env, encoding: "utf8", timeout: 20_000 });
    assert.ok(r.stdout.trim(), r.stderr); return { code: r.status, data: JSON.parse(r.stdout), stderr: r.stderr };
  };
  const started: { child: ChildProcess; started: string; closed: Promise<number | null>; output: () => string }[] = [];
  const start = (...args: string[]) => {
    // 故意不 detached：测试不能替正式启动器建立组，更不能把测试父组作为可停止组。
    const child = spawn(process.execPath, [LOOP, ...args, "--json"], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", errors = ""; child.stdout!.on("data", (data) => { output += data; }); child.stderr!.on("data", (data) => { errors += data; });
    const closed = new Promise<number | null>((accept) => child.once("close", accept));
    const result = { child, started: processStartTime(child.pid!), closed, output: () => output || errors }; started.push(result); return result;
  };
  const close = async () => {
    // 只使用本夹具正式启动登记中的完整身份，不按名称/端口猜测清理目标。
    const inspect = (path: string): void => {
      if (!existsSync(path)) return;
      for (const item of readdirSync(path, { withFileTypes: true })) {
        const full = join(path, item.name);
        if (item.isDirectory()) inspect(full);
        else if (item.name.endsWith(".launch.json")) {
          const launch = readJson<BatchLaunch>(full);
          if (launch?.processStarted) releaseProcessTree({ pgid: launch.pid, started: launch.processStarted, token: launch.token });
        }
      }
    };
    inspect(root);
    for (const item of started) {
      if (processStartTime(item.child.pid!) === item.started) item.child.kill("SIGTERM");
      await Promise.race([item.closed, sleep(1500)]);
      if (processStartTime(item.child.pid!) === item.started) item.child.kill("SIGKILL");
    }
    await sleep(50); rmSync(root, { recursive: true, force: true });
  };
  return { root, repo, home, env, git, init, cli, start, close };
}
async function withEnv(env: NodeJS.ProcessEnv, fn: () => Promise<void>) {
  const old = { ...process.env };
  try { Object.assign(process.env, env); await fn(); }
  finally { for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key]; Object.assign(process.env, old); }
}
async function until(check: () => boolean, message: string, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await sleep(30);
  assert.ok(check(), message);
}
const running = (pid: number): boolean => {
  const r = spawnSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" });
  return r.status === 0 && Boolean(r.stdout.trim()) && !r.stdout.trim().startsWith("Z");
};
function registeredPipeline(f: ReturnType<typeof fixture>, start: string, extra: Record<string, unknown> = {}) {
  writeFileSync(join(f.repo, ".autoreview.json"), JSON.stringify({ gate: { cmd: "true", timeoutMin: 1 } }));
  f.git(f.repo, "add", ".autoreview.json"); f.git(f.repo, "commit", "-qm", "fixture gate");
  const dev = join(f.root, "dev"), file = join(f.repo, "batch.json"), dir = join(f.root, "pipeline"), branch = "feat/generation";
  f.git(f.repo, "worktree", "add", "-b", branch, dev);
  const stages = { 甲: { cwd: dev, start }, 乙: { cwd: dev, start } }, steps = [["甲"], ["乙"]];
  writeFileSync(file, JSON.stringify({ name: "运行代次", branch, dir, stages, steps, ...extra }));
  registerQueueBatch(f.repo, { name: "运行代次", file, dir, project: f.repo, release: "main", acceptance: Boolean(extra.acceptance), steps,
    stages: Object.keys(stages).map((name) => ({ name, cwd: dev, branch, start })) });
  return { dev, file, dir };
}
function snapshot(path: string): unknown[] {
  const stat = statSync(path);
  return [[path, stat.mtimeMs, stat.size, stat.isFile() ? readFileSync(path).toString("base64") : ""],
    ...(stat.isDirectory() ? readdirSync(path).sort().flatMap((name) => snapshot(join(path, name))) : [])];
}

test("第 1 条：跨项目同名批次拒绝停止，PID 即使匹配也不碰另一批的进程/资源/状态/队列", async () => {
  const f = fixture(); let foreign: ChildProcess | undefined, started = "";
  try {
    await withEnv(f.env, async () => {
      const other = join(f.root, "other"); f.init(other);
      const dev = join(f.root, "dev"); f.git(f.repo, "worktree", "add", "-b", "feat/a", dev);
      const a = join(f.repo, "batch.json"), b = join(other, "batch.json");
      writeFileSync(a, JSON.stringify({ name: "同名", branch: "feat/a", stages: { 甲: { cwd: dev, start: "fake" } } }));
      writeFileSync(b, JSON.stringify({ name: "同名", stages: { 甲: { cwd: other, start: "fake" } } }));
      const infoA = batchInfo(a, f.repo), infoB = batchInfo(b, other);
      assert.equal(infoA.dir, infoB.dir);
      registerQueueBatch(f.repo, { file: a, name: "同名", dir: infoA.dir, project: f.repo, release: "main", stages: [{ name: "甲", cwd: dev, branch: "feat/a", start: "fake" }], steps: [["甲"]] });
      const queue = readMergeQueue(f.repo)!;
      queue.entries.push({ id: "a", batch: queue.batches[0].id, name: "同名", status: "pending", order: 1, sources: [], qualification: [], attempt: 0, createdAt: "now", updatedAt: "now" });
      writeFileSync(join(queueDir(f.repo), "queue.json"), JSON.stringify(queue));
      foreign = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" }); started = processStartTime(foreign.pid!);
      const summary = join(f.root, "b.md"), procs = join(f.root, "b.procs.json"); writeFileSync(summary, "B 的总结和证据\n");
      const session = { host: "pi", id: "b", pid: foreign.pid, processStarted: started };
      writeStageStatus({ dir: infoB.dir, stage: "甲" }, { ...session, batchFile: b, sessionId: "b", event: "started", summary, inbox: 0 });
      writePhase(infoB, "甲", "running", { session, evidence: { summary } });
      const resource = createRunResource("B", 0, procs); registerProc(procs, foreign.pid!, "B 消费者", process.execPath, undefined, resource.id);
      let before = snapshot(f.root);
      const rejected = f.cli("停止", a);
      assert.equal(rejected.data.ok, false); assert.match(rejected.data.reason.text, /归属/);
      assert.deepEqual(snapshot(f.root), before, "拒绝不得写 failed、改队列、释放资源或覆盖任何状态");
      assert.equal(processStartTime(foreign.pid!), started); assert.ok(running(foreign.pid!)); assert.ok(existsSync(resource.dir));
      const query = f.cli("查询", a); assert.equal(query.data.batches[0].state, null); assert.equal(query.data.batches[0].stages[0].session, null);
      // 元数据换回 A，也不能把目录里 B 的旧 session 当作 A；状态自身还要绑定批次。
      recordBatchInfo(infoA); before = snapshot(f.root);
      const stale = f.cli("停止", a); assert.equal(stale.data.ok, false); assert.match(stale.data.reason.text, /会话状态.*归属/);
      assert.deepEqual(snapshot(f.root), before); assert.ok(running(foreign.pid!));
    });
  } finally { if (foreign && started) releaseProcessTree({ pgid: foreign.pid!, started }); await f.close(); }
});

for (const prompt of [false, true]) test(`第 2 条：正式单段启动${prompt ? "经过 bin/pi-dev" : "自定义 start"}，宿主不是组长也能安全停止`, async () => {
  const f = fixture();
  try {
    const file = join(f.repo, "batch.json"), dir = join(f.root, "pipeline");
    if (prompt) {
      const pi = join(f.root, "fake-pi"), permission = join(f.root, "permission.ts");
      writeFileSync(pi, `#!/bin/sh\n'${process.execPath}' '${FAKE}' "$@"\nprintf '不应执行'\n`); chmodSync(pi, 0o755); writeFileSync(permission, "");
      Object.assign(f.env, { PI_BIN: pi, PERMISSION_EXTENSION: permission });
      const config = join(f.home, ".pi/agent/extensions/pi-permission-system/config.json"); mkdirSync(dirname(config), { recursive: true }); writeFileSync(config, '{"yoloMode":true}');
      writeFileSync(join(f.repo, "prompt.md"), "替身任务\n");
    }
    writeFileSync(file, JSON.stringify({ name: "正式单段", dir, stages: { 甲: { cwd: f.repo, ...(prompt ? { prompt: "prompt.md", ponytail: false } : { start: `'${process.execPath}' '${FAKE}'; printf '不应执行'` }) } } }));
    const launch = f.start("启动", file);
    const receipt = join(f.env.STOP_FIXTURE_DIR, "甲.session.json");
    await until(() => existsSync(receipt), launch.output());
    const session = readJson<any>(receipt), group = readJson<BatchLaunch>(launchPath(dir, "甲"))!;
    assert.ok(running(session.pid)); assert.notEqual(session.pid, group.pid, "不只测试宿主恰好是组长的情况");
    assert.equal(processGroup(session.pid), group.pid); assert.notEqual(group.pid, processGroup(process.pid));
    const stopped = f.cli("停止", file); assert.equal(stopped.code, 0, JSON.stringify(stopped.data)); assert.equal(stopped.data.ok, true);
    await until(() => !running(session.pid) && !running(group.pid), "正式会话与独立组必须结束");
    await launch.closed;
    assert.equal(readFileSync(join(f.env.STOP_FIXTURE_DIR, "甲.md"), "utf8"), "替身会话总结与证据，停止后保留\n");
    assert.equal(readJson<any>(phasePath(dir, null)).category, "已停止");
  } finally { await f.close(); }
});

test("第 2 条：正式多段启动停止编排及当前段，不再派发下一段，也不杀调用者共享组", async () => {
  const f = fixture();
  try {
    const file = join(f.repo, "batch.json"), dir = join(f.root, "pipeline");
    const start = `'${process.execPath}' '${FAKE}'; printf '不应执行'`;
    writeFileSync(file, JSON.stringify({ name: "正式多段", dir, stages: { 甲: { cwd: f.repo, start }, 乙: { cwd: f.repo, start } }, steps: [["甲"], ["乙"]] }));
    const launched = f.start("启动", file, "--launcher", "background");
    await until(() => existsSync(join(f.env.STOP_FIXTURE_DIR, "甲.session.json")), launched.output());
    const phase = readJson<any>(phasePath(dir, null)), session = readJson<any>(join(f.env.STOP_FIXTURE_DIR, "甲.session.json"));
    assert.equal(phase.session.pid, readJson<BatchLaunch>(launchPath(dir, null))!.pid);
    assert.equal(processGroup(phase.session.pid), phase.session.pid, "正式启动器负责独立组，而非测试夹具");
    const stopped = f.cli("停止", file); assert.equal(stopped.code, 0, JSON.stringify(stopped.data));
    assert.ok(stopped.data.stopped.some((item: any) => item.stage === null));
    await until(() => !running(phase.session.pid) && !running(session.pid), "编排及当前段应真实退出");
    await launched.closed; await sleep(150);
    assert.equal(existsSync(join(f.env.STOP_FIXTURE_DIR, "乙.session.json")), false, "不能继续派发后续段");
    assert.equal(readJson<any>(phasePath(dir, null)).category, "已停止");
  } finally { await f.close(); }
});

test("第 3 条：省略 name/dir 的只评审批次共用默认定位；查询可见运行中，停止真结束并释放 worktree", async () => {
  const f = fixture();
  try {
    const file = join(f.repo, "batch.json");
    writeFileSync(file, JSON.stringify({ recipe: "review-only", review: { repo: f.repo, base: "HEAD", head: "HEAD" } }));
    const reviewerDir = join(f.root, "reviewer");
    Object.assign(f.env, { AUTOREVIEW_REVIEWER_CMD: join(ROOT, "test/fake-reviewer.mjs"), FAKE_SLEEP_SECONDS: "60", FAKE_STATE_DIR: reviewerDir });
    const launched = f.start("启动", file);
    const reviewerFile = join(reviewerDir, "reviewer.pid");
    await until(() => existsSync(reviewerFile), launched.output());
    const dir = join(f.home, ".pi-autoreview/pipelines/只评审"), info = readJson<any>(batchInfoPath(dir));
    assert.equal(info.batch.name, "只评审");
    const query = f.cli("查询", file); assert.equal(query.data.batches[0].batch.name, "只评审"); assert.equal(query.data.batches[0].state, "running");
    const reviewer = Number(readFileSync(reviewerFile, "utf8")), phase = readJson<any>(phasePath(dir, null));
    const checkout = readFileSync(join(reviewerDir, "reviewer.cwd"), "utf8");
    const stopped = f.cli("停止", file); assert.equal(stopped.code, 0, JSON.stringify(stopped.data)); assert.equal(stopped.data.stopped.length, 1);
    assert.equal(await launched.closed, 2);
    assert.equal(running(phase.session.pid), false); assert.equal(running(reviewer), false); assert.equal(existsSync(checkout), false);
    assert.ok(!f.git(f.repo, "worktree", "list", "--porcelain").includes(checkout));
    assert.equal(f.cli("查询", file).data.batches[0].state, "failed");
    assert.equal(readJson<any>(phasePath(dir, null)).category, "已停止");
  } finally { await f.close(); }
});

test("第 2 条：没有独立组登记的共享终端进程，即使 PID/启动时间匹配也不结束", async () => {
  const f = fixture();
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  const started = processStartTime(child.pid!), closed = new Promise<void>((accept) => child.once("close", () => accept()));
  try {
    await withEnv(f.env, async () => {
      const file = join(f.repo, "batch.json"); writeFileSync(file, JSON.stringify({ name: "共享组", stages: { 甲: { cwd: f.repo, start: "fake" } } }));
      const info = batchInfo(file, f.repo);
      writePhase(info, "甲", "running", { session: { host: "pi", id: "shared", pid: child.pid, processStarted: started } });
      assert.equal(processGroup(child.pid!), processGroup(process.pid));
      const result = f.cli("停止", file);
      assert.equal(result.data.ok, false); assert.match(JSON.stringify(result.data.skipped), /独立进程组.*共享进程组/);
      assert.equal(processStartTime(child.pid!), started); assert.ok(running(child.pid!));
    });
  } finally {
    if (processStartTime(child.pid!) === started) child.kill("SIGTERM");
    await closed; await f.close();
  }
});

test("第 3 条：没有任何活动身份的只评审批次不能返回停止成功或写已停止事件", async () => {
  const f = fixture();
  try {
    const file = join(f.repo, "batch.json"); writeFileSync(file, JSON.stringify({ recipe: "review-only", review: { repo: f.repo, base: "HEAD", head: "HEAD" } }));
    // 模拟只有定位记录，没有实际运行/会话登记。
    const info = { project: f.repo, batch: { file, name: "只评审", recipe: "review-only" }, dir: join(f.home, ".pi-autoreview/pipelines/只评审"), stages: [] };
    recordBatchInfo(info);
    const before = snapshot(f.root), result = f.cli("停止", file);
    assert.equal(result.data.ok, false); assert.match(result.data.reason.text, /没有可核对的活动身份/); assert.deepEqual(snapshot(f.root), before);
  } finally { await f.close(); }
});

test("第三轮第 1 条：当前恢复组归属无法核对时，不能只看旧宿主退出就返回成功", async () => {
  const f = fixture();
  const original = spawn(process.execPath, ["-e", "setTimeout(()=>process.exit(),150)"], { stdio: "ignore" });
  const originalStarted = processStartTime(original.pid!), originalClosed = new Promise<void>((accept) => original.once("close", () => accept()));
  const owner = "stop-safety-real-recovery";
  let current: ChildProcess | undefined, started = "";
  try {
    await originalClosed;
    await withEnv(f.env, async () => {
      current = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore", env: { ...f.env, AUTOREVIEW_PROCESS_OWNER: owner } });
      started = processStartTime(current.pid!);
      const file = join(f.repo, "batch.json"), dir = join(f.root, "pipeline");
      writeFileSync(file, JSON.stringify({ name: "未知恢复组", dir, stages: { 甲: { cwd: f.repo, start: "不执行" } } }));
      const info = batchInfo(file, f.repo);
      writePhase(info, "甲", "running", { session: { host: "pi", id: "original", pid: original.pid, processStarted: originalStarted, runId: "old" } });
      writeFileSync(launchPath(dir, "甲"), JSON.stringify({ batchFile: file, stage: "甲", pid: current.pid, processStarted: started,
        token: "incorrect-owner", id: "new", runId: "new", active: true }));
      const result = f.cli("停止", file);
      assert.equal(result.data.ok, false); assert.equal(result.data.stopped.length, 0);
      assert.ok(result.data.skipped.some((item: any) => item.pid === current!.pid && /归属未确认/.test(item.reason)));
      assert.equal(processStartTime(current.pid!), started); assert.ok(running(current.pid!));
    });
  } finally {
    if (current) assert.equal(releaseProcessTree({ pgid: current.pid!, started, token: owner }), true);
    if (processStartTime(original.pid!) === originalStarted) original.kill("SIGTERM");
    await originalClosed; await f.close();
  }
});

for (const pendingHost of [false, true]) test(`第三轮第 1 条：原会话退出→队列恢复返修→${pendingHost ? "宿主尚未登记时" : "恢复同一 sessionId 后"}停止`, async () => {
  const f = fixture();
  let cleanup: { file: string; dir: string; queueRoot: string } | undefined;
  try {
    await withEnv(f.env, async () => {
      const gate = join(f.root, "gate.mjs"), pi = join(f.root, "fake-pi"), permission = join(f.root, "permission.ts");
      const resumeWait = join(f.root, "resume.wait"), resumePending = join(f.root, "resume.pending"), resumeArgs = join(f.root, "resume.args");
      writeFileSync(gate, `console.log('QUEUE_RETURN_SENTINEL file.txt:1'); process.exit(process.cwd().startsWith(${JSON.stringify(f.env.AUTOREVIEW_MERGE_QUEUE_ROOT)}) ? 1 : 0);\n`);
      writeFileSync(join(f.repo, ".autoreview.json"), JSON.stringify({ gate: { cmd: `${JSON.stringify(process.execPath)} ${JSON.stringify(gate)}`, timeoutMin: 1 } }));
      writeFileSync(join(f.repo, "prompt.md"), "替身开发任务\n");
      f.git(f.repo, "add", ".autoreview.json", "prompt.md"); f.git(f.repo, "commit", "-qm", "fixture gate and prompt");
      writeFileSync(permission, "");
      writeFileSync(pi, `#!/bin/sh\nresumed=0\nfor arg do [ "$arg" != "--session" ] || resumed=1; done\nif [ "$resumed" = 1 ] && [ "${pendingHost ? "yes" : "no"}" = yes ]; then\n  printf '%s\\n' "$@" > '${resumeArgs}'\n  printf pending > '${resumePending}'\n  while [ ! -f '${resumeWait}' ]; do sleep 0.05; done\nfi\n'${process.execPath}' '${FAKE}' "$@"\nprintf '不应在停止后继续执行'\n`);
      chmodSync(pi, 0o755);
      const hostEnv = { PI_BIN: pi, PERMISSION_EXTENSION: permission, AUTOREVIEW_MERGE_QUEUE_LAUNCHER: "background" };
      Object.assign(f.env, hostEnv); Object.assign(process.env, hostEnv);
      const config = join(f.home, ".pi/agent/extensions/pi-permission-system/config.json");
      mkdirSync(dirname(config), { recursive: true }); writeFileSync(config, '{"yoloMode":true}');
      const dev = join(f.root, "dev"), branch = "feat/session-recovery";
      f.git(f.repo, "worktree", "add", "-b", branch, dev);
      const file = join(f.repo, "batch.json"), dir = join(f.root, "pipeline");
      const raw = { name: "原会话恢复", branch, dir, stages: { 甲: { cwd: dev, prompt: join(f.repo, "prompt.md"), ponytail: false } }, steps: [["甲"]] };
      writeFileSync(file, JSON.stringify(raw));
      const plan = parsePlan(raw, f.repo, f.env, { batchFile: file, projectRoot: f.repo });
      registerQueueBatch(f.repo, { name: raw.name, file, dir, project: f.repo, release: "main", steps: raw.steps,
        stages: [{ ...plan.stages.get("甲")!, branch }] });
      cleanup = { file, dir, queueRoot: queueDir(f.repo) };
      const original = f.start("启动", file);
      const sessionFile = join(f.env.STOP_FIXTURE_DIR, "甲.session.json");
      await until(() => existsSync(sessionFile), original.output());
      const before = readJson<any>(sessionFile), originalGroup = readJson<BatchLaunch>(launchPath(dir, "甲"))!;
      assert.notEqual(before.pid, originalGroup.pid);
      writeFileSync(join(dev, "file.txt"), "checked candidate\n");
      const gatePass = spawnSync(process.execPath, [gate], { cwd: dev, env: f.env, encoding: "utf8" });
      assert.equal(gatePass.status, 0, gatePass.stderr);
      assert.equal(processStartTime(original.child.pid!), original.started); original.child.kill("SIGTERM");
      await original.closed;
      await until(() => !running(before.pid) && !running(originalGroup.pid), "原开发窗口及其组已经退出");
      const summary = join(f.env.STOP_FIXTURE_DIR, "甲.md");
      queueStageEvent({ cwd: dev, file, stage: "甲", status: { host: "pi", sessionId: before.id, pid: before.pid,
        processStarted: before.processStarted, runId: before.runId, event: "done", readyEpoch: "original-ready", inbox: 0, summary,
        candidate: workingTree(dev, f.root).tree, checks: { gate: "通过", review: "通过", acceptance: "未配置" } } });
      if (pendingHost) await until(() => existsSync(resumePending), "队列恢复命令已启动，宿主尚未更新 phase/status");
      else await until(() => {
        const current = readJson<any>(sessionFile);
        return current?.pid !== before.pid && current?.id === before.id && current?.inbox === 1;
      }, "队列真实恢复原会话并读取返修，不是整批验收编排恢复");
      await until(() => readMergeQueue(f.repo)?.entries[0]?.status === "returned", "失败门禁已经通过队列恢复入口退回");
      const active = readJson<BatchLaunch>(launchPath(dir, "甲"))!;
      assert.notEqual(active.runId, originalGroup.runId); assert.notEqual(active.pid, originalGroup.pid); assert.equal(active.active, true);
      const entry = readMergeQueue(f.repo)!.entries[0];
      assert.match(readFileSync(entry.log!, "utf8"), /QUEUE_RETURN_SENTINEL/);
      assert.equal(entry.deliveries?.[0].stage, "甲"); assert.equal(entry.deliveries?.[0].resumed, true);
      const args: string[] = pendingHost ? readFileSync(resumeArgs, "utf8").trim().split("\n") : readJson<any>(sessionFile).args;
      assert.equal(args[args.indexOf("--session") + 1], before.id, "恢复命令必须精确使用原 sessionId");
      assert.equal(args.some((arg) => arg.startsWith("@")), false, "不能重发原需求或另建会话");
      const resumed = readJson<any>(sessionFile);
      if (!pendingHost) {
        assert.equal(resumed.id, before.id); assert.notEqual(resumed.pid, before.pid);
        assert.notEqual(resumed.pid, active.pid, "必须覆盖宿主不是组长的正式恢复链");
        assert.equal(processGroup(resumed.pid), active.pid);
        assert.equal(readJson<any>(phasePath(dir, "甲")).session.runId, active.runId);
        assert.equal(readJson<any>(statusPath(dir, "甲")).runId, active.runId);
      }
      const head = f.git(dev, "rev-parse", "HEAD"), release = f.git(f.repo, "rev-parse", "main");
      const stopped = f.cli("停止", file); assert.equal(stopped.code, 0, JSON.stringify(stopped.data)); assert.equal(stopped.data.ok, true);
      await until(() => !running(active.pid) && (pendingHost || !running(resumed.pid)), `恢复出的独立组及宿主均已真实结束：${JSON.stringify({ active,
        stopped: stopped.data, owned: ownedProcessGroupAlive(active), started: processStartTime(active.pid), pgid: processGroup(active.pid) })}`);
      assert.equal(readMergeQueue(f.repo)!.entries[0].status, "stopped");
      assert.equal(readJson<any>(phasePath(dir, "甲")).category, "已停止");
      assert.equal(f.git(dev, "rev-parse", "HEAD"), head); assert.equal(f.git(dev, "branch", "--show-current"), branch);
      assert.equal(f.git(f.repo, "rev-parse", "main"), release); assert.ok(existsSync(dev)); assert.ok(existsSync(summary));
      if (pendingHost) {
        writeFileSync(resumeWait, "continue if still alive\n"); await sleep(150);
        assert.equal(readJson<any>(sessionFile).pid, before.pid, "已停止的恢复入口不能稍后启动宿主");
      }
    });
  } finally {
    if (cleanup) {
      const { file, dir, queueRoot } = cleanup;
      await withEnv(f.env, async () => {
        const state = readMergeQueue(f.repo), batch = state?.batches.find((item) => item.file === file);
        if (batch) for (const { path, proc } of stopQueueBatch(f.repo, batch).consumers) assert.equal(releaseProc(path, proc.pgid, proc), true);
        const active = readJson<BatchLaunch>(launchPath(dir, "甲"));
        if (active) assert.equal(releaseProcessTree({ pgid: active.pid, started: active.processStarted, token: active.token }), true);
        await until(() => !existsSync(join(queueRoot, "worker.lock")) && !readdirSync(queueRoot).some((name) => /^executor-.*\.json$/.test(name)),
          `本夹具队列执行器释放后再清理：${f.root}`, 20_000);
      });
    }
    await f.close();
  }
});

test("第二轮第 1 条：PA 派发占位不冒充活动 phase；并发编号拒绝，迟到失败不覆盖已取得运行权的身份", async () => {
  const f = fixture();
  let failLaunch: ((error: Error) => void) | undefined;
  let pending: Promise<Record<string, unknown>> | undefined;
  try {
    await withEnv(f.env, async () => {
      const file = join(f.repo, "batch.json"), dir = join(f.root, "pipeline");
      writeFileSync(file, JSON.stringify({ name: "PA派发", dir, stages: { 甲: { cwd: f.repo, start: "不执行" } } }));
      const info = batchInfo(file, f.repo);
      writePhase(info, null, "paused", { next: "resume" });
      const before = readFileSync(phasePath(dir, null), "utf8");
      let calls = 0;
      pending = resumeBatch({ info, id: "pending", launch: async () => {
        calls++; return new Promise<{ pid: number; processStarted: string }>((_accept, reject) => { failLaunch = reject; });
      } });
      assert.equal(calls, 1); assert.ok(existsSync(join(dir, "pa-starting.json")));
      assert.equal(readFileSync(phasePath(dir, null), "utf8"), before, "尚未取得运行权时不能写 pipeline-launch 占用活动 phase");
      const duplicate = await resumeBatch({ info, id: "other", launch: async () => assert.fail("派发期间不能再启动") });
      assert.equal(duplicate.state, "rejected");
      writePhase(info, null, "running", { session: { host: "pipeline", id: "actual", pid: process.pid,
        processStarted: processStartTime(process.pid), runId: "actual-owner" } });
      const active = readFileSync(phasePath(dir, null), "utf8");
      failLaunch!(new Error("派发失败")); assert.equal((await pending).state, "failed");
      assert.equal(readFileSync(phasePath(dir, null), "utf8"), active, "迟到的派发失败不能覆盖真正运行的编排");
    });
  } finally { failLaunch?.(new Error("测试收尾")); if (pending) await pending; await f.close(); }
});

test("第二轮第 1 条：活动编排重复启动被拒绝，不能覆盖持有运行权的组和 phase；原运行仍可停止", async () => {
  const f = fixture();
  try {
    await withEnv(f.env, async () => {
      const { file, dir } = registeredPipeline(f, `'${process.execPath}' '${FAKE}'; printf '不应执行'`);
      const first = f.start("启动", file, "--launcher", "background");
      await until(() => existsSync(join(f.env.STOP_FIXTURE_DIR, "甲.session.json")), first.output());
      const activePath = launchPath(dir, null), before = readFileSync(activePath, "utf8"), phaseBefore = readFileSync(phasePath(dir, null), "utf8");
      const active = readJson<BatchLaunch>(activePath)!;
      assert.equal(active.active, true); assert.ok(active.runId);
      const queue = readMergeQueue(f.repo)!;
      assert.equal(active.runId, readJson<any>(join(queue.dir, `integration-${queue.batches[0].id}.lock`)).token);
      assert.equal(readJson<any>(phasePath(dir, null)).session.runId, active.runId);
      const duplicate = f.start("启动", file, "--launcher", "background");
      assert.notEqual(await duplicate.closed, 0, duplicate.output());
      assert.equal(readFileSync(activePath, "utf8"), before, "未取得运行权的候选不能覆盖活动组");
      assert.equal(readFileSync(phasePath(dir, null), "utf8"), phaseBefore, "拒绝入口不能覆盖活动 phase");
      assert.ok(running(active.pid));
      const stopped = f.cli("停止", file); assert.equal(stopped.code, 0, JSON.stringify(stopped.data));
      await until(() => !running(active.pid), "原活动编排须真实结束"); await first.closed;
      assert.equal(existsSync(join(f.env.STOP_FIXTURE_DIR, "乙.session.json")), false);
    });
  } finally { await f.close(); }
});

for (const via of ["pa", "queue"] as const) test(`第二轮第 1 条：启动→暂停→${via === "pa" ? "loop 续跑" : "队列恢复入口"}→停止，活动登记绑定新代次`, async () => {
  const f = fixture();
  let recovery: Promise<unknown> | undefined;
  try {
    Object.assign(f.env, { AUTOREVIEW_ACCEPTANCE_CMD: join(ROOT, "test/fake-tester.mjs") });
    await withEnv(f.env, async () => {
      const flag = join(f.root, "resume.flag"), entered = join(f.root, "resumed"), criteria = join(f.root, "criteria.md");
      writeFileSync(criteria, "## 验收标准\nA1. [甲] 操作：执行命令\n    预期：成功\n");
      const prepare = `if [ ! -f ${JSON.stringify(flag)} ]; then echo AUTOREVIEW_FAILURE=environment; exit 75; fi; echo resumed > ${JSON.stringify(entered)}; while :; do sleep 1; done`;
      const { file, dir, dev } = registeredPipeline(f, `'${process.execPath}' '${join(ROOT, "test/fake-stage.mjs")}'`,
        { prepare, acceptance: { workDir: f.repo, criteria, timeoutMin: 1 } });
      const first = f.start("启动", file, "--launcher", "background");
      assert.notEqual(await first.closed, 0, first.output());
      assert.equal(readJson<any>(phasePath(dir, null)).next, "resume");
      const original = readJson<BatchLaunch>(launchPath(dir, null))!;
      assert.equal(original.active, false); assert.equal(running(original.pid), false);
      writeFileSync(flag, "resume\n");
      if (via === "pa") {
        const receipt = f.cli("续跑", file, "--id", "resume-for-stop");
        assert.equal(receipt.code, 0, JSON.stringify(receipt.data)); assert.equal(receipt.data.state, "started");
      } else {
        // 与 merge-queue 的恢复入口相同：受管 createChildExec 启动 pipeline --from 验收。
        recovery = createChildExec(join(f.root, "recovery.procs.json"))(process.execPath,
          [join(ROOT, "pipeline.ts"), file, "--from", "验收", "--project-root", f.repo, "--default-workspace", "dev分支"],
          { cwd: dev, env: f.env, timeout: 30_000, role: "队列返修后整合编排" });
      }
      await until(() => existsSync(entered), "续跑编排进入可取消的准备命令");
      const active = readJson<BatchLaunch>(launchPath(dir, null))!, phase = readJson<any>(phasePath(dir, null));
      assert.notEqual(active.runId, original.runId); assert.notEqual(active.pid, original.pid); assert.equal(active.active, true);
      assert.equal(phase.session.pid, active.pid); assert.equal(phase.session.runId, active.runId);
      const queue = readMergeQueue(f.repo)!;
      assert.equal(active.runId, readJson<any>(join(queue.dir, `integration-${queue.batches[0].id}.lock`)).token);
      const stopped = f.cli("停止", file); assert.equal(stopped.code, 0, JSON.stringify(stopped.data));
      await until(() => !running(active.pid), "停止必须结束新编排，不是只处理旧启动登记");
      if (recovery) await recovery;
      assert.equal(readJson<any>(phasePath(dir, null)).category, "已停止");
    });
  } finally { await f.close(); if (recovery) await recovery; }
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) test(`第二轮第 2 条：向 loop 启动发送 ${signal}，等待只评审失败报告、worktree 和进程释放`, async () => {
  const f = fixture();
  try {
    const file = join(f.repo, "batch.json"), reviewerDir = join(f.root, "reviewer");
    writeFileSync(file, JSON.stringify({ recipe: "review-only", review: { repo: f.repo, base: "HEAD", head: "HEAD" } }));
    Object.assign(f.env, { AUTOREVIEW_REVIEWER_CMD: join(ROOT, "test/fake-reviewer.mjs"), FAKE_SLEEP_SECONDS: "60", FAKE_STATE_DIR: reviewerDir });
    const launched = f.start("启动", file);
    await until(() => existsSync(join(reviewerDir, "reviewer.pid")), launched.output());
    const reviewer = Number(readFileSync(join(reviewerDir, "reviewer.pid"), "utf8")), checkout = readFileSync(join(reviewerDir, "reviewer.cwd"), "utf8");
    const dir = join(f.home, ".pi-autoreview/pipelines/只评审"), active = readJson<BatchLaunch>(launchPath(dir, null))!;
    assert.equal(processStartTime(launched.child.pid!), launched.started); launched.child.kill(signal);
    assert.equal(await launched.closed, 2, launched.output());
    const result = JSON.parse(launched.output());
    assert.equal(result.exitCode, 2); assert.match(readFileSync(result.report, "utf8"), /评审失败/);
    assert.equal(readJson<any>(result.reportJson).exitCode, 2);
    assert.equal(running(active.pid), false); assert.equal(running(reviewer), false); assert.equal(existsSync(checkout), false);
    assert.ok(!f.git(f.repo, "worktree", "list", "--porcelain").includes(checkout));
    assert.equal(readJson<BatchLaunch>(launchPath(dir, null))!.active, false);
    assert.equal(readJson<any>(phasePath(dir, null)).status, "failed");
  } finally { await f.close(); }
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) test(`第二轮第 2 条：向 loop 启动发送 ${signal}，取消实际编排、不再派发并保留原开发窗口`, async () => {
  const f = fixture();
  try {
    const file = join(f.repo, "batch.json"), dir = join(f.root, "pipeline"), start = `'${process.execPath}' '${FAKE}'; printf '不应执行'`;
    writeFileSync(file, JSON.stringify({ name: "前台取消", dir, stages: { 甲: { cwd: f.repo, start }, 乙: { cwd: f.repo, start } }, steps: [["甲"], ["乙"]] }));
    const launched = f.start("启动", file, "--launcher", "background");
    await until(() => existsSync(join(f.env.STOP_FIXTURE_DIR, "甲.session.json")), launched.output());
    const active = readJson<BatchLaunch>(launchPath(dir, null))!, session = readJson<any>(join(f.env.STOP_FIXTURE_DIR, "甲.session.json"));
    assert.equal(processStartTime(launched.child.pid!), launched.started); launched.child.kill(signal);
    assert.notEqual(await launched.closed, 0, launched.output());
    assert.equal(running(active.pid), false); assert.equal(readFileSync(join(dir, "pipeline.finished"), "utf8").trim(), "2");
    assert.match(readFileSync(join(dir, "report.md"), "utf8"), /取消/);
    assert.equal(existsSync(join(f.env.STOP_FIXTURE_DIR, "乙.session.json")), false);
    assert.ok(running(session.pid), "取消编排沿用保留开发会话的约定，不扩大到别的独立组");
    const stopped = f.cli("停止", file); assert.equal(stopped.code, 0, JSON.stringify(stopped.data));
    await until(() => !running(session.pid), "释放本测试保留的开发会话后再删除夹具");
  } finally { await f.close(); }
});

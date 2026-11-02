/** 配方 A1–A7：临时仓库、替身评审/会话；不触碰真实 HOME、远端或用户材料。 */
import "./test-env.ts";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { createChildExec } from "../hosts/review-hook.ts";
import { parsePlan } from "../pipeline.ts";
import { queueDir, queueStageEvent, readMergeQueue, registerQueueBatch } from "../merge-queue.ts";
import { writePhase, type BatchInfo } from "../events.ts";
import { writeStageStatus } from "../pipeline-core.ts";
import { processStartTime, registerProc, releaseProcessTree, stopSessionGroup } from "../procs.ts";
import { createRunResource } from "../resources.ts";
import { runReviewOnly } from "../review-only.ts";
import { newReviewState, runReviewRound } from "../review.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FAKE = join(ROOT, "test/fake-reviewer.mjs");
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "loop-recipes-"))), repo = join(root, "repo"), home = join(root, "home");
  mkdirSync(repo); mkdirSync(home);
  const env = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    LOOP_PA_CONFIG: join(root, "pa.json"), AUTOREVIEW_MERGE_QUEUE_ROOT: join(root, "queues"), AUTOREVIEW_RESOURCE_ROOT: join(root, "resources"), AUTOREVIEW_PROJECTS_ROOT: join(root, "projects"),
    AUTOREVIEW_REVIEWER_CMD: FAKE, FAKE_MODE: "report", FAKE_STATE_DIR: join(root, "fake") };
  writeFileSync(env.LOOP_PA_CONFIG, JSON.stringify({ pa: { eventsDir: join(root, "events"), localNotify: false } }));
  const git = (cwd: string, ...args: string[]) => { const result = spawnSync("git", args, { cwd, env, encoding: "utf8" }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  git(repo, "init", "-q", "-b", "main"); git(repo, "config", "user.email", "test@example.com"); git(repo, "config", "user.name", "test");
  writeFileSync(join(repo, "file.txt"), "base\n");
  writeFileSync(join(repo, ".autoreview.json"), JSON.stringify({ gate: { cmd: "exit 99" }, acceptance: { start: "exit 99" }, preparation: { check: "exit 99" } }));
  git(repo, "add", "."); git(repo, "commit", "-qm", "base"); const base = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "file.txt"), "candidate\n"); git(repo, "commit", "-am", "candidate"); const head = git(repo, "rev-parse", "HEAD");
  const cli = (...args: string[]) => {
    const result = spawnSync(process.execPath, [join(ROOT, "loop.ts"), ...args, "--json"], { cwd: repo, env, encoding: "utf8", timeout: 90_000 });
    assert.ok(result.stdout.trim(), result.stderr); return { code: result.status, data: JSON.parse(result.stdout), stderr: result.stderr };
  };
  const close = () => rmSync(root, { recursive: true, force: true });
  return { root, repo, home, env, base, head, git, cli, close };
}
async function withEnv<T>(env: NodeJS.ProcessEnv, fn: () => Promise<T> | T): Promise<T> {
  const old = { ...process.env };
  try { Object.assign(process.env, env); return await fn(); }
  finally { for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key]; Object.assign(process.env, old); }
}
const events = (root: string): any[] => readdirSync(join(root, "events")).flatMap((file) => readFileSync(join(root, "events", file), "utf8").trim().split("\n").map((line) => JSON.parse(line)));
function checkReport(f: ReturnType<typeof fixture>, data: any) {
  const json = JSON.parse(readFileSync(data.reportJson, "utf8")), markdown = readFileSync(data.report, "utf8");
  assert.equal(json.baseline, f.base); assert.equal(json.candidate, f.head);
  assert.equal(json.mustFix.length, 1); assert.deepEqual(json.suggestions, ["补充命令说明", "改善报错文案"]);
  assert.match(json.mustFix[0], /触发条件：传入空字符串[\s\S]*后果：返回成功但数据丢失/);
  for (const value of [...json.mustFix, ...json.suggestions]) assert.ok(markdown.replace(/\s+/g, " ").includes(value.replace(/\s+/g, " ")));
  assert.deepEqual(json.files, ["file.txt"]); assert.equal(json.model, "openai-codex/gpt-6-astra"); assert.ok(json.durationMs > 0);
  const cwd = readFileSync(join(f.root, "fake/reviewer.cwd"), "utf8");
  assert.equal(existsSync(cwd), false); assert.ok(!f.git(f.repo, "worktree", "list", "--porcelain").includes(cwd));
  assert.equal(existsSync(join(f.home, ".pi-autoreview/交付记录.md")), false);
  assert.equal(existsSync(join(f.root, "queues")), false);
  const walk = (path: string): string[] => readdirSync(path, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(join(path, entry.name)) : [entry.name]);
  assert.ok(!walk(f.home).some((file) => file.endsWith(".inbox.json")));
}

test("A1 CLI 只评审：报告保留 1 必修/2 建议，脏原工作区不变，无开发交付副作用", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.repo, "file.txt"), "dirty original\n"); f.git(f.repo, "add", "file.txt");
    writeFileSync(join(f.repo, "untracked.txt"), "keep\n");
    const before = f.git(f.repo, "status", "--porcelain=v1"), index = f.git(f.repo, "write-tree");
    const requirement = join(f.root, "need.md"), criteria = join(f.root, "criteria.md"), note = join(f.root, "note.md");
    writeFileSync(requirement, "需求原文\n"); writeFileSync(criteria, "## 验收标准\nA1. 操作：传入空字符串\n    预期：拒绝\n"); writeFileSync(note, "交付说明原文\n");
    const { code, data } = f.cli("评审", "--base", f.base, "--head", f.head, "--requirement", requirement, "--criteria", criteria, "--note", note);
    assert.equal(code, 1); checkReport(f, data);
    assert.equal(f.git(f.repo, "status", "--porcelain=v1"), before); assert.equal(f.git(f.repo, "write-tree"), index);
    assert.equal(readFileSync(join(f.repo, "file.txt"), "utf8"), "dirty original\n");
    const input = readFileSync(join(dirname(data.report), readdirSync(dirname(data.report)).find((file) => file.startsWith("review-input-"))!), "utf8");
    for (const text of ["需求原文", "交付说明原文", "拒绝", "candidate"]) assert.ok(input.includes(text));
    assert.deepEqual(events(f.root).map((event) => event.status), ["started", "done"]);
  } finally { f.close(); }
});

test("A2 recipe review-only 不需开工：启动产生 started/done 和报告；重复评审不吞 done", () => {
  const f = fixture();
  try {
    const batch = join(f.root, "批次.json");
    writeFileSync(batch, JSON.stringify({ recipe: "review-only", review: { repo: "repo", base: f.base, head: f.head } }));
    for (let i = 0; i < 2; i += 1) { const run = f.cli("启动", batch); assert.equal(run.code, 1); checkReport(f, run.data); }
    const list = events(f.root); assert.deepEqual(list.map((event) => event.status), ["started", "done", "started", "done"]);
    for (const event of list) assert.equal(event.batch.recipe, "review-only");
    for (const event of list.filter((event) => event.status === "done")) { assert.equal(event.detail.recipe, "review-only"); assert.ok(existsSync(event.detail.report)); }
  } finally { f.close(); }
});

test("A3 替身真实超时：复用预算/释放，退出 2，失败报告和 failed 事件", async () => {
  const f = fixture();
  try {
    await withEnv({ ...f.env, FAKE_SLEEP_SECONDS: "60" }, async () => {
      let clock = 0;
      const run = await runReviewOnly({ repo: f.repo, base: f.base, head: f.head }, {
        now: () => clock,
        callReviewer: async (session, round, _timeout, input) => {
          const result = await createChildExec()(FAKE, [String(round), input, session], { cwd: f.repo, timeout: 100, role: "评审" });
          clock += 60 * 60_000;
          assert.equal(result.killed, true); assert.equal(result.processesReleased, true); return result;
        },
      });
      assert.equal(run.exitCode, 2); assert.equal(run.ok, false); assert.match(readFileSync(String(run.report), "utf8"), /评审失败[\s\S]*超时/);
      assert.equal(f.git(f.repo, "worktree", "list", "--porcelain").split("worktree ").length, 2);
      assert.deepEqual(events(f.root).map((event) => event.status), ["started", "failed"]);
    });
  } finally { f.close(); }
});

test("可捕获中断也写失败报告并释放临时检出", async () => {
  const f = fixture();
  const child = spawn(process.execPath, [join(ROOT, "loop.ts"), "评审", "--base", f.base, "--head", f.head, "--json"], { cwd: f.repo, env: { ...f.env, FAKE_SLEEP_SECONDS: "60" }, detached: true });
  const started = processStartTime(child.pid!);
  let output = "", error = "";
  child.stdout!.on("data", (data) => { output += data; }); child.stderr!.on("data", (data) => { error += data; });
  const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
  try {
    const deadline = Date.now() + 10_000;
    while (!existsSync(join(f.root, "fake/reviewer.pid")) && Date.now() < deadline) await sleep(25);
    assert.ok(existsSync(join(f.root, "fake/reviewer.pid")), error);
    assert.equal(processStartTime(child.pid!), started); child.kill("SIGHUP");
    assert.equal(await closed, 2, error);
    const data = JSON.parse(output); assert.equal(data.exitCode, 2); assert.ok(existsSync(data.report));
    assert.equal(f.git(f.repo, "worktree", "list", "--porcelain").split("worktree ").length, 2);
  } finally { releaseProcessTree({ pgid: child.pid!, started }); f.close(); }
});

test("组长已退出但孤儿组仍在：不假称停止，也不凭旧 PID 杀组", async () => {
  const f = fixture(), marker = join(f.root, "orphan.pid"), token = `recipes-${f.base}`;
  const code = `const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); require('node:fs').writeFileSync(${JSON.stringify(marker)},String(c.pid)); setTimeout(()=>process.exit(),100);`;
  const child = spawn(process.execPath, ["-e", code], { detached: true, stdio: "ignore", env: { ...f.env, AUTOREVIEW_PROCESS_OWNER: token } });
  const started = processStartTime(child.pid!);
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  try {
    await closed;
    const result = await stopSessionGroup({ pid: child.pid, processStarted: started });
    assert.equal(result.stopped, false); assert.match(result.reason!, /组长已退出/);
    assert.ok(processStartTime(Number(readFileSync(marker, "utf8"))));
  } finally { assert.equal(releaseProcessTree({ pgid: child.pid!, started, token }), true); f.close(); }
});

test("A4 未知 recipe 退出 3 并列合法值；A7 缺省仍是 develop", () => {
  const f = fixture();
  try {
    const batch = join(f.root, "batch.json"); writeFileSync(batch, '{"recipe":"foo"}');
    const run = f.cli("启动", batch); assert.equal(run.code, 3); assert.match(run.data.error, /develop.*review-only/);
    const plan = parsePlan({ name: "dev", stages: { 甲: { start: "true" } } }, f.repo);
    assert.equal(plan.recipe, "develop"); assert.equal(plan.stages.size, 1); assert.deepEqual(plan.steps, [["甲"]]);
    f.env.FAKE_MODE = "pass";
    assert.equal(f.cli("评审", "--base", f.base, "--head", f.head).code, 0);
    f.env.FAKE_MODE = "fail";
    assert.equal(f.cli("评审", "--base", f.base, "--head", f.head).code, 2);
    assert.equal(f.git(f.repo, "worktree", "list", "--porcelain").split("worktree ").length, 2);
  } finally { f.close(); }
});

test("sink report 有/无必修均返回报告，不写总结、不返修、不跑方法、不记复发", async () => {
  const f = fixture();
  try {
    for (const fixes of [true, false]) await withEnv(f.env, async () => {
      const state = newReviewState(); state.baseline = f.base;
      const outcome = await runReviewRound({ sink: "report", cwd: f.repo, devSessionId: "report-sink", round: 1, state, deliveryNote: "",
        config: { maxRepairs: 0, reviewerModel: "m", reviewerThinking: "xhigh", reviewTimeoutMin: 60, reviewerCmd: "", gate: { cmd: "exit 99", timeoutMin: 1 } },
        exec: createChildExec(), env: {}, writeInput: (name, text) => { const path = join(f.root, name); writeFileSync(path, text); return path; }, saveState: () => {},
        writeSummary: async () => { assert.fail("report 不走开发总结"); }, callReviewer: async () => ({ code: 0, killed: false, stderr: "", stdout: `## 结论：通过\n## 必修\n${fixes ? "1. 触发：空输入；后果：数据丢失" : "无"}\n## 小问题\n- 无\n## 需求疑问\n- 无\n## 上轮必修复查\n- 无\n` }),
      });
      assert.equal(outcome.kind, "report"); assert.equal(outcome.review?.mustFix.length, fixes ? 1 : 0); assert.ok(outcome.record);
      assert.equal(state.repairs, 0); assert.equal(state.awaitingRepair, undefined); assert.equal(existsSync(join(f.root, "projects")), false);
    });
  } finally { f.close(); }
});

test("A5 停止核对身份的会话及登记消费者；同名身份不符不碰，保留工作区/分支/总结/证据", async () => {
  const f = fixture(), children: { child: ChildProcess; started: string }[] = [];
  try {
    await withEnv(f.env, async () => {
      const dev = join(f.root, "dev"); f.git(f.repo, "worktree", "add", "-b", "feat/stop", dev);
      const file = join(f.repo, "batch.json"), dir = join(f.root, "pipeline");
      writeFileSync(file, JSON.stringify({ name: "stop", branch: "feat/stop", dir, stages: { 甲: { cwd: dev, start: "fake" }, 乙: { cwd: dev, start: "fake" } } }));
      registerQueueBatch(f.repo, { name: "stop", file, dir, project: f.repo, release: "main", stages: [{ name: "甲", cwd: dev, branch: "feat/stop", start: "fake" }, { name: "乙", cwd: dev, branch: "feat/stop", start: "fake" }], steps: [["甲", "乙"]] });
      const state = readMergeQueue(f.repo)!;
      state.entries.push({ id: "stop-entry", batch: state.batches[0].id, name: "stop", order: 1, status: "pending", qualification: [], sources: [], attempt: 0, createdAt: "now", updatedAt: "now" });
      writeFileSync(join(queueDir(f.repo), "queue.json"), JSON.stringify(state));
      const info: BatchInfo = { project: f.repo, batch: { file, name: "stop", recipe: "develop" }, dir, stages: [{ stage: "甲", cwd: dev }, { stage: "乙", cwd: dev }] };
      for (const stage of ["甲", "乙"]) {
        const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
        const started = processStartTime(child.pid!); children.push({ child, started });
        const summary = join(f.root, `${stage}.md`); writeFileSync(summary, "保留总结和证据\n");
        const session = { host: "pi", id: stage, pid: child.pid, processStarted: stage === "甲" ? started : "wrong-start" };
        writeStageStatus({ dir, stage }, { host: "pi", sessionId: stage, pid: child.pid, processStarted: session.processStarted, event: "started", summary, inbox: 0 });
        writePhase(info, stage, "running", { session, evidence: { summary } });
      }
      const consumer = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
      children.push({ child: consumer, started: processStartTime(consumer.pid!) });
      const procs = join(f.root, "甲.procs.json"), resource = createRunResource("stop-test", 0, procs);
      registerProc(procs, consumer.pid!, "替身评审", process.execPath, undefined, resource.id);
      const preview = f.cli("停止", file, "--dry-run"); assert.equal(preview.data.dryRun, true);
      assert.equal(processStartTime(children[0].child.pid!), children[0].started); assert.equal(readMergeQueue(f.repo)!.entries[0].status, "pending");
      const outside = join(f.root, "outside-batch.json"); writeFileSync(outside, readFileSync(file));
      const unregistered = f.cli("停止", outside); assert.equal(unregistered.data.ok, false, "未登记复制品不能只凭名称/分支认领状态目录");
      assert.equal(readMergeQueue(f.repo)!.entries[0].status, "pending");
      assert.equal(processStartTime(children[0].child.pid!), children[0].started);
      const alias = join(dev, "batch.json"); writeFileSync(alias, readFileSync(file));
      const run = f.cli("停止", alias); assert.equal(run.code, 1, "已登记 worktree 的同位置别名可以停止；不匹配项不能伪装全部成功");
      assert.equal(run.data.v, 1); assert.equal(run.data.action, "停止"); assert.equal(run.data.reason.category, "已停止");
      assert.equal(run.data.stopped.length, 1); assert.ok(run.data.skipped.some((entry: any) => entry.session?.id === "乙"));
      for (const index of [0, 2]) {
        const ps = spawnSync("ps", ["-o", "stat=", "-p", String(children[index].child.pid)], { encoding: "utf8" });
        assert.ok(!ps.stdout.trim() || ps.stdout.trim().startsWith("Z"), "核对成功的会话及消费者已退出");
      }
      assert.equal(processStartTime(children[1].child.pid!), children[1].started); assert.equal(existsSync(resource.dir), false);
      assert.equal(readMergeQueue(f.repo)!.entries[0].status, "stopped"); assert.equal(readMergeQueue(f.repo)!.batches[0].stopped, true);
      assert.ok(existsSync(dev)); assert.equal(f.git(dev, "branch", "--show-current"), "feat/stop");
      assert.equal(readFileSync(join(f.root, "甲.md"), "utf8"), "保留总结和证据\n");
      assert.ok(events(f.root).some((event) => event.status === "failed" && event.reason.category === "已停止"));
      // 迟到完成不能把用户停止改成可合入。
      queueStageEvent({ cwd: dev, file, stage: "甲", status: { sessionId: "甲", event: "done", readyEpoch: "late", summary: join(f.root, "甲.md"), inbox: 0 } });
      assert.equal(readMergeQueue(f.repo)!.entries[0].status, "stopped");
      const oneStage = f.cli("停止", alias, "--stage", "甲"); assert.equal(oneStage.code, 0); assert.equal(oneStage.data.ok, true);
      assert.equal(processStartTime(children[1].child.pid!), children[1].started, "指定段不碰其他段");
    });
  } finally {
    for (const { child, started } of children) { releaseProcessTree({ pgid: child.pid!, started }); await sleep(20); }
    f.close();
  }
});

test("A6 JSON 外壳：合入/推送参数与执行失败也有固定字段和原因", () => {
  const f = fixture();
  try {
    for (const command of ["合入", "推送"]) for (const args of [[], [join(f.root, "missing.json")], ["--bad"]]) {
      const run = f.cli(command, ...args), data = run.data;
      assert.equal(data.v, 1); assert.equal(data.action, command); assert.equal(data.ok, false);
      for (const key of command === "合入" ? ["release", "merged", "queueStatus"] : ["branch", "remote", "pushed"]) assert.ok(key in data);
      assert.equal(typeof data.reason.category, "string"); assert.ok(data.reason.text);
    }
  } finally { f.close(); }
});

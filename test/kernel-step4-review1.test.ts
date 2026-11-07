/** 第一次独立评审反例：复用内核夹具，真实临时 Git/进程/宿主，模型均为替身。 */
import "./test-env.ts";
import "./helpers/git-runtime.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fakeKernelLauncher, kernelFixture, reviewer, PASS } from "./helpers/kernel-fixture.ts";
import { completeManagedDelivery, deployManaged, mergeManaged, reviewManaged } from "../kernel-session.ts";
import { createKernelRun, executeNode, queryKernel } from "../kernel.ts";
import { kernelCLI } from "../kernel-cli.ts";
import { launchKernel, releaseKernelWorkspace, resumeManaged, stopKernel } from "../kernel-runtime.ts";
import { readRun, readTaskRun } from "../node-ledger.ts";
import { submitCandidate } from "../submission-node.ts";
import { ownedProcessGroupAlive, readProcs } from "../procs.ts";
import { consumerProblem, readLocalQueue } from "../local-node-queue.ts";
import { createChildExec } from "../hosts/review-hook.ts";
import { handleKernelHook } from "../hosts/kernel-hook.ts";
import type { Exec } from "../git.ts";
import { acquireProjectExecution } from "../project-execution.ts";
import { harness as piHarness } from "./helpers/autoreview-fixture.ts";

const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
const BIN = fileURLToPath(new URL("../bin/loop", import.meta.url));
async function until(check: () => unknown, label: string, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (!check()) { if (Date.now() >= deadline) throw new Error(`屏障未到：${label}`); await sleep(20); }
}
function deployFixture(multi = false) {
  const f = kernelFixture(["开发评审", ...(multi ? ["测试", "验收"] : []), "提交", "部署"]);
  const marker = join(f.repo, ".autoreview.json"), output = join(f.root, "deployed.jsonl"), allow = join(f.root, "allow");
  const config: any = { release: "dev", localFiles: ["local.txt"], acceptance: { reset: "printf reset", cleanup: "printf released" },
    deployment: { enabled: true, timeoutMin: 1, cmd: `printf '%s\\n' "$AUTOREVIEW_DEPLOY_COMMIT" >> ${quote(output)}; test -e ${quote(allow)}`, check: "exit 0" } };
  if (multi) {
    f.card.tasks = ["甲", "乙"].map((name) => ({ name, prompt: "prompt.md", scope: [`${name}.txt`], test: "printf ok" })); f.card.acceptance = "标准.md";
    for (const t of f.card.tasks) writeFileSync(join(f.repo, `${t.name}.txt`), "base\n");
    writeFileSync(join(f.repo, "标准.md"), "## 验收标准\nA1. [甲] 操作：执行甲\n    预期：正确\nA2. [乙] 操作：执行乙\n    预期：正确\n");
    Object.assign(process.env, { AUTOREVIEW_ACCEPTANCE_CMD: fileURLToPath(new URL("./fake-tester.mjs", import.meta.url)), FAKE_ACC_MODE: "pass", FAKE_ACC_RESULTS: "[]", FAKE_ACC_FAIL: "", FAKE_ACC_FAIL_ONCE: "", FAKE_ACC_UNKNOWN: "", FAKE_STATE_DIR: join(f.root, "tester") });
  }
  writeFileSync(marker, JSON.stringify(config)); writeFileSync(f.file, JSON.stringify(f.card));
  if (multi) { f.git(f.repo, "add", "."); f.git(f.repo, "commit", "-qm", "review1 fixture"); }
  return { ...f, marker, config, output, allow };
}
async function publish(f: ReturnType<typeof deployFixture>) {
  const path = f.start(); f.candidate(path);
  await executeNode(path, "开发评审", async (input) => {
    const evidence = join(input.evidenceDir, "static.md"); writeFileSync(evidence, PASS);
    return { status: "通过", evidence: [evidence], operations: [], released: true };
  });
  assert.equal((await executeNode(path, "提交", submitCandidate)).status, "通过"); return path;
}
async function settle(f: ReturnType<typeof kernelFixture>, path?: string) {
  if (path && existsSync(path)) {
    await stopKernel(path);
    await until(() => [readRun(path!), ...(readRun(path!).taskRecords ?? [])].every((r) => [r.launch, r.supervisor, r.worker].every((g) => !g || ownedProcessGroupAlive(g) === false)), "本夹具已登记消费者结束");
    for (const a of readRun(path).deploymentAttempts ?? []) assert.equal(consumerProblem(a.procs), undefined);
    const evidence = process.env.LOOP_STEP4_REVIEW1_EVIDENCE;
    if (evidence) {
      const run = readRun(path), to = join(evidence, run.id); mkdirSync(to, { recursive: true }); cpSync(join(f.root, "kernel/runs"), join(to, "runs"), { recursive: true });
      for (const file of ["deployed.jsonl", "reviewer-started.json", "barrier"]) if (existsSync(join(f.root, file))) cpSync(join(f.root, file), join(to, file), { recursive: true });
      if (existsSync(join(run.common, "loop-project-execution.json"))) cpSync(join(run.common, "loop-project-execution.json"), join(to, "project-execution.json"));
      writeFileSync(join(to, "release-proof.json"), JSON.stringify({ run: run.id, root: f.root, release: run.release, groups: [run, ...(run.taskRecords ?? [])].flatMap((r) => [r.launch, r.supervisor, r.worker].filter(Boolean)).map((g) => ({ ...g, alive: ownedProcessGroupAlive(g!) })), procs: (run.deploymentAttempts ?? []).map((a) => ({ path: a.procs, problem: consumerProblem(a.procs) ?? null })) }, null, 2));
    }
  }
  f.cleanup();
}

test("第1条：cmd 部分副作用后失败，Pi/Hook 重复回调和普通续跑不重做，只有明确重跑部署可重试", async (t) => {
  for (const host of ["pi", "claude", "codex"]) await t.test(host, async () => {
    const f = deployFixture(); let path: string | undefined;
    try {
      if (host === "pi") {
        fakeKernelLauncher(f); process.env.KERNEL_FAKE_REPEAT_SETTLE = "1";
        const cli = spawnSync(BIN, ["启动", f.file, "--json"], { cwd: f.repo, env: process.env, encoding: "utf8" }); assert.equal(cli.status, 0, cli.stdout + cli.stderr);
        path = JSON.parse(cli.stdout).ledger;
        await until(() => readRun(path!).release.status === "已释放", "失败部署及 Pi 回调收尾");
        await until(() => readRun(path!).taskRecords?.every((r) => !r.supervisor || ownedProcessGroupAlive(r.supervisor) === false) ?? (!readRun(path!).supervisor || ownedProcessGroupAlive(readRun(path!).supervisor!) === false), "Pi supervisor 已退出");
      } else {
        path = await publish(f); const run = readRun(path);
        Object.assign(process.env, { AUTOREVIEW_KERNEL_LEDGER: path, AUTOREVIEW_KERNEL_RUN: run.id, AUTOREVIEW_DEV_ROOT: run.worktree, AUTOREVIEW_HOST: host });
        const event = { hook_event_name: "Stop", cwd: run.worktree, session_id: `original-${host}`, last_assistant_message: "【交付完成】" };
        await handleKernelHook(event); await handleKernelHook(event);
      }
      let run = readRun(path!); assert.equal(run.deploymentAttempts!.length, 1, "失败终态不能被重复回调重做");
      assert.equal(readFileSync(f.output, "utf8").trim().split("\n").length, 1); assert.equal(run.deploymentAttempts![0].category, "command");
      const publication = structuredClone(run.publication), checks = run.results.filter((r) => r.node !== "部署");
      await mergeManaged(path!); await resumeManaged(path!); await deployManaged(path!);
      assert.equal(readRun(path!).deploymentAttempts!.length, 1, "合入/续跑/自动接续不授权失败重试");
      for (const k of ["AUTOREVIEW_KERNEL_LEDGER", "AUTOREVIEW_KERNEL_RUN", "AUTOREVIEW_DEV_ROOT", "AUTOREVIEW_HOST"]) delete process.env[k];
      writeFileSync(f.allow, "explicit retry");
      await kernelCLI({ command: "重跑", batch: f.file, node: "部署", dryRun: false, json: true, rest: [] }, f.repo);
      await until(() => readRun(path!).deploymentAttempts?.at(-1)?.status === "succeeded" && !readRun(path!).workerRequest, "明确重跑的后台部署成功");
      run = readRun(path!); assert.equal(run.deploymentAttempts!.length, 2); assert.equal(run.deploymentAttempts![1].retryOf, run.deploymentAttempts![0].id); assert.deepEqual(run.publication, publication); assert.deepEqual(run.results.filter((r) => r.node !== "部署"), checks);
      assert.equal(readFileSync(f.output, "utf8").trim().split("\n").length, 2);
    } finally { await settle(f, path); }
  });
});

test("第2条：多任务真实 Pi 宿主承载批次部署，进程屏障跨过监督器轮询后仍存活，完成才释放", async () => {
  const f = deployFixture(true); let path: string | undefined;
  const barrier = join(f.root, "barrier"), gate = join(barrier, "deploy.go"), ready = join(barrier, "deploy.started"), crossed = join(barrier, "deploy.crossed"); mkdirSync(barrier);
  try {
    const script = join(f.root, "deploy-barrier.mjs");
    writeFileSync(script, `import {existsSync,writeFileSync,appendFileSync} from 'node:fs';\nconst [ready,crossed,gate,output]=process.argv.slice(2);writeFileSync(ready,JSON.stringify({pid:process.pid,at:Date.now()}));\nconst checkpoint=setTimeout(()=>writeFileSync(crossed,JSON.stringify({pid:process.pid,at:Date.now()})),1500);\nwhile(!existsSync(gate)) await new Promise(r=>setTimeout(r,20));clearTimeout(checkpoint);appendFileSync(output,process.env.AUTOREVIEW_DEPLOY_COMMIT+'\\n');\n`);
    f.config.deployment.cmd = [process.execPath, script, ready, crossed, gate, f.output].map(quote).join(" "); writeFileSync(f.marker, JSON.stringify(f.config));
    fakeKernelLauncher(f); process.env.KERNEL_FAKE_BARRIER = barrier; process.env.FAKE_STATE_DIR = join(f.root, "tester");
    path = f.start(); await launchKernel(path, true);
    await until(() => ["甲", "乙"].every((n) => existsSync(join(barrier, `${n}.started`))), "两个原宿主已登记");
    writeFileSync(join(barrier, "乙.go"), "go"); await until(() => readRun(path!).batch!.contributions.length === 1, "乙先汇入");
    writeFileSync(join(barrier, "甲.go"), "go"); await until(() => existsSync(crossed), "部署进程越过监督器轮询屏障");
    const run = readRun(path!), a = run.activity!; assert.equal(a.node, "部署"); assert.equal(run.publication!.push, "成功");
    assert.equal(run.taskRecords!.every((r) => !r.activity), true, "批次部署不登记成任务活动");
    const carrier = run.taskRecords!.find((r) => r.session?.pid === a.pid)!; assert.ok(carrier, "执行 PID 绑定具体原宿主");
    assert.equal(ownedProcessGroupAlive(carrier.launch!), true, "监督器不能提前终止部署载体"); assert.equal(ownedProcessGroupAlive(carrier.supervisor!), true);
    assert.equal(readProcs(run.deploymentAttempts![0].procs).some((r) => r.pgid === JSON.parse(readFileSync(crossed, "utf8")).pid), true);
    assert.equal(existsSync(carrier.worktree), true); assert.equal(readLocalQueue().items.length, 0);
    writeFileSync(gate, "go"); await until(() => readRun(path!).release.status === "已释放", "部署成功后释放全部空间");
    const after = readRun(path!); assert.equal(after.deploymentAttempts![0].status, "succeeded"); assert.equal(after.deploymentAttempts![0].calls.length, 2);
    assert.equal(after.results.filter((r) => r.node === "提交").length, 1); assert.equal(after.results.filter((r) => r.node === "验收").length, 1);
    assert.equal(f.git(f.origin, "rev-parse", "dev"), after.publication!.commit);
  } finally { writeFileSync(gate, "go"); await settle(f, path); }
});

test("第3条：评审程序不存在可有界失败；释放未知立即停重试，保留阻塞租约和真实报告", async (t) => {
  for (const kind of ["missing", "unknown-result", "unknown-throw"]) await t.test(kind, async () => {
    const f = kernelFixture(); let path: string | undefined;
    const controller = new AbortController(); let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 3500);
    try {
      const head = f.git(f.repo, "rev-parse", "HEAD");
      writeFileSync(f.file, JSON.stringify({ version: 1, name: "只评审失败", nature: "评审", flow: ["评审"], tasks: [{ name: "报告" }], review: { base: head, head } }));
      const model = join(f.root, "reviewer.mjs"), started = join(f.root, "reviewer-started.json");
      if (kind !== "missing") writeFileSync(model, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(started)},JSON.stringify({pid:process.pid}));console.error('fixture reviewer actually started');process.exitCode=1;\n`, { mode: 0o755 });
      process.env.AUTOREVIEW_REVIEWER_CMD = kind === "missing" ? join(f.root, "missing-reviewer") : model; path = createKernelRun(f.file, f.repo).path;
      const real = createChildExec(join(readRun(path).dir, "review.procs.json")); let calls = 0;
      const exec: Exec = async (cmd, args, options) => {
        if (options.role === "评审") calls++;
        const result = await real(cmd, args, options);
        if (options.role === "评审" && kind !== "missing") {
          assert.equal(result.processesReleased, true, "夹具真实消费者已收尾，再模拟丢失证明"); assert.equal(result.processStarted, true);
          if (kind === "unknown-result") return { ...result, processesReleased: false };
          throw new Error("fixture call failed without release proof");
        }
        return result;
      };
      const result = await reviewManaged(path, { signal: controller.signal, exec }); clearTimeout(timer);
      assert.equal(timedOut, false, "不能无限等待自己留下的 blocked 租约"); assert.equal(result.status, "没验证");
      const run = readRun(path), report = JSON.parse(readFileSync(run.reviewReport!.json, "utf8")); assert.equal(report.status, "没验证"); assert.equal(report.released, kind === "missing");
      assert.equal(calls, kind === "missing" ? 2 : 1, "明确未启动才允许有界调用重试；未知消费者不得重试");
      const leases = JSON.parse(readFileSync(join(run.common, "loop-project-execution.json"), "utf8"));
      if (kind === "missing") {
        assert.deepEqual(leases, []); assert.equal(existsSync(started), false);
        const call = JSON.parse(readFileSync(report.evidence.find((p: string) => p.endsWith("call-1.json")), "utf8")); assert.equal(call.processStarted, false); assert.equal(call.processesReleased, true); assert.match(call.stderr, /ENOENT/);
        await releaseKernelWorkspace(path); assert.equal(readRun(path).release.status, "已释放"); assert.match(readFileSync(run.reviewReport!.report, "utf8"), /没验证/);
      } else {
        assert.ok(leases.some((l: any) => l.blocked)); assert.equal(existsSync(started), true); assert.equal(run.release.status, "未确认"); assert.equal(existsSync(run.worktree), true); assert.equal(run.results.length, 1);
        await assert.rejects(acquireProjectExecution(run.worktree, "check", join(run.dir, "next.procs.json"), AbortSignal.timeout(1000)), /释放未确认/);
        assert.deepEqual(JSON.parse(readFileSync(join(run.common, "loop-project-execution.json"), "utf8")), leases, "不能删除未知租约制造恢复");
      }
    } finally { clearTimeout(timer); controller.abort(); await settle(f, path); }
  });
});

test("第3条兼容：Pi 内存替身仍保留显式释放失败，不能用夹具默认值洗白", async () => {
  const old = process.env.AUTOREVIEW_SINGLE_NODE; process.env.AUTOREVIEW_SINGLE_NODE = "1";
  const h = piHarness();
  try {
    h.reviewer = () => ({ stdout: PASS, stderr: "fixture release unknown", code: 0, killed: false, processesReleased: false });
    await h.event("session_start"); await h.begin(); h.write("file.txt", "change\n"); h.assistant(); await h.event("agent_settled"); await h.terminal();
    assert.equal(h.state().phase, "paused"); assert.equal(h.state().repairs, 0); assert.equal(h.inputs.length, 1);
    assert.match(h.summary(), /释放未确认/);
  } finally { await h.close(); if (old === undefined) delete process.env.AUTOREVIEW_SINGLE_NODE; else process.env.AUTOREVIEW_SINGLE_NODE = old; }
});

test("第4条：含测试的多任务卡发布后普通续跑及仅重跑部署不读任务返修状态，不重做检查或推送", async () => {
  const f = deployFixture(true); let path: string | undefined;
  try {
    const pushed = join(f.root, "pushes.log"); writeFileSync(join(f.origin, "hooks/pre-receive"), `#!/bin/sh\ncat >> ${quote(pushed)}\n`, { mode: 0o755 });
    path = f.start();
    for (const name of ["乙", "甲"]) { const task = readTaskRun(path, name); writeFileSync(join(task.worktree, `${name}.txt`), `${name} change\n`); await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: reviewer, task: task.taskId }); }
    const before = readRun(path); assert.equal(before.publication!.push, "成功"); assert.equal(before.deploymentAttempts!.at(-1)!.status, "failed"); assert.equal(before.results.filter((r) => r.node === "测试").length, 2);
    const checks = before.results.filter((r) => r.node !== "部署"), publication = structuredClone(before.publication), tasks = before.taskRecords!.map((r) => ({ id: r.id, candidate: r.candidate, repairs: r.repairs, counters: r.counters }));
    const errors: string[] = []; writeFileSync(f.allow, "explicit retry");
    try { await resumeManaged(path); } catch (e) { errors.push(`续跑: ${String(e)}`); }
    assert.equal(readRun(path).deploymentAttempts!.length, 1, "普通续跑不重做失败部署");
    try { await resumeManaged(path, false, "部署"); } catch (e) { errors.push(`重跑部署: ${String(e)}`); }
    assert.deepEqual(errors, [], "批次级发布后路径不能调用 taskDefinition(batch)");
    assert.equal(readRun(path).deploymentAttempts!.at(-1)!.status, "succeeded");
    await resumeManaged(path); await resumeManaged(path, false, "部署");
    const after = readRun(path); assert.equal(after.deploymentAttempts!.length, 2); assert.deepEqual(after.results.filter((r) => r.node !== "部署"), checks); assert.deepEqual(after.publication, publication);
    assert.deepEqual(after.taskRecords!.map((r) => ({ id: r.id, candidate: r.candidate, repairs: r.repairs, counters: r.counters })), tasks);
    assert.equal(readFileSync(pushed, "utf8").trim().split("\n").length, 1); assert.equal(after.release.status, "已释放"); assert.equal(queryKernel(path).status, "已合入");
  } finally { await settle(f, path); }
});

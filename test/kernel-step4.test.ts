import "./test-env.ts";
import "./helpers/git-runtime.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { createChildExec } from "../hosts/review-hook.ts";
import { handleKernelHook } from "../hosts/kernel-hook.ts";
import { staticReviewer } from "../static-review.ts";
import { submitCandidate } from "../submission-node.ts";
import { ownedProcessGroupAlive, readProcs } from "../procs.ts";
import { consumerProblem, readLocalQueue } from "../local-node-queue.ts";
import type { Exec } from "../git.ts";
import { readDevelopmentCard } from "../development-card.ts";
import { deliverCandidate } from "../kernel-workspace.ts";
import { createKernelRun, executeNode, queryKernel } from "../kernel.ts";
import { completeManagedDelivery, deployManaged, mergeManaged, reviewManaged } from "../kernel-session.ts";
import { readRun, updateRun } from "../node-ledger.ts";
import { checkInputs } from "../kernel-workspace.ts";
import { launchKernel, releaseKernelWorkspace, resumeManaged, stopKernel } from "../kernel-runtime.ts";
import { kernelCLI } from "../kernel-cli.ts";
import { requestCardChange } from "../kernel-controls.ts";
import { fakeKernelLauncher, kernelFixture, reviewer, PASS } from "./helpers/kernel-fixture.ts";

const quote = (text: string) => `'${text.replace(/'/g, "'\\''")}'`;
function deployFixture(cmd?: string, check = "exit 0", flow = ["开发评审", "提交", "部署"]) {
  const f = kernelFixture(flow), marker = join(f.repo, ".autoreview.json"), output = join(f.root, "deployed.jsonl");
  const config = JSON.parse(readFileSync(marker, "utf8"));
  config.deployment = { enabled: true, cmd: cmd ?? `printf '%s\\n' "$AUTOREVIEW_DEPLOY_COMMIT" >> ${quote(output)}`, check, timeoutMin: 1 };
  writeFileSync(marker, JSON.stringify(config));
  return { ...f, marker, config, output };
}
async function until(predicate: () => unknown, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error(`屏障未到：${label}`); await sleep(20); }
}
async function publish(f: ReturnType<typeof deployFixture>): Promise<string> {
  const path = f.start(); f.candidate(path);
  await executeNode(path, "开发评审", async (input) => {
    const evidence = join(input.evidenceDir, "fake-static.md"); writeFileSync(evidence, PASS);
    return { status: "通过", evidence: [evidence], operations: ["隔离静态替身"], released: true };
  });
  const result = await executeNode(path, "提交", submitCandidate); assert.equal(result.status, "通过", result.reason ?? ""); return path;
}
function barrier(f: ReturnType<typeof kernelFixture>) {
  const script = join(f.root, "barrier.mjs"), events = join(f.root, "events.jsonl");
  writeFileSync(script, `import {writeFileSync,appendFileSync,existsSync} from 'node:fs';\nconst [label,gate,ready,events]=process.argv.slice(2);\nappendFileSync(events,JSON.stringify({label,phase:'start',pid:process.pid})+'\\n');writeFileSync(ready,String(process.pid));\nwhile(gate!=='none'&&!existsSync(gate)) await new Promise(r=>setTimeout(r,10));\nappendFileSync(events,JSON.stringify({label,phase:'end',pid:process.pid})+'\\n');\nconsole.log(${JSON.stringify(PASS)});\n`);
  return { script, events, command: (label: string, gate: string, ready: string) => [process.execPath, script, label, gate, ready, events].map(quote).join(" ") };
}
function reviewFixture() {
  const f = kernelFixture(), base = f.git(f.repo, "rev-parse", "HEAD");
  writeFileSync(join(f.repo, "file.txt"), "existing commit\n"); f.git(f.repo, "add", "file.txt"); f.git(f.repo, "commit", "-qm", "existing");
  f.git(f.repo, "branch", "review-head");
  const head = f.git(f.repo, "rev-parse", "HEAD");
  const card = { version: 1, name: "只评审", nature: "评审", flow: ["评审"], review: { base, head: "review-head", requirement: "prompt.md" }, tasks: [{ name: "报告" }] };
  writeFileSync(f.file, JSON.stringify(card));
  return { ...f, base, head, card };
}

test("A12/A16 卡与配置在资源前拒绝；只评审无需 prompt/scope/dev 目标", () => {
  const f = deployFixture();
  try {
    const refs = f.git(f.repo, "show-ref"), works = f.git(f.repo, "worktree", "list", "--porcelain");
    const cases = [
      [{ ...f.card, flow: ["开发评审", "部署"] }, /部署必须位于提交之后/],
      [{ ...f.card, nature: "评审", flow: ["评审", "提交"] }, /只评审卡只能/],
      [{ version: 1, name: "评审", nature: "评审", flow: ["评审"], tasks: [{ name: "甲" }, { name: "乙" }], review: { base: "dev", head: "dev" } }, /限定单任务/],
      [{ version: 1, name: "评审", nature: "评审", flow: ["评审"], tasks: [{ name: "甲" }], review: { base: "missing", head: "dev" } }, /本地已有提交/],
      [{ ...f.card, nature: "测试", flow: ["测试"] }, /必须包含/],
    ] as const;
    for (const [card, error] of cases) { writeFileSync(f.file, JSON.stringify(card)); assert.throws(f.start, error); }
    writeFileSync(f.file, JSON.stringify(f.card));
    for (const deployment of [undefined, { enabled: false }, { enabled: true, cmd: "exit 0" }, { enabled: true, cmd: "exit 0", check: "exit 0", timeoutMin: 0 }]) {
      writeFileSync(f.marker, JSON.stringify({ ...f.config, deployment })); assert.throws(f.start, /deployment|部署/);
    }
    assert.equal(f.git(f.repo, "show-ref"), refs); assert.equal(f.git(f.repo, "worktree", "list", "--porcelain"), works);
    assert.equal(existsSync(join(f.root, "kernel")), false);
  } finally { f.cleanup(); }
  const r = reviewFixture();
  try { const dry = createKernelRun(r.file, r.repo, true); assert.equal(dry.run, undefined); assert.match(dry.lines.join("\n"), /只评审/); assert.doesNotMatch(dry.lines.join("\n"), /目标 dev|批次分支/); assert.equal(existsSync(join(r.root, "kernel")), false); }
  finally { r.cleanup(); }
});

test("A11 发布实际压缩提交→cmd/check 一次；CLI/续跑复用，不重复前置或推送，释放空间", async () => {
  const f = deployFixture();
  try {
    const path = f.start(), before = readRun(path); let calls = 0;
    writeFileSync(join(before.worktree, "file.txt"), "ready\n");
    await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: async () => { calls++; return reviewer(); } });
    let run = readRun(path), d = run.deploymentAttempts!.at(-1)!;
    assert.equal(run.publication!.push, "成功"); assert.equal(d.status, "succeeded", d.reason ?? "");
    assert.notEqual(run.publication!.commit, run.candidate!.commit); assert.equal(run.publication!.tree, run.candidate!.tree);
    assert.equal(f.git(f.origin, "rev-parse", "dev"), run.publication!.commit);
    assert.equal(readFileSync(f.output, "utf8").trim(), run.publication!.commit);
    assert.deepEqual(d.calls.map((c) => [c.phase, c.commit, c.released]), [["deploying", run.publication!.commit, true], ["checking", run.publication!.commit, true]]);
    await releaseKernelWorkspace(path); assert.equal(readRun(path).release.status, "已释放"); assert.equal(existsSync(before.worktree), false);
    await resumeManaged(path); await mergeManaged(path);
    run = readRun(path); assert.equal(run.deploymentAttempts!.length, 1); assert.equal(calls, 1);
    assert.equal(run.results.filter((r) => r.node === "提交").length, 1); assert.equal(run.results.filter((r) => r.node === "部署").length, 1);
    assert.equal(queryKernel(path).status, "已合入"); assert.equal(queryKernel(path).deployment.status, "succeeded");
  } finally { f.cleanup(); }
});

test("A12 项目启用但卡未安排不部署；推送失败保留本地事实且不重推/部署", async (t) => {
  for (const failPush of [false, true]) await t.test(String(failPush), async () => {
    const f = deployFixture(undefined, "exit 0", failPush ? ["开发评审", "提交", "部署"] : ["开发评审", "提交"]);
    try {
      if (failPush) writeFileSync(join(f.origin, "hooks/pre-receive"), "#!/bin/sh\necho refused-for-test >&2\nexit 1\n", { mode: 0o755 });
      const path = f.start(); writeFileSync(join(readRun(path).worktree, "file.txt"), "done\n");
      await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: reviewer });
      assert.equal(readRun(path).publication!.local, "merged"); assert.equal(readRun(path).publication!.push, failPush ? "失败" : "成功");
      assert.equal(readRun(path).deploymentAttempts?.length ?? 0, 0); assert.equal(existsSync(f.output), false);
      await resumeManaged(path); assert.equal(existsSync(f.output), false);
      if (failPush) assert.match(queryKernel(path).reason, /refused-for-test/);
      else assert.match(queryKernel(path).checks.join("\n"), /部署：没验证（本次未安排）/);
    } finally { f.cleanup(); }
  });
});

test("A13 cmd 失败只停部署；仅重跑部署不重新评审/发布", async () => {
  const f = deployFixture();
  try {
    const flag = join(f.root, "allow"); f.config.deployment.cmd = `test -e ${quote(flag)} && printf '%s\\n' "$AUTOREVIEW_DEPLOY_COMMIT" >> ${quote(f.output)}`;
    writeFileSync(f.marker, JSON.stringify(f.config)); const path = f.start();
    writeFileSync(join(readRun(path).worktree, "file.txt"), "done\n");
    await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: reviewer });
    const before = readRun(path); assert.equal(before.deploymentAttempts![0].status, "failed"); assert.equal(before.deploymentAttempts![0].rollback, undefined);
    await releaseKernelWorkspace(path); writeFileSync(flag, "yes");
    await resumeManaged(path, false, "部署"); const after = readRun(path);
    assert.equal(after.deploymentAttempts!.at(-1)!.status, "succeeded"); assert.equal(after.results.filter((r) => r.node === "开发评审").length, 1);
    assert.equal(after.results.filter((r) => r.node === "提交").length, 1); assert.deepEqual(after.publication, before.publication); assert.equal(after.repairs, 0);
  } finally { f.cleanup(); }
});

test("A13 check 失败只回退本地并重新部署上一版；恢复失败如实记账；不重发旧发布", async (t) => {
  for (const recoveryFail of [false, true]) await t.test(String(recoveryFail), async () => {
    const f = deployFixture(undefined, "exit 1");
    try {
      const base = f.git(f.repo, "rev-parse", "HEAD");
      if (recoveryFail) { f.config.deployment.cmd = `test "$AUTOREVIEW_DEPLOY_COMMIT" != ${quote(base)}`; writeFileSync(f.marker, JSON.stringify(f.config)); }
      const path = f.start(); writeFileSync(join(readRun(path).worktree, "file.txt"), "done\n");
      await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: reviewer });
      const run = readRun(path), attempt = run.deploymentAttempts![0];
      assert.equal(attempt.status, recoveryFail ? "failed" : "rolled-back", attempt.reason ?? "");
      assert.equal(f.git(f.repo, "rev-parse", "dev"), base); assert.equal(f.git(f.origin, "rev-parse", "dev"), run.publication!.commit);
      assert.equal(run.publication!.local, "merged"); assert.equal(run.publication!.push, "成功");
      assert.equal(run.results.find((r) => r.node === "提交")!.status, "通过"); assert.equal(run.results.find((r) => r.node === "开发评审")!.status, "通过");
      assert.deepEqual(attempt.calls.map((c) => c.phase), ["deploying", "checking", "redeploying"]);
      assert.match(queryKernel(path).lines.join("\n"), /远端仍是|远端（本次推送记录）/);
      await assert.rejects(resumeManaged(path, false, "部署"), /已不在本批发布/); assert.equal(readRun(path).deploymentAttempts!.length, 1);
      assert.equal(f.git(f.repo, "rev-parse", "dev"), base);
    } finally { f.cleanup(); }
  });
});

test("A15/A16 只评审固定已有 base/head：通过/必须修改/失败，只产报告且原工作区/索引不变", async (t) => {
  for (const output of [PASS, "## 结论：需返修\n## 必修\n1. 必须修改：触发 X 导致 Y\n## 小问题\n- 可延期\n", "bad format"]) await t.test(output.slice(0, 20), async () => {
    const f = reviewFixture();
    try {
      writeFileSync(join(f.repo, "file.txt"), "staged\n"); f.git(f.repo, "add", "file.txt"); writeFileSync(join(f.repo, "file.txt"), "unstaged\n"); writeFileSync(join(f.repo, "untracked.txt"), "do not touch\n");
      const index = f.git(f.repo, "rev-parse", "--path-format=absolute", "--git-path", "index"), bytes = readFileSync(index), refs = f.git(f.repo, "show-ref");
      const path = f.start(), before = readRun(path); assert.equal(before.candidate!.commit, f.head); assert.equal(before.session, undefined);
      f.git(f.repo, "branch", "-f", "review-head", f.base);
      let calls = 0;
      const result = await reviewManaged(path, { exec: f.exec, callReviewer: async () => { calls++; return { stdout: output, stderr: "", code: 0, killed: false, processesReleased: true }; } });
      assert.equal(result.status, output === PASS ? "通过" : output === "bad format" ? "没验证" : "不通过");
      await releaseKernelWorkspace(path); const run = readRun(path), q = queryKernel(path);
      assert.equal(run.release.status, "已释放"); assert.equal(existsSync(before.worktree), false); assert.equal(run.repair, undefined); assert.equal(run.repairs, 0); assert.equal(run.publication, undefined);
      assert.equal(run.results.every((r) => r.node === "评审"), true); assert.equal(run.reviewComparison!.head.commit, f.head);
      assert.equal(q.status, "等你决定"); assert.match(q.reason, /只评审已结束/); assert.equal(q.externalMerge, null);
      assert.deepEqual(readFileSync(index), bytes); assert.equal(readFileSync(join(f.repo, "file.txt"), "utf8"), "unstaged\n"); assert.equal(readFileSync(join(f.repo, "untracked.txt"), "utf8"), "do not touch\n");
      assert.equal(f.git(f.repo, "show-ref").replace(new RegExp(f.base + " refs/heads/review-head"), f.head + " refs/heads/review-head"), refs);
      const report = JSON.parse(readFileSync(run.reviewReport!.json, "utf8")); assert.equal(report.baseline, f.base); assert.equal(report.candidate, f.head); assert.equal(report.status, result.status);
      if (output.includes("可延期")) assert.deepEqual(report.suggestions, ["可延期"]);
      await assert.rejects(mergeManaged(path), /只评审/); await assert.rejects(mergeManaged(path, { accept: true }), /只评审/);
      await assert.rejects(kernelCLI({ command: "合入", batch: f.file, acceptUnverified: true, json: true, dryRun: false, rest: [] }, f.repo), /只评审/);
      if (output === PASS) { await resumeManaged(path, false, "评审"); assert.equal(readRun(path).results.length, 1); assert.equal(calls, 1); }
      assert.throws(() => requestCardChange(path, { from: f.replacement((c) => c.review.head = f.base), source: "cli:automation" }), /受评|任务身份/);
    } finally { f.cleanup(); }
  });
});

test("第四步 README 示例与 CLI 帮助由实际卡解析器核对", () => {
  const f = kernelFixture();
  try {
    const text = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8").split("## Claude Code / Codex 用法")[0];
    const examples = [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => JSON.parse(m[1])).filter((c) => c.version === 1);
    assert.equal(examples.length, 2);
    const directory = join(f.repo, "docs/batches/示例"), prompts = join(f.repo, "docs/prompt"); mkdirSync(directory, { recursive: true }); mkdirSync(prompts, { recursive: true });
    writeFileSync(join(prompts, "提示词-小改动.md"), "# 示例任务\n"); writeFileSync(join(prompts, "需求-示例.md"), "# 示例需求\n");
    writeFileSync(join(directory, "标准.md"), "## 验收标准\nA1. 操作：看改动\n    预期：符合需求\n"); writeFileSync(join(directory, "说明.md"), "# 交付说明\n");
    f.git(f.repo, "add", "."); f.git(f.repo, "commit", "-qm", "example input");
    for (const example of examples) { const path = join(directory, "开发卡.json"); writeFileSync(path, JSON.stringify(example)); assert.equal(readDevelopmentCard(path, f.repo).card.nature, example.nature); }
    const bin = fileURLToPath(new URL("../bin/loop", import.meta.url)), help = spawnSync(bin, ["帮助"], { cwd: f.repo, env: process.env, encoding: "utf8" });
    assert.equal(help.status, 2); assert.match(help.stderr, /评审\|测试\|验收\|部署/); assert.match(help.stderr, /review.base\/head/); assert.match(help.stderr, /limits.评审.timeoutMin/);
  } finally { f.cleanup(); }
});

test("A13 回退中已登记的部署方法版本变化可归一化，实际重新执行上一版方法", async () => {
  const f = deployFixture(undefined, "exit 1");
  try {
    f.config.methods = { paths: ["deploy.sh"] }; f.config.deployment.cmd = "sh deploy.sh";
    const script = (version: string) => `printf '${version}:%s\\n' \"$AUTOREVIEW_DEPLOY_COMMIT\" >> ${quote(f.output)}\n`;
    writeFileSync(join(f.repo, "deploy.sh"), script("old")); writeFileSync(f.marker, JSON.stringify(f.config));
    f.card.tasks[0].scope.push("deploy.sh"); writeFileSync(f.file, JSON.stringify(f.card)); f.git(f.repo, "add", "."); f.git(f.repo, "commit", "-qm", "deployment method");
    const path = f.start(); writeFileSync(join(readRun(path).worktree, "file.txt"), "new tree\n"); writeFileSync(join(readRun(path).worktree, "deploy.sh"), script("new"));
    updateRun(path, (r) => { r.candidate = deliverCandidate(r); });
    await executeNode(path, "开发评审", async (i) => { const evidence = join(i.evidenceDir, "static.md"); writeFileSync(evidence, PASS); return { status: "通过", evidence: [evidence], operations: [], released: true }; });
    await executeNode(path, "提交", submitCandidate); const result = await deployManaged(path);
    const run = readRun(path), d = run.deploymentAttempts![0]; assert.equal(d.status, "rolled-back", d.reason ?? ""); assert.equal(result.status, "不通过");
    assert.deepEqual(readFileSync(f.output, "utf8").trim().split("\n"), [`new:${run.publication!.commit}`, `old:${run.publication!.targetBefore}`]);
    assert.equal(run.results.find((r) => r.node === "部署")!.status, "不通过"); assert.equal(run.release.status, "已释放");
  } finally { f.cleanup(); }
});

test("A15 只评审取证失败但进程已确认释放，不伪造未知消费者或开发返修", async () => {
  const f = reviewFixture();
  try {
    const path = f.start(), run = readRun(path); let calls = 0;
    const output = await reviewManaged(path, { exec: async () => ({ stdout: "", stderr: "fixture Git read failure", code: 1, killed: false, processesReleased: true }),
      callReviewer: async () => { calls++; return reviewer(); } });
    assert.equal(output.status, "没验证"); assert.equal(output.released, true); assert.equal(calls, 0);
    await releaseKernelWorkspace(path); assert.equal(readRun(path).release.status, "已释放"); assert.equal(existsSync(run.worktree), false);
    assert.equal(readRun(path).repair, undefined); assert.match(readFileSync(readRun(path).reviewReport!.report, "utf8"), /没验证/);
  } finally { f.cleanup(); }
});

test("A15 只评审缺少消费者释放证明，即使登记为空也保留现场，不允许停止洗白后盲重跑", async () => {
  const f = reviewFixture();
  try {
    const path = f.start(), run = readRun(path);
    const result = await reviewManaged(path, { exec: f.exec, callReviewer: async () => ({ stdout: PASS, stderr: "", code: 0, killed: false, processesReleased: false }) });
    assert.equal(result.status, "没验证"); assert.equal(result.released, false);
    await releaseKernelWorkspace(path); assert.equal(readRun(path).release.status, "未确认"); assert.equal(existsSync(run.worktree), true);
    const stopped = await stopKernel(path); assert.equal(stopped.ok, false); assert.equal(readRun(path).release.status, "未确认");
    await assert.rejects(resumeManaged(path, false, "评审"), /资源释放未确认/);
    assert.equal(readRun(path).results.length, 1); assert.equal(readRun(path).results[0].released, false);
  } finally { f.cleanup(); }
});

test("A16 只评审拒绝检出目录被换成同树其他提交，不调用评审器", async () => {
  const f = reviewFixture();
  try {
    const path = f.start(), run = readRun(path), other = f.git(f.repo, "commit-tree", run.candidate!.tree, "-p", f.head, "-m", "same tree other commit");
    f.git(run.worktree, "update-ref", "HEAD", other, f.head);
    let calls = 0; await assert.rejects(reviewManaged(path, { exec: f.exec, callReviewer: async () => { calls++; return reviewer(); } }), /HEAD 已改变|固定 head/);
    assert.equal(calls, 0); assert.equal(readRun(path).results.length, 0); assert.equal(queryKernel(path).externalMerge, null);
  } finally { f.cleanup(); }
});

test("A17 CLI 只评审不需 dev/开发宿主；查询不迁移，重跑复用同一报告", async () => {
  const f = reviewFixture(); let path: string | undefined;
  try {
    f.git(f.repo, "branch", "-m", "dev", "existing-main");
    const script = join(f.root, "reviewer.mjs"); writeFileSync(script, `#!${process.execPath}\nconsole.log(${JSON.stringify(PASS)});\n`, { mode: 0o755 });
    process.env.AUTOREVIEW_REVIEWER_CMD = script;
    const bin = fileURLToPath(new URL("../bin/loop", import.meta.url));
    const start = spawnSync(bin, ["启动", f.file, "--json"], { cwd: f.repo, env: process.env, encoding: "utf8" }); assert.equal(start.status, 0, start.stdout + start.stderr);
    path = JSON.parse(start.stdout).ledger; assert.ok(path); const worker = readRun(path).worker;
    await until(() => readRun(path!).release.status === "已释放" && !readRun(path!).workerRequest, "只评审 worker 收尾");
    if (worker) await until(() => ownedProcessGroupAlive(worker) === false, "只评审 worker 退出");
    const run = readRun(path!), before = readFileSync(path!, "utf8"); assert.equal(run.session, undefined); assert.equal(run.branch, ""); assert.equal(run.publication, undefined);
    const query = spawnSync(bin, ["查询", f.file, "--json"], { cwd: f.repo, env: process.env, encoding: "utf8" }); const result = JSON.parse(query.stdout);
    assert.equal(result.status, "等你决定"); assert.match(result.reason, /只评审已结束/); assert.equal(result.reviewValid, true); assert.equal(readFileSync(path!, "utf8"), before);
    const rerun = spawnSync(bin, ["重跑", f.file, "--node", "评审", "--json"], { cwd: f.repo, env: process.env, encoding: "utf8" }); assert.equal(rerun.status, 0, rerun.stdout + rerun.stderr);
    assert.equal(readRun(path!).results.length, 1); assert.equal(readRun(path!).reviewReport!.attempt, run.reviewReport!.attempt);
  } finally { if (path) await stopKernel(path); f.cleanup(); }
});

test("A17 Pi 真入口替身及 Claude/Codex 已发布 Stop 均接续部署，重复回调不重复执行", async (t) => {
  await t.test("Pi", async () => {
    const f = deployFixture(); let path: string | undefined;
    try {
      fakeKernelLauncher(f); process.env.KERNEL_FAKE_REPEAT_SETTLE = "1";
      const bin = fileURLToPath(new URL("../bin/loop", import.meta.url));
      const start = spawnSync(bin, ["启动", f.file, "--launcher", "background", "--json"], { cwd: f.repo, env: process.env, encoding: "utf8" }); assert.equal(start.status, 0, start.stdout + start.stderr);
      path = JSON.parse(start.stdout).ledger; await until(() => readRun(path!).release.status === "已释放", "Pi 发布/部署/释放");
      const run = readRun(path!);
      if (run.supervisor) { const supervisor = run.supervisor; await until(() => ownedProcessGroupAlive(supervisor) === false, "Pi supervisor 退出"); }
      if (run.launch) assert.equal(ownedProcessGroupAlive(run.launch), false);
      assert.equal(run.publication!.push, "成功"); assert.equal(run.deploymentAttempts!.length, 1); assert.equal(run.deploymentAttempts![0].calls.length, 2);
      assert.equal(run.results.filter((r) => r.node === "开发评审").length, 1); assert.equal(run.results.filter((r) => r.node === "提交").length, 1);
    } finally { if (path) await stopKernel(path); f.cleanup(); }
  });
  for (const host of ["claude", "codex"]) await t.test(host, async () => {
    const f = deployFixture();
    try {
      const path = await publish(f), run = readRun(path);
      Object.assign(process.env, { AUTOREVIEW_KERNEL_LEDGER: path, AUTOREVIEW_KERNEL_RUN: run.id, AUTOREVIEW_DEV_ROOT: run.worktree, AUTOREVIEW_HOST: host });
      const event = { cwd: run.worktree, session_id: `original-${host}`, hook_event_name: "Stop", last_assistant_message: "【交付完成】" };
      const first = await handleKernelHook(event); assert.match(first!, /已合入/);
      const second = await handleKernelHook(event); assert.match(second!, /已合入/);
      const after = readRun(path); assert.equal(after.deploymentAttempts!.length, 1); assert.equal(after.deploymentAttempts![0].calls.length, 2); assert.equal(after.release.status, "已释放");
      assert.equal(queryKernel(path).status, "已合入");
    } finally { f.cleanup(); }
  });
});

test("A14 真实进程屏障：部署与共享静态检查双向互斥，不占本机测试槽", async () => {
  const f = deployFixture(); let deployment: Promise<unknown> | undefined, checking: Promise<unknown> | undefined;
  const gate = join(f.root, "release"), ready = join(f.root, "ready"), checkReady = join(f.root, "check-ready");
  try {
    const b = barrier(f); f.config.deployment.cmd = b.command("deploy", gate, ready); writeFileSync(f.marker, JSON.stringify(f.config));
    const path = await publish(f), run = readRun(path), checkProcs = join(f.root, "check.procs.json");
    // 先有真实检查消费者，部署只能等待。
    const firstGate = join(f.root, "first-gate"), firstReady = join(f.root, "first-ready");
    const call = staticReviewer({ cwd: run.worktree, procsFile: checkProcs, config: { reviewerModel: "fake", reviewerThinking: "", reviewerCmd: "unused" },
      exec: (cmd, args, options) => createChildExec(checkProcs)(process.execPath, [b.script, "first-check", firstGate, firstReady, b.events], options) });
    checking = call(randomUUID(), 1, 10_000, "unused"); await until(() => existsSync(firstReady), "检查实际启动");
    assert.equal(readProcs(checkProcs).length, 1);
    deployment = deployManaged(path); await until(() => readRun(path).deploymentAttempts?.length, "部署排队登记");
    assert.equal(readRun(path).activity!.kind, "waiting"); assert.equal(existsSync(ready), false); assert.equal(readLocalQueue().items.length, 0);
    writeFileSync(firstGate, "release"); await checking; await until(() => existsSync(ready), "部署实际启动");
    assert.equal(readProcs(readRun(path).deploymentAttempts![0].procs).length, 1);
    // 部署占有项目独占边界时，另一个真实静态调用不得启动。
    checking = staticReviewer({ cwd: f.repo, procsFile: checkProcs, config: { reviewerModel: "fake", reviewerThinking: "", reviewerCmd: "unused" },
      exec: (cmd, args, options) => createChildExec(checkProcs)(process.execPath, [b.script, "last-check", "none", checkReady, b.events], options) })(randomUUID(), 1, 10_000, "unused");
    assert.equal(existsSync(checkReady), false); writeFileSync(gate, "release"); await deployment; await checking;
    const events = readFileSync(b.events, "utf8").trim().split("\n").map((s) => JSON.parse(s));
    assert.deepEqual(events.map((e) => `${e.label}:${e.phase}`), ["first-check:start", "first-check:end", "deploy:start", "deploy:end", "last-check:start", "last-check:end"]);
    assert.equal(consumerProblem(checkProcs), undefined); assert.equal(readRun(path).release.status, "已释放");
    assert.deepEqual(JSON.parse(readFileSync(join(run.common, "loop-project-execution.json"), "utf8")), []);
  } finally { writeFileSync(gate, "release"); writeFileSync(join(f.root, "first-gate"), "release"); await Promise.allSettled([deployment, checking].filter(Boolean)); f.cleanup(); }
});

test("A14 停止部署排队/命令/检查；未知副作用不再检查、回退或盲重跑", async (t) => {
  for (const phase of ["waiting", "deploying", "checking"]) await t.test(phase, async () => {
    const f = deployFixture(); const gate = join(f.root, "gate"), ready = join(f.root, "ready"); let work: Promise<unknown> | undefined, reader: Promise<unknown> | undefined;
    try {
      const b = barrier(f), blocked = b.command(phase, gate, ready);
      if (phase === "checking") f.config.deployment.check = blocked; else if (phase === "deploying") f.config.deployment.cmd = blocked;
      writeFileSync(f.marker, JSON.stringify(f.config)); const path = await publish(f), run = readRun(path);
      if (phase === "waiting") {
        const procs = join(f.root, "reader.procs.json");
        reader = staticReviewer({ cwd: run.worktree, procsFile: procs, config: { reviewerModel: "fake", reviewerThinking: "", reviewerCmd: "unused" },
          exec: (cmd, args, options) => createChildExec(procs)(process.execPath, [b.script, "reader", gate, ready, b.events], options) })(randomUUID(), 1, 10_000, "unused");
        await until(() => existsSync(ready), "检查屏障");
      }
      work = deployManaged(path); await until(() => phase === "waiting" ? readRun(path).deploymentAttempts?.length : existsSync(ready), "部署停点");
      const stopped = await stopKernel(path); writeFileSync(gate, "release"); await work; if (reader) await reader;
      const after = readRun(path), attempt = after.deploymentAttempts![0];
      assert.equal(after.publication!.push, "成功"); assert.equal(attempt.rollback, undefined); assert.equal(attempt.status, "cancelled");
      assert.equal(attempt.calls.filter((c) => c.phase === "redeploying").length, 0);
      if (phase === "waiting") { assert.equal(attempt.calls.length, 0); await resumeManaged(path, false, "部署"); assert.equal(readRun(path).deploymentAttempts!.at(-1)!.status, "succeeded"); }
      else { assert.equal(stopped.status, "已合入"); await assert.rejects(resumeManaged(path, false, "部署"), /副作用|人工核对/); assert.equal(readRun(path).release.status, "未确认"); }
      assert.equal(queryKernel(path).status, "已合入"); assert.equal(readLocalQueue().items.length, 0);
    } finally { writeFileSync(gate, "release"); await Promise.allSettled([work, reader].filter(Boolean)); f.cleanup(); }
  });
});

test("A13/A14 目标前进、脏源码、未释放、超时和检查后停止均禁止自动回退", async (t) => {
  for (const kind of ["advanced", "dirty", "unreleased", "timeout", "stop-after-check", "write-restore"]) await t.test(kind, async () => {
    const f = deployFixture(undefined, "exit 1");
    try {
      if (kind === "write-restore") f.config.deployment.cmd = "before=$(cat file.txt); printf changed > file.txt; printf '%s\\n' \"$before\" > file.txt";
      if (kind === "timeout") f.config.deployment.cmd = `${quote(process.execPath)} -e 'setInterval(()=>{},1000)'`;
      writeFileSync(f.marker, JSON.stringify(f.config)); const path = await publish(f), p = readRun(path).publication!, actual = createChildExec(join(readRun(path).dir, "attempt-extra.procs.json"));
      const execute: Exec = async (command, args, options) => {
        const result = await actual(command, args, kind === "timeout" ? { ...options, timeout: 20 } : options);
        if (options.role?.includes("checking")) {
          if (kind === "advanced") { const next = f.git(f.repo, "commit-tree", p.tree, "-p", p.commit, "-m", "other batch"); f.git(f.repo, "update-ref", "refs/heads/dev", next, p.commit); }
          if (kind === "dirty") writeFileSync(join(f.repo, "file.txt"), "user new work\n");
          if (kind === "stop-after-check") await stopKernel(path);
        }
        if (kind === "unreleased") return { ...result, processesReleased: false };
        return result;
      };
      const result = await deployManaged(path, undefined, execute), run = readRun(path), attempt = run.deploymentAttempts![0];
      assert.notEqual(result.status, "通过"); assert.equal(attempt.rollback, undefined); assert.equal(attempt.calls.some((c) => c.phase === "redeploying"), false);
      assert.equal(run.publication!.push, "成功"); assert.equal(f.git(f.origin, "rev-parse", "dev"), p.commit);
      if (kind === "dirty") assert.equal(readFileSync(join(f.repo, "file.txt"), "utf8"), "user new work\n");
      if (kind === "write-restore") assert.match(attempt.reason!, /擅自修改源码/);
      if (kind === "timeout") assert.equal(attempt.category, "timeout");
      await assert.rejects(resumeManaged(path, false, "部署"), /副作用|人工核对|资源释放/);
      assert.equal(consumerProblem(join(run.dir, "attempt-extra.procs.json")), undefined);
    } finally { f.cleanup(); }
  });
});

test("A14 配置独立指纹、排队直接改配置不执行旧命令；发布前受控改卡可确认，发布后禁止追加", async () => {
  const f = deployFixture();
  try {
    const path = f.start(); f.candidate(path); const before = readRun(path), review = checkInputs(before, "开发评审").hash, testInput = checkInputs(before, "测试").hash;
    f.config.deployment.cmd = "exit 0"; writeFileSync(f.marker, JSON.stringify(f.config));
    assert.equal(checkInputs(readRun(path), "开发评审").hash, review); assert.equal(checkInputs(readRun(path), "测试").hash, testInput);
    assert.throws(() => checkInputs(readRun(path), "部署"), /配置.*变化/);
    writeFileSync(f.marker, JSON.stringify({ ...f.config, deployment: { enabled: true, cmd: null } }));
    assert.equal(checkInputs(readRun(path), "开发评审").hash, review); assert.equal(checkInputs(readRun(path), "测试").hash, testInput);
    writeFileSync(f.marker, JSON.stringify(f.config));
    const change = requestCardChange(path, { from: f.replacement((c) => c.name = "受控"), source: "cli:automation" }); assert.equal(change.state, "applied");
    assert.equal(readRun(path).deploymentPlan!.config.cmd, "exit 0"); assert.equal(checkInputs(readRun(path), "开发评审").hash, review);
    // 模拟未确认的在途副作用：续跑不能当作没执行过。
    const evidence = join(readRun(path).dir, "review-pass.md"); writeFileSync(evidence, PASS);
    await executeNode(path, "开发评审", async () => ({ status: "通过", evidence: [evidence], operations: [], released: true }));
    await executeNode(path, "提交", submitCandidate);
    assert.throws(() => requestCardChange(path, { from: f.replacement((c) => c.flow = ["开发评审", "提交"]), source: "cli:automation" }), /已发布/);
    updateRun(path, (r) => { r.deploymentAttempts = [{ id: randomUUID(), inputs: "frozen", publication: { commit: r.publication!.commit, tree: r.publication!.tree }, config: r.deploymentPlan!.config,
      cwd: r.deploymentPlan!.cwd, started: new Date().toISOString(), status: "rolling-back", calls: [], released: true, log: evidence, procs: join(r.dir, "unknown.procs.json"), rollback: { from: r.publication!.commit, to: r.base, state: "intent", at: new Date().toISOString() } }]; });
    await assert.rejects(resumeManaged(path, false, "部署"), /副作用|核对/); assert.equal(readRun(path).deploymentAttempts!.length, 1);
  } finally { f.cleanup(); }
});

test("A14 部署排队直接改配置或卡文件，旧命令不启动；恢复冻结输入后只跑部署", async (t) => {
  for (const kind of ["config", "card"]) await t.test(kind, async () => {
    const f = deployFixture(); let work: Promise<unknown> | undefined, reader: Promise<unknown> | undefined;
    const gate = join(f.root, "gate"), ready = join(f.root, "ready");
    try {
      const path = await publish(f), run = readRun(path), b = barrier(f), procs = join(f.root, "reader.procs.json");
      reader = staticReviewer({ cwd: run.worktree, procsFile: procs, config: { reviewerModel: "fake", reviewerThinking: "", reviewerCmd: "unused" },
        exec: (cmd, args, options) => createChildExec(procs)(process.execPath, [b.script, "reader", gate, ready, b.events], options) })(randomUUID(), 1, 10_000, "unused");
      await until(() => existsSync(ready), "检查实际启动");
      work = deployManaged(path); await until(() => readRun(path).deploymentAttempts?.length, "部署等待");
      const file = kind === "config" ? f.marker : f.file, frozen = readFileSync(file, "utf8");
      writeFileSync(file, kind === "config" ? JSON.stringify({ ...f.config, deployment: { ...f.config.deployment, cmd: "exit 99" } }) : JSON.stringify({ ...f.card, name: "direct change" }));
      writeFileSync(gate, "release"); await work; await reader;
      assert.equal(existsSync(f.output), false); assert.equal(readRun(path).deploymentAttempts![0].calls.length, 0);
      writeFileSync(file, frozen); await resumeManaged(path, false, "部署");
      const after = readRun(path); assert.equal(after.deploymentAttempts!.at(-1)!.status, "succeeded"); assert.equal(after.results.filter((r) => r.node === "提交").length, 1);
    } finally { writeFileSync(gate, "release"); await Promise.allSettled([work, reader].filter(Boolean)); f.cleanup(); }
  });
});

test("A16 只评审运行中标准/候选变化使本次报告作废；停后只重跑评审不开发", async (t) => {
  for (const kind of ["input", "tree", "stop"]) await t.test(kind, async () => {
    const f = reviewFixture();
    try {
      const path = f.start(), run = readRun(path); let calls = 0;
      const output = await reviewManaged(path, { exec: f.exec, callReviewer: async () => {
        calls++;
        if (kind === "input") writeFileSync(join(f.repo, "prompt.md"), "changed requirement\n");
        if (kind === "tree") writeFileSync(join(run.worktree, "file.txt"), "illegal review edit\n");
        if (kind === "stop") await stopKernel(path);
        return { stdout: PASS, stderr: "", code: 0, killed: false, processesReleased: true };
      } });
      assert.notEqual(output.status, "通过"); assert.equal(readRun(path).results.at(-1)!.status, "中断");
      const report = JSON.parse(readFileSync(readRun(path).reviewReport!.json, "utf8")); assert.equal(report.status, "中断"); assert.equal(report.valid, false);
      await releaseKernelWorkspace(path);
      if (kind === "tree") { assert.equal(existsSync(run.worktree), true); assert.equal(readRun(path).release.status, "未确认"); }
      if (kind === "input") {
        await assert.rejects(resumeManaged(path, false, "评审"), /受控|改卡/);
        const confirmed = requestCardChange(path, { from: f.replacement((c) => c.name = "确认新需求"), source: "cli:automation" }); assert.equal(confirmed.state, "applied");
      }
      if (kind === "stop") {
        await stopKernel(path); // 明确补偿后，恢复的只有评审节点。
        const script = join(f.root, "reviewer.mjs"); writeFileSync(script, `#!${process.execPath}\nconsole.log(${JSON.stringify(PASS)});\n`, { mode: 0o755 });
        process.env.AUTOREVIEW_REVIEWER_CMD = script;
        requestCardChange(path, { from: f.replacement((c) => c.name = "确认重跑"), source: "cli:automation" });
        await resumeManaged(path, false, "评审"); assert.equal(readRun(path).results.at(-1)!.status, "通过");
      }
      assert.equal(readRun(path).results.every((r) => r.node === "评审"), true); assert.equal(readRun(path).session, undefined); assert.equal(readRun(path).publication, undefined);
      assert.equal(calls, 1);
    } finally { f.cleanup(); }
  });
});

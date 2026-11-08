import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:net";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { fakeKernelLauncher, kernelFixture, reviewer } from "./helpers/kernel-fixture.ts";
import { attachSession, completeManagedDelivery, consumeManagedRepair, mergeManaged, recordManagedUserInput } from "../kernel-session.ts";
import { checkInputs } from "../kernel-workspace.ts";
import { readRun, updateRun } from "../node-ledger.ts";
import { executeNode, queryKernel } from "../kernel.ts";
import { runTestNode } from "../test-node.ts";
import { createChildExec, handleReviewEvent } from "../hosts/review-hook.ts";
import { fileURLToPath } from "node:url";
import { deliverManagedRepair, releaseKernelWorkspace, resumeManaged, stopKernel } from "../kernel-runtime.ts";
import { processStartTime, readProcs, registerProc, releaseProc } from "../procs.ts";
import { readLocalQueue } from "../local-node-queue.ts";
import { releaseTestWorkspace } from "../test-workspace.ts";

test("A2 产品测试失败回同一会话，修复后先评审再测试；各自计数/精确命令", async () => {
  const command = `node -e "if(require('fs').readFileSync('file.txt','utf8').trim()!=='fixed'){console.error('AssertionError: expected fixed');process.exit(1)}"`;
  const f = kernelFixture(["开发评审", "测试"], command);
  try {
    const path = f.start(), run = readRun(path); attachSession(path, "pi", "original-session", join(run.dir, "session.jsonl"));
    writeFileSync(join(run.worktree, "file.txt"), "broken"); let reviews = 0;
    const options = { exec: f.exec, callReviewer: async () => { reviews++; return reviewer(); } };
    const first = await completeManagedDelivery(path, "【交付完成】", options);
    assert.equal(first.status, "不通过", first.reason ?? ""); assert.match(first.message!, /AssertionError: expected fixed/);
    assert.equal(readRun(path).session!.id, "original-session"); assert.equal(readRun(path).repairs, 0); assert.equal(readRun(path).counters!.测试!.repairs, 1);
    assert.equal(readLocalQueue().items.length, 0); assert.equal(reviews, 1);
    writeFileSync(join(run.worktree, "file.txt"), "fixed");
    const second = await completeManagedDelivery(path, "【交付完成】", options); assert.equal(second.status, "通过", second.reason ?? "");
    assert.equal(reviews, 2); assert.deepEqual(readRun(path).results.map((r) => r.node), ["开发评审", "测试", "开发评审", "测试"]);
    assert.equal(queryKernel(path).status, "可合入");
    const results = readRun(path).results.filter((r) => r.node === "测试");
    for (const r of results) { const report = JSON.parse(readFileSync(r.evidence.find((p) => p.endsWith("test.json"))!, "utf8")); assert.equal(report.command, command); assert.equal(report.calls.length, 1); assert.equal(report.calls[0].command, command); }
  } finally { f.cleanup(); }
});
test("真实 bin/loop → Pi 生命周期替身 → 测试返修原会话 → 自动 dev 发布/释放", async () => {
  const f = kernelFixture(["开发评审", "测试", "提交"], `node -e "if(!require('fs').readFileSync('file.txt','utf8').includes('3')){console.error('AssertionError: need round 3');process.exit(1)}"`);
  let path: string | undefined;
  try {
    fakeKernelLauncher(f);
    const cli = spawnSync(fileURLToPath(new URL("../bin/loop", import.meta.url)), ["启动", f.file, "--launcher", "background", "--json"], { cwd: f.repo, env: process.env, encoding: "utf8", timeout: 20_000 });
    assert.equal(cli.status, 0, cli.stdout + cli.stderr); path = JSON.parse(cli.stdout).ledger;
    const end = Date.now() + 30_000;
    while (readRun(path!).release.status !== "已释放" && Date.now() < end) await sleep(50);
    const run = readRun(path!); assert.equal(run.release.status, "已释放", JSON.stringify(queryKernel(path!)));
    assert.equal(run.session!.id, "fake-original-session"); assert.equal(run.repairs, 0); assert.equal(run.counters!.测试!.repairs, 2);
    assert.equal(run.publication!.push, "成功"); assert.equal(existsSync(run.worktree), false); assert.equal(readLocalQueue().items.length, 0);
    assert.equal(f.git(f.origin, "for-each-ref", "--format=%(refname)"), "refs/heads/dev"); assert.match(readFileSync(join(run.dir, "repair-1.json"), "utf8"), /Loop 测试返修/);
  } finally { if (path) await stopKernel(path); f.cleanup(); }
});
test("同次尝试首次 75、自动重试 0 保留失败证据并继续提交，不被旧 failure 覆盖", async () => {
  const f = kernelFixture(["开发评审", "测试", "提交"]);
  try {
    const flag = join(f.root, "first-failure");
    const command = `if [ -f '${flag}' ]; then echo recovered; else touch '${flag}'; echo 'AUTOREVIEW_FAILURE=environment temporary blockage' >&2; exit 75; fi`;
    f.card.tasks[0].test = command; writeFileSync(f.file, JSON.stringify(f.card));
    const path = f.start(); writeFileSync(join(readRun(path).worktree, "file.txt"), "done");
    const output = await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: reviewer });
    assert.equal(output.status, "通过", output.reason ?? ""); const run = readRun(path);
    assert.equal(run.publication!.push, "成功"); assert.equal(run.repairs, 0); assert.deepEqual(run.counters!.测试, { repairs: 0, recoveries: 1 });
    assert.deepEqual(run.results.map((r) => [r.node, r.status]), [["开发评审", "通过"], ["测试", "通过"], ["提交", "通过"]]);
    const result = run.results.find((r) => r.node === "测试")!;
    const report = JSON.parse(readFileSync(result.evidence.find((p) => p.endsWith("test.json"))!, "utf8"));
    assert.deepEqual(report.calls.map((call: any) => call.code), [75, 0]); assert.ok(report.calls.every((call: any) => call.command === command));
    assert.match(report.calls[0].stderr, /temporary blockage/); assert.match(report.calls[1].stdout, /recovered/);
    assert.equal(report.result, "通过"); assert.equal(report.failure, undefined); assert.equal(readLocalQueue().items.length, 0);
  } finally { f.cleanup(); }
});

test("A3 环境有限恢复不扣产品次数，三条命令可见；只重跑测试不重新评审", async () => {
  const f = kernelFixture();
  try {
    const flag = join(f.root, "fixed-env"); f.card.tasks[0].test = `if [ -f '${flag}' ]; then echo ok; else echo EADDRINUSE >&2; exit 75; fi`; writeFileSync(f.file, JSON.stringify(f.card));
    const path = f.start(), run = readRun(path); writeFileSync(join(run.worktree, "file.txt"), "done"); let reviews = 0;
    const output = await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: async () => { reviews++; return reviewer(); } });
    assert.equal(output.failure, "environment"); assert.equal(readRun(path).counters!.测试!.repairs, 0); assert.equal(readRun(path).counters!.测试!.recoveries, 1);
    assert.equal(queryKernel(path).status, "等你决定"); assert.equal(queryKernel(path).node, "测试");
    const lines = queryKernel(path).lines.join("\n"); for (const action of ["重跑", "改卡", "放弃"]) assert.ok(lines.includes(action));
    await assert.rejects(() => mergeManaged(path), /普通合入被拒绝/);
    const proof = readRun(path).results[0], inputs = checkInputs(readRun(path), "开发评审").hash;
    writeFileSync(flag, "fixed"); await resumeManaged(path, false, "测试");
    assert.equal(reviews, 1); assert.equal(readRun(path).results[0].id, proof.id); assert.equal(checkInputs(readRun(path), "开发评审").hash, inputs);
    assert.equal(queryKernel(path).status, "可合入"); assert.equal(readLocalQueue().items.length, 0);
  } finally { f.cleanup(); }
});
test("无测试原因不是通过、不占槽；无测试 flow 不执行命令/旧验收", async () => {
  for (const flow of [["开发评审", "测试"], ["开发评审"]]) {
    const f = kernelFixture(flow, flow.includes("测试") ? "无：纯文档" : "exit 93");
    try {
      const path = f.start(); writeFileSync(join(readRun(path).worktree, "file.txt"), "done");
      const output = await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: reviewer });
      assert.equal(output.status, flow.includes("测试") ? "没验证" : "通过"); assert.equal(readLocalQueue().items.length, 0);
      assert.equal(existsSync(join(f.root, "local-queue", "queue.json")), false);
      if (flow.includes("测试")) await assert.rejects(() => mergeManaged(path), /普通合入被拒绝/);
    } finally { f.cleanup(); }
  }
});
test("ENOSPC 共享归因实际接入节点：通过名不吞产品返修，真实错误/冲突/未知不扣产品次数", async () => {
  for (const [failure, lines] of [
    ["product", ["ok 1 - ENOSPC 故障时保留证据", "AssertionError: actual product regression"]],
    ["environment", ["Error: ENOSPC: no space left on device, write '/tmp/report'", "AssertionError: evidence file missing", "AUTOREVIEW_FAILURE=product 衍生断言"]],
    ["environment", ["mc: Storage backend has reached its minimum free drive threshold", "AssertionError: upload failed"]],
    ["unknown", ["AUTOREVIEW_FAILURE=product 业务失败", "ModuleNotFoundError: runner unavailable"]],
    ["unknown", ["ok 1 - ENOSPC 故障时保留证据", "opaque failure"]],
  ] as const) {
    const command = `printf '%s\\n' ${lines.map((line) => `'${line.replace(/'/g, "'\\''")}'`).join(" ")} >&2; exit 1`;
    const f = kernelFixture(["开发评审", "测试"], command);
    try {
      const maxRecoveries = lines[0].startsWith("mc:") ? 1 : 0;
      f.card.limits = { 测试: { maxRecoveries } }; writeFileSync(f.file, JSON.stringify(f.card));
      const path = f.start(), run = readRun(path); attachSession(path, "pi", "original-enospc", join(run.dir, "session.jsonl"));
      writeFileSync(join(run.worktree, "file.txt"), "candidate");
      const output = await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: reviewer });
      assert.equal(output.failure, failure, output.reason ?? ""); assert.equal(output.released, true);
      const current = readRun(path); assert.equal(current.repairs, 0); assert.equal(current.counters!.测试!.repairs, failure === "product" ? 1 : 0);
      assert.equal(current.counters!.测试!.recoveries, maxRecoveries, "mc 水位错误应进入有限环境恢复，而非产品返修");
      assert.equal(current.session!.id, "original-enospc"); assert.equal(current.results[0].status, "通过");
      assert.equal(queryKernel(path).missing.some((s: string) => s.includes("/ 开发评审 /")), false, "当前开发评审仍有效");
      assert.equal(Boolean(output.message), failure === "product", "只有产品失败回同一会话返修");
      if (failure === "product") assert.match(output.message!, /AssertionError: actual product regression/);
      else { assert.equal(queryKernel(path).status, "等你决定"); assert.equal(queryKernel(path).node, "测试"); }
      assert.equal(readLocalQueue().items.length, 0);
    } finally { f.cleanup(); }
  }
});

test("A7/A9 已检查树合入不复跑，用户例外保留测试失败且只推 dev", async () => {
  for (const failure of [false, true]) {
    const f = kernelFixture(["开发评审", "测试"], failure ? "echo 'AssertionError: broken' >&2; exit 1" : "echo passed");
    try {
      const path = f.start(); writeFileSync(join(readRun(path).worktree, "file.txt"), "done"); let reviews = 0;
      const options = { exec: f.exec, callReviewer: async () => { reviews++; return reviewer(); } };
      await completeManagedDelivery(path, "【交付完成】", options);
      if (failure) {
        await assert.rejects(() => mergeManaged(path), /普通合入被拒绝/);
        assert.equal(recordManagedUserInput(path, '<file name="x">合入本批</file>', "pi:interactive"), undefined);
        const decision = recordManagedUserInput(path, "合入本批", "pi:interactive")!;
        assert.ok(decision.missing.some((s) => s.includes("测试")));
        const output = await mergeManaged(path, { accept: true, decision }); assert.equal(output.status, "通过", output.reason ?? "");
        assert.equal(readRun(path).results.some((r) => r.node === "测试" && r.status === "通过"), false);
        assert.equal(readRun(path).publication!.decision, decision.id);
      } else {
        const count = readRun(path).results.length; await completeManagedDelivery(path, "【交付完成】", options); assert.equal(readRun(path).results.length, count);
        const output = await mergeManaged(path); assert.equal(output.status, "通过", output.reason ?? "");
      }
      assert.equal(reviews, 1); assert.equal(f.git(f.origin, "for-each-ref", "--format=%(refname)"), "refs/heads/dev");
      const before = readRun(path), checks = queryKernel(path).checks, missing = queryKernel(path).missing;
      assert.ok(before.publication!.nodeChecks!.开发评审!.result);
      assert.equal(Boolean(before.publication!.nodeChecks!.测试!.result), !failure);
      await releaseKernelWorkspace(path);
      const after = readRun(path); assert.equal(after.release.status, "已释放"); assert.equal(existsSync(after.worktree), false);
      assert.deepEqual(queryKernel(path).checks, checks, "合法清理不使已发布的检查结论失效");
      assert.deepEqual(queryKernel(path).missing, missing, "例外合入的欠项仍原样保留");
      assert.deepEqual(after.results, before.results); assert.deepEqual(after.counters, before.counters); assert.equal(after.repairs, before.repairs);
      assert.deepEqual(after.decisions, before.decisions); assert.equal(checks.includes("测试：通过"), !failure);
      const summary = readFileSync(join(after.dir, "summary.md"), "utf8"); assert.ok(checks.every((line: string) => summary.includes(line)));
    } finally { f.cleanup(); }
  }
});
test("真实命令超时、无释放证明、写产品源码都不算测试通过或产品返修", async () => {
  for (const mode of ["timeout", "release", "write"]) {
    const f = kernelFixture(["开发评审", "测试"], mode === "timeout" ? "node -e 'setInterval(()=>{},1000)'" : mode === "write" ? "printf bad > file.txt" : "echo ok");
    let path: string | undefined;
    try {
      path = f.start(); f.candidate(path);
      await executeNode(path, "开发评审", async (i) => ({ status: "通过", evidence: [i.evidenceDir], operations: [], released: true }));
      const output = await executeNode(path, "测试", (i) => runTestNode({ ...i, deadline: mode === "timeout" ? Date.now() + 100 : i.deadline },
        mode === "release" ? async () => ({ code: 0, stdout: "ok", stderr: "", killed: false }) : createChildExec(i.procsFile)), { localSlot: true });
      assert.notEqual(output.status, "通过"); assert.notEqual(output.failure, "product"); assert.equal(readRun(path).counters?.测试?.repairs ?? 0, 0);
      await assert.rejects(() => mergeManaged(path!), /未确认|活动|普通合入|身份核对/);
      if (mode === "release") {
        const entry = readRun(path).testWorkspaces!.at(-1)!;
        assert.equal(releaseTestWorkspace(path, entry, true), undefined, "纯内存替身未启动消费者，仅释放本夹具检出；不改产品的未知结论");
      }
    } finally { if (path) await stopKernel(path); f.cleanup(); }
  }
});
test("Claude/Codex 真实 Hook 测试产品失败 block 原会话，返修不更新用户版本", async () => {
  for (const host of ["claude", "codex"]) {
    const f = kernelFixture(["开发评审", "测试"], "echo 'AssertionError: repair' >&2; exit 1");
    try {
      const path = f.start(), run = readRun(path);
      Object.assign(process.env, { AUTOREVIEW_KERNEL_LEDGER: path, AUTOREVIEW_KERNEL_RUN: run.id, AUTOREVIEW_DEV_ROOT: run.worktree, AUTOREVIEW_HOST: host,
        AUTOREVIEW_REVIEWER_CMD: fileURLToPath(new URL("./fake-reviewer.mjs", import.meta.url)), FAKE_MODE: "pass", FAKE_STATE_DIR: join(f.root, "fake") });
      const event = { cwd: run.worktree, session_id: "same-original" };
      await handleReviewEvent({ ...event, hook_event_name: "SessionStart" });
      await handleReviewEvent({ ...event, hook_event_name: "UserPromptSubmit", prompt: "按原任务修改" });
      const version = readRun(path).userVersion; writeFileSync(join(run.worktree, "file.txt"), "done");
      const output = JSON.parse((await handleReviewEvent({ ...event, hook_event_name: "Stop", last_assistant_message: "【交付完成】" }))!);
      assert.equal(output.decision, "block"); assert.match(output.reason, /AssertionError: repair/); assert.equal(readRun(path).userVersion, version);
      assert.equal(readRun(path).session!.id, "same-original"); assert.equal(readRun(path).repair!.state, "read"); assert.equal(readRun(path).repairs, 0);
    } finally { f.cleanup(); }
  }
});
test("新卡 Claude/Codex 实际启动/原生通道，独立测试返修仍回原 session 且不改用户版本", async () => {
  for (const host of ["claude", "codex"]) {
    const f = kernelFixture(["开发评审", "测试"], "echo 'AssertionError: native repair' >&2; exit 1"); let path: string | undefined;
    try {
      const root = fileURLToPath(new URL("..", import.meta.url)), plugin = join(f.root, "plugin"); mkdirSync(join(plugin, "hooks"), { recursive: true });
      const hooks = JSON.parse(readFileSync(join(root, "plugins/autoreview/hooks/hooks.json"), "utf8"));
      for (const groups of Object.values(hooks.hooks) as any[]) for (const group of groups) for (const hook of group.hooks) hook.command = hook.command.replace(/\S*\/hosts\/hook\.ts/, join(root, "hosts/hook.ts"));
      writeFileSync(join(plugin, "hooks/hooks.json"), JSON.stringify(hooks));
      const config = join(f.root, "fake-host.json"); writeFileSync(config, JSON.stringify({ root: f.root, plugin, host, session: `original-${host}`, hook: join(root, "hosts/hook.ts"), apiSocket: join(f.root, "api.sock") }));
      const hostCommand = join(f.root, "native-host.mjs");
      writeFileSync(hostCommand, `#!${process.execPath}\nimport ${JSON.stringify(new URL("./fake-live-hook.mjs", import.meta.url).href)};\n`, { mode: 0o755 });
      Object.assign(process.env, { LOOP_FAKE_HOST_CONFIG: config, AUTOREVIEW_HOST: host, CLAUDE_BIN: hostCommand, CODEX_BIN: hostCommand, CODEX_HOME: join(f.root, "codex"),
        AUTOREVIEW_REVIEWER_CMD: join(root, "test/fake-reviewer.mjs"), FAKE_MODE: "pass", FAKE_STATE_DIR: join(f.root, "reviewer") });
      f.card.host = host; f.card.tasks[0].scope = ["src/a.txt"]; writeFileSync(f.file, JSON.stringify(f.card));
      const cli = spawnSync(join(root, "bin/loop"), ["启动", f.file, "--launcher", "background", "--json"], { cwd: f.repo, env: process.env, encoding: "utf8", timeout: 20_000 });
      assert.equal(cli.status, 0, cli.stdout + cli.stderr); path = JSON.parse(cli.stdout).ledger;
      const wait = async (check: () => boolean, label: string) => { const end = Date.now() + 20_000; while (!check() && Date.now() < end) await sleep(50); assert.ok(check(), `${host}: ${label}; ${readRun(path!).stopReason}; ${readFileSync(join(readRun(path!).dir, "launch.log"), "utf8").slice(-4000)}`); };
      await wait(() => existsSync(join(f.root, "before-stop-1")), "原宿主实际启动"); writeFileSync(join(f.root, "run-stop-1"), "go");
      await wait(() => existsSync(join(f.root, "host-idle-1.json")), "首轮测试失败 block 已返回");
      const version = readRun(path!).userVersion; assert.equal(readRun(path!).repair!.state, "read");
      updateRun(path!, (r) => { r.activity = undefined; }); // 替身不执行 block 后的模型回合，明确转 idle 后模拟用户只重测。
      await resumeManaged(path!, true, "测试");
      await wait(() => existsSync(join(f.root, "host-receipt.jsonl")), "独立测试失败通过原生通道送回");
      assert.equal(readRun(path!).session!.id, `original-${host}`); assert.equal(readRun(path!).userVersion, version); assert.equal(readRun(path!).repair!.state, "read");
      assert.equal(readRun(path!).repairs, 0); assert.equal(readRun(path!).counters!.测试!.repairs, 2);
      const receipt = readFileSync(join(f.root, "host-receipt.jsonl"), "utf8"); assert.match(receipt, /Loop 测试返修/); assert.equal(readLocalQueue().items.length, 0);
    } finally { if (path) await stopKernel(path); f.cleanup(); }
  }
});
test("loop-kernel 原生拒收/异常应答保留待处理信封并通知，不记 sent 或清零计数", async () => {
  for (const host of ["claude", "codex"] as const) for (const reply of ['{"ok":false,"error":"denied"}', '{broken-json']) {
    const f = kernelFixture(["开发评审", "测试"], "echo 'AssertionError: needs repair' >&2; exit 1");
    let server: Server | undefined, ownedPid: number | undefined; const registry = join(f.root, "native-fixture.procs.json");
    try {
      const token = randomUUID();
      const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore", env: { ...process.env, AUTOREVIEW_PROCESS_OWNER: token } });
      await new Promise<void>((ok, no) => { child.once("spawn", ok); child.once("error", no); }); ownedPid = child.pid!;
      registerProc(registry, ownedPid, "native-rejection-fixture", process.execPath, token);
      const started = processStartTime(ownedPid), path = f.start();
      process.env.AUTOREVIEW_KERNEL_LAUNCH = token;
      updateRun(path, (r) => { r.launch = { pid: ownedPid!, processStarted: started, token }; });
      attachSession(path, host, "original-rejected", join(readRun(path).dir, "session.jsonl"));
      const command = join(f.root, "native-reply.cjs"); writeFileSync(command, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(reply)});\n`, { mode: 0o755 });
      const socket = join(f.root, "reject.sock"), binding = join(f.root, "binding.json");
      if (host === "claude") {
        server = createServer({ allowHalfOpen: true }, (connection) => {
          connection.on("data", () => {}); connection.on("end", () => connection.end(`${reply}\n`));
        });
        await new Promise<void>((ok, no) => { server!.once("error", no); server!.listen(socket, ok); });
      }
      writeFileSync(binding, JSON.stringify({ launch: token, session: "original-rejected", childPid: ownedPid, childStarted: started,
        ...(host === "claude" ? { channel: { socket, token: "private-fixture-token" } } : {}) }), { mode: 0o600 });
      updateRun(path, (r) => { r.native = { launch: token, command, childPid: ownedPid!, childStarted: started, binding }; });
      writeFileSync(join(readRun(path).worktree, "file.txt"), "candidate");
      await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: reviewer });
      const before = readRun(path); assert.equal(before.repair!.state, "pending");
      await deliverManagedRepair(path);
      const after = readRun(path); assert.equal(after.repair!.state, "unknown"); assert.equal(after.repair!.id, before.repair!.id);
      assert.equal(after.repair!.message, before.repair!.message); assert.deepEqual(after.results, before.results); assert.deepEqual(after.counters, before.counters);
      assert.equal(after.userVersion, before.userVersion); assert.equal(after.repairs, before.repairs);
      assert.match(queryKernel(path).reason, /返修投递未确认/); assert.ok(queryKernel(path).reason.includes("续跑"));
      assert.match(readFileSync(join(after.dir, "summary.md"), "utf8"), /返修投递未确认/);
    } finally {
      if (server?.listening) await new Promise<void>((ok) => server!.close(() => ok()));
      if (ownedPid) assert.equal(releaseProc(registry, ownedPid, readProcs(registry)[0]), true, "按本次启动登记确认替身进程释放");
      f.cleanup();
    }
  }
});

test("机器信封核对接收完整正文：同 token 篡改/追加撤权/文件引用后追加文本不吞真实输入", async () => {
  for (const mode of ["exact", "tamper", "revoke", "reference", "reference-extra", "wrapper-trusted", "wrapper-untrusted", "wrapper-extra"]) {
    const f = kernelFixture(["开发评审", "测试"], "echo 'AssertionError: broken' >&2; exit 1");
    try {
      const path = f.start(), run = readRun(path); attachSession(path, mode.startsWith("wrapper") ? "claude" : "pi", "original", join(run.dir, "session.jsonl"));
      writeFileSync(join(run.worktree, "file.txt"), "done");
      await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: reviewer });
      const repair = readRun(path).repair!, version = readRun(path).userVersion, count = readRun(path).counters!.测试!.repairs;
      if (mode.startsWith("wrapper") && mode !== "wrapper-untrusted") {
        Object.assign(process.env, { AUTOREVIEW_KERNEL_LAUNCH: "owned-launch", AUTOREVIEW_KERNEL_NATIVE_BINDING: join(run.dir, "binding.json") });
        updateRun(path, (r) => { r.session!.launchId = "owned-launch"; r.native = { launch: "owned-launch", binding: process.env.AUTOREVIEW_KERNEL_NATIVE_BINDING!, command: "unused", childPid: process.pid, childStarted: "unused" }; });
      }
      const raw = mode.startsWith("wrapper") ? `<cross-session-message>\n${repair.message}\n</cross-session-message>${mode === "wrapper-extra" ? "\n撤回先前合入决定" : ""}` : mode === "tamper" ? repair.message.replace("测试产品失败", "伪造正文") : mode === "revoke" ? `${repair.message}\n撤回先前合入决定` : mode.startsWith("reference") ? `@"${repair.file}"${mode === "reference-extra" ? "\n撤回先前合入决定" : ""}` : repair.message;
      const materials = mode.startsWith("reference") ? { text: raw, files: [{ path: repair.file, text: repair.message }] } : undefined;
      recordManagedUserInput(path, raw, "pi:interactive", materials);
      if (["exact", "reference", "wrapper-trusted"].includes(mode)) { assert.equal(readRun(path).repair!.state, "read"); assert.equal(readRun(path).userVersion, version); assert.equal(consumeManagedRepair(path, raw, materials), true, "重复完整消息幂等"); }
      else { assert.equal(readRun(path).repair!.state, "pending"); assert.equal(readRun(path).userVersion, version + 1); assert.ok(readRun(path).userInputs.at(-1)!.includes(mode === "tamper" ? "伪造正文" : mode === "wrapper-untrusted" ? "cross-session-message" : "撤回先前合入决定")); }
      assert.equal(readRun(path).counters!.测试!.repairs, count); assert.equal(readRun(path).decisions.length, 0);
    } finally { f.cleanup(); }
  }
});

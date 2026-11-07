import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { kernelFixture } from "./helpers/kernel-fixture.ts";
import { executeNode, queryKernel } from "../kernel.ts";
import { readRun } from "../node-ledger.ts";
import { readLocalQueue, recoverLocalQueue } from "../local-node-queue.ts";
import { stopKernel } from "../kernel-runtime.ts";
import { requestCardChange } from "../kernel-controls.ts";
const LOOP = fileURLToPath(new URL("../bin/loop", import.meta.url));
async function waitFor(check: () => boolean, label: string): Promise<void> { const end = Date.now() + 20_000; while (!check() && Date.now() < end) await sleep(40); assert.ok(check(), label); }
async function ready(f: ReturnType<typeof kernelFixture>): Promise<string> {
  const path = f.start(); f.candidate(path);
  await executeNode(path, "开发评审", async (i) => ({ status: "通过", evidence: [i.evidenceDir], operations: ["静态评审替身"], released: true })); return path;
}
function start(f: ReturnType<typeof kernelFixture>): void {
  const result = spawnSync(LOOP, ["重跑", f.file, "--node", "测试", "--json"], { cwd: f.repo, env: process.env, encoding: "utf8", timeout: 20_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr); assert.ok(JSON.parse(result.stdout).dispatched);
}
test("跨仓库真实 CLI worker 共用 FIFO，起止区间不重叠；查询排队不冒充执行", async () => {
  const a = kernelFixture(), b = kernelFixture(); let ap: string | undefined, bp: string | undefined;
  try {
    Object.assign(process.env, { AUTOREVIEW_KERNEL_ROOT: join(a.root, "kernel"), AUTOREVIEW_LOCAL_QUEUE_ROOT: join(a.root, "queue") });
    const events = join(a.root, "events"), gate = join(a.root, "release-a");
    a.card.tasks[0].test = `node -e "const f=require('fs');f.appendFileSync('${events}','a:start\\n');const t=setInterval(()=>{if(f.existsSync('${gate}')){clearInterval(t);f.appendFileSync('${events}','a:end\\n')}},20)"`;
    b.card.tasks[0].test = `node -e "require('fs').appendFileSync('${events}','b:start\\nb:end\\n')"`;
    writeFileSync(a.file, JSON.stringify(a.card)); writeFileSync(b.file, JSON.stringify(b.card)); ap = await ready(a); bp = await ready(b);
    start(a); await waitFor(() => existsSync(events) && readFileSync(events, "utf8").includes("a:start"), "第一仓库实际开始");
    start(b); await waitFor(() => readLocalQueue().items.some((t) => t.ledger === bp && t.state === "waiting"), "第二仓库排队");
    const persisted = readFileSync(bp, "utf8"), view = queryKernel(bp); assert.equal(view.status, "等你决定"); assert.match(view.reason, /本机排队/); assert.equal(readFileSync(bp, "utf8"), persisted);
    assert.equal(readFileSync(events, "utf8"), "a:start\n");
    writeFileSync(gate, "release"); await waitFor(() => readRun(bp!).results.some((r) => r.node === "测试" && r.status === "通过"), "第二仓库执行完成");
    assert.equal(readFileSync(events, "utf8"), "a:start\na:end\nb:start\nb:end\n"); await waitFor(() => readLocalQueue().items.length === 0, "全部票据释放");
  } finally { if (ap) await stopKernel(ap); if (bp) await stopKernel(bp); b.cleanup(); a.cleanup(); }
});
test("排队取消不碰另一仓库，执行中停止按身份释放，迟到不能复活", async () => {
  const a = kernelFixture(), b = kernelFixture(); let ap: string | undefined, bp: string | undefined;
  try {
    Object.assign(process.env, { AUTOREVIEW_KERNEL_ROOT: join(a.root, "kernel"), AUTOREVIEW_LOCAL_QUEUE_ROOT: join(a.root, "queue") });
    const begun = join(a.root, "begun"), forbidden = join(a.root, "should-not-run");
    a.card.tasks[0].test = `node -e "require('fs').writeFileSync('${begun}','started');setInterval(()=>{},1000)"`;
    b.card.tasks[0].test = `node -e "require('fs').writeFileSync('${forbidden}','bad')"`;
    writeFileSync(a.file, JSON.stringify(a.card)); writeFileSync(b.file, JSON.stringify(b.card)); ap = await ready(a); bp = await ready(b);
    start(a); await waitFor(() => existsSync(begun), "实际测试已开始"); start(b);
    await waitFor(() => readLocalQueue().items.some((t) => t.ledger === bp && t.state === "waiting"), "另一卡等待");
    await stopKernel(bp); assert.equal(existsSync(forbidden), false); assert.ok(readLocalQueue().items.some((t) => t.ledger === ap));
    const stopped = await stopKernel(ap); assert.equal(stopped.ok, true, JSON.stringify(stopped));
    await waitFor(() => readLocalQueue().items.length === 0, "执行消费者及票据已停止");
    assert.equal(readRun(ap).stopped, true); assert.equal(queryKernel(ap).status, "等你决定");
    assert.equal(readRun(ap).results.some((r) => r.node === "测试" && r.status === "通过"), false);
  } finally { if (ap) await stopKernel(ap); if (bp) await stopKernel(bp); b.cleanup(); a.cleanup(); }
});
test("waiting 边界改卡取消旧票，原 worker 接续新命令，不执行新旧两份", async () => {
  const a = kernelFixture(), b = kernelFixture(); let ap: string | undefined, bp: string | undefined;
  try {
    Object.assign(process.env, { AUTOREVIEW_KERNEL_ROOT: join(a.root, "kernel"), AUTOREVIEW_LOCAL_QUEUE_ROOT: join(a.root, "queue") });
    const began = join(a.root, "began"), gate = join(a.root, "gate"), old = join(a.root, "old"), fresh = join(a.root, "fresh");
    a.card.tasks[0].test = `node -e "const f=require('fs');f.writeFileSync('${began}','yes');const t=setInterval(()=>{if(f.existsSync('${gate}'))clearInterval(t)},20)"`;
    b.card.tasks[0].test = `node -e "require('fs').writeFileSync('${old}','old')"`;
    writeFileSync(a.file, JSON.stringify(a.card)); writeFileSync(b.file, JSON.stringify(b.card)); ap = await ready(a); bp = await ready(b);
    start(a); await waitFor(() => existsSync(began), "A 开始占槽"); start(b);
    await waitFor(() => readLocalQueue().items.some((t) => t.ledger === bp && t.state === "waiting"), "B 等待");
    const from = b.replacement((c) => { c.tasks[0].test = `node -e "require('fs').writeFileSync('${fresh}','new')"`; });
    const change = requestCardChange(bp, { from, source: "cli:automation" }); assert.equal(change.state, "applied");
    await waitFor(() => readLocalQueue().items.some((t) => t.ledger === bp && t.epoch === 1), "原 worker 按新输入重新排队");
    writeFileSync(gate, "release"); await waitFor(() => existsSync(fresh) && readRun(bp!).results.some((r) => r.node === "测试" && r.status === "通过"), "新命令通过");
    assert.equal(existsSync(old), false); assert.equal(readRun(bp).results.filter((r) => r.node === "开发评审").length, 1);
  } finally { if (ap) await stopKernel(ap); if (bp) await stopKernel(bp); b.cleanup(); a.cleanup(); }
});
test("死亡 worker 的损坏消费者登记阻止抢槽；仅已证明释放才能回收", () => {
  const f = kernelFixture();
  try {
    const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }); assert.equal(dead.status, 0);
    const root = process.env.AUTOREVIEW_LOCAL_QUEUE_ROOT!; mkdirSync(root); const procs = join(root, "owned.procs.json"); writeFileSync(procs, "broken");
    writeFileSync(join(root, "queue.json"), JSON.stringify({ v: 1, next: 2, items: [{ id: "owned-ticket", token: "random-owned", ledger: "owned-ledger", run: "run", common: "common", task: "甲", node: "测试", tree: "tree", inputs: "hash", epoch: 0, pid: Number(dead.stdout), started: "saved-start", procs, seq: 1, at: new Date().toISOString(), state: "active" }] }));
    const original = readFileSync(join(root, "queue.json"), "utf8"), malformed = JSON.parse(original); delete malformed.items[0].procs;
    writeFileSync(join(root, "queue.json"), JSON.stringify(malformed)); const damaged = readFileSync(join(root, "queue.json"), "utf8");
    assert.throws(recoverLocalQueue, /身份损坏/); assert.equal(readFileSync(join(root, "queue.json"), "utf8"), damaged, "缺归属字段不能作为无消费者而抢槽");
    writeFileSync(join(root, "queue.json"), original);
    recoverLocalQueue(); assert.equal(readLocalQueue().items[0].state, "blocked"); assert.match(readLocalQueue().items[0].reason!, /损坏/);
    writeFileSync(procs, "[]"); recoverLocalQueue(); assert.equal(readLocalQueue().items.length, 0);
  } finally { f.cleanup(); }
});

import "./test-env.ts";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { batchInfo, batchEventKey, eventReason, eventsRoot, lastEventSeq, pushEvent } from "../events.ts";
import { readPAConfig } from "../config.ts";
import { systemNotify } from "../notify.ts";

const EVENTS = fileURLToPath(new URL("../events.ts", import.meta.url));
function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "loop-pa-events-")), home = join(root, "home"), dir = join(root, "received"), config = join(root, "pa.json"), file = join(root, "batch.json");
  mkdirSync(home); mkdirSync(dir);
  writeFileSync(file, JSON.stringify({ name: "PA 测试", stages: { 甲: { cwd: root, prompt: "prompt.md" } } }));
  writeFileSync(config, JSON.stringify({ pa: { eventsDir: dir, localNotify: false } }));
  const old = { HOME: process.env.HOME, LOOP_PA_CONFIG: process.env.LOOP_PA_CONFIG };
  process.env.HOME = home; process.env.LOOP_PA_CONFIG = config;
  t.after(() => { for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } rmSync(root, { recursive: true, force: true }); });
  const info = batchInfo(file, root, join(home, ".pi-autoreview", "pipelines", "test"));
  const rows = () => readdirSync(dir).filter((name) => name.endsWith(".jsonl")).sort().flatMap((name) => readFileSync(join(dir, name), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)));
  return { root, home, dir, config, file, info, rows };
}

test("A1/A6：完整 v1 事件、逐批序号、进程重启不补发；同段暂停去重，恢复后可再暂停", (t) => {
  const h = fixture(t);
  pushEvent(h.info, "甲", "started", eventReason(), {}, { recipe: "develop" });
  const paused = () => pushEvent(h.info, "甲", "paused", eventReason("门禁环境阻塞", "environment"), { log: join(h.root, "gate.log") }, { next: "send", round: 1, repairs: 0 });
  paused(); paused();
  assert.equal(h.rows().length, 2);
  const first = h.rows()[0]; assert.deepEqual(Object.keys(first), ["v", "seq", "id", "at", "project", "batch", "stage", "status", "reason", "evidence", "detail"]);
  assert.equal(first.v, 1); assert.equal(first.seq, 1); assert.match(first.at, /Z$/); assert.equal(first.batch.recipe, "develop");
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `import {pushEvent,eventReason} from ${JSON.stringify(EVENTS)}; pushEvent(${JSON.stringify(h.info)},'甲','resumed',eventReason(),{}, {via:'auto'});`], { env: process.env, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr); paused();
  assert.deepEqual(h.rows().map((row) => row.seq), [1, 2, 3, 4]); assert.equal(h.rows()[3].status, "paused"); assert.equal(lastEventSeq(h.file), 4);
});

test("PA事件／完成去重：同一完成在队列通知和进程重启后仍去重，真实暂停恢复后同一提交可再次完成", (t) => {
  const h = fixture(t), detail = { scope: "整批", branch: "feat/same", commit: "same-commit", completion: "same-qualification" };
  const done = () => pushEvent(h.info, null, "done", eventReason(), {}, detail);
  done(); done();
  pushEvent(h.info, null, "queue", eventReason(), {}, { queueStatus: "pending" });
  pushEvent(h.info, null, "queue", eventReason(), {}, { queueStatus: "ready" });
  done();
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `import {pushEvent,eventReason} from ${JSON.stringify(EVENTS)}; pushEvent(${JSON.stringify(h.info)},null,'done',eventReason(),{},${JSON.stringify(detail)});`], { env: process.env, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(h.rows().filter((row) => row.status === "done").length, 1, "队列变化或重放不能制造第二次完成");
  pushEvent(h.info, null, "paused", eventReason("整批验收无法验收"), {}, { next: "resume" });
  pushEvent(h.info, null, "resumed", eventReason(), {}, { via: "user" });
  done(); done();
  assert.deepEqual(h.rows().filter((row) => row.status === "done").map((row) => row.detail.commit), ["same-commit", "same-commit"]);
  assert.deepEqual(h.rows().map((row) => row.seq), [1, 2, 3, 4, 5, 6]);
});

test("A7：只读接收目录不抛错，失败序号消耗且错误留在本机；恢复权限后接着编", (t) => {
  const h = fixture(t); chmodSync(h.dir, 0o500);
  try {
    assert.equal(pushEvent(h.info, "甲", "started"), undefined);
    const errors = readFileSync(join(eventsRoot(), "errors.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(errors[0].seq, 1); assert.match(errors[0].reason, /EACCES|EPERM/); assert.equal(lastEventSeq(h.file), 1);
  } finally { chmodSync(h.dir, 0o700); }
  pushEvent(h.info, "甲", "done", eventReason(), {}, { scope: "整批", commit: "abc" });
  assert.deepEqual(h.rows().map((row) => row.seq), [2]);
});

test("A9：两个批次并发追加，每行完整 JSON，各批次独立连续编号", async (t) => {
  const h = fixture(t), count = 35;
  const others = { ...h.info, batch: { ...h.info.batch, file: join(h.root, "other.json") } };
  await Promise.all([h.info, others].map((info) => new Promise<void>((done, fail) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", `import {pushEvent,eventReason} from ${JSON.stringify(EVENTS)}; for(let round=0;round<${count};round++) pushEvent(${JSON.stringify(info)},'甲','paused',eventReason('评审超时'),{}, {round,next:'send'});`], { env: process.env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = ""; child.stderr.on("data", (chunk) => { stderr += chunk; }); child.on("error", fail); child.on("exit", (code) => { try { assert.equal(code, 0, stderr); done(); } catch (error) { fail(error); } });
  })));
  const rows = h.rows(); assert.equal(rows.length, count * 2);
  for (const info of [h.info, others]) assert.deepEqual(rows.filter((row) => row.batch.file === info.batch.file).map((row) => row.seq), Array.from({ length: count }, (_, index) => index + 1));
});

test("无 eventsDir 不建事件状态；通知 false 不调用系统执行器但保留完整 stderr", async (t) => {
  const h = fixture(t); writeFileSync(h.config, JSON.stringify({ pa: { localNotify: false } }));
  assert.deepEqual(readPAConfig(), { localNotify: false });
  pushEvent(h.info, "甲", "started"); assert.equal(existsSync(eventsRoot()), false);
  let called = false, output = "";
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string) => { output += chunk; return true; }) as typeof process.stderr.write;
  try { await systemNotify("自动评审", "A. 保留\nB. 改动\n【需要你决定】", { exec: async () => { called = true; return { code: 0, stdout: "", stderr: "", killed: false }; } }); }
  finally { process.stderr.write = original; }
  assert.equal(called, false); assert.match(output, /A\. 保留\nB\. 改动\n【需要你决定】/);
  writeFileSync(h.config, "{}"); await systemNotify("测试", "默认通知", { exec: async () => { called = true; return { code: 0, stdout: "", stderr: "", killed: false }; } }); assert.equal(called, true);
});

test("暂停原因映射覆盖率：收集两个宿主、共享评审、验收与流水线的原因字符串，新增原因不能落到其他", () => {
  const reasons = new Set<string>();
  const patterns = [
    /\bpause\(ctx,\s*(?:state,\s*)?(["'`])([\s\S]*?)\1/g,
    /\bkind:\s*"paused",\s*reason:\s*(["'`])([\s\S]*?)\1/g,
    /\breturn\s*\{\s*reason:\s*(["'`])([\s\S]*?)\1/g,
    /\bfinish\(2,\s*(["'`])([\s\S]*?)\1/g,
    /(?:const INTERRUPTED|const USER_INPUT_CHANGED)\s*=\s*(["'`])([\s\S]*?)\1/g,
  ];
  for (const name of ["autoreview.ts", "hosts/review-hook.ts", "review.ts", "acceptance.ts", "pipeline.ts"]) {
    const source = readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), "utf8");
    for (const pattern of patterns) for (const match of source.matchAll(pattern)) reasons.add(match[2]);
  }
  // 条件分支中的两条，以及通过辅助函数返回到 pause 的固定原因。
  for (const reason of ["评审改动了工作区", "工作区或提交发生了变化", "候选或输入版本变化，原评审结果不能放行当前候选", "当前必需验收尚未通过，不能接力", "上游来源配置已移除，需要重新确认输入"]) reasons.add(reason);
  assert.ok(reasons.size >= 40, `仅收集到 ${reasons.size} 条原因，收集规则可能已失效`);
  assert.deepEqual([...reasons].filter((reason) => eventReason(reason).category === "其他"), [], "暂停原因未登记");
});

test("原因分类优先使用 FailureKind；大详情留绝对路径；损坏序号不能从头编", (t) => {
  const h = fixture(t);
  assert.deepEqual(eventReason("评审超时", "method"), { category: "方法", text: "评审超时" });
  const event = pushEvent(h.info, "甲", "needs-decision", eventReason("开发方需要你决定"), { bad: "relative.log" }, { next: "send", question: "问".repeat(5000) });
  assert.equal(event?.detail.next, "send"); assert.equal(event?.evidence.bad, undefined);
  assert.equal(JSON.parse(readFileSync(event!.evidence.detail, "utf8")).question.length, 5000);
  writeFileSync(join(eventsRoot(), `${batchEventKey(h.file)}.json`), "corrupt");
  assert.equal(pushEvent(h.info, "甲", "started"), undefined); assert.equal(h.rows().length, 1);
});

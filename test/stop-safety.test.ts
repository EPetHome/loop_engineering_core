/** 历史读取/安全停止仍保留；不通过停止或 PA 重新启动旧编排。 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fixture } from "./helpers/merge-queue-fixture.ts";
import { stopBatch } from "../stop.ts";
import { writePhase, phasePath } from "../events.ts";
import { processStartTime, releaseProcessTree } from "../procs.ts";
import { resumeBatch } from "../pa-resume.ts";
test("跨项目同名/复制批次不能认领别人的 PID、状态、队列或资源", async () => {
  const f = fixture(), child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" }), started = processStartTime(child.pid!);
  try { writePhase(f.info, "甲", "running", { session: { host: "pi", id: "original", pid: child.pid!, processStarted: started } }); const copied = join(f.root, "same-name.json"); writeFileSync(copied, readFileSync(f.oldFile)); const bytes = f.snapshot(); const out = await stopBatch(copied); assert.equal(out.ok, false); assert.deepEqual(f.snapshot(), bytes); assert.equal(processStartTime(child.pid!), started); } finally { assert.equal(releaseProcessTree({ pgid: child.pid!, started }), true); f.close(); }
});
test("历史独立会话停止预览只读；正式按 PID/启动时间停止并保留工作区及证据", async () => {
  const f = fixture(), child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" }), started = processStartTime(child.pid!);
  try { writePhase(f.info, "甲", "running", { session: { host: "pi", id: "original", pid: child.pid!, processStarted: started } }); const before = f.snapshot(); assert.equal((await stopBatch(f.oldFile, { dryRun: true })).ok, true); assert.deepEqual(f.snapshot(), before); const out = await stopBatch(f.oldFile); assert.equal(out.ok, true, JSON.stringify(out)); assert.equal(f.read().batches[0].stopped, true); assert.equal(f.read().entries[0].status, "stopped"); } finally { assert.equal(releaseProcessTree({ pgid: child.pid!, started }), true); f.close(); }
});
test("缺活动身份、共享终端组或启动时间不匹配不能冒充停止成功，不杀共享调用者", async () => {
  const f = fixture(); try { assert.equal((await stopBatch(f.oldFile)).ok, false); for (const session of [{ host: "pi", id: "self", pid: process.pid, processStarted: processStartTime(process.pid) }, { host: "pi", id: "wrong", pid: process.pid, processStarted: "wrong" }]) { writePhase(f.info, "甲", "running", { session }); const result = await stopBatch(f.oldFile); assert.equal(result.ok, false); assert.ok((result.skipped as any[]).length); } } finally { f.close(); }
});
test("旧未完成发布事务不由停止隐式恢复，原发布/私有 stash 事实保持", async () => {
  const f = fixture(); try { f.history.entries[0].status = "merging"; Object.assign(f.history.entries[0], { runtimePublication: "publishing", runtimeStash: { ref: "private", hash: "keep" } }); f.saveHistory(); const before = f.bytes(); await assert.rejects(stopBatch(f.oldFile), /旧发布.*人工核对/); assert.deepEqual(f.bytes(), before); } finally { f.close(); }
});
test("PA 旧续跑不派发、不替换活动 phase；请求去重保留迁移拒绝，不清零历史次数", async () => {
  const f = fixture(); try { writePhase(f.info, null, "paused", { next: "resume", repairs: 3 }); const phase = readFileSync(phasePath(f.info.dir, null)); let launches = 0; const options = { info: f.info, id: "legacy-request", launch: async () => { launches++; throw new Error("不得启动"); } }; const first = await resumeBatch(options), second = await resumeBatch(options); assert.equal(first.state, "rejected"); assert.match((first.reason as any).text, /旧批次.*已停用/); assert.deepEqual(second, first); assert.equal(launches, 0); assert.deepEqual(readFileSync(phasePath(f.info.dir, null)), phase); } finally { f.close(); }
});

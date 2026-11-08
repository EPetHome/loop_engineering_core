import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { eventLock } from "../events.ts";
import { processStartTime } from "../procs.ts";
import { fixture } from "./helpers/merge-queue-fixture.ts";
test("历史发布锁身份不明或另一个活 owner 持有时不删除；等待有界", () => {
  const f = fixture(); try { const file = join(f.info.dir, "test.lock"); for (const owner of [{}, { pid: process.pid, started: processStartTime(process.pid), token: "other" }]) { writeFileSync(file, JSON.stringify(owner)); const before = readFileSync(file); assert.throws(() => eventLock(file, 10), /身份不明|超时/); assert.deepEqual(readFileSync(file), before); } } finally { f.close(); }
});
test("旧 publishing/prepared/已发布意图均不由查询或旧合入重测/覆盖并发目标", () => {
  const f = fixture(); try { for (const phase of ["prepared", "publishing", "published"]) { Object.assign(f.history.entries[0], { status: "merging", runtimePublication: phase }); f.saveHistory(); f.refuse("合入"); f.refuse("合入", ["--dry-run"], true); } } finally { f.close(); }
});

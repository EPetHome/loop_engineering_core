import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fixture } from "./helpers/merge-queue-fixture.ts";
test("旧 gate 失败/写文件/挂起不被查询或旧发布触发；冲突上限不恢复旧派发", () => {
  const f = fixture(); try { for (const cmd of ["exit 1", `touch '${f.executed}'`, "sleep 999"]) { const file = join(f.repo, ".autoreview.json"), raw = JSON.parse(readFileSync(file, "utf8")); raw.gate = { cmd, timeoutMin: 1 }; writeFileSync(file, JSON.stringify(raw)); f.refuse("合入"); f.refuse("启动"); } assert.equal(f.read().entries[0].attempt, 0); } finally { f.close(); }
});

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { legacyFixture } from "./helpers/pipeline-fixture.ts";
test("旧启动失败/静默/暂停/并行分支不再启动任何段，也不覆盖已有状态或用户会话", () => {
  const f = legacyFixture();
  try {
    writeFileSync(join(f.repo, "existing.status.json"), JSON.stringify({ sessionId: "original", event: "paused", repairs: 3 }));
    for (const start of ["exit 1", "sleep 999", `touch '${f.executed}'`]) { f.raw.stages.甲.start = start; f.raw.stages.乙 = { cwd: f.repo, start }; f.save(); f.refuse("启动"); f.refuse("启动", ["--dry-run"], true); }
  } finally { f.cleanup(); }
});

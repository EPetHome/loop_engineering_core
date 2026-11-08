import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fixture } from "./helpers/merge-queue-fixture.ts";
test("旧撤回不执行反向 CAS 或 stash；待恢复事实与用户重叠改动保持原样", () => {
  const f = fixture(); try { writeFileSync(join(f.repo, "file.txt"), "user staged"); f.git(f.repo, "add", "file.txt"); writeFileSync(join(f.repo, "file.txt"), "unstaged"); for (const status of ["merged", "withdrawing", "withdrawn"] as const) { f.history.entries[0].status = status; f.saveHistory(); f.refuse("撤回"); f.refuse("撤回", ["--dry-run"]); assert.equal(readFileSync(join(f.repo, "file.txt"), "utf8"), "unstaged"); } } finally { f.close(); }
});

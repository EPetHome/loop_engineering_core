import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import test from "node:test";
import { fixture } from "./helpers/merge-queue-fixture.ts";
import { kernelFixture } from "./helpers/kernel-fixture.ts";
import { mergeManaged } from "../kernel-session.ts";
import { readRun } from "../node-ledger.ts";
test("旧整批验收/未归属/冲突不回退最后一段或重新开 pipeline，统一给迁移说明", () => {
  const f = fixture(); try { for (const acceptance of [true, false]) { f.history.batches[0].acceptance = acceptance; f.saveHistory(); f.refuse("启动"); f.refuse("续跑"); } } finally { f.close(); }
});
test("新提交节点缺真实验收证据仍不能发布，不用旧队列 done 补资格", async () => {
  const f = kernelFixture(["开发评审", "验收"]);
  try { const standard = join(f.repo, "验收.md"); writeFileSync(standard, "## 验收标准\nA1. [甲] 操作：读取文件\n预期：正确\n"); const c = { ...f.card, acceptance: "验收.md" }; writeFileSync(f.file, JSON.stringify(c)); f.git(f.repo, "add", "验收.md", "开发卡.json"); f.git(f.repo, "commit", "-qm", "acceptance card"); const path = f.start(); f.candidate(path); await assert.rejects(mergeManaged(path), /普通合入被拒绝/); assert.equal(readRun(path).publication, undefined); assert.equal(readRun(path).results.length, 0); } finally { f.cleanup(); }
});

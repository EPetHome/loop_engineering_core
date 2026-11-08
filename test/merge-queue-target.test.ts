/** 继承的旧 --release 实现随 C6 停用，不能迁成任意目标发布。 */
import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "../loop.ts";
import { fixture } from "./helpers/merge-queue-fixture.ts";
test("旧 --release 参数只保留迁移诊断；重复/错误动作仍拒绝", () => {
  assert.throws(() => parseArgs(["状态", "--release", "dev"]), /已停用/); assert.throws(() => parseArgs(["合入", "x", "--release", "dev", "--release", "main"]), /不能重复/);
  const f = fixture(); try { const main = f.git(f.repo, "rev-parse", "HEAD"); for (const target of ["dev", "main", "master", "arbitrary"]) for (const dry of [[], ["--dry-run"]]) { const out = f.refuse("合入", ["--release", target, ...dry]); assert.match(out.error, /只处理既定 dev.*不碰 main/); } assert.equal(f.git(f.repo, "rev-parse", "HEAD"), main); } finally { f.close(); }
});

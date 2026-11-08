/** 旧 e2e/acceptance 批次都迁移到新卡；项目执行器配置仍保持类型/默认值/相对路径。 */
import assert from "node:assert/strict";
import test from "node:test";
import { parseAcceptanceConfig } from "../config.ts";
import { legacyFixture } from "./helpers/pipeline-fixture.ts";
test("A1–A4 旧 e2e、平铺 acceptance、双写及旧续跑参数均拒绝，绝不重启段或验收", () => {
  const f = legacyFixture(); try { const acc = f.raw.acceptance; for (const input of [{ e2e: { acceptance: acc } }, { acceptance: acc }, { acceptance: acc, e2e: acc }]) { delete f.raw.acceptance; delete f.raw.e2e; Object.assign(f.raw, input); f.save(); f.refuse("启动"); f.pipeline("--from", "验收"); f.pipeline("--from", "e2e"); } } finally { f.cleanup(); }
});
test("项目验收配置仍解析完整类型、默认值、相对路径和独立时限", () => {
  const c = parseAcceptanceConfig({ timeoutMin: 90, guide: "guide.md", actions: "actions", env: { PORT: "1" } }, "/tmp/project", {})!;
  assert.equal(c.timeoutMin, 90); assert.equal(c.guide, "/tmp/project/guide.md"); assert.equal(c.actions, "/tmp/project/actions"); assert.equal(c.readyTimeoutSec, 60); assert.deepEqual(c.env, { PORT: "1" });
  for (const raw of [null, { timeoutMin: 0 }, { readyUrl: "file:///etc/passwd" }, { actions: "../outside" }, { env: { x: 1 } }]) assert.throws(() => parseAcceptanceConfig(raw, "/tmp/project", {}));
});

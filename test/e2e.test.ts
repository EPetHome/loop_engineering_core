/** S1：联调断言必须拒绝「未解析」模板及失败轮，不能用固定文字证明成功。 */
import assert from "node:assert/strict";
import test from "node:test";
import { hasParsedLatestRound } from "./e2e.mjs";

test("S1 R5/R6 结构化断言不再假绿", () => {
  assert.equal(hasParsedLatestRound(undefined), false);
  assert.equal(hasParsedLatestRound({ rounds: [] }), false);
  assert.equal(hasParsedLatestRound({ rounds: [{ conclusion: "", failed: "两次无法解析" }] }), false);
  assert.equal(hasParsedLatestRound({ rounds: [{ conclusion: "未解析" }] }), false);
  assert.equal(hasParsedLatestRound({ rounds: [{ conclusion: "通过", failed: "失败" }] }), false);
  assert.equal(hasParsedLatestRound({ rounds: [{ conclusion: "通过" }, { conclusion: "", failed: "失败" }] }), false);
  assert.equal(hasParsedLatestRound({ rounds: [{ conclusion: "通过" }] }), true);
  assert.equal(hasParsedLatestRound({ rounds: [{ conclusion: "需返修" }] }), true);
});

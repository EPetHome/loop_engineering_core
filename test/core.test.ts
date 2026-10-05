/**
 * core.ts 单测（T1–T10）。
 * 运行：PATH="/Users/Admin/.hermes/node/bin:$PATH" node --test test/core.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  CONVENTION,
  MAX_DIFF_BYTES,
  buildRepairMessage,
  buildReviewInput,
  classifyMarker,
  decideNext,
  parseReview,
  renderSummary,
  type RoundRecord,
  type SummaryInput,
} from "../core.ts";

test("T1 标准格式：两条必修、小问题、需求疑问正确取出", () => {
  const output = `## 结论：需返修
## 必修
1. 位置：calc.py:2
   问题：add 用了减法
   依据：需求第 1 条
   建议：改成加法
2. 位置：test_calc.py:1-3
   问题：没有断言
   依据：可复现错误
   建议：补断言
## 小问题
- 命名可以更清楚
## 需求疑问
- 是否需要支持负数？
## 上轮必修复查
- 无
`;
  const result = parseReview(output);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.review.conclusion, "需返修");
  assert.equal(result.review.mustFix.length, 2);
  assert.match(result.review.mustFix[0], /add 用了减法/);
  assert.match(result.review.mustFix[1], /没有断言/);
  assert.deepEqual(result.review.minor, ["命名可以更清楚"]);
  assert.deepEqual(result.review.questions, ["是否需要支持负数？"]);
  assert.equal(result.review.note, undefined);
});

test("T2 必修一节只有「无」：0 条", () => {
  const output = `## 结论：通过
## 必修
无
## 小问题
- 无
## 需求疑问
- 无
## 上轮必修复查
无
`;
  const result = parseReview(output);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.review.mustFix.length, 0);
  assert.deepEqual(result.review.minor, []);
});

test("T3 缺「## 必修」标题：解析失败", () => {
  const output = `## 结论：通过
## 小问题
- 无
`;
  const result = parseReview(output);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /必修/);
});

test("T4 结论写「通过」但有 1 条必修：按 1 条处理并带矛盾提示", () => {
  const output = `## 结论：通过
## 必修
1. 位置：a.py:1
   问题：坏的
## 小问题
- 无
## 需求疑问
- 无
## 上轮必修复查
- 无
`;
  const result = parseReview(output);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.review.mustFix.length, 1);
  assert.ok(result.review.note && result.review.note.includes("通过") && result.review.note.includes("1 条必修"));
});

test("T5 交付标记只看最后一个非空行", () => {
  assert.equal(classifyMarker("做完了。\n【交付完成】"), "delivered");
  assert.equal(classifyMarker("需要你决定：选 A 还是 B\n【需要你决定】"), "decision");
  assert.equal(classifyMarker("普通回复，没有任何标记"), "none");
  assert.equal(classifyMarker("【交付完成】\n然后又补充了一句"), "none");
  assert.equal(classifyMarker(""), "none");
});

test("T6 下一步决策", () => {
  assert.equal(decideNext(2, 0, 3), "repair");
  assert.equal(decideNext(2, 2, 3), "repair");
  assert.equal(decideNext(2, 3, 3), "pause");
  assert.equal(decideNext(0, 3, 3), "done");
});

test("T7 返修消息：含必修原文和第几次返修、结尾要求，不含小问题", () => {
  const parsed = parseReview("## 结论：需返修\n## 必修\n1. 位置：a.py:1\n   问题：坏的\n## 小问题\n- 小问题条目不该出现\n");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.review.minor, ["小问题条目不该出现"]);
  const message = buildRepairMessage(2, parsed.review.mustFixRaw);
  assert.ok(message.startsWith("【自动评审 · 第 2 次返修】"));
  assert.ok(message.includes("1. 位置：a.py:1"));
  assert.ok(message.includes("坏的"));
  assert.ok(message.includes("【交付完成】"));
  assert.ok(!message.includes("小问题条目不该出现"));
});

test("T8 评审输入：第 1 轮有需求原文；第 2 轮有上一轮必修与开发方回应", () => {
  const round1 = buildReviewInput({
    round: 1,
    requirement: "修复 add 的减法错误",
    deliveryNote: "已修复并自测通过",
    diff: "diff --git a/calc.py b/calc.py\n-    return a - b\n+    return a + b",
    diffStat: " calc.py | 2 +-",
    untracked: ["test_calc.py"],
  });
  assert.ok(round1.includes("## 需求原文"));
  assert.ok(round1.includes("修复 add 的减法错误"));
  assert.ok(round1.includes("## 开发方交付说明"));
  assert.ok(round1.includes("test_calc.py"));

  const round2 = buildReviewInput({
    round: 2,
    requirement: "修复 add 的减法错误",
    deliveryNote: "第 1 条：已修",
    previousMustFix: "1. 位置：calc.py:2\n   问题：add 用了减法",
    diff: "diff --git a/calc.py b/calc.py\n-    return a - b\n+    return a + b",
    diffStat: " calc.py | 2 +-",
    untracked: [],
  });
  assert.ok(!round2.includes("## 需求原文"));
  assert.ok(round2.includes("## 上一轮必修"));
  assert.ok(round2.includes("add 用了减法"));
  assert.ok(round2.includes("## 开发方最新回复"));
  assert.ok(round2.includes("第 1 条：已修"));
  const retry = buildReviewInput({
    round: 3, firstReview: true, requirement: "首轮未成功时重送需求",
    deliveryNote: "重试", diff: "+未审改动", diffStat: "", untracked: [],
  });
  assert.ok(retry.includes("## 需求原文") && retry.includes("首轮未成功时重送需求"));
  const manual = buildReviewInput({ round: 1, deliveryNote: "", diff: "", diffStat: "", untracked: [] });
  assert.ok(manual.includes("本会话没有记录需求原文（手动 /review），请按改动本身和项目文档评审"));
});

test("T9 diff 超过 200KB：只给 stat 和文件列表并提示", () => {
  const huge = "x".repeat(MAX_DIFF_BYTES + 1);
  const input = buildReviewInput({
    round: 1,
    requirement: "需求",
    deliveryNote: "说明",
    diff: huge,
    diffStat: " big.py | 9999 +++---",
    untracked: ["new.py"],
  });
  assert.ok(!input.includes(huge.slice(0, 1000)));
  assert.ok(input.includes("big.py | 9999 +++---"));
  assert.ok(input.includes("改动太大，请自己读文件"));
  assert.ok(input.includes("new.py"));
});

function roundRecord(overrides: Partial<RoundRecord>): RoundRecord {
  return {
    round: 1,
    startedAt: "2026-10-04 10:00:00",
    durationMs: 12_000,
    conclusion: "通过",
    mustFixRaw: "无",
    mustFix: [],
    minor: [],
    questions: [],
    recheck: [],
    ...overrides,
  };
}

function summaryInput(overrides: Partial<SummaryInput>): SummaryInput {
  return {
    cwd: "/tmp/project",
    devSessionId: "dev-1",
    reviewerSessionId: "autoreview-rev-dev-1",
    status: "完成",
    rounds: [roundRecord({})],
    repairs: 0,
    gitStatusShort: " M calc.py",
    ...overrides,
  };
}

test("T10 总结渲染：完成 / 暂停（达到上限）/ 暂停（评审失败）", () => {
  const done = renderSummary(summaryInput({ status: "完成" }));
  assert.ok(done.includes("- 状态：完成"));
  assert.ok(!done.includes("## 未解决的必修"));
  assert.ok(done.includes("## 改动文件（git status --short）"));

  const capped = renderSummary(
    summaryInput({
      status: "暂停",
      pauseReason: "达到返修上限",
      repairs: 3,
      unresolvedMustFix: "1. 位置：calc.py:2\n   问题：add 用了减法",
      rounds: [
        roundRecord({
          mustFixRaw: "1. 位置：calc.py:2\n   问题：add 用了减法",
          mustFix: ["位置：calc.py:2 问题：add 用了减法"],
          conclusion: "需返修",
        }),
      ],
    }),
  );
  assert.ok(capped.includes("- 状态：暂停（达到返修上限）"));
  assert.ok(capped.includes("## 未解决的必修"));
  assert.ok(capped.includes("add 用了减法"));
  assert.ok(capped.includes("- 评审 1 次，返修 3 次"));

  const failed = renderSummary(
    summaryInput({
      status: "暂停",
      pauseReason: "评审失败",
      rounds: [roundRecord({ conclusion: "", mustFixRaw: "", failed: "第 2 次评审退出码 1" })],
    }),
  );
  assert.ok(failed.includes("- 状态：暂停（评审失败）"));
  assert.ok(!failed.includes("## 未解决的必修"));
  assert.ok(failed.includes("第 2 次评审退出码 1"));
});

test("T11 开发约定：标记可选、改动也会自动评审", () => {
  assert.ok(CONVENTION.includes("【自动评审约定】"));
  assert.ok(CONVENTION.includes("交付时最后一行写【交付完成】，评审会立即开始；不写的话，程序检测到改动也会自动评审。"));
  assert.ok(CONVENTION.includes("需要用户决定时，最后一行写【需要你决定】。"));
  assert.ok(CONVENTION.includes("第 N 条：已修"));
  assert.ok(CONVENTION.includes("第 N 条：异议：理由"));
});

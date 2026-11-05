/** 交付总表：结果索引、历史字节、追加与并发；所有产物只写 os.tmpdir()。 */
import "./helpers/git-runtime.ts";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AcceptanceRecord } from "../acceptance-core.ts";
import {
  appendBatchCommitRecord, appendLedgerRecord, appendMergeRecord, appendMissRecord, appendPARelayRecord,
  deliveryLedgerPath, pendingItems, projectRootOf, renderLedgerRecord, resultLine, taskTitle,
} from "../ledger.ts";

const tempDir = (): string => mkdtempSync(join(tmpdir(), "autoreview-ledger-"));
const record = (overrides: Partial<AcceptanceRecord> = {}): AcceptanceRecord => ({
  verdict: "部分验证", items: [], logErrors: [], extra: [], runDir: "/run", durationMs: 0, ...overrides,
});

test("A4/L1 新段只记录项目、任务、结果、总结与欠项；人工和部分验证仍有未勾选框", () => {
  const pending = pendingItems(record({ items: [
    { id: "A1", text: "操作：a", verdict: "通过", detail: "" },
    { id: "A4", text: "操作：b", verdict: "无法验证", detail: "原因：标准写得含糊", cause: "其他" },
    { id: "A10", text: "[人工] 操作：c", verdict: "需人工", detail: "标了 [人工]" },
  ] }));
  assert.deepEqual(pending, [{ id: "A4", kind: "部分验证", reason: "标准写得含糊" }, { id: "A10", kind: "人工" }]);
  const text = renderLedgerRecord({
    at: new Date(2026, 9, 19, 3, 12), project: "/project", session: "01a15257", task: "03三项必修",
    result: "完成（部分验证）；评审 3 次，返修 2 次", summary: "/state/01a15257.md", pending,
  });
  assert.equal(text, [
    "## 2026-10-19 03:12 · /project · 会话 01a15257", "- 任务：03三项必修",
    "- 结果：完成（部分验证）；评审 3 次，返修 2 次", "- 门禁：没有记录；评审：没有记录；验收：没有记录",
    "- 交付报告：/state/01a15257.md", "- 总结：/state/01a15257.md",
    "- [ ] A4 部分验证：标准写得含糊", "- [ ] A10 人工", "",
  ].join("\n"));
  assert.doesNotMatch(text, /已回写原单/);
  const complete = renderLedgerRecord({ project: "/p", session: "s", task: "t", result: "完成", summary: "/s.md", pending: [] });
  assert.match(complete, /- 总结：\/s.md\n$/); assert.doesNotMatch(complete, /\[ \]/);
  assert.equal(resultLine(undefined, 1, 0), "完成；评审 1 次，返修 0 次");
  assert.equal(resultLine(record(), 2, 1), "完成（部分验证）；评审 2 次，返修 1 次");
});

test("交付总表／历史结论：区分明确无验收欠项与历史未知，未知不能显示成全部通过", () => {
  const explicit = { failed: [], partial: [], manual: [] };
  assert.deepEqual(pendingItems(undefined, explicit), []); assert.equal(resultLine(undefined, 2, 0, explicit), "完成；评审 2 次，返修 0 次");
  assert.deepEqual(pendingItems(undefined, null), [{ id: "验收结论", kind: "部分验证", reason: "历史队列缺少验收结论；免重复评审未补做验收" }]);
  assert.equal(resultLine(undefined, 2, 0, null), "完成（部分验证）；评审 2 次，返修 0 次");
});

test("L2 任务名取需求第一个标题，没有标题取前 40 字", () => {
  assert.equal(taskTitle("# 03三项必修\n\n正文"), "03三项必修");
  assert.equal(taskTitle("说明\n\n## 交付总表\n正文"), "交付总表");
  assert.equal(taskTitle("```md\n# 不是标题\n```\n# 真标题"), "真标题");
  assert.equal(taskTitle("修复 add 的错误，新建 test_calc.py"), "修复 add 的错误，新建 test_calc.py");
  assert.equal(taskTitle("修复 add 的错误，新建 test_calc.py 并用 python3 运行通过。"), "修复 add 的错误，新建 test_calc.py 并用 python3 运行…");
  assert.equal(taskTitle("自动评审总表\n## 验收标准\n1. 操作：a"), "自动评审总表");
  assert.equal(taskTitle("一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十多出来的部分"), "一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十…");
  assert.equal(taskTitle(""), "未记录任务");
  assert.equal(taskTitle('<file name="/tmp/需求.md">\n# 需求\n</file>'), "需求");
});

test("L3 总表只追加、不覆盖；写入失败由调用方处理", () => {
  const root = tempDir();
  try {
    const file = join(root, "sub", "交付记录.md");
    const base = { project: "/p", session: "s1", task: "t", result: "完成", summary: "/s.md", pending: [] };
    assert.equal(appendLedgerRecord(base, file), file); appendLedgerRecord({ ...base, session: "s2" }, file);
    const text = readFileSync(file, "utf8");
    assert.equal(text.match(/^## /gm)?.length, 2); assert.match(text, /s1[\s\S]*s2/);
    assert.ok(text.startsWith("## ")); assert.ok(!text.includes("\n\n\n")); assert.ok(text.endsWith("\n\n"));
    const blocked = join(root, "dir.md"); mkdirSync(blocked);
    assert.throws(() => appendLedgerRecord(base, blocked));
    assert.match(deliveryLedgerPath(), /\.pi-autoreview[\\/]交付记录\.md$/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("A5 历史勾选与原文逐字节保留；完成、合入、批次、漏网、PA 新段都不生成回写勾", () => {
  const root = tempDir();
  try {
    const file = join(root, "交付记录.md"), old = Buffer.from("## 2026-10-19 03:12 · /p · 会话 old\r\n- [ ] 已回写原单\r\n- [x] A1 人工\r\n原文\r\n\r\n");
    writeFileSync(file, old);
    const base = { project: "/p", session: "s", task: "t", result: "完成", summary: "/s.md", pending: [] };
    appendLedgerRecord(base, file);
    appendMergeRecord({ project: "/p", batch: "b", entry: "e", commit: "head", file: "/batch.json", manual: [{ id: "A1", text: "[人工] 看页面", detail: "待用户验" }] }, file);
    appendBatchCommitRecord({ project: "/p", batch: "b", entry: "e", file: "/batch.json", commits: [], conclusions: ["门禁通过"], pending: [{ id: "A2", text: "部分验证", detail: "待核对" }] }, file);
    appendMissRecord({ project: "/p", session: "s", round: 1, defect: "问题", discovery: "静态核对", summary: "/s.md", snapshot: null, draft: "/draft.json" }, file);
    appendPARelayRecord({ project: "/p", session: "s", summary: "/s.md", source: { id: "m1", at: "now", input: 1 } }, file);
    const text = readFileSync(file), next = text.subarray(old.length).toString();
    assert.deepEqual(text.subarray(0, old.length), old);
    assert.doesNotMatch(next, /已回写原单|待回写/);
    assert.match(next, /- \[ \] A1 人工/); assert.match(next, /- \[ \] A2 待验/);
    assert.equal((next.match(/^## /gm) ?? []).length, 5);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("L6 两个会话同时完成：80 段均完整，不交错", async () => {
  const root = tempDir();
  try {
    const file = join(root, "交付记录.md"), script = join(root, "append.mjs");
    writeFileSync(script, `
import { appendLedgerRecord } from ${JSON.stringify(new URL("../ledger.ts", import.meta.url).href)};
const [file, session, marker] = process.argv.slice(2);
for (let i = 0; i < 40; i += 1) {
  appendLedgerRecord({ project: "/repo/a", session: \`\${session}-\${i}\`, task: marker.repeat(200), result: "完成", summary: "/s.md", pending: [] }, file);
}
`);
    const run = (session: string, marker: string) => new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, [script, file, session, marker], { stdio: "inherit" });
      child.on("exit", (code) => resolve(code));
    });
    assert.deepEqual(await Promise.all([run("s1", "甲"), run("s2", "乙")]), [0, 0]);
    const text = readFileSync(file, "utf8").trimEnd(), blocks = text.split("\n\n").filter(Boolean);
    assert.equal(blocks.length, 80);
    for (const block of blocks) {
      assert.equal(block.split("\n").length, 6, block.slice(0, 80));
      assert.ok(!/^## /m.test(block.split("\n").slice(1).join("\n")));
    }
    assert.equal((text.match(/会话 s1-/g) ?? []).length, 40); assert.equal((text.match(/会话 s2-/g) ?? []).length, 40);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("L7 项目路径：Git 顶层目录而不是子目录，非 Git 使用真实目录", () => {
  const root = tempDir();
  try {
    assert.equal(projectRootOf(root), realpathSync(root));
    const repo = join(root, "repo"), sub = join(repo, "sub"); mkdirSync(sub, { recursive: true });
    const run = spawnSync("git", ["init", "-q"], { cwd: repo, encoding: "utf8" }); assert.equal(run.status, 0);
    assert.equal(projectRootOf(sub), projectRootOf(repo)); assert.ok(projectRootOf(sub).endsWith("/repo"));
    assert.equal(existsSync(join(sub, ".git")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

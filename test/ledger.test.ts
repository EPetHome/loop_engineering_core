/** 交付总表：格式、追加、提醒、并发；所有产物只写 os.tmpdir()。 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AcceptanceRecord } from "../acceptance-core.ts";
import {
  appendLedgerRecord, deliveryLedgerPath, parseLedger, pendingItems, pendingWritebackCount, projectRootOf,
  readLedgerForReminder, renderLedgerRecord, resultLine, taskTitle, writebackReminder,
} from "../ledger.ts";

const tempDir = (): string => mkdtempSync(join(tmpdir(), "autoreview-ledger-"));

const record = (overrides: Partial<AcceptanceRecord> = {}): AcceptanceRecord => ({
  verdict: "部分验证", items: [], logErrors: [], extra: [], runDir: "/run", durationMs: 0, ...overrides,
});

test("L1 总表一段的格式：项目、任务、结果、总结、待回写和欠项", () => {
  const pending = pendingItems(record({
    items: [
      { id: "A1", text: "操作：a", verdict: "通过", detail: "" },
      { id: "A4", text: "操作：b", verdict: "无法验证", detail: "原因：标准写得含糊", cause: "其他" },
      { id: "A10", text: "[人工] 操作：c", verdict: "需人工", detail: "标了 [人工]" },
    ],
  }));
  assert.deepEqual(pending, [
    { id: "A4", kind: "部分验证", reason: "标准写得含糊" },
    { id: "A10", kind: "人工" },
  ]);
  const text = renderLedgerRecord({
    at: new Date(2026, 9, 19, 3, 12), project: "/Users/Admin/Desktop/Promate/dev分支", session: "01a15257",
    task: "03三项必修", result: "完成（部分验证）；评审 3 次，返修 2 次", summary: "/Users/Admin/.pi-autoreview/dev分支/01a15257.md", pending,
  });
  assert.equal(text, [
    "## 2026-10-19 03:12 · /Users/Admin/Desktop/Promate/dev分支 · 会话 01a15257",
    "- 任务：03三项必修",
    "- 结果：完成（部分验证）；评审 3 次，返修 2 次",
    "- 总结：/Users/Admin/.pi-autoreview/dev分支/01a15257.md",
    "- [ ] 已回写原单",
    "- [ ] A4 部分验证：标准写得含糊",
    "- [ ] A10 人工",
    "",
  ].join("\n"));
  // 没有欠项时只写「已回写原单」。
  assert.match(renderLedgerRecord({ project: "/p", session: "s", task: "t", result: "完成", summary: "/s.md", pending: [] }),
    /- \[ \] 已回写原单\n$/);
  assert.equal(resultLine(undefined, 1, 0), "完成；评审 1 次，返修 0 次");
  assert.equal(resultLine(record(), 2, 1), "完成（部分验证）；评审 2 次，返修 1 次");
});

test("L2 任务名取需求第一个标题，没有标题取前 40 字", () => {
  assert.equal(taskTitle("# 03三项必修\n\n正文"), "03三项必修");
  assert.equal(taskTitle("说明\n\n## 交付总表与收尾回写\n正文"), "交付总表与收尾回写");
  assert.equal(taskTitle("```md\n# 不是标题\n```\n# 真标题"), "真标题");
  assert.equal(taskTitle("修复 add 的错误，新建 test_calc.py"), "修复 add 的错误，新建 test_calc.py");
  assert.equal(taskTitle("修复 add 的错误，新建 test_calc.py 并用 python3 运行通过。"), "修复 add 的错误，新建 test_calc.py 并用 python3 运行…");
  // 「## 验收标准」不是任务标题；没有别的标题时取需求前 40 字。
  assert.equal(taskTitle("自动评审总表\n## 验收标准\n1. 操作：a"), "自动评审总表");
  assert.equal(taskTitle("一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十多出来的部分"), "一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十…");
  assert.equal(taskTitle(""), "未记录任务");
  // 用户消息里的文件包裹不算任务名。
  assert.equal(taskTitle('<file name="/tmp/需求.md">\n# 需求\n</file>'), "需求");
});

test("L3 总表只追加、不覆盖；读取失败或超限时提醒跳过", () => {
  const root = tempDir();
  try {
    const file = join(root, "sub", "交付记录.md");
    const base = { project: "/p", session: "s1", task: "t", result: "完成", summary: "/s.md", pending: [] };
    assert.equal(appendLedgerRecord(base, file), file);
    appendLedgerRecord({ ...base, session: "s2" }, file);
    const text = readFileSync(file, "utf8");
    assert.equal(text.match(/^## /gm)?.length, 2);
    assert.match(text, /s1[\s\S]*s2/);
    assert.ok(text.startsWith("## "), "第一段前没有空行");
    assert.ok(!text.includes("\n\n\n"), "段之间只空一行");
    assert.ok(text.endsWith("\n\n"), "每段自带结尾空行，追加时不需读旧内容");
    assert.equal(readLedgerForReminder(file), text);
    assert.equal(readLedgerForReminder(join(root, "没有这个文件.md")), undefined);
    assert.equal(readLedgerForReminder(file, 10), undefined, "过大时跳过");
    mkdirSync(join(root, "dir.md"));
    assert.equal(readLedgerForReminder(join(root, "dir.md")), undefined, "不是普通文件时跳过");
    // 不可写：直接抛错，由调用方提示，不影响会话完成。
    assert.throws(() => appendLedgerRecord(base, join(root, "dir.md")));
    assert.match(deliveryLedgerPath(), /\.pi-autoreview[\\/]交付记录\.md$/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("L4 提醒只看本项目、只看同一会话最后一段", () => {
  const text = [
    "## 2026-10-19 03:12 · /repo/a · 会话 s1", "- [ ] 已回写原单", "",
    "## 2026-10-19 03:20 · /repo/a · 会话 s2", "- [ ] 已回写原单", "",
    "## 2026-10-19 03:30 · /repo/a · 会话 s1", "- [x] 已回写原单", "",
    "## 2026-10-19 03:40 · /repo/b · 会话 s3", "- [ ] 已回写原单", "",
    "## 格式不对的一段", "",
  ].join("\n");
  assert.equal(pendingWritebackCount(text, "/repo/a"), 1, "s1 的最后一段已勾，不算；s2 未勾");
  assert.equal(pendingWritebackCount(text, "/repo/b"), 1);
  assert.equal(pendingWritebackCount(text, "/repo/c"), 0);
  assert.equal(pendingWritebackCount("", "/repo/a"), 0);
  assert.equal(pendingWritebackCount("## 2026-10-19 03:12 · /repo/a · 会话 s1\n- 任务：x\n", "/repo/a"), 0, "没有已回写行不提醒");
  assert.equal(writebackReminder(text, "/repo/a", "/tmp/交付记录.md"),
    "交付总表里本项目有 1 段待回写原单：/tmp/交付记录.md。按 .autoreview/CONVENTIONS.md「收尾回写」处理。");
  assert.equal(writebackReminder(text, "/repo/c"), undefined);
  // 没有 Git 时项目路径记当前目录；项目路径按真实路径比较。
  const root = tempDir();
  try {
    assert.equal(projectRootOf(root), realpathSync(root));
    const same = `## 2026-10-19 03:12 · ${root} · 会话 s1\n- [ ] 已回写原单\n`;
    assert.equal(pendingWritebackCount(same, root), 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("L5 解析：勾选状态、旧式段、重复标题都兼容", () => {
  const text = [
    "## 2026-10-19 03:12 · /repo/a · 会话 s1", "- [ ] 已回写原单", "- [ ] A4 部分验证：原因", "",
    "## 2026-10-19 03:13 · /repo/a · 会话 s1", "- [x] 已回写原单", "",
  ].join("\n");
  const segments = parseLedger(text);
  assert.deepEqual(segments.map((segment) => [segment.session, segment.writeback]), [["s1", "unchecked"], ["s1", "checked"]]);
  assert.equal(parseLedger("# 只有标题\n").length, 0);
});

test("L6 两个会话同时完成：两段都完整，不交错", async () => {
  const root = tempDir();
  try {
    const file = join(root, "交付记录.md");
    const script = join(root, "append.mjs");
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
    const text = readFileSync(file, "utf8").trimEnd();
    const segments = parseLedger(text);
    assert.equal(segments.length, 80);
    // 每段 5 行（标题、任务、结果、总结、已回写），两个进程的段都完整且没有交错。
    const blocks = text.split("\n\n").filter(Boolean);
    assert.equal(blocks.length, 80);
    for (const block of blocks) {
      assert.equal(block.split("\n").length, 5, block.slice(0, 80));
      assert.ok(!/^## /m.test(block.split("\n").slice(1).join("\n")), "段中间不能出现另一段的标题");
    }
    assert.equal(segments.filter((segment) => segment.session.startsWith("s1-")).length, 40);
    assert.equal(segments.filter((segment) => segment.session.startsWith("s2-")).length, 40);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("L7 项目路径：Git 顶层目录而不是子目录", () => {
  const root = tempDir();
  try {
    const repo = join(root, "repo"), sub = join(repo, "sub");
    mkdirSync(sub, { recursive: true });
    const run = spawnSync("git", ["init", "-q"], { cwd: repo, encoding: "utf8" });
    assert.equal(run.status, 0);
    assert.equal(projectRootOf(sub), projectRootOf(repo));
    assert.ok(projectRootOf(sub).endsWith("/repo"));
    assert.equal(existsSync(join(sub, ".git")), false, "子目录不是 Git 顶层");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

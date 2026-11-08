/** 旧开工/合入回写迁移后仍保留问题单原文、归档文件安全与并发保护。 */
import assert from "node:assert/strict";
import { chmodSync, linkSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { regularFile, stateField, writeIssue } from "../issue-writeback.ts";
import { legacyFixture } from "./helpers/pipeline-fixture.ts";
test("旧 issues 卡不开工/回写/自动关单；CRLF、正文状态行与外部引用原文不变", () => {
  const f = legacyFixture(); try { const file = join(f.repo, "问题.md"), original = "# 原单\r\n状态：待修复\r\n## 问题描述\r\n状态：正文不是单头\r\n"; writeFileSync(file, original); f.raw.issues = [file, join(f.root, "outside.md")]; f.save(); f.refuse("开工"); f.refuse("合入"); assert.equal(readFileSync(file, "utf8"), original); assert.equal(stateField(original)[0], "状态：待修复"); } finally { f.cleanup(); }
});
test("实际归档共用文件操作拒绝缺失、只读、链接、父目录链接及硬链接", () => {
  const f = legacyFixture(); try { const file = join(f.root, "issue.md"), dir = join(f.root, "dir"); writeFileSync(file, "old"); mkdirSync(dir); symlinkSync(file, join(f.root, "link")); symlinkSync(dir, join(f.root, "parent-link")); writeFileSync(join(dir, "child.md"), "child"); linkSync(file, join(f.root, "hard")); for (const p of [join(f.root, "missing"), join(f.root, "link"), join(f.root, "parent-link/child.md"), join(f.root, "hard")]) assert.throws(() => regularFile(p, true)); const readOnly = join(f.root, "readonly.md"); writeFileSync(readOnly, "preserve"); chmodSync(readOnly, 0o444); assert.throws(() => writeIssue(readOnly, "new", "preserve"), /只读/); assert.equal(readFileSync(file, "utf8"), "old"); } finally { f.cleanup(); }
});
test("问题单原文 CAS 不吞并发正文或用户关单；重复/正文状态不作单头", () => {
  const f = legacyFixture(); try { const file = join(f.root, "issue.md"); writeFileSync(file, "user new"); assert.throws(() => writeIssue(file, "program", "old"), /期间变化/); assert.equal(readFileSync(file, "utf8"), "user new"); for (const text of ["# 单\n## 正文\n状态：已解决", "# 单\n状态：待修\n状态：已解决\n## 正文"]) assert.throws(() => stateField(text), /唯一/); } finally { f.cleanup(); }
});

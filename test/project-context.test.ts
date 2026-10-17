import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { contextDir, parseContext, recordProjectOutcome, refreshContext } from '../project-context.ts';

test('来源哈希只更新变化；代码变化不改已确认输入，依赖变更可定位且旧内容可回看', () => {
  const root = mkdtempSync(join(tmpdir(), 'autoreview-context-'));
  const old = process.env.AUTOREVIEW_PROJECTS_ROOT;
  process.env.AUTOREVIEW_PROJECTS_ROOT = join(root, 'store');
  const project = join(root, 'project'); mkdirSync(project);
  try {
    writeFileSync(join(project, 'AGENTS.md'), '# 稳定规则\n不自动修改。\n');
    writeFileSync(join(project, '需求.md'), '# 需求\n保存旧作者。\n');
    writeFileSync(join(project, '方案.md'), '# 方案\n依照需求。\n');
    writeFileSync(join(project, 'app.ts'), 'export function saveAuthor() {}\n');
    const config = parseContext({ sources: [
      { path: 'AGENTS.md', role: 'rules' },
      { id: 'need', path: '需求.md', role: 'requirement' },
      { id: 'design', path: '方案.md', role: 'design', dependsOn: ['need'] },
      { path: 'app.ts', role: 'code' },
    ] }, project)!;
    const first = refreshContext(config, 'saveAuthor');
    assert.equal(first.snapshot.revision, 1);
    assert.match(first.text, /saveAuthor:1/);
    const stamp = statSync(first.path).mtimeMs;
    assert.equal(refreshContext(config).changed, false);
    assert.equal(statSync(first.path).mtimeMs, stamp);
    writeFileSync(join(project, 'app.ts'), 'export function saveAuthor(value: string) {}\n');
    const code = refreshContext(config);
    assert.equal(code.snapshot.inputsFingerprint, first.snapshot.inputsFingerprint);
    writeFileSync(join(project, '需求.md'), '# 需求\n保存旧作者和固定提交。\n');
    const changed = refreshContext(config);
    assert.notEqual(changed.snapshot.inputsFingerprint, first.snapshot.inputsFingerprint);
    assert.ok(changed.affected.includes('need') && changed.affected.includes('design'));
    const original = first.snapshot.files.find((f) => f.source === 'need')!;
    assert.equal(readFileSync(join(contextDir(config), 'contents', original.hash), 'utf8'), '# 需求\n保存旧作者。\n');
    assert.throws(() => recordProjectOutcome(config, 'task', 'done', '/summary', first.snapshot.inputsFingerprint), /来源变化/);
    recordProjectOutcome(config, 'task', 'done', '/summary', changed.snapshot.inputsFingerprint);
    const journal = readFileSync(join(contextDir(config), 'changes.jsonl'), 'utf8');
    recordProjectOutcome(config, 'task', 'done', '/summary', changed.snapshot.inputsFingerprint);
    assert.equal(readFileSync(join(contextDir(config), 'changes.jsonl'), 'utf8'), journal);
    const metadata = structuredClone(config);
    metadata.sources.find((s) => s.id === 'design')!.dependsOn = [];
    const changedDefinition = refreshContext(metadata);
    assert.ok(changedDefinition.changed && changedDefinition.affected.includes('design'));
    assert.match(readFileSync(join(contextDir(config), 'changes.jsonl'), 'utf8'), /"sourceChanges":\["design"\]/);
    rmSync(join(project, '需求.md'));
    const deleted = refreshContext(config);
    assert.deepEqual(deleted.snapshot.missing, ['需求.md']);
    assert.ok(deleted.changes.some((c) => c.path === '需求.md' && c.kind === 'deleted'));
    assert.equal(readFileSync(join(project, 'AGENTS.md'), 'utf8'), '# 稳定规则\n不自动修改。\n');
  } finally {
    if (old === undefined) delete process.env.AUTOREVIEW_PROJECTS_ROOT; else process.env.AUTOREVIEW_PROJECTS_ROOT = old;
    rmSync(root, { recursive: true, force: true });
  }
});

test('来源配置拒绝越界、凭据目录和依赖错指；文件链接不跟随', () => {
  const root = mkdtempSync(join(tmpdir(), 'autoreview-context-scope-'));
  const old = process.env.AUTOREVIEW_PROJECTS_ROOT;
  process.env.AUTOREVIEW_PROJECTS_ROOT = join(root, 'store');
  try {
    assert.throws(() => parseContext({ sources: ['../secret'] }, root), /越界/);
    assert.throws(() => parseContext({ sources: ['.env'] }, root), /排除区域/);
    assert.throws(() => parseContext({ sources: [{ path: 'a.md', dependsOn: ['unknown'] }] }, root), /依赖不存在/);
    writeFileSync(join(root, 'source.md'), 'source'); symlinkSync(join(root, 'source.md'), join(root, 'link.md'));
    assert.throws(() => refreshContext(parseContext({ sources: ['link.md'] }, root)!), /符号链接/);
  } finally {
    if (old === undefined) delete process.env.AUTOREVIEW_PROJECTS_ROOT; else process.env.AUTOREVIEW_PROJECTS_ROOT = old;
    rmSync(root, { recursive: true, force: true });
  }
});

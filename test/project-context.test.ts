import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { contextDir, isRegisteredSource, loadContext, parseContext, recordProjectOutcome, recordSourceChange, refreshContext, sourceInputsProblem } from '../project-context.ts';

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
    // 来源变化不再阻塞发布：按当前版本记录，重复调用不追加。
    recordProjectOutcome(config, 'task', 'done', '/summary');
    const deliveries = join(contextDir(config), 'deliveries');
    const record = JSON.parse(readFileSync(join(deliveries, readdirSync(deliveries)[0]), 'utf8'));
    assert.equal(record.inputsFingerprint, changed.snapshot.inputsFingerprint);
    assert.equal(record.revision, changed.snapshot.revision);
    const journal = readFileSync(join(contextDir(config), 'changes.jsonl'), 'utf8');
    recordProjectOutcome(config, 'task', 'done', '/summary');
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

test('来源内容变化只记录并更新版本；缺失和配置移除照旧返回问题', () => {
  const root = mkdtempSync(join(tmpdir(), 'autoreview-context-check-'));
  const old = process.env.AUTOREVIEW_PROJECTS_ROOT;
  process.env.AUTOREVIEW_PROJECTS_ROOT = join(root, 'store');
  const project = join(root, 'project'); mkdirSync(project);
  try {
    writeFileSync(join(project, 'need.md'), 'v1');
    writeFileSync(join(project, '.autoreview.json'), JSON.stringify({ context: { sources: [{ path: 'need.md', role: 'requirement' }] } }));
    const first = refreshContext(loadContext(project)!).snapshot.inputsFingerprint;
    assert.equal(sourceInputsProblem(project, first), undefined);
    writeFileSync(join(project, 'need.md'), 'v2');
    const current = refreshContext(loadContext(project)!);
    assert.deepEqual(current.changes.map((change) => change.path), ['need.md']);
    assert.equal(sourceInputsProblem(project, first), undefined, '内容变化不阻塞完成资格');
    const state: { sourceChanges?: { path: string; at: string }[]; sourceChangeNote?: string } = {};
    assert.equal(recordSourceChange(state, current.changes, current.snapshot.revision), true);
    assert.deepEqual(state.sourceChanges?.map((item) => item.path), ['need.md']);
    assert.match(state.sourceChanges![0].at, /^\d{4}-\d{2}-\d{2}T/);
    // 拿不到文件列表（只改来源声明）时留一句版本说明。
    const declared = { sourceChanges: undefined as { path: string; at: string }[] | undefined, sourceChangeNote: undefined as string | undefined };
    assert.equal(recordSourceChange(declared, [], 3), true);
    assert.equal(declared.sourceChangeNote, '来源有变化（第 3 版）');
    assert.equal(isRegisteredSource(loadContext(project)!, project, 'need.md'), true);
    assert.equal(isRegisteredSource(loadContext(project)!, project, 'app.ts'), false, '未登记文件不算来源');
    const guarded = parseContext({ sources: [{ path: 'src/app.ts', role: 'code' }, { path: 'pkg', role: 'guide' }, { path: 'docs', role: 'guide' }] }, project)!;
    assert.equal(isRegisteredSource(guarded, project, 'src/app.ts'), false, 'code 来源的改动仍是候选改动');
    assert.equal(isRegisteredSource(guarded, join(project, 'pkg'), 'src/other.ts'), false, '包住整个开发目录的来源不能放行代码');
    assert.equal(isRegisteredSource(guarded, project, 'docs/a.md'), true);
    // 内容变化时仍能记录交付；缺失时不写新的。
    assert.equal(recordProjectOutcome(loadContext(project)!, 'task-ok', 'done', '/summary'), undefined);
    const deliveries = join(contextDir(loadContext(project)!), 'deliveries');
    assert.equal(readdirSync(deliveries).length, 1);
    rmSync(join(project, 'need.md'));
    assert.match(sourceInputsProblem(project, first)!, /上游来源缺失：need\.md/);
    // 发布 done 前仍核对缺失：不写新的交付记录。
    assert.match(recordProjectOutcome(loadContext(project)!, 'task-blocked', 'done', '/summary')!, /上游来源缺失：need\.md/);
    assert.equal(readdirSync(deliveries).length, 1, '缺失时不写新的交付');
    rmSync(join(project, '.autoreview.json'));
    assert.match(sourceInputsProblem(project, first)!, /配置已移除/);
  } finally {
    if (old === undefined) delete process.env.AUTOREVIEW_PROJECTS_ROOT; else process.env.AUTOREVIEW_PROJECTS_ROOT = old;
    rmSync(root, { recursive: true, force: true });
  }
});

test('目录型来源：登记路径还在就不算缺失；内部文件增删按资料变化记录', () => {
  const root = mkdtempSync(join(tmpdir(), 'autoreview-context-dir-'));
  const old = process.env.AUTOREVIEW_PROJECTS_ROOT;
  process.env.AUTOREVIEW_PROJECTS_ROOT = join(root, 'store');
  const project = join(root, 'project'); mkdirSync(project); mkdirSync(join(project, 'docs'));
  try {
    writeFileSync(join(project, 'docs', 'a.md'), 'v1');
    writeFileSync(join(project, 'docs', 'b.md'), 'v1');
    writeFileSync(join(project, '.autoreview.json'), JSON.stringify({ context: { sources: [{ path: 'docs', role: 'guide' }] } }));
    const first = refreshContext(loadContext(project)!);
    assert.deepEqual(first.snapshot.missing, []);
    assert.equal(sourceInputsProblem(project, first.snapshot.inputsFingerprint), undefined);
    // 目录内删一个文件：目录还在，不算缺失，按资料变化记录（会进总结）。
    rmSync(join(project, 'docs', 'a.md'));
    const removed = refreshContext(loadContext(project)!);
    assert.deepEqual(removed.snapshot.missing, []);
    assert.deepEqual(removed.changes.map((change) => [change.path, change.kind]), [['docs/a.md', 'deleted']]);
    assert.equal(sourceInputsProblem(project, first.snapshot.inputsFingerprint), undefined);
    const state: { sourceChanges?: { path: string; at: string }[] } = {};
    assert.equal(recordSourceChange(state, removed.changes, removed.snapshot.revision), true);
    assert.deepEqual(state.sourceChanges?.map((mark) => mark.path), ['docs/a.md']);
    // 目录内新增文件：同样只记变化。
    writeFileSync(join(project, 'docs', 'c.md'), 'new');
    const added = refreshContext(loadContext(project)!);
    assert.deepEqual(added.snapshot.missing, []);
    assert.deepEqual(added.changes.map((change) => [change.path, change.kind]), [['docs/c.md', 'added']]);
    // 目录被删空也不算缺失。
    rmSync(join(project, 'docs', 'b.md')); rmSync(join(project, 'docs', 'c.md'));
    const empty = refreshContext(loadContext(project)!);
    assert.deepEqual(empty.snapshot.missing, []);
    assert.deepEqual(empty.snapshot.files, []);
    assert.equal(sourceInputsProblem(project, first.snapshot.inputsFingerprint), undefined);
    // 登记目录本身被删：才算缺失并阻断。
    rmSync(join(project, 'docs'), { recursive: true });
    assert.match(sourceInputsProblem(project, first.snapshot.inputsFingerprint)!, /上游来源缺失：docs/);
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

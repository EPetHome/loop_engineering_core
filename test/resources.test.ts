import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRunResource, reapRunResources, releaseRunResource } from '../resources.ts';

test('资源释放只处理匹配身份的临时目录，保留活动任务、证据和链接目标', () => {
  const root = mkdtempSync(join(tmpdir(), 'autoreview-resources-'));
  const previous = process.env.AUTOREVIEW_RESOURCE_ROOT;
  process.env.AUTOREVIEW_RESOURCE_ROOT = join(root, 'owned');
  try {
    const item = createRunResource('gate', 0);
    writeFileSync(join(item.dir, 'cache'), 'temporary');
    assert.equal(reapRunResources().length, 0, '活动进程的目录不清理');
    assert.equal(releaseRunResource(item).status, 'released');
    assert.equal(existsSync(item.dir), false);
    assert.equal(JSON.parse(readFileSync(join(item.root, `${item.id}.json`), 'utf8')).status, 'released');
    const evidence = join(root, 'evidence'); mkdirSync(evidence); writeFileSync(join(evidence, 'keep'), 'record');
    const linked = createRunResource('linked', 0);
    rmSync(linked.dir, { recursive: true }); symlinkSync(evidence, linked.dir);
    assert.equal(releaseRunResource(linked).status, 'cleanup-failed');
    assert.equal(readFileSync(join(evidence, 'keep'), 'utf8'), 'record');
    const unknown = createRunResource('unknown', 0);
    assert.equal(releaseRunResource({ ...unknown, ownerStarted: 'forged' }).status, 'cleanup-failed');
    assert.equal(existsSync(unknown.dir), true);
    const retained = createRunResource('inspection', 0);
    assert.equal(releaseRunResource(retained, true).status, 'retained');
    assert.equal(existsSync(retained.dir), true);
    assert.throws(() => createRunResource('no-space', Number.MAX_SAFE_INTEGER), /ENOSPC/);
  } finally {
    if (previous === undefined) delete process.env.AUTOREVIEW_RESOURCE_ROOT; else process.env.AUTOREVIEW_RESOURCE_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('成功、失败和中断都释放缓存并保留系统临时目录里的验收证据', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'autoreview-artifacts-'));
  const previous = process.env.AUTOREVIEW_RESOURCE_ROOT;
  process.env.AUTOREVIEW_RESOURCE_ROOT = join(root, 'owned');
  const { createChildExec } = await import('../hosts/hook.ts');
  const { managedShell } = await import('../resources.ts');
  try {
    for (const mode of ['success', 'failure', 'interrupted']) await t.test(mode, async () => {
      const procs = join(root, `${mode}.procs.json`), resource = createRunResource(mode, 0, procs);
      const body = 'const fs=require("node:fs");fs.writeFileSync(require("node:path").join(require("node:os").tmpdir(),"report.md"),"evidence");fs.writeFileSync(process.env.AUTOREVIEW_TEMP_DIR+"/cache","temporary");'
        + (mode === 'interrupted' ? 'setTimeout(()=>{},30000);' : `process.exit(${mode === 'failure' ? 1 : 0});`);
      const result = await createChildExec(procs)('/bin/sh', ['-c', managedShell(`'${process.execPath}' -e '${body}'`, resource)], { cwd: root, timeout: 500, role: '验收命令' });
      assert.equal(result.killed, mode === 'interrupted');
      if (!result.killed) assert.equal(result.code, mode === 'failure' ? 1 : 0);
      assert.equal(releaseRunResource(resource).status, 'released');
      assert.equal(existsSync(resource.dir), false);
      assert.equal(readFileSync(join(resource.evidenceDir, 'report.md'), 'utf8'), 'evidence');
      assert.equal(JSON.parse(readFileSync(join(resource.root, `${resource.id}.json`), 'utf8')).evidenceDir, resource.evidenceDir);
    });
  } finally {
    if (previous === undefined) delete process.env.AUTOREVIEW_RESOURCE_ROOT; else process.env.AUTOREVIEW_RESOURCE_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('释放只看本次运行的进程登记；前一次运行和没有 runId 的旧登记不跨界', async () => {
  const root = mkdtempSync(join(tmpdir(), 'autoreview-runid-'));
  const previous = process.env.AUTOREVIEW_RESOURCE_ROOT;
  process.env.AUTOREVIEW_RESOURCE_ROOT = join(root, 'owned');
  const { spawn } = await import('node:child_process');
  const { registerProc, readProcs } = await import('../procs.ts');
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { detached: true, stdio: 'ignore' });
  try {
    const procs = join(root, 'runid.procs.json');
    const first = createRunResource('run one', 0, procs);
    registerProc(procs, child.pid!, '被测系统', process.execPath, 'token', first.id);
    // 后一次运行的资源：前一次的登记还在，但不算本次消费者，正常释放。
    const second = createRunResource('run two', 0, procs);
    assert.equal(releaseRunResource(second).status, 'released');
    assert.equal(existsSync(second.dir), false);
    assert.deepEqual(readProcs(procs).map((entry) => entry.runId), [first.id], '前一次的登记保留不动');
    // 没有 runId 的旧登记身份不明，继续保护。
    registerProc(procs, 999_999_999, '旧登记', 'legacy');
    const third = createRunResource('run three', 0, procs);
    assert.equal(releaseRunResource(third).status, 'cleanup-failed');
    assert.equal(existsSync(third.dir), true);
    // 孤儿回收同样只看本次运行自己的消费者：登记里只有别的运行的进程时可以回收。
    const orphanProcs = join(root, 'orphan.procs.json');
    const orphan = createRunResource('orphan', 0, orphanProcs);
    writeFileSync(join(orphan.dir, 'cache'), 'temporary');
    registerProc(orphanProcs, child.pid!, '别人家的被测系统', process.execPath, 'token', second.id);
    orphan.ownerPid = 2_147_480_000; orphan.ownerStarted = 'owner exited';
    writeFileSync(join(orphan.root, `${orphan.id}.json`), JSON.stringify(orphan));
    const reclaimed = reapRunResources();
    assert.deepEqual(reclaimed.map((item) => item.id), [orphan.id]);
    assert.equal(existsSync(orphan.dir), false);
    assert.equal(readProcs(orphanProcs).length, 1, '别的运行的登记不动');
    assert.ok(readProcs(procs).some((entry) => entry.runId === undefined), '旧登记仍在');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (previous === undefined) delete process.env.AUTOREVIEW_RESOURCE_ROOT; else process.env.AUTOREVIEW_RESOURCE_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('孤儿目录回收先检查已登记消费者，消费者活着时不删除', async () => {
  const root = mkdtempSync(join(tmpdir(), 'autoreview-consumer-'));
  const previous = process.env.AUTOREVIEW_RESOURCE_ROOT;
  process.env.AUTOREVIEW_RESOURCE_ROOT = join(root, 'owned');
  const { spawn } = await import('node:child_process');
  const { registerProc, unregisterProc } = await import('../procs.ts');
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { detached: true, stdio: 'ignore' });
  try {
    const procs = join(root, 'consumer.procs.json');
    registerProc(`${procs}.cleanup`, child.pid!, 'consumer', process.execPath);
    const resource = createRunResource('owned temporary', 0, procs);
    writeFileSync(join(resource.dir, 'cache'), 'in use');
    assert.equal(releaseRunResource(resource).status, 'cleanup-failed');
    assert.equal(readFileSync(join(resource.dir, 'cache'), 'utf8'), 'in use');
    resource.ownerPid = 2147480000; resource.ownerStarted = 'owner exited';
    writeFileSync(join(resource.root, `${resource.id}.json`), JSON.stringify(resource));
    writeFileSync(join(resource.evidenceDir, 'failure.txt'), 'keep');
    assert.equal(reapRunResources().length, 0);
    assert.ok(existsSync(resource.dir));
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve())); child.kill('SIGKILL'); await exited;
    unregisterProc(`${procs}.cleanup`, child.pid!);
    assert.equal(reapRunResources()[0].status, 'released');
    assert.equal(readFileSync(join(resource.evidenceDir, 'failure.txt'), 'utf8'), 'keep');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (previous === undefined) delete process.env.AUTOREVIEW_RESOURCE_ROOT; else process.env.AUTOREVIEW_RESOURCE_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

/** 定向自检：公开 CLI、实际落点与独立消费者；不是本批独立业务验收。 */
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { checkedWritePath } from '../acceptance-tools/isolated-loop.mjs';

const target = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const tool = join(target, 'acceptance-tools/isolated-loop.mjs');
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const running = (pid: number) => {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8', timeout: 2000 });
  if (result.status === 1 && !result.stdout.trim()) return false;
  assert.equal(result.status, 0, result.stderr);
  return !result.stdout.trim().startsWith('Z');
};

function fixture() {
  // Owned parent with spaces also exercises physical path/env matching, without real user probes.
  const outer = realpathSync(mkdtempSync(join(tmpdir(), 'loop isolation selfcheck-')));
  const evidence = join(outer, 'evidence'), temp = join(outer, 'tmp');
  for (const path of [evidence, temp, join(outer, 'home')]) mkdirSync(path);
  const children: ChildProcess[] = [];
  const env = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, LC_ALL: 'C',
    HOME: join(outer, 'home'), TMPDIR: temp, TMP: temp, TEMP: temp,
    AUTOREVIEW_RESOURCE_ROOT: join(outer, 'resources'), AUTOREVIEW_MERGE_QUEUE_ROOT: join(outer, 'queues'),
    AUTOREVIEW_PROJECTS_ROOT: join(outer, 'projects'), PI_CODING_AGENT_DIR: join(outer, 'agent'),
    LOOP_PA_CONFIG: join(outer, 'pa.json'),
    AUTOREVIEW_BATCH_FILE: 'OUTER-POISON', AUTOREVIEW_STAGE: 'OUTER-POISON', AUTOREVIEW_PIPELINE_DIR: 'OUTER-POISON',
    AUTOREVIEW_BASE_REV: 'OUTER-POISON', AUTOREVIEW_PIPELINE_LAUNCH_TOKEN: 'OUTER-POISON', AUTOREVIEW_DEV_ROOT: 'OUTER-POISON',
    AUTOREVIEW_PROCESS_OWNER: 'OUTER-POISON', AUTOREVIEW_RUN_ID: 'OUTER-POISON',
    PI_SESSION_ID: 'OUTER-POISON', CODEX_THREAD_ID: 'OUTER-POISON', CLAUDE_CODE_MESSAGING_TOKEN: 'OUTER-POISON',
    OPENAI_API_KEY: 'FAKE-NOT-A-CREDENTIAL', ANTHROPIC_API_KEY: 'FAKE-NOT-A-CREDENTIAL', NODE_OPTIONS: '--no-warnings',
  };
  writeFileSync(env.LOOP_PA_CONFIG, JSON.stringify({ pa: { eventsDir: join(outer, 'pa-events'), localNotify: false } }));
  const launch = (source: string, options: { flags?: string[]; command?: string[]; seconds?: number; onOutput?: (text: string, child: ChildProcess) => void } = {}) => {
    const args = [tool, '--target', target, '--evidence-dir', evidence, '--label', 'Selfcheck', '--timeout-sec', String(options.seconds ?? 10),
      ...(options.flags ?? []), '--', ...(options.command ?? [process.execPath, '--input-type=module', '-e', source])];
    const child = spawn(process.execPath, args, { cwd: outer, env, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child);
    const stdout: Uint8Array[] = [], stderr: Uint8Array[] = [];
    child.stdout!.on('data', (chunk) => { stdout.push(new Uint8Array(chunk)); options.onOutput?.(chunk.toString(), child); });
    child.stderr!.on('data', (chunk) => stderr.push(new Uint8Array(chunk)));
    return new Promise<{ code: number | null; stdout: Buffer; stderr: Buffer; report: any }>((accept, reject) => {
      child.once('error', reject);
      child.once('close', (code) => {
        const output = Buffer.concat(stdout), error = Buffer.concat(stderr);
        try {
          const marker = [...output.toString().matchAll(/^ISOLATION_REPORT=(.+)$/gm)].at(-1);
          assert.ok(marker, `缺少报告：${output}\n${error}`);
          const report = json(marker[1]);
          assert.ok(marker[1].startsWith(`${evidence}/Selfcheck-isolation-`));
          accept({ code, stdout: output, stderr: error, report });
        } catch (failure) { reject(failure); }
      });
    });
  };
  const close = async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      const done = new Promise((accept) => child.once('close', accept)); child.kill('SIGTERM');
      await Promise.race([done, sleep(2000)]);
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await done; }
    }
    rmSync(outer, { recursive: true });
  };
  return { outer, evidence, temp, env, launch, close };
}

test('--help 与参数错误不创建私有环境或启动命令', async () => {
  const f = fixture();
  try {
    const missing = join(f.outer, 'not-created');
    const result = spawnSync(process.execPath, [tool, '--help'], { cwd: f.outer, env: { ...f.env, TMPDIR: missing }, encoding: 'utf8' });
    assert.equal(result.status, 0); assert.match(result.stdout, /--write-path/); assert.equal(existsSync(missing), false);
    const invalid = spawnSync(process.execPath, [tool, '--target', target, '--timeout-sec', '0', '--', 'false'], { cwd: f.outer, env: f.env, encoding: 'utf8' });
    assert.notEqual(invalid.status, 0); assert.equal(existsSync(missing), false);
  } finally { await f.close(); }
});

test('物理路径检查拒绝前缀近似、悬空链接、内部链接及 link/.. 越界', async () => {
  const f = fixture();
  try {
    const root = join(f.outer, 'private'), sibling = join(f.outer, 'private-other'), outside = join(f.outer, 'outside');
    for (const path of [root, sibling, outside, join(outside, 'child')]) mkdirSync(path);
    symlinkSync(join(outside, 'child'), join(root, 'link'));
    symlinkSync(join(f.outer, 'absent'), join(root, 'dangling'));
    symlinkSync(root, join(root, 'inside'));
    for (const path of ['../private-other/file', join(sibling, 'file'), 'link/file', 'link/../file', 'dangling/file']) {
      assert.throws(() => checkedWritePath(root, path), /路径|越界/);
    }
    assert.equal(checkedWritePath(root, 'new/sub/file').resolved, join(root, 'new/sub/file'));
    assert.equal(checkedWritePath(root, 'inside/file').resolved, join(root, 'file'));
  } finally { await f.close(); }
});

test('公开 CLI 在派发前拒绝父目录、绝对路径及外部链接，哨兵不变', async () => {
  const f = fixture();
  try {
    const sentinel = join(f.outer, 'sentinel'), alias = join(f.outer, 'alias'), entered = join(f.evidence, 'entered');
    writeFileSync(sentinel, 'unchanged'); symlinkSync(sentinel, alias);
    for (const path of ['../sentinel', sentinel, alias]) {
      const result = await f.launch(`require('node:fs').writeFileSync(${JSON.stringify(entered)}, 'bad')`, { flags: ['--write-path', path] });
      assert.notEqual(result.code, 0); assert.equal(result.report.commandStarted, false);
      assert.equal(result.report.processesReleased, true); assert.equal(result.report.rootReleased, true);
      assert.ok(result.report.reason.includes(path)); assert.equal(existsSync(entered), false);
      assert.equal(readFileSync(sentinel, 'utf8'), 'unchanged');
    }
  } finally { await f.close(); }
});

test('真实状态 API 写私有 HOME/PA；凭据及外层身份被清除，原始双流逐字节保留', async () => {
  const f = fixture();
  try {
    const source = `
      import { readFileSync, writeFileSync, existsSync } from 'node:fs';
      import { join } from 'node:path'; import { pathToFileURL } from 'node:url';
      const root=process.env.LOOP_ISOLATION_ROOT, candidate=process.env.LOOP_CANDIDATE_ROOT;
      const { pushEvent, recordBatchInfo }=await import(pathToFileURL(join(candidate,'events.ts')));
      const { appendLedgerRecord }=await import(pathToFileURL(join(candidate,'ledger.ts')));
      const batch=join(root,'batch.json'); writeFileSync(batch,'{}');
      const info={project:root,batch:{file:batch,name:'private-sample',recipe:'develop'},dir:join(process.env.HOME,'.pi-autoreview/pipelines/sample'),stages:[]};
      recordBatchInfo(info); pushEvent(info,null,'started');
      const ledger=appendLedgerRecord({project:root,session:'private-sample',task:'sample',result:'selfcheck',summary:join(root,'summary.md'),pending:[]});
      const pa=JSON.parse(readFileSync(process.env.LOOP_PA_CONFIG,'utf8'));
      console.log(JSON.stringify({root,cwd:process.cwd(),env:process.env,pa,ledger,ledgerExists:existsSync(ledger)}));
      process.stdout.write(Buffer.from([0,255,10])); process.stderr.write(Buffer.from([1,254,10]));
    `;
    const result = await f.launch(source, { flags: ['--write-path', 'sample/output'] });
    assert.equal(result.code, 0, result.stderr.toString());
    const { report } = result, observed = JSON.parse(readFileSync(report.stdoutLog, 'utf8').split('\n')[0]);
    assert.equal(observed.cwd, report.root); assert.equal(dirname(report.root), f.temp);
    assert.equal(observed.env.LOOP_CANDIDATE_ROOT, target); assert.equal(observed.pa.pa.localNotify, false);
    assert.equal(observed.pa.pa.eventsDir, report.paths.paEvents); assert.equal(observed.ledgerExists, true);
    for (const key of ['HOME', 'TMPDIR', 'TMP', 'TEMP', 'AUTOREVIEW_MERGE_QUEUE_ROOT', 'AUTOREVIEW_RESOURCE_ROOT', 'AUTOREVIEW_PROJECTS_ROOT', 'PI_CODING_AGENT_DIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'LOOP_PA_CONFIG', 'GIT_CONFIG_GLOBAL']) {
      assert.ok(observed.env[key].startsWith(`${report.root}/`), key);
    }
    for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'AUTOREVIEW_BATCH_FILE', 'AUTOREVIEW_STAGE', 'AUTOREVIEW_PIPELINE_DIR', 'AUTOREVIEW_BASE_REV', 'AUTOREVIEW_PIPELINE_LAUNCH_TOKEN', 'AUTOREVIEW_DEV_ROOT', 'PI_SESSION_ID', 'CODEX_THREAD_ID', 'CLAUDE_CODE_MESSAGING_TOKEN', 'NODE_OPTIONS']) assert.equal(observed.env[key], undefined, key);
    assert.notEqual(observed.env.AUTOREVIEW_PROCESS_OWNER, 'OUTER-POISON');
    assert.deepEqual(readFileSync(report.stdoutLog), result.stdout.subarray(0, result.stdout.indexOf('\nISOLATION_REPORT=')));
    const rawStderr = readFileSync(report.stderrLog);
    assert.deepEqual(rawStderr.subarray(0, 3), Buffer.from([1, 254, 10]));
    assert.ok(result.stderr.includes(rawStderr), '包括 Node 自身警告在内的命令 stderr 必须原样转发');
    assert.equal(report.processesReleased, true); assert.equal(report.rootReleased, true); assert.equal(existsSync(report.root), false);
    assert.ok(json(report.ownership).consumers.length > 0); assert.equal(existsSync(join(f.outer, 'home/.pi-autoreview')), false);
    assert.equal(f.env.HOME, join(f.outer, 'home')); // No global mutation in the test or product entry.
  } finally { await f.close(); }
});

test('同名并行两轮并接续一轮，不读取上轮样本且证据不覆盖', async () => {
  const f = fixture();
  try {
    const source = `import {existsSync,writeFileSync} from 'node:fs'; import {join} from 'node:path';
      const file=join(process.cwd(),'sample'); console.log(JSON.stringify({id:process.env.LOOP_ISOLATION_ID,old:existsSync(file)})); writeFileSync(file,'sample');`;
    const pair = await Promise.all([f.launch(source), f.launch(source)]), next = await f.launch(source);
    const all = [...pair, next];
    assert.equal(new Set(all.map((item) => item.report.root)).size, 3);
    assert.equal(new Set(all.map((item) => item.report.stdoutLog)).size, 3);
    assert.equal(new Set(all.map((item) => item.report.id)).size, 3);
    for (const item of all) {
      assert.equal(item.code, 0, item.stderr.toString()); assert.equal(item.report.rootReleased, true);
      assert.deepEqual(JSON.parse(readFileSync(item.report.stdoutLog, 'utf8')).old, false);
    }
  } finally { await f.close(); }
});

for (const outcome of ['success', 'failure', 'timeout', 'cancel']) {
  test(`独立更换 owner 的后台消费者：${outcome}，返回前停止且备用临时目录私有`, async () => {
    const f = fixture();
    const obs = join(f.evidence, `observation-${randomUUID()}`); mkdirSync(obs);
    const foreign = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { env: f.env, detached: true, stdio: 'ignore' });
    const token = randomUUID();
    try {
      const consumer = `const fs=require('node:fs'),os=require('node:os'),cp=require('node:child_process');
        fs.writeFileSync(${JSON.stringify(join(obs, 'consumer.json'))},JSON.stringify({pid:process.pid,root:process.env.LOOP_ISOLATION_ROOT,token:process.env.SELFCHECK_TOKEN,temp:os.tmpdir(),started:cp.spawnSync('ps',['-p',String(process.pid),'-o','lstart='],{encoding:'utf8'}).stdout.trim()}));
        const beat=()=>fs.appendFileSync(${JSON.stringify(join(obs, 'heartbeat'))},'beat\\n'); beat(); const timer=setInterval(beat,30);
        const safety=setTimeout(()=>{fs.writeFileSync(${JSON.stringify(join(obs, 'safety'))},'expired');clearInterval(timer);},15000);
        process.once('SIGTERM',()=>{clearTimeout(safety);clearInterval(timer);fs.writeFileSync(${JSON.stringify(join(obs, 'stopped'))},'SIGTERM');});`;
      const source = `import {spawn} from 'node:child_process'; import {existsSync} from 'node:fs'; import {setTimeout as sleep} from 'node:timers/promises';
        const env={...process.env,AUTOREVIEW_PROCESS_OWNER:${JSON.stringify(randomUUID())},SELFCHECK_TOKEN:${JSON.stringify(token)}};
        for(const key of ['TMPDIR','AUTOREVIEW_RUN_ID','AUTOREVIEW_TEMP_DIR','AUTOREVIEW_EVIDENCE_DIR','AUTOREVIEW_RUN_DIR']) delete env[key];
        spawn(process.execPath,['-e',${JSON.stringify(consumer)}],{env,detached:true,stdio:'ignore'}).unref();
        while(!existsSync(${JSON.stringify(join(obs, 'consumer.json'))})) await sleep(20);
        console.log('CONSUMER_STARTED');
        ${['cancel', 'timeout'].includes(outcome) ? "setInterval(()=>{},1000);" : `process.exitCode=${outcome === 'failure' ? 23 : 0};`}`;
      let cancelled = false;
      const result = await f.launch(source, { seconds: outcome === 'timeout' ? 2 : 10, onOutput: (text, child) => {
        if (outcome === 'cancel' && text.includes('CONSUMER_STARTED') && !cancelled) { cancelled = true; child.kill('SIGTERM'); }
      } });
      const details = json(join(obs, 'consumer.json'));
      assert.equal(result.code, ({ success: 0, failure: 23, timeout: 124, cancel: 143 })[outcome], result.stderr.toString());
      assert.equal(result.report.commandExitCode, result.code);
      assert.equal(result.report.processesReleased, true, result.stderr.toString());
      assert.equal(running(details.pid), false, '必须在任何观察者补偿之前已停止');
      assert.ok(details.temp.startsWith(`${result.report.root}/`));
      assert.equal(existsSync(join(obs, 'safety')), false, '不得依赖 15 秒自退');
      assert.equal(details.token, token); assert.equal(running(foreign.pid!), true, '不能影响其他 owner/根的消费者');
      const beat = readFileSync(join(obs, 'heartbeat')); await sleep(100); assert.deepEqual(readFileSync(join(obs, 'heartbeat')), beat);
      assert.equal(result.report.rootReleased, outcome === 'success');
      assert.equal(existsSync(result.report.root), outcome !== 'success');
      if (outcome !== 'success') assert.match(result.report.reason, outcome === 'failure' ? /23/ : outcome === 'timeout' ? /超时/ : /SIGTERM/);
    } finally {
      // Observer compensation uses this test's exact token + root + process start, never a guessed PID.
      const file = join(obs, 'consumer.json');
      if (existsSync(file)) {
        const details = json(file);
        if (running(details.pid)) {
          const status = spawnSync('ps', ['eww', '-p', String(details.pid), '-o', 'lstart=,command='], { encoding: 'utf8' });
          assert.ok(status.stdout.includes(details.started)); assert.ok(status.stdout.includes(`SELFCHECK_TOKEN=${token}`));
          assert.ok(status.stdout.includes(`LOOP_ISOLATION_ROOT=${details.root}`));
          process.kill(details.pid, 'SIGKILL');
          for (let i = 0; i < 30 && running(details.pid); i++) await sleep(20);
          assert.equal(running(details.pid), false);
        }
      }
      if (foreign.exitCode === null && foreign.signalCode === null) {
        const done = new Promise((accept) => foreign.once('close', accept)); foreign.kill('SIGKILL'); await done;
      }
      await f.close();
    }
  });
}

test('进程扫描失败必须非零保留现场和登记，不能以空缓存报告释放成功', async () => {
  const f = fixture();
  try {
    const bin = join(f.outer, 'bin'); mkdirSync(bin);
    const fake = join(bin, 'ps');
    writeFileSync(fake, '#!/bin/sh\nfor arg in "$@"; do if [ "$arg" = "-A" ]; then echo scan-unavailable >&2; exit 2; fi; done\nexec /bin/ps "$@"\n');
    chmodSync(fake, 0o700); f.env.PATH = `${bin}:${f.env.PATH}`;
    const result = await f.launch("console.log('finite-command')");
    assert.notEqual(result.code, 0); assert.equal(result.report.processesReleased, false);
    assert.equal(result.report.rootReleased, false); assert.equal(existsSync(result.report.root), true);
    assert.match(result.report.reason, /无法核对进程表/);
    const ownership = json(result.report.ownership);
    assert.ok(ownership.main?.pgid); assert.equal(running(ownership.main.pgid), false, '有限命令本身已退出，但扫描失败仍不能宣布全部释放');
    assert.ok(existsSync(join(dirname(result.report.ownership), 'procs.json')));
  } finally { await f.close(); }
});

test('命令不存在仍留双流与原因，不冒称命令成功', async () => {
  const f = fixture();
  try {
    const result = await f.launch('', { command: [join(f.outer, 'missing-command')] });
    assert.equal(result.code, 127, result.stderr.toString()); assert.equal(result.report.commandExitCode, 127);
    assert.equal(result.report.processesReleased, true); assert.equal(result.report.rootReleased, false);
    assert.match(result.report.reason, /ENOENT/);
    for (const log of [result.report.stdoutLog, result.report.stderrLog]) assert.ok(lstatSync(log).isFile());
  } finally { await f.close(); }
});

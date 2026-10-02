// Cross-process recovery lock and page-record races, isolated from the real WB profile.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { PLUGIN_ROOT, ProxySession, makeHome, startStub, writeConfig } from './helpers.mjs';

const pageLink = reply => reply?.result?.content?.[0]?.text.match(/http:\/\/127\.0\.0\.1:\d+\/configure\/[a-f0-9]{64}/)?.[0];
const call = id => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'my_projects', arguments: {} } });
async function until(predicate, reason) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw Error(typeof reason === 'function' ? reason() : reason);
    await new Promise(resolve => setTimeout(resolve, 10)); // explicit file/process event only
  }
}
async function cancel(url) {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  const nonce = (await response.text()).match(/name="nonce" value="([a-f0-9]{64})"/)[1];
  const reply = await fetch(url, { method: 'POST', headers: { Origin: new URL(url).origin },
    body: new URLSearchParams({ action: 'cancel', nonce }) });
  assert.equal(reply.status, 200);
}
function background(home, code, extra = {}) {
  return spawn(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, PROMATE_HOME: home, PROMATE_CONFIG: '', ...extra }, stdio: 'ignore',
  });
}
const owner = (pid, uid = process.getuid()) => ({ id: 'ba2c7875-bbcc-4b0f-a93d-d4d81c52b1ce', pid, uid });
const put = (file, data) => writeFileSync(file, JSON.stringify(data), { flag: 'wx', mode: 0o600 });
async function stoppedPid(home) {
  const child = background(home, 'setInterval(() => {}, 1000)');
  await until(() => child.pid && (() => { try { process.kill(child.pid, 0); return true; } catch { return false; } })(), 'test owner missing');
  const exited = new Promise(resolve => child.once('close', resolve));
  child.kill('SIGTERM'); await exited;
  return child.pid;
}
async function interruptedRecovery(home, lockPresent) {
  const dir = join(home, '.promate-recovery'), ready = join(home, 'guard-ready');
  const child = background(home, `import fs from 'node:fs'; import {join} from 'node:path';
    const dir=${JSON.stringify(dir)}, lock=join(dir,'page.lock');
    const owner={id:'ba2c7875-bbcc-4b0f-a93d-d4d81c52b1ce',pid:process.pid,uid:process.getuid()};
    fs.writeFileSync(lock,JSON.stringify(owner),{flag:'wx',mode:0o600});
    fs.writeFileSync(join(dir,'page.recover'),JSON.stringify(owner),{flag:'wx',mode:0o600});
    if(!${lockPresent}) fs.unlinkSync(lock);
    fs.writeFileSync(${JSON.stringify(ready)},'guard-written');
    setInterval(()=>{},1000);`);
  try {
    await until(() => existsSync(ready), 'recovery owner did not write guard');
  } finally {
    const exited = new Promise(resolve => child.once('close', resolve));
    child.kill('SIGTERM'); await exited;
  }
  return child.pid;
}

test('terminated legacy guard: both lock-present and lock-removed states recover without deleting real profile', async () => {
  for (const lockPresent of [true, false]) {
    const { home, cleanup } = makeHome();
    const stub = await startStub(() => ({ status: 401, body: {} }));
    writeConfig(home, { url: stub.url, key: 'pk_FictionalGuard0123456789', keyOrigin: new URL(stub.url).origin });
    const dir = join(home, '.promate-recovery'); mkdirSync(dir, { mode: 0o700 });
    await interruptedRecovery(home, lockPresent); // terminate only this test-owned guard writer
    const proxy = new ProxySession({ home });
    try {
      const link = pageLink(await proxy.request(call(1)));
      assert.ok(link && !existsSync(join(dir, 'page.recover')) && !existsSync(join(dir, 'page.lock')));
      await cancel(link);
    } finally { proxy.close(); await stub.close(); cleanup(); }
  }
});

test('active and unverifiable legacy owners fail closed, without clearing either file', async () => {
  const { home, cleanup } = makeHome();
  const stub = await startStub(() => ({ status: 401, body: {} }));
  writeConfig(home, { url: stub.url, key: 'pk_FictionalGuard0123456789', keyOrigin: new URL(stub.url).origin });
  const dir = join(home, '.promate-recovery'); mkdirSync(dir, { mode: 0o700 });
  const guard = join(dir, 'page.recover');
  const proxy = new ProxySession({ home });
  try {
    put(guard, owner(process.pid));
    assert.equal(pageLink(await proxy.request(call(1))), undefined);
    assert.ok(existsSync(guard));
    unlinkSync(guard);
    put(guard, { ...owner(await stoppedPid(home)), uid: process.getuid() + 1 });
    assert.equal(pageLink(await proxy.request(call(2))), undefined);
    assert.ok(existsSync(guard));
    unlinkSync(guard);
    put(guard, { invalid: true });
    assert.equal(pageLink(await proxy.request(call(3))), undefined);
    assert.ok(existsSync(guard));
  } finally { proxy.close(); await stub.close(); cleanup(); }
});

test('two independent proxies recover the same dead lock and share one usable URL', async () => {
  const { home, cleanup } = makeHome();
  const stub = await startStub(() => ({ status: 401, body: {} }));
  writeConfig(home, { url: stub.url, key: 'pk_FictionalGuard0123456789', keyOrigin: new URL(stub.url).origin });
  const dir = join(home, '.promate-recovery'); mkdirSync(dir, { mode: 0o700 });
  const pid = await stoppedPid(home);
  put(join(dir, 'page.lock'), owner(pid)); put(join(dir, 'page.recover'), owner(pid));
  const a = new ProxySession({ home }), b = new ProxySession({ home });
  try {
    const [one, two] = await Promise.all([a.request(call(1)), b.request(call(1))]);
    assert.ok(pageLink(one) && pageLink(one) === pageLink(two));
    await cancel(pageLink(one));
  } finally { a.close(); b.close(); await stub.close(); cleanup(); }
});

test('failed child after record publication cleans only its own entry; next launch can save and finish', async () => {
  const { home, cleanup } = makeHome();
  const stub = await startStub(({ request }) => ({ body: { jsonrpc: '2.0', id: request?.id,
    result: { content: [], isError: false } } }));
  writeConfig(home, { url: stub.url, key: 'pk_FictionalFailedPage0123456789', keyOrigin: new URL(stub.url).origin });
  const failed = join(home, 'child-probe-failed'), preload = join(home, 'fail-probe.cjs');
  writeFileSync(preload, `const fs=require('node:fs'),cp=require('node:child_process'),spawn=cp.spawn;
    cp.spawn=function(command,args,options){
      if(String(args?.[0]).endsWith('/mcp/recovery-page.mjs'))
        options={...options,env:{...options.env,NODE_OPTIONS:${JSON.stringify(`--require=${preload}`)}}};
      return spawn.call(this,command,args,options);
    };
    if(process.argv.includes('--page')&&!fs.existsSync(${JSON.stringify(failed)})) {
      fs.writeFileSync(${JSON.stringify(failed)},'once');
      const get=global.fetch;
      global.fetch=(url,...args)=>String(url).includes('/configure/')
        ? Promise.reject(Error('ISOLATED_PROBE_FAILURE')) : get(url,...args);
    }
    require('node:module').syncBuiltinESMExports();`, { mode: 0o600 });
  const proxy = new ProxySession({ home, env: { NODE_OPTIONS: `--require=${preload}` } });
  const recordFile = join(home, '.promate-recovery/page.json');
  try {
    const first = await proxy.request({ ...call(1), params: { name: 'configure_key', arguments: {} } });
    assert.equal(first.result.isError, true);
    assert.equal(existsSync(recordFile), false, 'failed launch must remove its own record');
    const second = await proxy.request({ ...call(2), params: { name: 'configure_key', arguments: {} } });
    const link = pageLink(second); assert.ok(link);
    assert.equal((await fetch(link)).status, 200);
    const html = await (await fetch(link)).text();
    const nonce = html.match(/name="nonce" value="([a-f0-9]{64})"/)[1];
    const key = 'pk_FictionalRecoveredPage0123456789';
    const response = await fetch(link, { method: 'POST', headers: { Origin: new URL(link).origin },
      body: new URLSearchParams({ action: 'save', nonce, key }) });
    assert.match(await response.text(), /身份连接成功/);
    assert.equal(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).key, key);
    await until(() => !existsSync(recordFile), 'new page did not clean its own record');
  } finally { proxy.close(); await stub.close(); cleanup(); }
});

test('old cleanup paused after seeing old generation cannot remove a concurrently published new record', async () => {
  const { home, cleanup } = makeHome();
  const stub = await startStub(({ request }) => ({ body: { jsonrpc: '2.0', id: request?.id,
    result: { content: [], isError: false } } }));
  writeConfig(home, { url: stub.url, key: 'pk_FictionalRecordOld0123456789', keyOrigin: new URL(stub.url).origin });
  const gate = join(home, 'cleanup-held'), release = join(home, 'cleanup-release');
  const preload = join(home, 'hold-cleanup.cjs');
  writeFileSync(preload, `const fs=require('node:fs'), cp=require('node:child_process'), original=fs.unlinkSync;
    const spawn=cp.spawn;
    cp.spawn=function(command,args,options){
      if(String(args?.[0]).endsWith('/mcp/recovery-page.mjs'))
        options={...options,env:{...options.env,NODE_OPTIONS:${JSON.stringify(`--require=${preload}`)}}};
      return spawn.call(this,command,args,options);
    };
    fs.unlinkSync=function(path,...args){
      if(String(path).endsWith('/.promate-recovery/page.json') && !fs.existsSync(${JSON.stringify(gate)})) {
        fs.writeFileSync(${JSON.stringify(gate)},'old-cleanup-ready');
        while(!fs.existsSync(${JSON.stringify(release)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
      }
      return original.call(this,path,...args);
    }; require('node:module').syncBuiltinESMExports();`, { mode: 0o600 });
  const a = new ProxySession({ home, env: { NODE_OPTIONS: `--require=${preload}` } });
  const b = new ProxySession({ home });
  const recordFile = join(home, '.promate-recovery/page.json');
  let oldPid;
  try {
    const first = await a.request({ ...call(1), params: { name: 'configure_key', arguments: {} } });
    const old = pageLink(first); assert.ok(old);
    const entry = JSON.parse(readFileSync(recordFile, 'utf8')); oldPid = entry.pid;
    // Only this test's isolated record: force the old page watcher to finish.
    const tmp = recordFile + '.test';
    writeFileSync(tmp, JSON.stringify({ ...entry, expiresAt: Date.now() - 1 }), { mode: 0o600 });
    renameSync(tmp, recordFile);
    await until(() => existsSync(gate), 'old cleanup did not reach its unlink boundary');
    const second = b.request({ ...call(2), params: { name: 'configure_key', arguments: {} } });
    // New code serializes publication behind old cleanup. Old code could publish
    // between the old read and unlink, then destroy the new page.json and URL.
    assert.equal(JSON.parse(readFileSync(recordFile, 'utf8')).id, entry.id);
    writeFileSync(release, 'go');
    const next = pageLink(await second); assert.ok(next && next !== old);
    const newest = JSON.parse(readFileSync(recordFile, 'utf8'));
    assert.notEqual(newest.id, entry.id);
    assert.equal((await fetch(next)).status, 200);
    const html = await (await fetch(next)).text();
    const nonce = html.match(/name="nonce" value="([a-f0-9]{64})"/)[1];
    const key = 'pk_FictionalRecordNew0123456789';
    const saved = await fetch(next, { method: 'POST', headers: { Origin: new URL(next).origin },
      body: new URLSearchParams({ action: 'save', nonce, key }) });
    assert.match(await saved.text(), /身份连接成功/);
    assert.equal(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).key, key);
    await until(() => !existsSync(recordFile), 'new page did not clean its own record');
  } finally {
    if (!existsSync(release)) writeFileSync(release, 'go');
    if (oldPid) { try { process.kill(oldPid, 'SIGTERM'); } catch {} }
    a.close(); b.close(); await stub.close(); cleanup();
  }
});

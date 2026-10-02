// proxy.mjs 自测：没 Key / Key 失效 / 连不上平台时的本地握手和 isError 结果；
// 中途写入 Key 不用重启代理。对应自检表 S12、S13。

import assert from 'node:assert/strict';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { PLUGIN_ROOT, ProxySession, makeHome, runHook, runHookAsync, startStub, unusedPort, writeConfig } from './helpers.mjs';
async function confirmWrite(home,name,input={}){
  const event={session_id:'proxy-write-fixture',tool_name:`mcp__promate__${name}`,tool_input:input};
  const first=await runHookAsync('confirm.mjs',event,{home});assert.equal(JSON.parse(first.stdout).hookSpecificOutput.permissionDecision,'deny');
  runHook('route.mjs',{session_id:event.session_id,prompt:'确认'},{home});
  const allowed=await runHookAsync('confirm.mjs',event,{home});assert.equal(JSON.parse(allowed.stdout).hookSpecificOutput.permissionDecision,'allow');
}

// Test-owned Node preload pauses only the proxy's first detached-page readiness probe.
function heldPageListen(home, { fail = false } = {}) {
  const ready = join(home, 'listen-ready'), releaseFile = join(home, 'listen-release');
  const attempts = join(home, 'listen-attempts'), preload = join(home, 'hold-listen.cjs');
  const stdinClosed = join(home, 'stdin-closed');
  writeFileSync(preload, `const fs=require('node:fs'),child=require('node:child_process');
    const spawn=child.spawn;
    child.spawn=function(...args){
      if(String(args[1]?.[0]).endsWith('/mcp/recovery-page.mjs'))fs.appendFileSync(${JSON.stringify(attempts)},'1');
      return spawn.apply(this,args);
    };
    const originalFetch=global.fetch;let probes=0;
    global.fetch=async function(url,...options){
      if(String(url).includes('/configure/')&&++probes===1){
        await new Promise(resolve=>{
          const watcher=fs.watch(${JSON.stringify(home)},()=>{
            if(!fs.existsSync(${JSON.stringify(releaseFile)}))return;
            watcher.close();resolve();
          });
          fs.writeFileSync(${JSON.stringify(ready)},'ready');
        });
        ${fail ? "throw Error('TEST_PROBE_FAILED');" : ''}
      }
      return originalFetch(url,...options);
    };
    const readline=require('node:readline'),original=readline.createInterface;
    readline.createInterface=function(...args){
      const reader=original.apply(this,args);
      reader.on('close',()=>setImmediate(()=>fs.writeFileSync(${JSON.stringify(stdinClosed)},'closed')));
      return reader;
    };
    require('node:module').syncBuiltinESMExports();`, { mode: 0o600 });
  return { ready, attempts, stdinClosed, env: { NODE_OPTIONS: `--require=${preload}` },
    release: () => { if (!existsSync(releaseFile)) writeFileSync(releaseFile, 'release'); } };
}
async function until(predicate, reason) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw Error(reason);
    await new Promise(resolve => setTimeout(resolve, 10)); // only waits for explicit ready/log signals
  }
}
const pageLink = reply => reply?.result?.content?.[0]?.text.match(/http:\/\/127\.0\.0\.1:\d+\/configure\/[a-f0-9]{64}/)?.[0];
function testPageExited(pid) {
  try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
}

const EXPECTED_TOOLS = [
  'list_skills', 'get_skill', 'upload_skill', 'my_projects', 'my_alerts', 'list_requirements',
  'add_artifact', 'mark_delivered', 'mark_done', 'get_requirement', 'retry_writeback',
  'update_artifact', 'remove_artifact', 'my_skills', 'upload_skill_version',
];

test('S12 没 Key：本地握手、15 服务／3 本地资源工具与 1 个无参数配置入口', async () => {
  const { home, cleanup } = makeHome();
  const proxy = new ProxySession({ home });
  try {
    const init = await proxy.request({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    assert.equal(init.result.protocolVersion, '2024-11-05');
    assert.ok(init.result.instructions.includes('Promate 产品中台'), '本地 initialize 要带 instructions');
    assert.deepEqual(init.result.capabilities, { tools: { listChanged: false }, promate:{toolset:'mcp-tools-v2',programApi:1} });

    const list = await proxy.request({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.deepEqual(list.result.tools.map((tool) => tool.name), [...EXPECTED_TOOLS, 'install_resource','uninstall_resource','my_installed','configure_key']);

    const call = await proxy.request({
      jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'my_projects', arguments: {} },
    });
    assert.equal(call.error, undefined, '没 Key 时不应回 JSON-RPC 错误');
    assert.equal(call.result.isError, true);
    assert.match(call.result.content[0].text, /尚未配置 Promate Key/);
    assert.match(call.result.content[0].text, /configure_key/);
    assert.doesNotMatch(call.result.content[0].text, /终端|configure\.mjs/);
    assert.match(init.result.instructions, /平台连接未验证/);

    const ping = await proxy.request({ jsonrpc: '2.0', id: 4, method: 'ping' });
    assert.deepEqual(ping.result, {});
    assert.deepEqual(proxy.badLines, [], 'stdout 每行都必须是合法 JSON');
  } finally {
    proxy.close();
    cleanup();
  }
});

test('本地工具定义和 tools.json 完全一致', () => {
  const local = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'mcp', 'tools.json'), 'utf8'));
  assert.deepEqual(local.tools.map((tool) => tool.name), EXPECTED_TOOLS);
  assert.equal(local.protocolVersion, '2024-11-05');
  assert.equal(local.serverInfo.name, 'promate-mcp');
  assert.ok(local.instructions.includes('mark_done 和 mark_delivered 只提交目标字段'));
  assert.ok(
    !local.instructions.includes("每天同步"),
    "服务说明不能再说「每天同步」",
  );
});

test('S13 同一个进程里中途写 Key，下一次调用就转发到平台', async () => {
  const { home, cleanup } = makeHome();
  const stub = await startStub(({ request }) => ({
    body: {
      jsonrpc: '2.0',
      id: request?.id,
      result: {
        content: [{ type: 'text', text: '项目列表：Promate 产品中台' }],
        structuredContent: { success: true },
        isError: false,
      },
    },
  }));
  const proxy = new ProxySession({ home });
  try {
    const before = await proxy.request({
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'my_projects', arguments: {} },
    });
    assert.equal(before.result.isError, true, '没 Key 时应是本地 isError');

    writeConfig(home, { url: stub.url, key: 'st_test_token' });

    const after = await proxy.request({
      jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'my_projects', arguments: {} },
    });
    assert.equal(after.result.isError, false, '写入 Key 后应转发到平台');
    assert.ok(after.result.content[0].text.includes('项目列表'), JSON.stringify(after));
    assert.deepEqual(proxy.badLines, []);
  } finally {
    proxy.close();
    await stub.close();
    cleanup();
  }
});

test('有 Key 且平台可连时也只在插件代理追加无参数本地配置工具', async () => {
  const { home, cleanup } = makeHome();
  const stub = await startStub(({ request }) => ({ body: { jsonrpc: '2.0', id: request.id, result: { tools: [{ name: 'my_projects', inputSchema: { type: 'object' } }] } } }));
  writeConfig(home, { url: stub.url, key: 'st_test_only' });
  const proxy = new ProxySession({ home });
  try {
    const list = await proxy.request({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.deepEqual(list.result.tools.map((tool) => tool.name), ['my_projects','install_resource','uninstall_resource','my_installed','configure_key']);
    assert.deepEqual(list.result.tools.at(-1).inputSchema, { type: 'object', properties: {}, additionalProperties: false });
    assert.match(list.result._meta.promate.message,/平台尚未升级/);
  } finally { proxy.close(); await stub.close(); cleanup(); }
});

test('连不上平台：握手退回本地，tools/call 提示结果未确认', async () => {
  const { home, cleanup } = makeHome();
  const port = await unusedPort();
  writeConfig(home, { url: `http://127.0.0.1:${port}/api/mcp`, key: 'st_test_token' });
  const proxy = new ProxySession({ home });
  try {
    const init = await proxy.request({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    assert.ok(init.result.instructions.includes('Promate 产品中台'));

    const list = await proxy.request({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.equal(list.result.tools.length, 19);

    const call = await proxy.request({
      jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'my_projects', arguments: {} },
    });
    assert.equal(call.result.isError, true);
    assert.match(call.result.content[0].text, /连不上 Promate/);
    assert.match(call.result.content[0].text, /结果未确认/);
  } finally {
    proxy.close();
    cleanup();
  }
});

test('平台 401：握手和列表保留协议结构，实际调用含程序链接而不妄断过期', async () => {
  const { home, cleanup } = makeHome();
  const stub = await startStub(() => ({ status: 401, body: { code: 'UNAUTHORIZED' } }));
  writeConfig(home, { url: stub.url, key: 'st_expired' });
  const proxy = new ProxySession({ home });
  try {
    const init = await proxy.request({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    assert.ok(init.result.instructions.includes('Promate 产品中台'));
    assert.equal(init.result.protocolVersion, '2024-11-05');
    const list = await proxy.request({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.equal(list.result.tools.length, 19);
    const call = await proxy.request({
      jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'my_projects', arguments: {} },
    });
    assert.equal(call.result.isError, true);
    assert.match(call.result.content[0].text, /身份验证未通过（401）/);
    assert.match(call.result.content[0].text, /不能断言 Key 过期/);
    assert.match(call.result.content[0].text, /不要为排查而自动重新生成/);
    assert.match(call.result.content[0].text, /\[配置 Key\]\(http:\/\/127\.0\.0\.1:/);
    const automatic = call.result.content[0].text.match(/http:\/\/127\.0\.0\.1:\d+\/configure\/[a-f0-9]{64}/)?.[0];
    const requested = await proxy.request({ jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'configure_key', arguments: {} } });
    assert.ok(automatic && requested.result.content[0].text.includes(automatic),
      'explicit configure must not invalidate the 401 recovery link');
    assert.ok(!call.result.content[0].text.includes('st_expired'));
  } finally {
    proxy.close();
    await stub.close();
    cleanup();
  }
});

test('日常401由代理返回可点击私密链接，不自动弹页；新Key保存后同代理重读', async () => {
  const { home, cleanup } = makeHome();
  const old = 'pk_FictionalProxyOld0123456789';
  const next = 'pk_FictionalProxyNew0123456789';
  let revoked = false, revokeFresh = false, writes = 0;
  const stub = await startStub(({ request, headers }) => {
    if (revoked && headers.authorization === `Bearer ${old}` || revokeFresh && headers.authorization === `Bearer ${next}`)
      return { status: 401, body: { code: 'UNAUTHORIZED' } };
    if (request?.method === 'tools/call' && request.params?.name === 'mark_done') writes++;
    return { body: { jsonrpc: '2.0', id: request?.id,
      result: { content: [{ type: 'text', text: '虚构项目' }], isError: false } } };
  });
  writeConfig(home, { url: stub.url, key: old, keyOrigin: new URL(stub.url).origin });
  const proxy = new ProxySession({ home });
  const call = (id, name = 'my_projects') => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } });
  try {
    assert.equal((await proxy.request(call(1))).result.isError, false);
    revoked = true;
    await confirmWrite(home,'mark_done');
    const denied = await proxy.request(call(2, 'mark_done'));
    assert.equal(denied.result.isError, true);
    const message = denied.result.content[0].text;
    const url = message.match(/http:\/\/127\.0\.0\.1:\d+\/configure\/[a-f0-9]{64}/)?.[0];
    assert.ok(url, 'proxy must supply the actual loopback page URL to the Agent');
    assert.match(message, /\[配置 Key\]\(http:\/\/127\.0\.0\.1:/);
    assert.ok(!message.includes(old) && !message.includes(next));
    assert.equal(writes, 0, 'rejected write was not executed');
    assert.equal((await fetch(url)).status, 200, 'not automatically opened, only listener created');
    const html = await (await fetch(url)).text();
    const nonce = html.match(/name="nonce" value="([a-f0-9]{64})"/)[1];
    const saved = await fetch(url, { method: 'POST', headers: { Origin: new URL(url).origin },
      body: new URLSearchParams({ nonce, action: 'save', key: next }) });
    assert.match(await saved.text(), /身份连接成功/);
    assert.equal((await proxy.request(call(3))).result.isError, false);
    assert.equal(writes, 0, 'failed write cannot be automatically replayed');
    revokeFresh = true;
    const renewed = await proxy.request(call(4));
    const newLink = renewed.result.content[0].text.match(/http:\/\/127\.0\.0\.1:\d+\/configure\/[a-f0-9]{64}/)?.[0];
    assert.ok(newLink && newLink !== url, 'a completed link cannot be reused after a later genuine 401');
  } finally { proxy.close(); await stub.close(); cleanup(); }
});

test('401链接在代理stdin结束并退出后仍由原页面服务完成虚构Key配置', async () => {
  const { home, cleanup } = makeHome();
  const old = 'pk_FictionalDetachedOld0123456789';
  const fresh = 'pk_FictionalDetachedNew0123456789';
  const stub = await startStub(({ request, headers }) => headers.authorization === `Bearer ${old}`
    ? { status: 401, body: {} }
    : { body: { jsonrpc: '2.0', id: request?.id, result: { content: [], isError: false } } });
  writeConfig(home, { url: stub.url, key: old, keyOrigin: new URL(stub.url).origin });
  const proxy = new ProxySession({ home });
  let link, nextProxy;
  try {
    const denied = await proxy.request({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'my_projects', arguments: {} } });
    link = pageLink(denied);
    assert.ok(link);
    const pagePid = JSON.parse(readFileSync(join(home, '.promate-recovery/page.json'), 'utf8')).pid;
    const exited = new Promise(resolve => proxy.child.once('close', resolve));
    proxy.child.stdin.end();
    assert.equal(await Promise.race([exited,
      new Promise((_, reject) => setTimeout(() => reject(Error('parent did not exit')), 4000))]), 0);
    const page = await fetch(link); // only after the originating proxy has actually exited
    assert.equal(page.status, 200);
    const nonce = (await page.text()).match(/name="nonce" value="([a-f0-9]{64})"/)[1];
    const saved = await fetch(link, { method: 'POST', headers: { Origin: new URL(link).origin },
      body: new URLSearchParams({ nonce, action: 'save', key: fresh }) });
    assert.match(await saved.text(), /身份连接成功/);
    assert.equal(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).key, fresh);
    await until(() => !existsSync(join(home, '.promate-recovery/page.json')), 'successful page did not clean its record');
    await until(() => testPageExited(pagePid), 'successful page process did not exit');
    const closed = await fetch(link).then(reply => reply.status !== 200, () => true);
    assert.equal(closed, true, 'completed page must not remain usable');
    nextProxy = new ProxySession({ home });
    assert.equal((await nextProxy.request({ jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'my_projects', arguments: {} } })).result.isError, false);
  } finally { nextProxy?.close(); if (proxy.child.exitCode === null) proxy.close(); await stub.close(); cleanup(); }
});

test('代理收到SIGTERM后原401链接仍能完成本机配置并清理', async () => {
  const { home, cleanup } = makeHome();
  const old = 'pk_FictionalTermOld0123456789', fresh = 'pk_FictionalTermNew0123456789';
  const stub = await startStub(({ request, headers }) => headers.authorization === `Bearer ${old}`
    ? { status: 401, body: {} }
    : { body: { jsonrpc: '2.0', id: request?.id, result: { content: [], isError: false } } });
  writeConfig(home, { url: stub.url, key: old, keyOrigin: new URL(stub.url).origin });
  const proxy = new ProxySession({ home });
  const recordFile = join(home, '.promate-recovery/page.json');
  let owner;
  try {
    const denied = await proxy.request({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'my_projects', arguments: {} } });
    const link = pageLink(denied);
    assert.ok(link && existsSync(recordFile));
    owner = JSON.parse(readFileSync(recordFile, 'utf8'));
    const exited = new Promise(resolve => proxy.child.once('close', resolve));
    proxy.child.kill('SIGTERM'); // only this test-owned isolated proxy
    await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(Error('proxy not terminated')), 4000))]);
    const available = await fetch(link);
    assert.equal(available.status, 200);
    const nonce = (await available.text()).match(/name="nonce" value="([a-f0-9]{64})"/)[1];
    const saved = await fetch(link, { method: 'POST', headers: { Origin: new URL(link).origin },
      body: new URLSearchParams({ nonce, action: 'save', key: fresh }) });
    assert.match(await saved.text(), /身份连接成功/);
    assert.equal(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).key, fresh);
    await until(() => !existsSync(recordFile), 'SIGTERM recovery page did not clean its record');
    await until(() => testPageExited(owner.pid), 'SIGTERM recovery page process did not exit');
  } finally {
    if (proxy.child.exitCode === null && !proxy.child.signalCode) proxy.close();
    if (owner && existsSync(recordFile)) { try { process.kill(owner.pid, 'SIGTERM'); } catch { /* test-owned process already exited */ } }
    await stub.close(); cleanup();
  }
});

test('代理重建后复用仍存活的同源链接；取消后才创建新入口', async () => {
  const { home, cleanup } = makeHome();
  const stub = await startStub(() => ({ status: 401, body: {} }));
  writeConfig(home, { url: stub.url, key: 'pk_FictionalRebuild0123456789', keyOrigin: new URL(stub.url).origin });
  const first = new ProxySession({ home });
  const call = id => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'my_projects', arguments: {} } });
  const recordFile = join(home, '.promate-recovery/page.json');
  let second, owner;
  try {
    const original = pageLink(await first.request(call(1)));
    assert.ok(original);
    owner = JSON.parse(readFileSync(recordFile, 'utf8'));
    const exited = new Promise(resolve => first.child.once('close', resolve));
    first.child.stdin.end();
    await exited;
    second = new ProxySession({ home });
    const reused = pageLink(await second.request(call(2)));
    assert.ok(reused === original, 'another proxy must validate and reuse the original live page');
    const nonce = (await (await fetch(original)).text()).match(/name="nonce" value="([a-f0-9]{64})"/)[1];
    const cancelled = await fetch(original, { method: 'POST', headers: { Origin: new URL(original).origin },
      body: new URLSearchParams({ nonce, action: 'cancel' }) });
    assert.equal(cancelled.status, 200);
    await until(() => !existsSync(recordFile), 'cancelled child did not clean record');
    const renewed = pageLink(await second.request(call(3)));
    assert.ok(renewed && renewed !== original);
    const n2 = (await (await fetch(renewed)).text()).match(/name="nonce" value="([a-f0-9]{64})"/)[1];
    await fetch(renewed, { method: 'POST', headers: { Origin: new URL(renewed).origin },
      body: new URLSearchParams({ nonce: n2, action: 'cancel' }) });
    await until(() => !existsSync(recordFile), 'second page did not clean record');
  } finally {
    if (first.child.exitCode === null) first.close(); second?.close();
    if (owner && existsSync(recordFile)) { try { process.kill(owner.pid, 'SIGTERM'); } catch {} }
    await stub.close(); cleanup();
  }
});

test('父代理退出后记录到期，独立页面关闭并可受控重建', async () => {
  const { home, cleanup } = makeHome();
  const stub = await startStub(() => ({ status: 401, body: {} }));
  writeConfig(home, { url: stub.url, key: 'pk_FictionalExpiry0123456789', keyOrigin: new URL(stub.url).origin });
  const proxy = new ProxySession({ home });
  const recordFile = join(home, '.promate-recovery/page.json');
  let owner, later;
  const call = id => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'my_projects', arguments: {} } });
  try {
    const original = pageLink(await proxy.request(call(1)));
    assert.ok(original);
    owner = JSON.parse(readFileSync(recordFile, 'utf8'));
    const exited = new Promise(resolve => proxy.child.once('close', resolve));
    proxy.child.stdin.end(); await exited;
    const temp = recordFile + '.test';
    writeFileSync(temp, JSON.stringify({ ...owner, expiresAt: Date.now() - 1 }), { flag: 'wx', mode: 0o600 });
    renameSync(temp, recordFile); // only this isolated test record; simulates original deadline
    await until(() => !existsSync(recordFile), 'expired page process did not clean record');
    const expired = await fetch(original).then(reply => reply.status !== 200, () => true);
    assert.equal(expired, true);
    later = new ProxySession({ home });
    const renewed = pageLink(await later.request(call(2)));
    assert.ok(renewed && renewed !== original);
    const nonce = (await (await fetch(renewed)).text()).match(/name="nonce" value="([a-f0-9]{64})"/)[1];
    await fetch(renewed, { method: 'POST', headers: { Origin: new URL(renewed).origin },
      body: new URLSearchParams({ nonce, action: 'cancel' }) });
    await until(() => !existsSync(recordFile), 'renewed page did not clean record');
  } finally {
    if (proxy.child.exitCode === null) proxy.close(); later?.close();
    if (owner && existsSync(recordFile)) { try { process.kill(owner.pid, 'SIGTERM'); } catch {} }
    await stub.close(); cleanup();
  }
});

test('连续与并发401复用一条有效链接；取消后下一次才新建', async () => {
  const { home, cleanup } = makeHome();
  const stub = await startStub(() => ({ status: 401, body: { code: 'UNAUTHORIZED' } }));
  writeConfig(home, { url: stub.url, key: 'pk_Fictional401Only0123456789', keyOrigin: new URL(stub.url).origin });
  const proxy = new ProxySession({ home });
  const call = id => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'my_projects', arguments: {} } });
  const link = reply => reply.result?.content?.[0]?.text.match(/http:\/\/127\.0\.0\.1:\d+\/configure\/[a-f0-9]{64}/)?.[0];
  try {
    const [one, two] = await Promise.all([proxy.request(call(1)), proxy.request(call(2))]);
    assert.equal(one.result.isError, true); assert.equal(two.result.isError, true);
    const original = link(one);
    assert.ok(original && original === link(two), 'concurrent replies must share a live page');
    const third = link(await proxy.request(call(3)));
    assert.ok(third === original);
    const html = await (await fetch(original)).text();
    const nonce = html.match(/name="nonce" value="([a-f0-9]{64})"/)[1];
    const cancelled = await fetch(original, { method: 'POST', headers: { Origin: new URL(original).origin },
      body: new URLSearchParams({ nonce, action: 'cancel' }) });
    assert.equal(cancelled.status, 200);
    const renewed = link(await proxy.request(call(4)));
    assert.ok(renewed && renewed !== original, 'cancelled link must never be reused');
    assert.equal((await fetch(renewed)).status, 200);
    await assert.rejects(fetch(original), /fetch failed/);
    const source = readFileSync(join(PLUGIN_ROOT, 'mcp/proxy.mjs'), 'utf8');
    assert.doesNotMatch(source, /\/usr\/bin\/open|present_files|workbuddy:\/\/task/,
      'daily proxy has no browser launch path');
  } finally { proxy.close(); await stub.close(); cleanup(); }
});

test('等待显式页面创建期间旧401过时，不关闭刚返回的有效链接', async () => {
  const { home, cleanup } = makeHome();
  const gate = heldPageListen(home);
  const old = 'pk_FictionalHeldOld0123456789';
  const fresh = 'pk_FictionalHeldNew0123456789';
  let oldCalls = 0;
  const stub = await startStub(({ request, headers }) => {
    if (headers.authorization === `Bearer ${old}`) { oldCalls++; return { status: 401, body: {} }; }
    return { body: { jsonrpc: '2.0', id: request?.id,
      result: { content: [{ type: 'text', text: '本地虚构项目' }], isError: false } } };
  });
  writeConfig(home, { url: stub.url, key: old, keyOrigin: new URL(stub.url).origin });
  const proxy = new ProxySession({ home, env: gate.env });
  const call = (id, name = 'my_projects') => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } });
  try {
    const explicit = proxy.request(call(1, 'configure_key'));
    await until(() => existsSync(gate.ready), 'explicit page did not reach held listen');
    const stale = proxy.request(call(2));
    await until(() => proxy.stderr.includes('平台返回 401'), '401 did not reach proxy before release');
    const file = join(home, 'config.json');
    const config = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file + '.new', JSON.stringify({ ...config, key: fresh }) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(file + '.new', file); // simulated second local session, no real profile
    gate.release();
    const replies = await Promise.all([explicit, stale]);
    const byId = new Map(replies.map(reply => [reply.id, reply]));
    const original = pageLink(byId.get(1));
    assert.ok(original);
    const opened = await fetch(original);
    assert.equal(opened.status, 200, 'old 401 must not close the explicit page');
    const nonce = (await opened.text()).match(/name="nonce" value="([a-f0-9]{64})"/)[1];
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).key, fresh);
    const verified = await fetch(original, { method: 'POST', headers: { Origin: new URL(original).origin },
      body: new URLSearchParams({ nonce, action: 'check' }) });
    assert.match(await verified.text(), /身份连接成功/, 'explicit link remains usable');
    assert.equal(pageLink(byId.get(2)), undefined);
    assert.equal(byId.get(2).result.isError, true);
    assert.equal(readFileSync(gate.attempts, 'utf8'), '1', 'stale 401 must not start another page');
    assert.equal(oldCalls, 1);
    assert.equal((await proxy.request(call(3))).result.isError, false, 'new Key remains usable');
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).key, fresh);
  } finally { gate.release(); proxy.close(); await stub.close(); cleanup(); }
});

test('前一页面创建失败：过时401不重建，仍有效的401可重建', async () => {
  for (const changed of [true, false]) {
    const { home, cleanup } = makeHome();
    const gate = heldPageListen(home, { fail: true });
    const old = 'pk_FictionalFailedListen0123456789';
    const next = 'pk_FictionalUpdatedAfterFailure0123456789';
    const stub = await startStub(({ headers }) => headers.authorization === `Bearer ${old}`
      ? { status: 401, body: {} }
      : { body: { jsonrpc: '2.0', id: 'unused', result: { content: [], isError: false } } });
    writeConfig(home, { url: stub.url, key: old, keyOrigin: new URL(stub.url).origin });
    const proxy = new ProxySession({ home, env: gate.env });
    const call = (id, name = 'my_projects') => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } });
    try {
      const explicit = proxy.request(call(1, 'configure_key'));
      await until(() => existsSync(gate.ready), 'failed listen did not reach barrier');
      const waiting = proxy.request(call(2));
      await until(() => proxy.stderr.includes('平台返回 401'), '401 did not wait on failing creation');
      if (changed) {
        const file = join(home, 'config.json'), config = JSON.parse(readFileSync(file, 'utf8'));
        writeFileSync(file + '.new', JSON.stringify({ ...config, key: next }) + '\n', { flag: 'wx', mode: 0o600 });
        renameSync(file + '.new', file);
      }
      gate.release();
      const byId = new Map((await Promise.all([explicit, waiting])).map(reply => [reply.id, reply]));
      assert.equal(byId.get(1).result.isError, true);
      if (changed) {
        assert.equal(pageLink(byId.get(2)), undefined, 'stale 401 must not retry failed creation');
        assert.equal(readFileSync(gate.attempts, 'utf8'), '1');
        assert.match(byId.get(2).result.content[0].text, /已过时/);
      } else {
        const recovered = pageLink(byId.get(2));
        assert.ok(recovered, 'valid 401 must rebuild after prior failure');
        assert.equal(readFileSync(gate.attempts, 'utf8'), '11');
        assert.equal((await fetch(recovered)).status, 200);
      }
    } finally { gate.release(); proxy.close(); await stub.close(); cleanup(); }
  }
});

test('等待期间来源改为B：旧401不创建额外页面，B的显式页面仍可建立', async () => {
  const { home, cleanup } = makeHome();
  const gate = heldPageListen(home);
  const a = await startStub(() => ({ status: 401, body: {} }));
  const b = await startStub(() => ({ status: 401, body: {} }));
  writeConfig(home, { url: a.url, key: 'pk_FictionalOriginA0123456789', keyOrigin: new URL(a.url).origin });
  const proxy = new ProxySession({ home, env: gate.env });
  const call = (id, name = 'my_projects') => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } });
  try {
    const explicit = proxy.request(call(1, 'configure_key'));
    await until(() => existsSync(gate.ready), 'A page did not reach barrier');
    const waiting = proxy.request(call(2));
    await until(() => proxy.stderr.includes('平台返回 401'), 'old 401 did not wait');
    writeConfig(home, { url: b.url, key: 'pk_FictionalOriginB0123456789', keyOrigin: new URL(b.url).origin });
    gate.release();
    const replies = new Map((await Promise.all([explicit, waiting])).map(reply => [reply.id, reply]));
    assert.equal(pageLink(replies.get(2)), undefined);
    assert.equal(readFileSync(gate.attempts, 'utf8'), '1');
    const bPage = pageLink(await proxy.request(call(3, 'configure_key')));
    assert.ok(bPage);
    assert.equal((await fetch(bPage)).status, 200);
    assert.equal(readFileSync(gate.attempts, 'utf8'), '11', 'only explicit B request creates a new page');
  } finally { gate.release(); proxy.close(); await a.close(); await b.close(); cleanup(); }
});

test('代理stdin在等待页面创建时关闭，旧401不能再创建页面', async () => {
  const { home, cleanup } = makeHome();
  const gate = heldPageListen(home);
  const stub = await startStub(() => ({ status: 401, body: {} }));
  writeConfig(home, { url: stub.url, key: 'pk_FictionalShutdown0123456789', keyOrigin: new URL(stub.url).origin });
  const proxy = new ProxySession({ home, env: gate.env });
  const call = (id, name = 'my_projects') => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } });
  try {
    proxy.child.stdin.write(JSON.stringify(call(1, 'configure_key')) + '\n');
    await until(() => existsSync(gate.ready), 'held page creation did not start');
    proxy.child.stdin.write(JSON.stringify(call(2)) + '\n');
    await until(() => proxy.stderr.includes('平台返回 401'), 'old 401 did not wait');
    const exited = new Promise(resolve => proxy.child.once('close', resolve));
    proxy.child.stdin.end();
    await until(() => existsSync(gate.stdinClosed), 'proxy did not process stdin close');
    gate.release();
    const exit = await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(Error('proxy remained active')), 5000))]);
    assert.equal(exit, 0);
    assert.equal(readFileSync(gate.attempts, 'utf8'), '1', 'shutdown must not create a second page');
  } finally { gate.release(); if (proxy.child.exitCode === null) proxy.close(); await stub.close(); cleanup(); }
});

test('401页面绑定来源，不把A的旧Key或页面复用到B', async () => {
  const { home, cleanup } = makeHome();
  let aCalls = 0, bCalls = 0;
  const a = await startStub(() => { aCalls++; return { status: 401, body: { code: 'A401' } }; });
  const b = await startStub(() => { bCalls++; return { status: 401, body: { code: 'B401' } }; });
  const old = 'pk_FictionalSourceA0123456789';
  const other = 'pk_FictionalSourceB0123456789';
  writeConfig(home, { url: a.url, key: old, keyOrigin: new URL(a.url).origin });
  const proxy = new ProxySession({ home });
  const call = id => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'my_projects', arguments: {} } });
  const link = reply => reply.result?.content?.[0]?.text.match(/http:\/\/127\.0\.0\.1:\d+\/configure\/[a-f0-9]{64}/)?.[0];
  try {
    const oldLink = link(await proxy.request(call(1)));
    assert.ok(oldLink);
    writeConfig(home, { url: b.url, key: old, keyOrigin: new URL(a.url).origin });
    const mismatched = await proxy.request(call(2));
    assert.equal(mismatched.result.isError, true);
    assert.equal(link(mismatched), undefined, 'old Key must not cross platform source');
    assert.equal((await fetch(oldLink)).status, 410);
    writeConfig(home, { url: b.url, key: other, keyOrigin: new URL(b.url).origin });
    const newLink = link(await proxy.request(call(3)));
    assert.ok(newLink && newLink !== oldLink);
    assert.equal((await fetch(newLink)).status, 200);
    assert.equal(aCalls, 1); assert.equal(bCalls, 1);
    assert.ok(!proxy.stderr.includes(old) && !proxy.stderr.includes(other));
  } finally { proxy.close(); await a.close(); await b.close(); cleanup(); }
});

test('旧请求迟到401不关闭新Key配置、不生成新链接或重放写操作', async () => {
  const { home, cleanup } = makeHome();
  const old = 'pk_FictionalLate401Old0123456789';
  const fresh = 'pk_FictionalLate401New0123456789';
  let arrived, release, oldCalls = 0, newCalls = 0;
  const entered = new Promise(resolve => { arrived = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw);
    if (req.headers.authorization === `Bearer ${old}`) {
      oldCalls++; arrived(); await held;
      if (!res.destroyed) { res.writeHead(401); res.end('{}'); }
      return;
    }
    assert.equal(req.headers.authorization, `Bearer ${fresh}`);
    newCalls++;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: input.id,
      result: { content: [], isError: false } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = `http://127.0.0.1:${server.address().port}/api/mcp`;
  writeConfig(home, { url: address, key: old, keyOrigin: new URL(address).origin });
  const proxy = new ProxySession({ home });
  try {
    await confirmWrite(home,'mark_done',{id:'fictional'});
    const oldRequest = proxy.request({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'mark_done', arguments: { id: 'fictional' } } });
    await entered;
    const configure = proxy.request({ jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'configure_key', arguments: {} } });
    // ProxySession resolves in stdout order; the local tool responds while request 1 is still held.
    const ready = await oldRequest;
    assert.equal(ready.id, 2);
    const link = ready.result.content[0].text.match(/http:\/\/127\.0\.0\.1:\d+\/configure\/[a-f0-9]{64}/)?.[0];
    assert.ok(link);
    const html = await (await fetch(link)).text();
    const nonce = html.match(/name="nonce" value="([a-f0-9]{64})"/)[1];
    const saved = await fetch(link, { method: 'POST', headers: { Origin: new URL(link).origin },
      body: new URLSearchParams({ nonce, action: 'save', key: fresh }) });
    assert.match(await saved.text(), /身份连接成功/);
    release();
    const stale = await configure;
    assert.equal(stale.id, 1);
    assert.equal(stale.result.isError, true);
    assert.equal(/configure\/[a-f0-9]{64}/.test(stale.result.content[0].text), false);
    assert.equal(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).key, fresh);
    const after = await proxy.request({ jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'my_projects', arguments: {} } });
    assert.equal(after.result.isError, false);
    assert.equal(oldCalls, 1, 'failed write was not replayed');
    assert.equal(newCalls, 2, 'one read-only page check and one later business query');
  } finally { release(); proxy.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); cleanup(); }
});

test('同Key被原子重写后，旧请求迟到401也不能生成链接（凭据代次）', async () => {
  const { home, cleanup } = makeHome();
  let release, arrived;
  const held = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { arrived = resolve; });
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* fictional request */ }
    arrived(); await held;
    if (!res.destroyed) { res.writeHead(401); res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/mcp`;
  const file = join(home, 'config.json');
  writeConfig(home, { url, key: 'pk_FictionalSameKey0123456789', keyOrigin: new URL(url).origin });
  const proxy = new ProxySession({ home });
  try {
    const inFlight = proxy.request({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'my_projects', arguments: {} } });
    await entered;
    const bytes = readFileSync(file);
    writeFileSync(file + '.new', bytes, { flag: 'wx', mode: 0o600 });
    renameSync(file + '.new', file); // same Key and URL, but a new credential file generation
    release();
    const stale = await inFlight;
    assert.equal(stale.result.isError, true);
    assert.equal(/configure\/[a-f0-9]{64}/.test(stale.result.content[0].text), false);
  } finally { release(); proxy.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); cleanup(); }
});

test('平台 503：身份服务不可用不能解释为无效 Key', async () => {
  const { home, cleanup } = makeHome();
  const stub = await startStub(() => ({ status: 503, body: { code: 'AUTH_SERVICE_UNAVAILABLE' } }));
  writeConfig(home, { url: stub.url, key: 'st_test_token' });
  const proxy = new ProxySession({ home });
  try {
    const response = await proxy.request({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'my_projects', arguments: {} } });
    assert.equal(response.error.code, -32603);
    assert.match(response.error.message, /不能断言 Key 无效或过期/);
  } finally { proxy.close(); await stub.close(); cleanup(); }
});

test('403、503、普通业务错误和成功均不创建401恢复链接', async () => {
  const { home, cleanup } = makeHome();
  let mode = 'forbidden';
  const stub = await startStub(({ request }) => {
    if (mode === 'forbidden') return { status: 403, body: { code: 'FORBIDDEN' } };
    if (mode === 'unavailable') return { status: 503, body: { code: 'SERVICE_UNAVAILABLE' } };
    return { body: { jsonrpc: '2.0', id: request.id,
      result: { content: [{ type: 'text', text: mode === 'business' ? '普通业务错误' : '正常项目' }], isError: mode === 'business' } } };
  });
  writeConfig(home, { url: stub.url, key: 'pk_FictionalNo4010123456789' });
  const proxy = new ProxySession({ home });
  try {
    for (const next of ['forbidden', 'unavailable', 'business', 'success']) {
      mode = next;
      const reply = await proxy.request({ jsonrpc: '2.0', id: next, method: 'tools/call',
        params: { name: 'my_projects', arguments: {} } });
      assert.equal(/configure\/[a-f0-9]{64}/.test(JSON.stringify(reply)), false);
      if (next === 'forbidden' || next === 'unavailable') assert.equal(reply.error.code, -32603);
      else assert.equal(reply.result.isError, next === 'business');
    }
  } finally { proxy.close(); await stub.close(); cleanup(); }
});

test('X1 自宣新版仍返旧包时兜底拦截；正式说明里的字段示例不误认安装包',async()=>{
  const {home,cleanup}=makeHome();let mode='structured';const encoded=Buffer.from('LEGACY_PRIVATE_BYTES').toString('base64');
  const preview={skill:{id:7},preview:{content:'说明示例：{"contentBase64":"illustration only"}，不是文件'}};
  const stub=await startStub(({request})=>{if(request.method==='initialize')return {body:{jsonrpc:'2.0',id:request.id,result:{capabilities:{promate:{toolset:'mcp-tools-v2',programApi:1}}}}};const legacy={skill:{id:7},contentBase64:encoded};return {body:{jsonrpc:'2.0',id:request.id,result:{isError:false,...(mode==='structured'?{structuredContent:legacy}:{}),content:[{type:'text',text:JSON.stringify(mode==='preview'?preview:legacy)}]}}};});
  writeConfig(home,{url:stub.url,key:'fictional-legacy-key'});const proxy=new ProxySession({home});
  try{
    for(const next of ['structured','text','preview']){mode=next;const reply=await proxy.request({jsonrpc:'2.0',id:next,method:'tools/call',params:{name:'get_skill',arguments:{skillId:7}}});
      assert.equal(reply.result.isError,next!=='preview');assert.ok(!JSON.stringify(reply).includes(encoded));
      if(next==='preview')assert.match(reply.result.content[0].text,/illustration only/);else assert.match(reply.result.content[0].text,/平台尚未升级/);
    }
    assert.equal((await proxy.request({jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'invoke_skill',arguments:{skillId:7}}})).result.isError,true);
  }finally{proxy.close();await stub.close();cleanup();}
});

test('X1 大旧包／异常大回复在2MB边界阻断，不进入模型或误报成功',async()=>{
  const {home,cleanup}=makeHome();const sentinel='PRIVATE_LARGE_CONTENT';
  const stub=await startStub(({request})=>request.method==='initialize'?{body:{jsonrpc:'2.0',id:request.id,result:{capabilities:{promate:{toolset:'mcp-tools-v2',programApi:1}}}}}:{body:{jsonrpc:'2.0',id:request.id,result:{content:[{type:'text',text:JSON.stringify({contentBase64:sentinel+'x'.repeat(2*1024*1024)})}],isError:false}}});
  writeConfig(home,{url:stub.url,key:'fictional-large-key'});const proxy=new ProxySession({home});
  try{const reply=await proxy.request({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'get_skill',arguments:{skillId:7}}});assert.equal(reply.error.code,-32603);assert.match(reply.error.message,/平台可能尚未升级/);assert.ok(!JSON.stringify(reply).includes(sentinel));}
  finally{proxy.close();await stub.close();cleanup();}
});

test('平台 500：仍是 JSON-RPC 错误（非 Key 问题）', async () => {
  const { home, cleanup } = makeHome();
  const stub = await startStub(() => ({ status: 500, body: { code: 'BOOM' } }));
  writeConfig(home, { url: stub.url, key: 'st_test_token' });
  const proxy = new ProxySession({ home });
  try {
    const response = await proxy.request({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.equal(response.error.code, -32603);
  } finally {
    proxy.close();
    await stub.close();
    cleanup();
  }
});

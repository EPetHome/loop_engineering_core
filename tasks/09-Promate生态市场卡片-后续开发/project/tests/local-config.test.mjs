import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { fileMode, makeHome, PLUGIN_ROOT, ProxySession, readConfigFile, startStub, writeConfig } from './helpers.mjs';
import { startConfigPage } from '../marketplace/plugins/promate/mcp/local-config.mjs';

const KEY = 'pk_FictionOnly0123456789NoAccount';
const call = (id, name = 'configure_key', args = {}) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
function link(reply) {
  const text = reply.result.content[0].text;
  const url = text.match(/http:\/\/127\.0\.0\.1:\d+\/configure\/[0-9a-f]{64}/)?.[0];
  assert.ok(url, '必须只给出 loopback 临时配置页');
  assert.ok(!text.includes(KEY), '工具输出不包含凭据');
  return url;
}
async function form(url) {
  const r = await fetch(url);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal(r.headers.get('cache-control'), 'no-store, max-age=0');
  assert.equal(r.headers.get('referrer-policy'), 'same-origin');
  const html = await r.text();
  assert.ok(!html.includes(KEY));
  return html.match(/name="nonce" value="([0-9a-f]{64})"/)?.[1];
}
function getWithHost(url, host) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { headers: { Host: host } }, (res) => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject); req.end();
  });
}
async function post(url, nonce, key = KEY, { action = 'save', headers = {} } = {}) {
  const body = new URLSearchParams({ nonce, action, ...(action === 'save' ? { key } : {}) });
  return fetch(url, { method: 'POST', headers: { Origin: new URL(url).origin, ...headers }, body });
}

test('无 Key 参数本机配置页：一次保存、不回显、下次代理读取；新版分层目录19项', async () => {
  const { home, cleanup } = makeHome();
  let authorized = false;
  const stub = await startStub(({ request, headers }) => {
    authorized = request?.params?.name === 'my_projects' && headers.authorization === `Bearer ${KEY}`;
    return { body: { jsonrpc: '2.0', id: request?.id, result: { content: [{ type: 'text', text: '虚构项目' }], isError: false } } };
  });
  writeConfig(home, { url: stub.url, extra: { untouched: true } });
  const proxy = new ProxySession({ home });
  try {
    const list = await proxy.request({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const catalog=JSON.parse(readFileSync(join(PLUGIN_ROOT,'mcp/tools.json'),'utf8'));
    assert.equal(catalog.tools.length,15);assert.equal(catalog.localTools.length,3);
    assert.equal(list.result.tools.length,19);
    assert.deepEqual(list.result.tools.map(t=>t.name),[...catalog.tools,...catalog.localTools,{name:'configure_key'}].map(t=>t.name));
    assert.ok(!list.result.tools.some(t=>['set_stage','invoke_skill'].includes(t.name)));
    assert.deepEqual(list.result.tools.find((t) => t.name === 'configure_key').inputSchema, { type: 'object', properties: {}, additionalProperties: false });
    const before = await proxy.request(call(2, 'my_projects'));
    assert.equal(before.result.isError, true);
    const created = await proxy.request(call(3));
    const url = link(created);
    assert.ok(!url.includes(KEY));
    const nonce = await form(url);
    assert.ok(nonce);
    const saved = await post(url, nonce);
    const text = await saved.text();
    assert.equal(saved.status, 200);
    assert.match(text, /已保存，身份连接成功/);
    assert.ok(!text.includes(KEY));
    assert.equal(readConfigFile(home).key, KEY);
    assert.equal(readConfigFile(home).keyOrigin, new URL(stub.url).origin);
    assert.deepEqual(readConfigFile(home).extra, { untouched: true });
    assert.equal(fileMode(home), 0o700);
    assert.equal(fileMode(join(home, 'config.json')), 0o600);
    await assert.rejects(post(url, nonce), /fetch failed/, '已完成的短期页不能重放');
    const after = await proxy.request(call(4, 'my_projects'));
    assert.equal(after.result.isError, false);
    assert.ok(authorized, '同进程代理下一次调用使用新 Key');
    assert.ok(!(proxy.buffer + proxy.stderr + JSON.stringify(created) + JSON.stringify(after)).includes(KEY));
  } finally { proxy.close(); await stub.close(); cleanup(); }
});

test('页面区分已保存、401 拒绝、服务故障和空项目连接成功，不回显虚构 Key', async () => {
  const { home, cleanup } = makeHome();
  let mode = 'empty';
  const stub = await startStub(({ request, headers }) => {
    assert.equal(headers.authorization, `Bearer ${KEY}`);
    assert.equal(request.params?.name, 'my_projects');
    if (mode === 'reject') return { status: 401, body: { error: 'denied' } };
    if (mode === 'fault') return { status: 503, body: { error: 'unavailable' } };
    if (mode === 'wrongId') return { body: { jsonrpc: '2.0', id: 'unrelated', result: { content: [], isError: false } } };
    if (mode === 'toolError') return { body: { jsonrpc: '2.0', id: request.id, result: { content: [], isError: true } } };
    if (mode === 'large') return { body: { jsonrpc: '2.0', id: request.id,
      result: { content: [{ type: 'text', text: 'x'.repeat(128 * 1024) }], isError: false } } };
    return { body: { jsonrpc: '2.0', id: request.id, result: { content: [], isError: false } } };
  });
  writeConfig(home, { url: stub.url });
  const previous = process.env.PROMATE_HOME;
  process.env.PROMATE_HOME = home;
  try {
    for (const [state, expected] of [['empty', /连接成功/], ['reject', /身份验证被拒绝（401）/],
      ['fault', /平台未能完成连接检查（HTTP 503）/], ['wrongId', /连接检查结果未确认/],
      ['toolError', /连接检查结果未确认/],
      ['large', /连接检查响应过大/]]) {
      mode = state;
      const page = await startConfigPage();
      try {
        const nonce = await form(page.url);
        const response = await post(page.url, nonce);
        assert.equal(response.status, 200, state);
        const text = await response.text();
        assert.match(text, expected);
        assert.ok(!text.includes(KEY));
        if (state === 'empty') assert.equal((await post(page.url, nonce)).status, 410);
        else {
          assert.equal((await post(page.url, nonce)).status, 409, '失败的旧提交不能重放');
          assert.match(text, /name="key" type="password"/);
          assert.equal((await fetch(page.url)).status, 200, '失败可在同页继续');
        }
      } finally { page.close(); }
    }
    assert.equal(readConfigFile(home).key, KEY);
  } finally {
    if (previous === undefined) delete process.env.PROMATE_HOME; else process.env.PROMATE_HOME = previous;
    await stub.close(); cleanup();
  }
});

test('已有虚构 Key 检查401后同页更换并成功：失败不关闭、不回显、不重放', async () => {
  const { home, cleanup } = makeHome();
  const old = 'pk_FictionalOldRejected0123456789';
  let checks = 0, done;
  const stub = await startStub(({ request, headers }) => {
    checks++;
    return headers.authorization === `Bearer ${old}` ? { status: 401, body: { error: 'denied' } }
      : { body: { jsonrpc: '2.0', id: request.id, result: { content: [], isError: false } } };
  });
  writeConfig(home, { url: stub.url, key: old, keyOrigin: new URL(stub.url).origin, extra: 'keep' });
  const prior = process.env.PROMATE_HOME; process.env.PROMATE_HOME = home;
  let page;
  try {
    page = await startConfigPage({ keepAlive: true, onDone: code => { done = code; } });
    const nonce = await form(page.url);
    const checked = await post(page.url, nonce, undefined, { action: 'check' });
    const html = await checked.text();
    assert.equal(checked.status, 200);
    assert.match(html, /尚未完成身份配置/);
    assert.match(html, /现有 Key 未通过验证/);
    assert.match(html, /name="key" type="password"/);
    assert.ok(!html.includes(old) && !html.includes(KEY));
    assert.equal(readConfigFile(home).key, old);
    assert.equal(done, undefined, '401 cannot complete the page');
    const next = html.match(/name="nonce" value="([a-f0-9]{64})"/)[1];
    assert.notEqual(next, nonce);
    assert.notEqual((await post(page.url, nonce, KEY)).status, 200, 'old nonce cannot replay');
    assert.equal((await fetch(page.url)).status, 200);
    const saved = await post(page.url, next);
    assert.equal(saved.status, 200);
    assert.match(await saved.text(), /已保存，身份连接成功/);
    assert.equal(readConfigFile(home).key, KEY);
    assert.equal(readConfigFile(home).extra, 'keep');
    assert.equal(done, 'PRIVATE_PAGE_CONNECTED');
    assert.equal(checks, 2);
  } finally { page?.close(); if (prior === undefined) delete process.env.PROMATE_HOME; else process.env.PROMATE_HOME = prior;
    await stub.close(); cleanup(); }
});

test('新Key保存后401仍能在同页更换；503后可重试，只有连接成功才结束', async () => {
  const { home, cleanup } = makeHome();
  const nextKey = 'pk_FictionalReplacementKey0123456789';
  let mode = 'reject', done, checks = 0;
  const stub = await startStub(({ request, headers }) => {
    checks++;
    if (mode === 'reject' || headers.authorization === `Bearer ${KEY}` && mode !== 'connected') {
      return mode === 'reject' ? { status: 401, body: { error: 'denied' } }
        : { status: 503, body: { error: 'temporary' } };
    }
    return { body: { jsonrpc: '2.0', id: request.id, result: { content: [], isError: false } } };
  });
  writeConfig(home, { url: stub.url });
  const previous = process.env.PROMATE_HOME; process.env.PROMATE_HOME = home;
  let page;
  try {
    page = await startConfigPage({ keepAlive: true, onDone: code => { done = code; } });
    const firstHtml = await (await fetch(page.url)).text();
    assert.match(firstHtml, /尚未配置 Key，请输入/);
    let nonce = firstHtml.match(/name="nonce" value="([a-f0-9]{64})"/)[1];
    const rejected = await post(page.url, nonce);
    const deniedHtml = await rejected.text();
    assert.match(deniedHtml, /Key 已保存；尚未完成身份配置/);
    assert.match(deniedHtml, /身份验证被拒绝（401）/);
    assert.equal(readConfigFile(home).key, KEY);
    assert.equal(done, undefined);
    assert.ok(!deniedHtml.includes(KEY));
    nonce = deniedHtml.match(/name="nonce" value="([a-f0-9]{64})"/)[1];
    mode = 'fault';
    const unavailable = await post(page.url, nonce, undefined, { action: 'check' });
    const unavailableHtml = await unavailable.text();
    assert.match(unavailableHtml, /平台未能完成连接检查（HTTP 503）/);
    assert.match(unavailableHtml, /身份连接尚未确认/);
    assert.equal(readConfigFile(home).key, KEY);
    assert.equal(done, undefined);
    nonce = unavailableHtml.match(/name="nonce" value="([a-f0-9]{64})"/)[1];
    mode = 'connected';
    const saved = await post(page.url, nonce, nextKey);
    assert.match(await saved.text(), /Key 已保存，身份连接成功/);
    assert.equal(readConfigFile(home).key, nextKey);
    assert.equal(done, 'PRIVATE_PAGE_CONNECTED');
    assert.equal(checks, 3);
  } finally { page?.close(); if (previous === undefined) delete process.env.PROMATE_HOME; else process.env.PROMATE_HOME = previous;
    await stub.close(); cleanup(); }
});

test('重复接入页面可直接检查原有 Key，不重复输入也不重写配置', async () => {
  const { home, cleanup } = makeHome();
  const stub = await startStub(({ request, headers }) => {
    assert.equal(headers.authorization, `Bearer ${KEY}`);
    return { body: { jsonrpc: '2.0', id: request.id, result: { content: [], isError: false } } };
  });
  writeConfig(home, { url: stub.url, key: KEY, extra: 'preserved' });
  const before = readFileSync(join(home, 'config.json'), 'utf8');
  const proxy = new ProxySession({ home });
  try {
    const url = link(await proxy.request(call(1)));
    const html = await (await fetch(url)).text();
    assert.match(html, /无需重复输入/);
    assert.ok(!html.includes(KEY));
    const nonce = html.match(/name="nonce" value="([0-9a-f]{64})"/)[1];
    const checked = await post(url, nonce, undefined, { action: 'check' });
    assert.match(await checked.text(), /原有 Key 已保留，身份连接成功/);
    assert.equal(readFileSync(join(home, 'config.json'), 'utf8'), before);
  } finally { proxy.close(); await stub.close(); cleanup(); }
});

test('网络中断后保留输入与重查入口，loopback恢复后同页连接成功', async () => {
  const { home, cleanup } = makeHome();
  let online = false, done;
  const server = createServer((_req, res) => {
    if (!online) { res.destroy(); return; }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 'promate-connect-check', result: { content: [], isError: false } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/mcp`;
  writeConfig(home, { url, key: KEY, keyOrigin: new URL(url).origin });
  const previous = process.env.PROMATE_HOME; process.env.PROMATE_HOME = home;
  let page;
  try {
    page = await startConfigPage({ keepAlive: true, onDone: code => { done = code; } });
    const nonce = await form(page.url);
    const failed = await post(page.url, nonce, undefined, { action: 'check' });
    const html = await failed.text();
    assert.equal(failed.status, 200);
    assert.match(html, /平台暂不可达或响应无效/);
    assert.match(html, /身份连接尚未确认/);
    assert.match(html, /name="key" type="password"/);
    assert.equal(done, undefined);
    assert.equal(readConfigFile(home).key, KEY);
    online = true;
    const next = html.match(/name="nonce" value="([a-f0-9]{64})"/)[1];
    const recovered = await post(page.url, next, undefined, { action: 'check' });
    assert.match(await recovered.text(), /原有 Key 已保留，身份连接成功/);
    assert.equal(done, 'PRIVATE_PAGE_CONNECTED');
    assert.equal(readConfigFile(home).key, KEY);
  } finally { page?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    if (previous === undefined) delete process.env.PROMATE_HOME; else process.env.PROMATE_HOME = previous; cleanup(); }
});

test('连续401与格式错误只轮换nonce，不延长五分钟期限；到期仍失效', async () => {
  const { home, cleanup } = makeHome();
  let checks = 0, done, clock = 1000;
  const stub = await startStub(() => { checks++; return { status: 401, body: { error: 'denied' } }; });
  writeConfig(home, { url: stub.url });
  const previous = process.env.PROMATE_HOME; process.env.PROMATE_HOME = home;
  let page;
  try {
    page = await startConfigPage({ keepAlive: true, now: () => clock, ttlMs: 10000,
      onDone: code => { done = code; } });
    const originalExpiry = page.expiresAt;
    let nonce = await form(page.url);
    const bad = await post(page.url, nonce, 'not-a-key');
    let corrected = await bad.text();
    assert.equal(bad.status, 400);
    assert.match(corrected, /Key 格式无效/);
    assert.equal(checks, 0);
    assert.equal(readConfigFile(home).key, undefined);
    for (let i = 0; i < 3; i++) {
      nonce = corrected.match(/name="nonce" value="([a-f0-9]{64})"/)[1];
      const rejected = await post(page.url, nonce);
      const html = await rejected.text();
      assert.equal(rejected.status, 200);
      assert.match(html, /尚未完成身份配置/);
      assert.notEqual(html.match(/name="nonce" value="([a-f0-9]{64})"/)[1], nonce);
      assert.equal(page.expiresAt, originalExpiry);
      assert.equal(done, undefined);
      corrected = html;
    }
    clock = originalExpiry;
    assert.equal((await fetch(page.url)).status, 410);
    assert.equal(done, 'PRIVATE_PAGE_EXPIRED');
    assert.equal(readConfigFile(home).key, KEY);
    assert.equal(checks, 3);
  } finally { page?.close(); if (previous === undefined) delete process.env.PROMATE_HOME; else process.env.PROMATE_HOME = previous;
    await stub.close(); cleanup(); }
});

test('并发显式配置请求复用同源有效链接，不相互关闭（15.14）', async () => {
  const { home, cleanup } = makeHome();
  writeConfig(home, { url: 'https://platform.example.test/api/mcp' });
  const proxy = new ProxySession({ home });
  try {
    const replies = await Promise.all([proxy.request(call(1)), proxy.request(call(2))]);
    const byId = new Map(replies.map((reply) => [reply.id, reply]));
    assert.deepEqual([...byId.keys()].sort(), [1, 2]);
    const earlier = link(byId.get(1));
    const latest = link(byId.get(2));
    assert.equal(earlier, latest, 'explicit and concurrent requests must share one still-valid page');
    const latestNonce = await form(latest);
    assert.equal((await fetch(earlier)).status, 200);
    assert.equal((await post(latest, latestNonce)).status, 200);
    assert.equal(readConfigFile(home).key, KEY);
  } finally { proxy.close(); cleanup(); }
});

test('显式配置页在代理stdin关闭且退出后仍可点击并取消', async () => {
  const { home, cleanup } = makeHome();
  writeConfig(home, { url: 'https://platform.example.test/api/mcp' });
  const proxy = new ProxySession({ home });
  try {
    const url = link(await proxy.request(call(1)));
    await form(url);
    proxy.child.stdin.end();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('插件 stdin 关闭后仍未退出')), 5000);
      proxy.child.once('close', () => { clearTimeout(timer); resolve(); });
    });
    assert.equal((await fetch(url)).status, 200, '代理退出不能撤销已交付链接');
    const nonce = await form(url);
    const cancelled = await post(url, nonce, undefined, { action: 'cancel' });
    assert.equal(cancelled.status, 200);
    assert.equal(readConfigFile(home).key, undefined);
  } finally { proxy.close(); cleanup(); }
});

test('stdin 结束时即使业务请求仍在途也保留独立配置页', async () => {
  const { home, cleanup } = makeHome();
  let entered;
  let release;
  const arrived = new Promise((resolve) => { entered = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    entered();
    await held;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, result: { content: [], isError: false } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  writeConfig(home, { url: `http://127.0.0.1:${server.address().port}/api/mcp`, key: 'st_testonly_not_real' });
  const proxy = new ProxySession({ home });
  try {
    const url = link(await proxy.request(call(1)));
    await form(url);
    const pending = proxy.request(call(2, 'my_projects'));
    await arrived;
    proxy.child.stdin.end();
    // 在途业务请求仍可完成；独立页面不依赖此代理stdin。
    assert.equal((await fetch(url)).status, 200);
    assert.equal(proxy.child.exitCode, null, 'stdin EOF 不应截断在途业务响应');
    const exited = new Promise(resolve => proxy.child.once('close', resolve));
    release();
    assert.equal((await pending).result.isError, false);
    await exited;
    assert.equal((await fetch(url)).status, 200, '代理完成在途请求并退出后原页仍可用');
    const nonce = await form(url);
    assert.equal((await post(url, nonce, undefined, { action: 'cancel' })).status, 200);
    assert.equal(readConfigFile(home).key, 'st_testonly_not_real');
  } finally { release(); proxy.close(); await new Promise((resolve) => server.close(resolve)); cleanup(); }
});

test('在途只读检查可取消，迟到成功不能结束配置或改动旧 Key', async () => {
  const { home, cleanup } = makeHome();
  let arrived, release, done, checks = 0;
  const entered = new Promise(resolve => { arrived = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const server = createServer(async (req, res) => {
    for await (const _part of req) { /* consume fictional request */ }
    checks++;
    arrived(); await held;
    if (!res.destroyed) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 'promate-connect-check', result: { content: [], isError: false } }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/mcp`;
  writeConfig(home, { url, key: KEY, keyOrigin: new URL(url).origin });
  const previous = process.env.PROMATE_HOME; process.env.PROMATE_HOME = home;
  let page;
  try {
    page = await startConfigPage({ keepAlive: true, onDone: code => { done = code; } });
    const nonce = await form(page.url);
    const checking = post(page.url, nonce, undefined, { action: 'check' });
    await entered;
    assert.equal((await post(page.url, nonce, undefined, { action: 'check' })).status, 409,
      'an in-flight nonce cannot be replayed');
    const during = await (await fetch(page.url)).text();
    const cancelNonce = during.match(/name="nonce" value="([a-f0-9]{64})"/)[1];
    assert.notEqual(cancelNonce, nonce);
    assert.equal((await post(page.url, cancelNonce, KEY)).status, 409,
      'a different submission cannot write during a check');
    assert.equal(checks, 1);
    assert.equal(readConfigFile(home).key, KEY);
    const cancelled = await post(page.url, cancelNonce, undefined, { action: 'cancel' });
    assert.equal(cancelled.status, 200);
    assert.match(await cancelled.text(), /已取消检查/);
    assert.equal(done, 'PRIVATE_PAGE_CANCELLED');
    release();
    const late = await checking.then(async response => ({ status: response.status, text: await response.text() }),
      () => ({ status: 410, text: '' }));
    assert.notEqual(late.status === 200 && late.text.includes('连接成功'), true);
    assert.equal(done, 'PRIVATE_PAGE_CANCELLED');
    assert.equal(readConfigFile(home).key, KEY);
  } finally { release(); page?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    if (previous === undefined) delete process.env.PROMATE_HOME; else process.env.PROMATE_HOME = previous; cleanup(); }
});

test('检查在途跨过原到期时间后不能被迟到成功改写', async () => {
  const { home, cleanup } = makeHome();
  let release, arrived, done, clock = 1000;
  const held = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { arrived = resolve; });
  const server = createServer(async (req, res) => {
    for await (const _part of req) { /* fictional read-only check */ }
    arrived(); await held;
    if (!res.destroyed) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 'promate-connect-check', result: { content: [], isError: false } }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/mcp`;
  writeConfig(home, { url, key: KEY, keyOrigin: new URL(url).origin });
  const previous = process.env.PROMATE_HOME; process.env.PROMATE_HOME = home;
  let page;
  try {
    page = await startConfigPage({ keepAlive: true, now: () => clock, ttlMs: 10000,
      onDone: code => { done = code; } });
    const nonce = await form(page.url);
    const pending = post(page.url, nonce, undefined, { action: 'check' });
    await entered;
    clock = page.expiresAt;
    release();
    const late = await pending.then(async response => ({ status: response.status, text: await response.text() }),
      () => ({ status: 410, text: '' }));
    assert.ok(late.status !== 200 || !late.text.includes('连接成功'));
    assert.equal(done, 'PRIVATE_PAGE_INCOMPLETE');
    assert.equal(readConfigFile(home).key, KEY);
  } finally { release(); page?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    if (previous === undefined) delete process.env.PROMATE_HOME; else process.env.PROMATE_HOME = previous; cleanup(); }
});

test('短命 SessionStart 退出后独立页面进程可达，并在上限到期后关闭', async () => {
  const { home, cleanup } = makeHome();
  writeConfig(home, { url: 'https://platform.example.test/api/mcp' });
  const source = `import {startConfigPage} from ${JSON.stringify(new URL('../marketplace/plugins/promate/mcp/local-config.mjs', import.meta.url).href)};
    const page=await startConfigPage({keepAlive:true,ttlMs:800,onDone:code=>process.stdout.write('done:'+code+'\\n')});
    process.stdout.write(page.url+'\\n');`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    env: { ...process.env, PROMATE_HOME: home, PROMATE_CONFIG: join(home, 'config.json') }, stdio: ['ignore', 'pipe', 'ignore'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  try {
    const started = Date.now() + 3000;
    while (!output.includes('\n') && Date.now() < started) await new Promise(resolve => setTimeout(resolve, 10));
    const url = output.split('\n')[0];
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/configure\/[0-9a-f]{64}$/);
    assert.equal((await fetch(url)).status, 200, 'hook already exited; page owner remains alive');
    const [code] = await Promise.race([once(child, 'exit'), new Promise((_, reject) => setTimeout(() => reject(Error('page did not expire')), 3000))]);
    assert.equal(code, 0);
    assert.match(output, /done:PRIVATE_PAGE_EXPIRED/);
    await assert.rejects(fetch(url), /fetch failed/);
  } finally { if (child.exitCode === null) child.kill(); cleanup(); }
});

test('短期页面到期会断开不完整 POST，不留下无限存活的子进程', async () => {
  const { home, cleanup } = makeHome();
  writeConfig(home, { url: 'https://platform.example.test/api/mcp' });
  const previous = process.env.PROMATE_HOME; process.env.PROMATE_HOME = home;
  let outcome;
  const page = await startConfigPage({ keepAlive: true, ttlMs: 150, onDone: code => { outcome = code; } });
  const address = new URL(page.url);
  const socket = connect(Number(address.port), '127.0.0.1');
  socket.on('error', () => {});
  try {
    await once(socket, 'connect');
    socket.write(`POST ${address.pathname} HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\nOrigin: ${address.origin}\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: 100\r\n\r\nnonce=`);
    await Promise.race([new Promise(resolve => socket.once('close', resolve)),
      new Promise((_, reject) => setTimeout(() => reject(Error('socket survived page expiry')), 3000))]);
    assert.equal(outcome, 'PRIVATE_PAGE_EXPIRED');
    assert.equal(readConfigFile(home).key, undefined);
  } finally {
    socket.destroy(); page.close();
    if (previous === undefined) delete process.env.PROMATE_HOME; else process.env.PROMATE_HOME = previous;
    cleanup();
  }
});

test('未就绪无地址、工具参数带 Key 时不开放页面', async () => {
  const { home, cleanup } = makeHome();
  const proxy = new ProxySession({ home });
  try {
    assert.equal((await proxy.request(call(1))).result.isError, true);
    writeConfig(home, { url: 'http://127.0.0.1:18000/api/mcp' });
    const denied = await proxy.request(call(2, 'configure_key', { key: KEY }));
    assert.equal(denied.result.isError, true);
    assert.ok(!JSON.stringify(denied).includes(KEY));
  } finally { proxy.close(); cleanup(); }
});

test('私密页拒绝外部 Host/Origin、跨站、查询拼接、无同源证明、过大及重复字段；拒绝不消费有效页', async () => {
  const { home, cleanup } = makeHome();
  writeConfig(home, { url: 'https://platform.example.test/api/mcp' });
  const previous = process.env.PROMATE_HOME;
  process.env.PROMATE_HOME = home;
  const page = await startConfigPage();
  try {
    const nonce = await form(page.url);
    assert.equal(await getWithHost(page.url, 'evil.example'), 403);
    assert.equal((await fetch(page.url, { headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await fetch(`${page.url}?key=unsafe`)).status, 404);
    assert.equal((await post(page.url, nonce, KEY, { headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await post(page.url, nonce, KEY, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await post(page.url, nonce, KEY, { headers: { Origin: '' } })).status, 403);
    assert.equal((await post(page.url, nonce, KEY.repeat(40))).status, 413);
    const duplicated = new URLSearchParams({ nonce, action: 'save', key: KEY });
    duplicated.append('key', KEY);
    assert.equal((await fetch(page.url, { method: 'POST', headers: { Origin: new URL(page.url).origin }, body: duplicated })).status, 400);
    assert.equal(readConfigFile(home).key, undefined);
    assert.equal((await post(page.url, nonce)).status, 200, '拒绝请求不能占用用户的单次提交');
  } finally { page.close(); if (previous === undefined) delete process.env.PROMATE_HOME; else process.env.PROMATE_HOME = previous; cleanup(); }
});

test('取消、过期和格式错误均不覆盖旧 Key，且不能重放', async () => {
  const { home, cleanup } = makeHome();
  const old = 'pk_ExistingOnly0123456789NoAccount';
  writeConfig(home, { url: 'https://old.example.test/api/mcp', key: old, keyOrigin: 'https://old.example.test' });
  const previous = process.env.PROMATE_HOME;
  process.env.PROMATE_HOME = home;
  let page, expired;
  try {
    page = await startConfigPage();
    let nonce = await form(page.url);
    assert.equal((await post(page.url, nonce, undefined, { action: 'cancel' })).status, 200);
    assert.equal((await post(page.url, nonce)).status, 410);
    assert.equal(readConfigFile(home).key, old);
    page.close();
    page = await startConfigPage();
    nonce = await form(page.url);
    const malformed = await post(page.url, nonce, 'not-a-key');
    assert.equal(malformed.status, 400);
    const correction = await malformed.text();
    assert.match(correction, /name="key" type="password"/);
    assert.ok(!correction.includes(old));
    assert.notEqual(correction.match(/name="nonce" value="([a-f0-9]{64})"/)[1], nonce);
    assert.equal((await post(page.url, nonce)).status, 409);
    assert.equal(readConfigFile(home).key, old);
    let clock = 0;
    expired = await startConfigPage({ now: () => clock, ttlMs: 10000 });
    const expiredNonce = await form(expired.url);
    clock = 10000;
    assert.equal((await post(expired.url, expiredNonce)).status, 410);
    assert.equal(readConfigFile(home).key, old);
  } finally { page?.close(); expired?.close(); if (previous === undefined) delete process.env.PROMATE_HOME; else process.env.PROMATE_HOME = previous; cleanup(); }
});

test('换来源、坏配置和保存失败 fail closed；不向新来源复用旧凭据', async () => {
  const { home, cleanup } = makeHome();
  const old = 'pk_ExistingOnly0123456789NoAccount';
  writeConfig(home, { url: 'https://old.example.test/api/mcp', key: old, keyOrigin: 'https://old.example.test' });
  const previous = process.env.PROMATE_HOME;
  process.env.PROMATE_HOME = home;
  let page;
  try {
    page = await startConfigPage();
    let nonce = await form(page.url);
    writeConfig(home, { url: 'https://new.example.test/api/mcp', key: old, keyOrigin: 'https://old.example.test' });
    const failed = await post(page.url, nonce);
    assert.equal(failed.status, 410);
    assert.ok(!(await failed.text()).includes(KEY));
    assert.equal(readConfigFile(home).key, old);
    assert.equal(readConfigFile(home).keyOrigin, 'https://old.example.test');
    assert.equal((await post(page.url, nonce)).status, 410);
    page.close();
    page = await startConfigPage();
    nonce = await form(page.url);
    writeFileSync(join(home, 'config.json'), '{invalid-json');
    assert.equal((await post(page.url, nonce)).status, 410);
    assert.equal(readFileSync(join(home, 'config.json'), 'utf8'), '{invalid-json');
  } finally { page?.close(); if (previous === undefined) delete process.env.PROMATE_HOME; else process.env.PROMATE_HOME = previous; cleanup(); }
});

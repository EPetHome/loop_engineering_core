import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { requestFirstConnect, readFirstConnectResult, pendingFirstConnect, canReuseFirstConnect, claimFirstConnect, publishFirstConnect,
  finishFirstConnect, restoreFirstConnect } from '../marketplace/plugins/promate/mcp/first-connect.mjs';
import { resumeFirstConnect } from '../marketplace/plugins/promate/hooks/first-connect.mjs';
import { serveHandoffPage } from '../marketplace/plugins/promate/mcp/handoff-page.mjs';
const version = '0.2.14';
const platform = 'https://platform.example.test/api/mcp';
const marketplace = 'https://platform.example.test/api/skills/plugins/marketplace-' + 'a'.repeat(64) + '.zip';
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'promate-session-handoff-')));
  const profile = join(root, 'profile'), home = join(root, 'config');
  const pluginRoot = join(profile, 'plugins/cache/promate/promate', version);
  mkdirSync(pluginRoot, { recursive: true, mode: 0o700 });
  mkdirSync(join(profile, 'plugins/.promate-first-connect'), { mode: 0o700 });
  mkdirSync(home, { mode: 0o700 });
  writeFileSync(join(profile, 'plugins/installed_plugins.json'), JSON.stringify({ plugins: { 'promate@promate': [{
    scope: 'user', version, installPath: pluginRoot }] } }), { mode: 0o600 });
  writeFileSync(join(profile, 'plugins/known_marketplaces.json'), JSON.stringify({ promate: {
    manifestName: 'promate', source: { url: marketplace } } }), { mode: 0o600 });
  const previous = [process.env.PROMATE_HOME, process.env.PROMATE_CONFIG];
  process.env.PROMATE_HOME = home; process.env.PROMATE_CONFIG = join(home, 'config.json');
  const config = { url: platform, key: 'pk_FictionalNeverARealKey012345', extra: 'kept' };
  writeFileSync(join(home, 'config.json'), JSON.stringify(config), { mode: 0o600 });
  return { root, profile, home, pluginRoot, config, request: (options = {}) => requestFirstConnect({
    profile, version, platform, marketplace, ...options }),
  close() { for (const [name, value] of [['PROMATE_HOME', previous[0]], ['PROMATE_CONFIG', previous[1]]]) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  } rmSync(root, { recursive: true, force: true }); } };
}

test('no request does not open a page; canonical installed profile and registry are required', async () => {
  const f = fixture();
  try {
    let calls = 0;
    assert.equal(await resumeFirstConnect({ pluginRoot: f.pluginRoot, version, spawnPage: () => { calls++; } }), null);
    assert.equal(calls, 0);
    f.request();
    assert.throws(() => claimFirstConnect({ pluginRoot: f.pluginRoot, version: '0.2.8' }), /PLUGIN_PATH_UNPROVEN/);
    assert.throws(() => claimFirstConnect({ pluginRoot: f.root, version }), /PLUGIN_PATH_UNPROVEN/); // cannot guess another profile
    assert.equal(calls, 0);
  } finally { f.close(); }
});

test('one valid SessionStart claims exactly once without waiting for MCP; repeat preserves Key', async () => {
  const f = fixture();
  try {
    const before = readFileSync(join(f.home, 'config.json'), 'utf8');
    const id = f.request();
    assert.equal(f.request(), id); // same-version retry does not replace a pending request
    assert.equal(pendingFirstConnect({ profile: f.profile, version, platform, marketplace }), id);
    let call;
    const state = await resumeFirstConnect({ pluginRoot: f.pluginRoot, version, spawnPage: (...args) => {
      call = args;
      const child = new EventEmitter(); child.pid = process.pid; child.unref = () => {};
      queueMicrotask(() => child.emit('spawn'));
      return child;
    } });
    assert.equal(state, 'PRIVATE_PAGE_STARTING');
    assert.equal(await resumeFirstConnect({ pluginRoot: f.pluginRoot, version, spawnPage: () => assert.fail('duplicate page') }), null);
    const claim = JSON.parse(Buffer.from(call[1][1], 'base64url').toString('utf8'));
    assert.equal(claim.request.id, id);
    assert.equal(claim.profile, f.profile);
    assert.equal(call[2].env.PROMATE_CONFIG, join(f.home, 'config.json'));
    assert.equal(call[2].env.CODEBUDDY_CONFIG_DIR, undefined);
    assert.equal(readFileSync(join(f.home, 'config.json'), 'utf8'), before);
    assert.equal(publishFirstConnect(claim, 'PRIVATE_PAGE_OPENED', { pagePid: process.pid }), true);
    const receipt = readFirstConnectResult(f.profile, id);
    assert.equal(receipt.loaded, false);
    assert.equal(receipt.code, 'PRIVATE_PAGE_OPENED');
    assert.equal(finishFirstConnect(claim, 'PRIVATE_PAGE_CONNECTED'), true);
    assert.equal(canReuseFirstConnect({ profile: f.profile, version, platform, marketplace }), true);
    const resultFile = join(f.profile, 'plugins/.promate-first-connect/result.json');
    writeFileSync(resultFile, JSON.stringify({ ...JSON.parse(readFileSync(resultFile, 'utf8')),
      code: 'PRIVATE_PAGE_FINISHED' }), { mode: 0o600 });
    assert.equal(canReuseFirstConnect({ profile: f.profile, version, platform, marketplace }), false,
      'legacy finished could include a rejected Key and must not imply authentication');
    assert.equal(canReuseFirstConnect({ profile: f.profile, version, platform: 'https://other.test/api/mcp', marketplace }), false);
    assert.equal(existsSync(claim.claim), false);
    assert.ok(!JSON.stringify(receipt).includes(f.config.key));
  } finally { f.close(); }
});

test('wrong source, expired request, wrong uid/profile/version and replaced claim fail closed', () => {
  const f = fixture();
  try {
    f.request({ now: 1 });
    assert.equal(claimFirstConnect({ pluginRoot: f.pluginRoot, version }), null);
    f.request();
    const requestFile = join(f.profile, 'plugins/.promate-first-connect/request.json');
    for (const patch of [{ uid: process.getuid() + 1 }, { profile: '/other' }, { version: '0.2.8' },
      { marketplace: 'https://other.example.test/x.zip' }]) {
      const original = JSON.parse(readFileSync(requestFile, 'utf8'));
      writeFileSync(requestFile, JSON.stringify({ ...original, ...patch }), { mode: 0o600 });
      assert.equal(claimFirstConnect({ pluginRoot: f.pluginRoot, version }), null);
      writeFileSync(requestFile, JSON.stringify(original), { mode: 0o600 });
    }
    const claim = claimFirstConnect({ pluginRoot: f.pluginRoot, version });
    f.request({ now: Date.now() + 1 }); // replaces claimed request
    assert.equal(publishFirstConnect(claim, 'PRIVATE_PAGE_OPENED'), false);
    assert.equal(readFirstConnectResult(f.profile, claim.request.id), null);
    assert.equal(existsSync(requestFile), true);
  } finally { f.close(); }
});

test('handoff identity lock refuses active/unknown owners and recovers only a proven exited owner', () => {
  const f = fixture();
  const control = join(f.profile, 'plugins/.promate-first-connect');
  const lock = join(control, 'identity.lock');
  try {
    const old = '11111111-1111-4111-8111-111111111111';
    writeFileSync(lock, JSON.stringify({ id: old, uid: process.getuid(), pid: process.pid }), { mode: 0o600 });
    assert.throws(() => f.request(), /HANDOFF_BUSY/);
    assert.equal(JSON.parse(readFileSync(lock, 'utf8')).id, old);
    unlinkSync(lock);
    writeFileSync(lock, '{}', { mode: 0o600 });
    assert.throws(() => f.request(), /HANDOFF_BUSY/);
    unlinkSync(lock);
    const exited = spawnSync(process.execPath, ['-e', ''], { timeout: 5000 });
    writeFileSync(lock, JSON.stringify({ id: old, uid: process.getuid(), pid: exited.pid }), { mode: 0o600 });
    assert.ok(f.request());
    assert.equal(existsSync(lock), false);
    assert.equal(existsSync(join(control, 'identity.recover')), false);
  } finally { f.close(); }
});

test('legacy request without a provable current generation is not consumed; explicit connect rebuilds it', () => {
  const f = fixture();
  try {
    const old = f.request();
    unlinkSync(join(f.profile, 'plugins/.promate-first-connect/current.json'));
    assert.equal(claimFirstConnect({ pluginRoot: f.pluginRoot, version }), null);
    const next = f.request();
    assert.notEqual(next, old);
    assert.equal(claimFirstConnect({ pluginRoot: f.pluginRoot, version }).request.id, next);
  } finally { f.close(); }
});

test('R1 page stays revoked after R2 is claimed; late R1 recovery cannot restore or overwrite R2', async () => {
  const f = fixture();
  const key = 'pk_FictionalReplacementKey0123456789';
  let checks = 0;
  const server = createServer((_req, res) => { checks++; res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 'promate-connect-check', result: { content: [], isError: false } })); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/mcp`;
  const market = `http://127.0.0.1:${server.address().port}/marketplace-${'a'.repeat(64)}.zip`;
  writeFileSync(join(f.profile, 'plugins/known_marketplaces.json'), JSON.stringify({ promate: {
    manifestName: 'promate', source: { url: market } } }));
  const input = { platform: url, marketplace: market };
  let p1, p2;
  try {
    const r1 = f.request(input);
    const c1 = claimFirstConnect({ pluginRoot: f.pluginRoot, version });
    p1 = await serveHandoffPage(c1, () => ({ status: 0 }));
    const nonce1 = (await (await fetch(p1.url)).text()).match(/name="nonce" value="([a-f0-9]{64})"/)[1];
    const r2 = f.request(input);
    const c2 = claimFirstConnect({ pluginRoot: f.pluginRoot, version });
    p2 = await serveHandoffPage(c2, () => ({ status: 0 }));
    const before = readFileSync(join(f.home, 'config.json'), 'utf8');
    const receipt = readFirstConnectResult(f.profile, r2);
    const posted = await fetch(p1.url, { method: 'POST', headers: { Origin: new URL(p1.url).origin },
      body: new URLSearchParams({ nonce: nonce1, action: 'save', key }) });
    assert.equal(posted.status, 410);
    assert.equal(readFileSync(join(f.home, 'config.json'), 'utf8'), before);
    assert.equal(checks, 0);
    assert.deepEqual(readFirstConnectResult(f.profile, r2), receipt);
    assert.equal(readFirstConnectResult(f.profile, r1), null);
    restoreFirstConnect(c1); // late failure after R2's request.json has already been claimed
    assert.equal(existsSync(join(f.profile, 'plugins/.promate-first-connect/request.json')), false);
    const nonce2 = (await (await fetch(p2.url)).text()).match(/name="nonce" value="([a-f0-9]{64})"/)[1];
    const done = await fetch(p2.url, { method: 'POST', headers: { Origin: new URL(p2.url).origin },
      body: new URLSearchParams({ nonce: nonce2, action: 'cancel' }) });
    assert.equal(done.status, 200);
    assert.equal(readFirstConnectResult(f.profile, r2).code, 'PRIVATE_PAGE_CANCELLED');
    assert.equal(restoreFirstConnect(c1), false);
    assert.equal(existsSync(join(f.profile, 'plugins/.promate-first-connect/request.json')), false);
    assert.equal(readFirstConnectResult(f.profile, r2).code, 'PRIVATE_PAGE_CANCELLED');
  } finally { p1?.close(); p2?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.close(); }
});

test('source changed before claim or before page creation is rejected without opening the other platform', async () => {
  const f = fixture();
  let checks = 0;
  const other = createServer((_req, res) => { checks++; res.end('{}'); });
  await new Promise(resolve => other.listen(0, '127.0.0.1', resolve));
  const b = `http://127.0.0.1:${other.address().port}/api/mcp`;
  try {
    const first = f.request();
    writeFileSync(join(f.home, 'config.json'), JSON.stringify({ ...f.config, url: b }));
    assert.equal(claimFirstConnect({ pluginRoot: f.pluginRoot, version }), null);
    assert.equal(readFirstConnectResult(f.profile, first)?.code, 'HANDOFF_SOURCE_CHANGED');
    assert.equal(JSON.parse(readFileSync(join(f.home, 'config.json'), 'utf8')).key, f.config.key);
    writeFileSync(join(f.home, 'config.json'), JSON.stringify(f.config));
    const second = f.request();
    assert.notEqual(second, first, 'invalidated request cannot revive when config returns to A');
    const claim = claimFirstConnect({ pluginRoot: f.pluginRoot, version });
    writeFileSync(join(f.home, 'config.json'), JSON.stringify({ ...f.config, url: b }));
    let page;
    try { page = await serveHandoffPage(claim, () => ({ status: 0 })); assert.fail('B page opened for A request'); }
    catch (error) { assert.notEqual(error.message, 'B page opened for A request'); }
    finally { page?.close(); }
    assert.equal(readFirstConnectResult(f.profile, second)?.code, 'HANDOFF_SOURCE_CHANGED');
    assert.equal(checks, 0);
  } finally { other.closeAllConnections(); await new Promise(resolve => other.close(resolve)); f.close(); }
});

test('same origin with a different platform path is still a source change', () => {
  const f = fixture();
  try {
    const id = f.request();
    writeFileSync(join(f.home, 'config.json'), JSON.stringify({ ...f.config,
      url: 'https://platform.example.test/other/api/mcp' }));
    assert.equal(claimFirstConnect({ pluginRoot: f.pluginRoot, version }), null);
    assert.equal(readFirstConnectResult(f.profile, id)?.code, 'HANDOFF_SOURCE_CHANGED');
  } finally { f.close(); }
});

test('auto page rejects source change after opening; consistent A can save and reuse-check without contacting B', async () => {
  const f = fixture();
  const fresh = 'pk_FictionalSourceBound012345678901';
  let callsA = 0, callsB = 0;
  const a = createServer((_req, res) => { callsA++; res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 'promate-connect-check', result: { content: [], isError: false } })); });
  const b = createServer((_req, res) => { callsB++; res.end('{}'); });
  await Promise.all([new Promise(resolve => a.listen(0, '127.0.0.1', resolve)),
    new Promise(resolve => b.listen(0, '127.0.0.1', resolve))]);
  const urlA = `http://127.0.0.1:${a.address().port}/api/mcp`;
  const urlB = `http://127.0.0.1:${b.address().port}/api/mcp`;
  const marketA = `http://127.0.0.1:${a.address().port}/marketplace-${'a'.repeat(64)}.zip`;
  writeFileSync(join(f.profile, 'plugins/known_marketplaces.json'), JSON.stringify({ promate: {
    manifestName: 'promate', source: { url: marketA } } }));
  const options = { platform: urlA, marketplace: marketA };
  const pageFor = async () => {
    const id = f.request(options);
    const claim = claimFirstConnect({ pluginRoot: f.pluginRoot, version });
    const page = await serveHandoffPage(claim, () => ({ status: 0 }));
    const nonce = (await (await fetch(page.url)).text()).match(/name="nonce" value="([a-f0-9]{64})"/)[1];
    return { id, page, nonce };
  };
  const submit = (page, nonce, action) => fetch(page.url, { method: 'POST', headers: { Origin: new URL(page.url).origin },
    body: new URLSearchParams({ nonce, action, ...(action === 'save' ? { key: fresh } : {}) }) });
  try {
    const first = await pageFor();
    const previousKey = JSON.parse(readFileSync(join(f.home, 'config.json'), 'utf8')).key;
    writeFileSync(join(f.home, 'config.json'), JSON.stringify({ url: urlB, key: previousKey, keyOrigin: new URL(urlA).origin }));
    assert.equal((await submit(first.page, first.nonce, 'save')).status, 410);
    assert.equal(JSON.parse(readFileSync(join(f.home, 'config.json'), 'utf8')).key, previousKey);
    assert.equal(readFirstConnectResult(f.profile, first.id)?.code, 'HANDOFF_SOURCE_CHANGED');
    writeFileSync(join(f.home, 'config.json'), JSON.stringify({ url: urlA, key: previousKey, keyOrigin: new URL(urlA).origin }));
    await assert.rejects(submit(first.page, first.nonce, 'save'), /fetch failed/, 'restoring A cannot revive old page');
    assert.equal(callsA, 0); assert.equal(callsB, 0);
    first.page.close();
    const second = await pageFor();
    assert.equal((await submit(second.page, second.nonce, 'save')).status, 200);
    assert.equal(readFirstConnectResult(f.profile, second.id).code, 'PRIVATE_PAGE_CONNECTED');
    assert.equal(JSON.parse(readFileSync(join(f.home, 'config.json'), 'utf8')).key, fresh);
    assert.equal(callsA, 1); assert.equal(callsB, 0);
    const third = await pageFor();
    assert.equal((await submit(third.page, third.nonce, 'check')).status, 200);
    assert.equal(readFirstConnectResult(f.profile, third.id).code, 'PRIVATE_PAGE_CONNECTED');
    assert.equal(callsA, 2); assert.equal(callsB, 0);
  } finally { a.closeAllConnections(); b.closeAllConnections();
    await Promise.all([new Promise(resolve => a.close(resolve)), new Promise(resolve => b.close(resolve))]); f.close(); }
});

test('SessionStart receipt stays open after old Key 401; same page saves fictional Key and only then records connection', async () => {
  const f = fixture();
  const old = 'pk_FictionalRejectedByStub012345';
  const fresh = 'pk_FictionalAcceptedByStub012345';
  let checks = 0;
  const server = createServer((req, res) => {
    checks++;
    if (req.headers.authorization === `Bearer ${old}`) { res.writeHead(401); res.end('{}'); return; }
    assert.equal(req.headers.authorization, `Bearer ${fresh}`);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 'promate-connect-check', result: { content: [], isError: false } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/mcp`;
  const market = `http://127.0.0.1:${server.address().port}/marketplace-${'a'.repeat(64)}.zip`;
  writeFileSync(join(f.profile, 'plugins/known_marketplaces.json'), JSON.stringify({ promate: {
    manifestName: 'promate', source: { url: market } } }));
  let page;
  try {
    const id = f.request({ platform: url, marketplace: market });
    writeFileSync(join(f.home, 'config.json'), JSON.stringify({ url, key: old, keyOrigin: new URL(url).origin }));
    const claim = claimFirstConnect({ pluginRoot: f.pluginRoot, version });
    page = await serveHandoffPage(claim, () => ({ status: 0 }));
    const oldNonce = (await (await fetch(page.url)).text()).match(/name="nonce" value="([a-f0-9]{64})"/)[1];
    const checked = await fetch(page.url, { method: 'POST', headers: { Origin: new URL(page.url).origin },
      body: new URLSearchParams({ nonce: oldNonce, action: 'check' }) });
    const formHtml = await checked.text();
    assert.match(formHtml, /现有 Key 未通过验证/);
    assert.match(formHtml, /name="key" type="password"/);
    assert.ok(!formHtml.includes(old) && !formHtml.includes(fresh));
    assert.equal(readFirstConnectResult(f.profile, id).code, 'PRIVATE_PAGE_OPENED');
    assert.equal(readFirstConnectResult(f.profile, id).authenticated, false);
    assert.equal(canReuseFirstConnect({ profile: f.profile, version, platform: url, marketplace: market }), false);
    assert.equal(readFileSync(join(f.home, 'config.json'), 'utf8').includes(old), true);
    const nextNonce = formHtml.match(/name="nonce" value="([a-f0-9]{64})"/)[1];
    assert.notEqual(nextNonce, oldNonce);
    const saved = await fetch(page.url, { method: 'POST', headers: { Origin: new URL(page.url).origin },
      body: new URLSearchParams({ nonce: nextNonce, action: 'save', key: fresh }) });
    assert.match(await saved.text(), /已保存，身份连接成功/);
    assert.equal(readFirstConnectResult(f.profile, id).code, 'PRIVATE_PAGE_CONNECTED');
    assert.equal(readFirstConnectResult(f.profile, id).authenticated, true);
    assert.equal(canReuseFirstConnect({ profile: f.profile, version, platform: url, marketplace: market }), true);
    assert.equal(JSON.parse(readFileSync(join(f.home, 'config.json'), 'utf8')).key, fresh);
    assert.equal(checks, 2);
  } finally { page?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.close(); }
});

test('late successful check from R1 cannot replace R2 result after R2 takes ownership', async () => {
  const f = fixture();
  let release, arrived;
  const held = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { arrived = resolve; });
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* isolated fictional request */ }
    arrived(); await held;
    if (!res.destroyed) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 'promate-connect-check', result: { content: [], isError: false } }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/mcp`;
  const market = `http://127.0.0.1:${server.address().port}/marketplace-${'a'.repeat(64)}.zip`;
  writeFileSync(join(f.profile, 'plugins/known_marketplaces.json'), JSON.stringify({ promate: {
    manifestName: 'promate', source: { url: market } } }));
  const input = { platform: url, marketplace: market };
  let p1, p2;
  try {
    const r1 = f.request(input);
    writeFileSync(join(f.home, 'config.json'), JSON.stringify({ url, key: f.config.key, keyOrigin: new URL(url).origin }));
    const c1 = claimFirstConnect({ pluginRoot: f.pluginRoot, version });
    p1 = await serveHandoffPage(c1, () => ({ status: 0 }));
    const n1 = (await (await fetch(p1.url)).text()).match(/name="nonce" value="([a-f0-9]{64})"/)[1];
    const waiting = fetch(p1.url, { method: 'POST', headers: { Origin: new URL(p1.url).origin },
      body: new URLSearchParams({ nonce: n1, action: 'check' }) });
    await entered;
    const r2 = f.request(input);
    const c2 = claimFirstConnect({ pluginRoot: f.pluginRoot, version });
    p2 = await serveHandoffPage(c2, () => ({ status: 0 }));
    const receipt = readFirstConnectResult(f.profile, r2);
    release();
    const late = await waiting.then(async r => ({ status: r.status, body: await r.text() }),
      () => ({ status: 410, body: '' }));
    assert.ok(late.status !== 200 || !late.body.includes('连接成功'));
    assert.equal(readFirstConnectResult(f.profile, r1), null);
    assert.deepEqual(readFirstConnectResult(f.profile, r2), receipt);
    assert.equal(JSON.parse(readFileSync(join(f.home, 'config.json'), 'utf8')).key, f.config.key);
    const n2 = (await (await fetch(p2.url)).text()).match(/name="nonce" value="([a-f0-9]{64})"/)[1];
    assert.equal((await fetch(p2.url, { method: 'POST', headers: { Origin: new URL(p2.url).origin },
      body: new URLSearchParams({ nonce: n2, action: 'cancel' }) })).status, 200);
    assert.equal(readFirstConnectResult(f.profile, r2).code, 'PRIVATE_PAGE_CANCELLED');
  } finally { release(); p1?.close(); p2?.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); f.close(); }
});

test('claimed page actually binds loopback, dispatches browser and records cancel without claiming MCP', async () => {
  const f = fixture();
  try {
    const id = f.request();
    const claim = claimFirstConnect({ pluginRoot: f.pluginRoot, version });
    let opened;
    const page = await serveHandoffPage(claim, (_bin, args) => { opened = args[0]; return { status: 0 }; });
    assert.equal(opened, page.url);
    const http = await fetch(page.url);
    assert.equal(http.status, 200);
    const nonce = (await http.text()).match(/name="nonce" value="([a-f0-9]{64})"/)[1];
    const running = readFirstConnectResult(f.profile, id);
    assert.equal(running.code, 'PRIVATE_PAGE_OPENED');
    assert.equal(running.loaded, false);
    assert.equal(running.pageReachable, true);
    assert.equal(running.browserLaunchRequested, true);
    const cancelled = await fetch(page.url, { method: 'POST', headers: { Origin: new URL(page.url).origin },
      body: new URLSearchParams({ nonce, action: 'cancel' }) });
    assert.equal(cancelled.status, 200);
    assert.equal(readFirstConnectResult(f.profile, id).code, 'PRIVATE_PAGE_CANCELLED');
    assert.equal(existsSync(claim.claim), false);
    assert.equal(JSON.parse(readFileSync(join(f.home, 'config.json'), 'utf8')).key, f.config.key);
  } finally { f.close(); }
});

test('browser dispatch failure records failure and restores the request for a controlled retry', async () => {
  const f = fixture();
  try {
    const id = f.request();
    const claim = claimFirstConnect({ pluginRoot: f.pluginRoot, version });
    await assert.rejects(serveHandoffPage(claim, () => ({ status: 1 })), /PAGE_LAUNCH_FAILED/);
    assert.equal(readFirstConnectResult(f.profile, id).code, 'PRIVATE_PAGE_UNAVAILABLE');
    assert.equal(JSON.parse(readFileSync(join(f.profile, 'plugins/.promate-first-connect/request.json'), 'utf8')).id, id);
  } finally { f.close(); }
});

test('asynchronous spawn error with no PID and overlapping exit is handled once; no page is claimed ready', async () => {
  const f = fixture();
  try {
    const id = f.request();
    const child = new EventEmitter();
    child.pid = undefined; child.unref = () => assert.fail('failed child must not be unrefed as ready');
    const state = resumeFirstConnect({ pluginRoot: f.pluginRoot, version, spawnPage: () => {
      queueMicrotask(() => { child.emit('error', Object.assign(Error('denied'), { code: 'EACCES' })); child.emit('exit', 1); });
      return child;
    } });
    assert.equal(await state, 'PRIVATE_PAGE_UNAVAILABLE');
    assert.equal(pendingFirstConnect({ profile: f.profile, version, platform, marketplace }), id);
    assert.equal(readFirstConnectResult(f.profile, id)?.code, 'PRIVATE_PAGE_UNAVAILABLE');
  } finally { f.close(); }
});

test('real Node spawn ENOENT reports failure without an unhandled child error', async () => {
  const f = fixture();
  try {
    const id = f.request();
    assert.equal(await resumeFirstConnect({ pluginRoot: f.pluginRoot, version,
      spawnPage: () => spawn('/promate-nonexistent/never-run') }), 'PRIVATE_PAGE_UNAVAILABLE');
    assert.equal(pendingFirstConnect({ profile: f.profile, version, platform, marketplace }), id);
    assert.equal(readFirstConnectResult(f.profile, id).code, 'PRIVATE_PAGE_UNAVAILABLE');
  } finally { f.close(); }
});

test('no-PID spawn event followed by error and exit does not restore twice', async () => {
  const f = fixture();
  try {
    const id = f.request();
    const child = new EventEmitter(); child.pid = undefined;
    const task = resumeFirstConnect({ pluginRoot: f.pluginRoot, version, spawnPage: () => {
      queueMicrotask(() => { child.emit('spawn'); child.emit('error', Error('denied')); child.emit('exit', 1); });
      return child;
    } });
    assert.equal(await task, 'PRIVATE_PAGE_UNAVAILABLE');
    const receipt = readFirstConnectResult(f.profile, id);
    assert.equal(receipt.code, 'PRIVATE_PAGE_UNAVAILABLE');
    assert.deepEqual(readFirstConnectResult(f.profile, id), receipt);
    assert.equal(pendingFirstConnect({ profile: f.profile, version, platform, marketplace }), id);
  } finally { f.close(); }
});

test('isolated SessionStart spawns a short-lived page owner; fictional Key saves after hook returns', async () => {
  const f = fixture();
  const canary = 'pk_FictionalSessionStart0123456789';
  let checks = 0;
  const stub = createServer((req, res) => {
    checks++;
    assert.equal(req.headers.authorization, `Bearer ${canary}`);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 'promate-connect-check', result: { content: [], isError: false } }));
  });
  await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${stub.address().port}/api/mcp`;
  const market = `http://127.0.0.1:${stub.address().port}/marketplace-${'a'.repeat(64)}.zip`;
  writeFileSync(join(f.profile, 'plugins/known_marketplaces.json'), JSON.stringify({ promate: { manifestName: 'promate', source: { url: market } } }));
  const linkFile = join(f.root, 'isolated-page-link'); // private test-only, never included in hook output
  let child, pageExited;
  try {
    const id = f.request({ platform: url, marketplace: market });
    const script = `import {serveHandoffPage} from ${JSON.stringify(new URL('../marketplace/plugins/promate/mcp/handoff-page.mjs', import.meta.url).href)};
      import {writeFileSync} from 'node:fs';
      const claim=JSON.parse(Buffer.from(process.argv[1],'base64url').toString('utf8'));
      const page=await serveHandoffPage(claim,()=>({status:0}));
      writeFileSync(process.argv[2],page.url,{flag:'wx',mode:0o600});`;
    const stage = await resumeFirstConnect({ pluginRoot: f.pluginRoot, version, spawnPage: (_node, args, options) => {
      child = spawn(process.execPath, ['--input-type=module', '-e', script, args[1], linkFile], options);
      pageExited = new Promise(resolve => child.once('exit', resolve));
      return child;
    } });
    assert.equal(stage, 'PRIVATE_PAGE_STARTING'); // hook has finished, child still owns page
    const deadline = Date.now() + 3000;
    while (!existsSync(linkFile) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(existsSync(linkFile), true);
    const pageUrl = readFileSync(linkFile, 'utf8');
    const nonce = (await (await fetch(pageUrl)).text()).match(/name="nonce" value="([a-f0-9]{64})"/)[1];
    const submitted = await fetch(pageUrl, { method: 'POST', headers: { Origin: new URL(pageUrl).origin },
      body: new URLSearchParams({ nonce, action: 'save', key: canary }) });
    assert.equal(submitted.status, 200);
    await submitted.text();
    assert.equal(await Promise.race([pageExited, new Promise((_, reject) => setTimeout(() => reject(Error('page owner did not exit')), 3000))]), 0);
    assert.equal(readFirstConnectResult(f.profile, id).code, 'PRIVATE_PAGE_CONNECTED');
    assert.equal(JSON.parse(readFileSync(join(f.home, 'config.json'), 'utf8')).key, canary);
    assert.equal(checks, 1);
    assert.equal(readFirstConnectResult(f.profile, id).loaded, false);
  } finally {
    if (child?.exitCode === null) child.kill();
    stub.closeAllConnections(); await new Promise(resolve => stub.close(resolve)); f.close();
  }
});

test('page spawn failure restores only its own request; concurrent hooks cannot both start it', async () => {
  const f = fixture();
  try {
    const id = f.request();
    assert.equal(await resumeFirstConnect({ pluginRoot: f.pluginRoot, version,
      spawnPage: () => { throw Error('spawn denied'); } }), 'PRIVATE_PAGE_UNAVAILABLE');
    const requestFile = join(f.profile, 'plugins/.promate-first-connect/request.json');
    assert.equal(JSON.parse(readFileSync(requestFile, 'utf8')).id, id);
    const claim = claimFirstConnect({ pluginRoot: f.pluginRoot, version });
    assert.equal(restoreFirstConnect(claim), true);
    assert.equal(JSON.parse(readFileSync(requestFile, 'utf8')).id, id);
  } finally { f.close(); }
});

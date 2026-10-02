// version.mjs（SessionStart）自测：版本提示照常输出，顺手清掉超过 24 小时的状态文件。

import assert from 'node:assert/strict';
import { existsSync, utimesSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { PLUGIN_ROOT, makeHome, runHook, runHookAsync, startStub, stateFile, unusedPort, writeConfig, writeStateFile } from './helpers.mjs';

test('新版本提示复用平台地址且不发送 Key，不承诺即时更新', async () => {
  const { home, cleanup } = makeHome();
  const paths = [];
  const stub = await startStub(({ path, headers }) => {
    paths.push(path);
    assert.equal(headers.authorization, undefined);
    return { body: { version: '999.0.0' } };
  });
  try {
    writeConfig(home, { url: stub.url, key: 'pk_FakeOnly0123456789FakeOnly01234567' });
    const result = await runHookAsync('version.mjs', {}, { home, env: { CODEBUDDY_PLUGIN_ROOT: PLUGIN_ROOT } });
    assert.equal(result.status, 0);
    assert.match(JSON.parse(result.stdout).systemMessage, /从 Promate 网页接入更新/);
    assert.match(JSON.parse(result.stdout).systemMessage, /钩子版本不证明 MCP 代理版本或身份连接/);
    assert.deepEqual(paths, ['/api/skills/plugins/latest']);
  } finally { await stub.close(); cleanup(); }
});

test('只有目标插件已加载且显式地址就绪才提示打开本机配置 Key 页面', async () => {
  const { home, cleanup } = makeHome();
  const stub = await startStub(() => ({ body: { version: '0.2.8' } }));
  try {
    writeConfig(home, { url: stub.url });
    const ready = await runHookAsync('version.mjs', {}, { home, env: { CODEBUDDY_PLUGIN_ROOT: PLUGIN_ROOT } });
    assert.equal(ready.status, 0);
    assert.match(JSON.parse(ready.stdout).systemMessage, /平台地址 .* 已配置；请从 Promate 网页接入/);
    writeConfig(home, { key: 'pk_FictionOnly0123456789NoAccount' });
    const missing = await runHookAsync('version.mjs', {}, { home, env: { CODEBUDDY_PLUGIN_ROOT: PLUGIN_ROOT } });
    assert.doesNotMatch(JSON.parse(missing.stdout).systemMessage, /已配置；请从 Promate 网页接入/);
    assert.match(JSON.parse(missing.stdout).systemMessage, /由程序配置公开平台地址/);
  } finally { await stub.close(); cleanup(); }
});

test('SessionStart 清掉过期状态，保留新状态', async () => {
  const { home, cleanup } = makeHome();
  try {
    const port = await unusedPort();
    writeConfig(home, { url: `http://127.0.0.1:${port}/api/mcp` });
    writeStateFile(home, 'old', { promateTurn: true, promateCalled: false });
    writeStateFile(home, 'fresh', { promateTurn: true, promateCalled: false });
    const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
    utimesSync(stateFile(home, 'old'), oldTime, oldTime);
    writeFileSync(`${stateFile(home, 'old')}.messages`, '00000000-0000-4000-8000-000000000001\n');
    writeFileSync(`${stateFile(home, 'fresh')}.messages`, '00000000-0000-4000-8000-000000000002\n');
    utimesSync(`${stateFile(home, 'old')}.messages`, oldTime, oldTime);

    const result = runHook('version.mjs', {
      session_id: 'v1',
      hook_event_name: 'SessionStart',
      source: 'startup',
    }, { home });
    assert.equal(result.status, 0, `stderr=${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.ok(output.systemMessage.includes('Promate 会话钩子'), output.systemMessage);
    assert.equal(existsSync(stateFile(home, 'old')), false, '过期状态应被删掉');
    assert.equal(existsSync(stateFile(home, 'fresh')), true, '新状态应保留');
    assert.equal(existsSync(`${stateFile(home, 'old')}.messages`), false, '过期代次记录应清理');
    assert.equal(existsSync(`${stateFile(home, 'fresh')}.messages`), true, '有效代次记录不能清除');
  } finally {
    cleanup();
  }
});

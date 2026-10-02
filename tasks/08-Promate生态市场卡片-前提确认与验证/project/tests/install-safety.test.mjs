import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { PLUGIN_ROOT, ProxySession, makeHome, readConfigFile, readStateFile, runHook, runHookAsync,
  startStub, stateFile, writeConfig, writeStateFile } from './helpers.mjs';

const KEY = 'pk_FakeOnly0123456789FakeOnly01234567';
const tools = {
  mark_done: { requirementId: 13 },
  set_stage: { requirementId: 13, stage: 'DELIVERED' },
  add_artifact: { requirementId: 13, artifactType: 'PRD', title: '示例', documentUrl: 'https://example.test/doc' },
  upload_skill: { name: '示例', category: 'GENERAL', filePath: 'fixture.md' },
};
const uploadInput = home => ({...tools.upload_skill,filePath:join(home,'fixture.md')});
const decision = (r) => JSON.parse(r.stdout).hookSpecificOutput.permissionDecision;
const configure = (home, ...args) => spawnSync(process.execPath, [join(PLUGIN_ROOT, 'configure.mjs'), ...args], {
  encoding: 'utf8', env: { ...process.env, PROMATE_HOME: home, PROMATE_CONFIG: '' },
});

for (const [tool, input] of Object.entries(tools)) {
  test(`${tool}：确认/取消/换参/换工具/重放/过期/缺会话/坏状态全部 fail closed`, async () => {
    const { home, cleanup } = makeHome();
    const actualInput=tool==='upload_skill'?uploadInput(home):input;
    const event = { session_id: tool, permission_mode: 'default', tool_name: `mcp__promate__${tool}`, tool_input: actualInput };
    const call = (patch = {}) => runHook('confirm.mjs', { ...event, ...patch }, { home });
    const reply = (prompt) => runHook('route.mjs', { session_id: tool, prompt }, { home });
    try {
      assert.equal(decision(call()), 'deny');
      reply('确认');
      assert.equal(decision(call()), 'allow');
      assert.equal(decision(call()), 'deny');
      reply('取消');
      assert.equal(decision(call()), 'deny');
      reply('确认');
      assert.equal(decision(call({ tool_input: { ...actualInput, title: '改参数' } })), 'deny');
      assert.equal(decision(call()), 'deny');
      reply('确认');
      assert.equal(decision(call({ tool_name: 'mcp__promate__my_projects' })), 'deny');
      // 未知工具拒绝不会消费确认；同参数确认仍限一次。
      assert.equal(decision(call()), 'allow');
      for (const createdAt of [Date.now() - 700000, Date.now() + 700000, 'bad']) {
        call(); reply('确认');
        const state = readStateFile(home, tool);
        state.pendingConfirm.createdAt = createdAt;
        writeStateFile(home, tool, state);
        assert.equal(decision(call()), 'deny');
      }
      assert.equal(decision(call({ session_id: undefined })), 'deny');
      writeFileSync(stateFile(home, tool), '{bad json');
      assert.equal(decision(call()), 'deny');
      reply('确认');
      mkdirSync(`${stateFile(home, tool)}.lock`);
      assert.equal(decision(call()), 'deny');
    } finally { cleanup(); }
  });
}

/** 子进程真实持有会话锁；stdout 就绪信号和 stdin EOF 决定顺序，不用 sleep。 */
async function holdStateSnapshot(home, sessionId) {
  const script = `import { readFileSync, writeSync } from 'node:fs';
    import { withSessionState, writeState } from ${JSON.stringify(join(PLUGIN_ROOT, 'hooks/lib.mjs'))};
    withSessionState(${JSON.stringify(sessionId)}, (snapshot) => {
      writeSync(1, 'LOCKED\\n');
      readFileSync(0); // 父进程明确释放前一直持锁，随后模拟 mark 写回旧快照。
      writeState(${JSON.stringify(sessionId)}, { ...snapshot, promateCalled: true });
    });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PROMATE_HOME: home, PROMATE_CONFIG: join(home, 'config.json'),
      PROMATE_SKILLS_DIR: join(home, 'workbuddy-skills') },
  });
  const closed = once(child, 'close');
  const [ready] = await Promise.race([
    once(child.stdout, 'data'),
    closed.then(() => { throw new Error('持锁进程未到达同步点即退出'); }),
  ]);
  assert.match(ready.toString(), /LOCKED/);
  return {
    async release() {
      child.stdin.end();
      const [code] = await closed;
      assert.equal(code, 0, '持锁进程必须正常写回旧快照并释放锁');
    },
    stop() { if (child.exitCode === null) child.kill(); },
  };
}

/** 在实际 hook 的一个文件提交点暂停；测试夹具仅作用于临时 HOME 下的指定文件。 */
async function pauseHookCommit(home, script, event, operation, target) {
  const preload = join(home, 'pause-hook.mjs');
  writeFileSync(preload, `import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const original = fs[${JSON.stringify(operation)}];
    let paused = false;
    fs[${JSON.stringify(operation)}] = function (...args) {
      const result = original(...args);
      if (!paused && String(args[${operation === 'renameSync' ? 1 : 0}]) === ${JSON.stringify(target)}) {
        paused = true; fs.writeSync(4, 'PAUSED\\n'); fs.readFileSync(3);
      }
      return result;
    };
    syncBuiltinESMExports();`);
  const child = spawn(process.execPath, ['--import', preload, join(PLUGIN_ROOT, 'hooks', script)], {
    stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
    env: { ...process.env, PROMATE_HOME: home, PROMATE_CONFIG: join(home, 'config.json'),
      PROMATE_SKILLS_DIR: join(home, 'workbuddy-skills') },
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const closed = once(child, 'close');
  const ready = once(child.stdio[4], 'data');
  child.stdin.end(JSON.stringify(event));
  const [signal] = await Promise.race([ready, closed.then(() => { throw new Error('hook 未到达文件同步点'); })]);
  assert.match(signal.toString(), /PAUSED/);
  return {
    async release() {
      child.stdio[3].end();
      const [status] = await closed;
      return { status, stdout, stderr };
    },
    stop() { if (child.exitCode === null) child.kill(); },
  };
}

for (const [tool, input] of Object.entries(tools)) {
  for (const prompt of ['取消', '先帮我整理一下思路']) {
    test(`返修取消确认：${tool} / ${prompt} / 锁释放并写回旧快照后仍须 deny`, { timeout: 10000 }, async () => {
      const { home, cleanup } = makeHome();
      const event = { session_id: 'cancel-lock', tool_name: `mcp__promate__${tool}`, tool_input: tool==='upload_skill'?uploadInput(home):input };
      const call = () => runHook('confirm.mjs', event, { home });
      const reply = (text) => runHook('route.mjs', { session_id: event.session_id, prompt: text }, { home });
      let holder;
      try {
        assert.equal(decision(call()), 'deny');
        reply('确认');
        assert.equal(readStateFile(home, event.session_id).pendingConfirm.confirmed, true);
        holder = await holdStateSnapshot(home, event.session_id);
        reply(prompt); // 消息处理已结束，但另一进程此刻仍持锁。
        await holder.release();
        assert.equal(readStateFile(home, event.session_id).pendingConfirm.confirmed, true,
          '证明持锁者确实写回过旧授权；不能靠磁盘状态碰巧消失');
        assert.equal(decision(call()), 'deny', '取消/改口结束后，旧确认不得随锁释放复活');
        reply('确认');
        assert.equal(decision(call()), 'allow', '必须允许重新发起并独立确认后的新操作');
        assert.equal(decision(call()), 'deny', '新确认也只能消费一次');
      } finally { holder?.stop(); cleanup(); }
    });
  }
}

test('返修取消确认：锁冲突取消后直接再说确认，不能复活尚未重新发起的旧请求', { timeout: 10000 }, async () => {
  const { home, cleanup } = makeHome();
  const event = { session_id: 'late-confirm', tool_name: 'mcp__promate__upload_skill', tool_input: uploadInput(home) };
  let holder;
  try {
    runHook('confirm.mjs', event, { home });
    runHook('route.mjs', { session_id: event.session_id, prompt: '确认' }, { home });
    holder = await holdStateSnapshot(home, event.session_id);
    runHook('route.mjs', { session_id: event.session_id, prompt: '取消' }, { home });
    await holder.release();
    runHook('route.mjs', { session_id: event.session_id, prompt: '确认' }, { home });
    assert.equal(decision(runHook('confirm.mjs', event, { home })), 'deny');
  } finally { holder?.stop(); cleanup(); }
});

test('返修取消确认：消费期间到达取消，输出 allow 前必须复验最新代次', { timeout: 10000 }, async () => {
  const { home, cleanup } = makeHome();
  const event = { session_id: 'cancel-at-consume', tool_name: 'mcp__promate__upload_skill', tool_input: uploadInput(home) };
  let paused;
  try {
    runHook('confirm.mjs', event, { home });
    runHook('route.mjs', { session_id: event.session_id, prompt: '确认' }, { home });
    paused = await pauseHookCommit(home, 'confirm.mjs', event, 'renameSync', stateFile(home, event.session_id));
    // confirm 仍持锁但尚未输出 allow，取消必须无需此锁即可撤销。
    const cancelled = runHook('route.mjs', { session_id: event.session_id, prompt: '取消' }, { home });
    assert.equal(cancelled.status, 2);
    assert.match(cancelled.stdout, /旧的未消费确认已失效/);
    assert.equal(decision(await paused.release()), 'deny');
    assert.equal(decision(runHook('confirm.mjs', event, { home })), 'deny');
  } finally { paused?.stop(); cleanup(); }
});

test('返修取消确认：较早确认消息处理落后于取消，不得覆盖新消息代次', { timeout: 10000 }, async () => {
  const { home, cleanup } = makeHome();
  const event = { session_id: 'message-order', tool_name: 'mcp__promate__upload_skill', tool_input: uploadInput(home) };
  let holder, paused;
  try {
    runHook('confirm.mjs', event, { home });
    runHook('route.mjs', { session_id: event.session_id, prompt: '确认' }, { home });
    holder = await holdStateSnapshot(home, event.session_id);
    paused = await pauseHookCommit(home, 'route.mjs', { session_id: event.session_id, prompt: '确认' },
      'appendFileSync', `${stateFile(home, event.session_id)}.messages`);
    runHook('route.mjs', { session_id: event.session_id, prompt: '取消' }, { home });
    await holder.release(); // 写回旧快照；较早的确认处理现在才继续。
    const late = await paused.release();
    assert.equal(late.status, 2, '过时消息不能建立确认');
    assert.equal(decision(runHook('confirm.mjs', event, { home })), 'deny');
  } finally { paused?.stop(); holder?.stop(); cleanup(); }
});

test('安装地址消息先撤销旧确认，锁争用写回旧快照也不能复活', { timeout: 10000 }, async () => {
  const { home, cleanup } = makeHome();
  const event = { session_id: 'address-cancel', tool_name: 'mcp__promate__upload_skill', tool_input: uploadInput(home) };
  let holder;
  try {
    writeConfig(home, { url: 'https://old.example.test/api/mcp' });
    runHook('confirm.mjs', event, { home });
    runHook('route.mjs', { session_id: event.session_id, prompt: '确认' }, { home });
    holder = await holdStateSnapshot(home, event.session_id);
    const changed = runHook('route.mjs', { session_id: event.session_id,
      prompt: 'Promate 平台地址：https://new.example.test/api/mcp' }, { home });
    assert.equal(changed.status, 2);
    assert.match(changed.stdout, /地址已保存/);
    await holder.release();
    assert.equal(decision(runHook('confirm.mjs', event, { home })), 'deny');
  } finally { holder?.stop(); cleanup(); }
});

test('返修取消确认：探针与 Key 短路消息同样使旧授权失效', { timeout: 10000 }, async () => {
  const { home, cleanup } = makeHome();
  const event = { session_id: 'short-circuit', tool_name: 'mcp__promate__upload_skill', tool_input: uploadInput(home) };
  let holder;
  try {
    for (const prompt of ['/promate check-hooks', KEY]) {
      runHook('confirm.mjs', event, { home });
      runHook('route.mjs', { session_id: event.session_id, prompt: '确认' }, { home });
      holder = await holdStateSnapshot(home, event.session_id);
      const result = runHook('route.mjs', { session_id: event.session_id, prompt }, { home });
      assert.equal(result.status, 2);
      assert.ok(!(result.stdout + result.stderr).includes(KEY));
      await holder.release();
      assert.equal(decision(runHook('confirm.mjs', event, { home })), 'deny');
    }
  } finally { holder?.stop(); cleanup(); }
});

test('返修取消确认：代次不可写或损坏须明确报错，旧版无代次状态也不能放行', () => {
  const { home, cleanup } = makeHome();
  try {
    for (const failure of ['unwritable', 'corrupt', 'legacy']) {
      const event = { session_id: failure, tool_name: 'mcp__promate__upload_skill', tool_input: uploadInput(home) };
      runHook('confirm.mjs', event, { home });
      runHook('route.mjs', { session_id: failure, prompt: '确认' }, { home });
      const journal = `${stateFile(home, failure)}.messages`;
      if (failure === 'legacy') {
        const state = readStateFile(home, failure);
        delete state.pendingConfirm.messageId;
        writeStateFile(home, failure, state);
      } else {
        if (failure === 'unwritable') { unlinkSync(journal); mkdirSync(journal); }
        else writeFileSync(journal, 'broken');
        const result = runHook('route.mjs', { session_id: failure, prompt: '取消' }, { home });
        assert.equal(result.status, 2);
        assert.match(result.stdout, /未能安全完成/);
        assert.ok(!result.stdout.includes('旧的未消费确认已失效'));
      }
      assert.equal(decision(runHook('confirm.mjs', event, { home })), 'deny');
    }
  } finally { cleanup(); }
});

test('同一确认并发调用只放行一次；切换服务/Key 后旧确认无效', async () => {
  const { home, cleanup } = makeHome();
  const event = { session_id: 'race', tool_name: 'mcp__promate__upload_skill', tool_input: uploadInput(home) };
  try {
    runHook('confirm.mjs', event, { home });
    runHook('route.mjs', { session_id: 'race', prompt: '确认' }, { home });
    const results = await Promise.all(Array.from({ length: 5 }, () => runHookAsync('confirm.mjs', event, { home })));
    assert.equal(results.filter((r) => decision(r) === 'allow').length, 1);
    runHook('route.mjs', { session_id: 'race', prompt: '确认' }, { home });
    configure(home, '--url', 'https://new.example.test');
    assert.equal(decision(runHook('confirm.mjs', event, { home })), 'deny');
  } finally { cleanup(); }
});

test('地址保存保留 Key/其它字段，切换来源不发送旧 Key；标题查询同样拒绝跨来源', async () => {
  const { home, cleanup } = makeHome();
  let requests = 0;
  const stub = await startStub(() => { requests++; return { body: {} }; });
  const proxy = new ProxySession({ home });
  try {
    writeConfig(home, { url: 'https://old.example.test/api/mcp', key: KEY, extra: { keep: true } });
    assert.equal(configure(home, '--url', stub.url.replace('/api/mcp', '')).status, 0);
    const saved = readConfigFile(home);
    assert.equal(saved.url, stub.url);
    assert.equal(saved.key, KEY);
    assert.equal(saved.keyOrigin, 'https://old.example.test');
    assert.deepEqual(saved.extra, { keep: true });
    const result = await proxy.request({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'my_projects' } });
    assert.equal(result.result.isError, true);
    assert.match(result.result.content[0].text, /不会跨来源发送/);
    const hook = await runHookAsync('confirm.mjs', { session_id: 'origin', tool_name: 'mcp__promate__mark_done', tool_input: { requirementId: 13 } }, { home });
    assert.equal(decision(hook), 'deny');
    assert.equal(requests, 0);
    assert.ok(!(JSON.stringify(result) + proxy.stderr + hook.stdout + hook.stderr).includes(KEY.slice(0, 11)));
  } finally { proxy.close(); await stub.close(); cleanup(); }
});

test('同来源地址更新保留凭据；错误 URL/坏配置不覆写、不回退 localhost', async () => {
  const { home, cleanup } = makeHome();
  const proxy = new ProxySession({ home });
  try {
    writeConfig(home, { url: 'https://platform.example.test/api/mcp', key: KEY });
    assert.equal(configure(home, '--url', 'https://platform.example.test/prefix').status, 0);
    assert.equal(readConfigFile(home).keyOrigin, 'https://platform.example.test');
    const before = readFileSync(join(home, 'config.json'), 'utf8');
    for (const url of ['https://user:password@example.test', `https://example.test?key=${KEY}`, 'javascript:alert(1)', '']) {
      const result = configure(home, '--url', url);
      assert.equal(result.status, 1);
      assert.ok(!(result.stdout + result.stderr).includes(KEY.slice(0, 11)));
      assert.equal(readFileSync(join(home, 'config.json'), 'utf8'), before);
    }
    writeFileSync(join(home, 'config.json'), `{"key":"${KEY}`);
    assert.equal(configure(home, '--url', 'https://platform.example.test').status, 1);
    const result = await proxy.request({ jsonrpc: '2.0', id: 1, method: 'tools/call' });
    assert.equal(result.result.isError, true);
    assert.ok(!(JSON.stringify(result) + proxy.stderr).includes(KEY.slice(0, 11)));
  } finally { proxy.close(); cleanup(); }
});

test('错误响应不回显 Key；无地址的聊天 Key 被拦截且不会声称保存成功', async () => {
  const { home, cleanup } = makeHome();
  const stub = await startStub(() => ({ status: 500, body: { message: KEY } }));
  const proxy = new ProxySession({ home });
  try {
    const keyMessage = runHook('route.mjs', { prompt: KEY }, { home });
    assert.equal(keyMessage.status, 2);
    assert.match(keyMessage.stdout, /插件未保存/);
    writeConfig(home, { url: stub.url, key: KEY });
    const result = await proxy.request({ jsonrpc: '2.0', id: 1, method: 'tools/call' });
    assert.equal(result.error.code, -32603);
    assert.ok(!(JSON.stringify(result) + proxy.stderr + keyMessage.stdout + keyMessage.stderr).includes(KEY.slice(0, 11)));
    const check = configure(home, '--check');
    assert.equal(check.status, 0);
    assert.ok(!check.stdout.includes(KEY.slice(0, 11)));
  } finally { proxy.close(); await stub.close(); cleanup(); }
});

test('代理和标题查询不跟随重定向，凭据不会发送给跳转目标', async () => {
  const { home, cleanup } = makeHome();
  let redirected = 0;
  const target = await startStub(() => { redirected++; return { body: {} }; });
  const source = await startStub(() => ({ status: 307, responseHeaders: { Location: target.url } }));
  const proxy = new ProxySession({ home });
  try {
    writeConfig(home, { url: source.url, key: KEY });
    const result = await proxy.request({ jsonrpc: '2.0', id: 1, method: 'tools/call' });
    assert.equal(result.result.isError, true);
    const hook = await runHookAsync('confirm.mjs', { session_id: 'redirect', tool_name: 'mcp__promate__mark_done', tool_input: { requirementId: 13 } }, { home });
    assert.equal(decision(hook), 'deny');
    assert.equal(redirected, 0);
  } finally { proxy.close(); await source.close(); await target.close(); cleanup(); }
});

test('含路径字符的不同 session 不共享确认记录', () => {
  const { home, cleanup } = makeHome();
  const event = { tool_name: 'mcp__promate__upload_skill', tool_input: uploadInput(home) };
  try {
    runHook('confirm.mjs', { ...event, session_id: 'a/b' }, { home });
    runHook('route.mjs', { session_id: 'a/b', prompt: '确认' }, { home });
    assert.equal(decision(runHook('confirm.mjs', { ...event, session_id: 'a_b' }, { home })), 'deny');
  } finally { cleanup(); }
});

test('PostToolUse 与确认共用会话锁，不覆盖正在消费的确认', () => {
  const { home, cleanup } = makeHome();
  const event = { session_id: 'mark-lock', tool_name: 'mcp__promate__upload_skill', tool_input: uploadInput(home) };
  try {
    runHook('confirm.mjs', event, { home });
    runHook('route.mjs', { session_id: event.session_id, prompt: '确认' }, { home });
    const before = readFileSync(stateFile(home, event.session_id), 'utf8');
    mkdirSync(`${stateFile(home, event.session_id)}.lock`);
    runHook('mark.mjs', event, { home });
    assert.equal(readFileSync(stateFile(home, event.session_id), 'utf8'), before);
  } finally { cleanup(); }
});

test('参数中的特殊对象键不能绕过同参数指纹校验', () => {
  const { home, cleanup } = makeHome();
  const event = { session_id: 'prototype-key', tool_name: 'mcp__promate__upload_skill', tool_input: uploadInput(home) };
  try {
    runHook('confirm.mjs', event, { home });
    runHook('route.mjs', { session_id: event.session_id, prompt: '确认' }, { home });
    const changed = JSON.parse(JSON.stringify(uploadInput(home)).replace(/}$/, ',"__proto__":{"changed":true}}'));
    assert.equal(decision(runHook('confirm.mjs', { ...event, tool_input: changed }, { home })), 'deny');
  } finally { cleanup(); }
});

test('隐藏输入期间地址被切换，不能把 Key 绑定到用户未确认的新来源', () => {
  const { home, cleanup } = makeHome();
  try {
    writeConfig(home, { url: 'https://new.example.test/api/mcp', extra: 'keep' });
    const script = `import { writeConfigKey } from ${JSON.stringify(join(PLUGIN_ROOT, 'hooks/lib.mjs'))};
      try { writeConfigKey('pk_FakeOnly0123456789FakeOnly01234567', 'https://old.example.test/api/mcp'); process.exitCode = 9; }
      catch (e) { if (!e.message.includes('输入期间已变化')) throw e; }`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8', env: { ...process.env, PROMATE_HOME: home, PROMATE_CONFIG: '' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readConfigFile(home).key, undefined);
    assert.equal(readConfigFile(home).extra, 'keep');
  } finally { cleanup(); }
});

test('插件三处版本一致，MCP 协议版本独立', () => {
  const manifest = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.codebuddy-plugin/plugin.json')));
  const market = JSON.parse(readFileSync(join(PLUGIN_ROOT, '../../.codebuddy-plugin/marketplace.json')));
  const tools = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'mcp/tools.json')));
  assert.equal(manifest.version, market.metadata.version);
  assert.equal(manifest.version, market.plugins[0].version);
  assert.equal(tools.serverInfo.version, '0.1.0');
});

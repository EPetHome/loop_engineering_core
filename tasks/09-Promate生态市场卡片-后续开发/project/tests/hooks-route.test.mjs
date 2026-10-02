// route.mjs（UserPromptSubmit）自测：关键词路由、误伤排查、Key 保存与拦截。
// 对应自检表 S1–S5 和陷阱 3、4。

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileMode, makeHome, readConfigFile, readStateFile, runHook, writeConfig, writeStateFile } from './helpers.mjs';

/** 虚构凭据；输出连前缀片段也不应出现。 */
const FAKE_KEY = 'pk_AbCdEfGh12345678AbCdEfGh12345678';
const KEY_HINT = 'pk_AbCdEfGh';

function contextOf(result) {
  assert.equal(result.status, 0, `退出码应为 0；stderr=${result.stderr}`);
  assert.ok(result.stdout.trim(), '应该有路由输出');
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  return output.hookSpecificOutput.additionalContext;
}

test('S1 命中需求关键词：注入路由指令并写状态', () => {
  const { home, cleanup } = makeHome();
  try {
    const result = runHook('route.mjs', { session_id: 't1', prompt: '项目 8 有哪些需求？' }, { home });
    const context = contextOf(result);
    assert.ok(context.includes('【Promate 路由】'), context);
    assert.ok(context.includes('list_requirements'), context);
    const state = readStateFile(home, 't1');
    assert.equal(state.promateTurn, true);
    assert.equal(state.promateCalled, false);
    assert.equal(typeof state.at, 'number');
  } finally {
    cleanup();
  }
});

test('S2 显式开关和需求编号都命中', () => {
  const { home, cleanup } = makeHome();
  try {
    for (const prompt of ['@promate 随便问问', '/promate 查数据', 'REQ-1029 进度如何', '我负责的需求']) {
      const context = contextOf(runHook('route.mjs', { session_id: 't2', prompt }, { home }));
      assert.ok(context.includes('【Promate 路由】'), `${prompt} 应命中`);
    }
  } finally {
    cleanup();
  }
});

test('公开配置意图只注入无参数本地工具，不要求聊天发送 Key', () => {
  const { home, cleanup } = makeHome();
  try {
    const context = contextOf(runHook('route.mjs', { session_id: 'configure-intent', prompt: 'Promate 配置 Key' }, { home }));
    assert.match(context, /configure_key（不传任何参数/);
    assert.match(context, /本机「配置 Key」页/);
    assert.doesNotMatch(context, /暂不可配置|聊天发送 Key，由插件/);
  } finally { cleanup(); }
});

test('S3 普通消息不命中：不输出、状态 promateTurn=false', () => {
  const { home, cleanup } = makeHome();
  try {
    const prompts = ['帮我写个需求文档', '提醒我明天开会', '帮我写个项目总结', '今天天气怎么样',
      '帮我写个需求文档，更新一下格式', '这个需求的状态机怎么设计'];
    for (const prompt of prompts) {
      const result = runHook('route.mjs', { session_id: 't3', prompt }, { home });
      assert.equal(result.status, 0, `stderr=${result.stderr}`);
      assert.equal(result.stdout, '', `${prompt} 不应命中`);
      assert.equal(readStateFile(home, 't3').promateTurn, false);
    }
  } finally {
    cleanup();
  }
});

test('S4 整条消息是 Key：退出码 2，但宿主 hook 前已入内存，插件不得保存或宣称安全', () => {
  const { home, cleanup } = makeHome();
  try {
    writeConfig(home, { url: 'https://platform.example.test/api/mcp', extra: 'keep' });
    const result = runHook('route.mjs', { session_id: 't4', prompt: `  ${FAKE_KEY}  ` }, { home });
    assert.equal(result.status, 2, `stderr=${result.stderr}`);
    assert.match(result.stdout, /插件未保存/);
    assert.ok(!(result.stdout + result.stderr).includes(KEY_HINT));
    assert.equal(readConfigFile(home).extra, 'keep');
    assert.equal(readConfigFile(home).key, undefined);
    assert.equal(readStateFile(home, 't4').pendingConfirm, undefined, 'Key 消息清除旧确认');
  } finally {
    cleanup();
  }
});

test('WorkBuddy 内公开地址消息由 hook 保存，保留字段和旧 Key，换来源拒绝自动发送', async () => {
  const { home, cleanup } = makeHome();
  try {
    writeConfig(home, { url: 'https://old.example.test/api/mcp', key: FAKE_KEY, extra: 'keep' });
    const result = runHook('route.mjs', { session_id: 'address', prompt: 'Promate 平台地址：https://new.example.test/api/mcp' }, { home });
    assert.equal(result.status, 2);
    assert.match(result.stdout, /地址已保存/);
    assert.ok(!(result.stdout + result.stderr).includes(KEY_HINT));
    const config = readConfigFile(home);
    assert.equal(config.url, 'https://new.example.test/api/mcp');
    assert.equal(config.key, FAKE_KEY);
    assert.equal(config.extra, 'keep');
    assert.equal(config.keyOrigin, 'https://old.example.test');
    const { requestKey } = await import('../marketplace/plugins/promate/hooks/lib.mjs');
    assert.throws(() => requestKey(config), /服务来源已变化/);
    const next = runHook('route.mjs', { session_id: 'address', prompt: FAKE_KEY }, { home });
    assert.equal(next.status, 2);
    assert.equal(readConfigFile(home).keyOrigin, 'https://old.example.test');
    assert.equal(fileMode(join(home, 'config.json')), 0o600);
    assert.equal(runHook('route.mjs', { session_id: 'address', prompt: 'Promate 平台地址：https://new.example.test/api/mcp?key=bad' }, { home }).status, 2);
    assert.equal(readConfigFile(home).url, config.url);
  } finally { cleanup(); }
});

test('S5 消息里夹着 Key：不保存、不回显任何片段', () => {
  const { home, cleanup } = makeHome();
  try {
    writeConfig(home, { url: 'https://platform.example.test/api/mcp' });
    const result = runHook('route.mjs', { session_id: 't5', prompt: `帮我看看 ${FAKE_KEY} 能不能用` }, { home });
    assert.equal(result.status, 2);
    assert.match(result.stdout, /插件未保存/);
    assert.ok(!(result.stdout + result.stderr).includes(KEY_HINT));
    assert.ok(!result.stdout.includes(FAKE_KEY), '不能回显完整 Key');
    assert.equal(readConfigFile(home).key, undefined);
  } finally {
    cleanup();
  }
});

test('st_ 开头的会话令牌不当 Key 处理', () => {
  const { home, cleanup } = makeHome();
  try {
    const result = runHook('route.mjs', { session_id: 't6', prompt: '我的令牌 st_abcdefghijklmnopqrstuvwxyz' }, { home });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(existsSync(join(home, 'config.json')), false);
  } finally {
    cleanup();
  }
});

test('没配 Key 时指令带配置提示；配了 Key 就不带', () => {
  const { home, cleanup } = makeHome();
  try {
    const withoutKey = contextOf(runHook('route.mjs', { session_id: 't7', prompt: '项目 8 有哪些需求？' }, { home }));
    assert.ok(withoutKey.includes('尚未配置 Promate Key'), withoutKey);
    writeConfig(home, { key: 'pk_1234567890abcdefghij' });
    const withKey = contextOf(runHook('route.mjs', { session_id: 't7', prompt: '项目 8 有哪些需求？' }, { home }));
    assert.ok(!withKey.includes('尚未配置 Promate Key'), withKey);
  } finally {
    cleanup();
  }
});

test('没有 session_id 时照常注入指令，但不写状态', () => {
  const { home, cleanup } = makeHome();
  try {
    const context = contextOf(runHook('route.mjs', { prompt: '项目 8 有哪些需求？' }, { home }));
    assert.ok(context.includes('【Promate 路由】'));
    assert.equal(existsSync(join(home, 'state')), false);
  } finally {
    cleanup();
  }
});

/** 造一份带待确认记录的状态，createdAt 默认是现在。 */
function pendingState(createdAt = Date.now()) {
  return {
    promateTurn: true,
    promateCalled: false,
    at: Date.now(),
    pendingConfirm: {
      tool: 'mcp__promate__mark_done',
      argsHash: 'a'.repeat(64),
      messageId: null, // 尚无用户消息的请求代次；旧版无此字段的授权不能继承。
      text: '将需求 13 标记为已完成，并回写飞书需求表',
      createdAt,
      confirmed: false,
    },
  };
}

test('S10 关键词修补：需求与进度/状态之间允许隔 0–6 个字', () => {
  const { home, cleanup } = makeHome();
  try {
    for (const prompt of ['我的需求有哪些进度更新', '需求现在什么状态', '我的需求']) {
      const context = contextOf(runHook('route.mjs', { session_id: 'k1', prompt }, { home }));
      assert.ok(context.includes('【Promate 路由】'), `${prompt} 应命中`);
    }
    for (const prompt of ['帮我写个需求文档', '提醒我明天开会', '帮我写个项目总结']) {
      const result = runHook('route.mjs', { session_id: 'k1', prompt }, { home });
      assert.equal(result.status, 0, `stderr=${result.stderr}`);
      assert.equal(result.stdout, '', `${prompt} 不应命中`);
    }
  } finally {
    cleanup();
  }
});

test('S3 待确认存在时回「确认」：只记 confirmed，不注入路由', () => {
  const { home, cleanup } = makeHome();
  try {
    writeStateFile(home, 'c1', pendingState());
    const result = runHook('route.mjs', { session_id: 'c1', prompt: '确认' }, { home });
    assert.equal(result.status, 0, `stderr=${result.stderr}`);
    assert.equal(result.stdout, '');
    const pending = readStateFile(home, 'c1').pendingConfirm;
    assert.equal(pending.confirmed, true);
    assert.equal(pending.tool, 'mcp__promate__mark_done');
    assert.equal(pending.argsHash, 'a'.repeat(64));
  } finally {
    cleanup();
  }
});

test('S6 待确认存在时回别的：清掉待确认；可路由的消息照常路由', () => {
  const { home, cleanup } = makeHome();
  try {
    writeStateFile(home, 'c2', pendingState());
    let result = runHook('route.mjs', { session_id: 'c2', prompt: '好的' }, { home });
    assert.equal(result.stdout, '');
    let state = readStateFile(home, 'c2');
    assert.equal(state.pendingConfirm, undefined);
    assert.equal(state.promateTurn, false, '「好的」不是 Promate 问题');

    writeStateFile(home, 'c2', pendingState());
    result = runHook('route.mjs', { session_id: 'c2', prompt: '确认一下是哪条' }, { home });
    assert.equal(result.stdout, '');
    assert.equal(readStateFile(home, 'c2').pendingConfirm, undefined);

    writeStateFile(home, 'c2', pendingState());
    result = runHook('route.mjs', { session_id: 'c2', prompt: '需求 13 的进度' }, { home });
    assert.ok(contextOf(result).includes('【Promate 路由】'));
    state = readStateFile(home, 'c2');
    assert.equal(state.pendingConfirm, undefined);
    assert.equal(state.promateTurn, true);
  } finally {
    cleanup();
  }
});

test('S7 过期的待确认不算确认，记录被删掉', () => {
  const { home, cleanup } = makeHome();
  try {
    writeStateFile(home, 'c3', pendingState(Date.now() - 11 * 60 * 1000));
    const result = runHook('route.mjs', { session_id: 'c3', prompt: '确认' }, { home });
    assert.equal(result.status, 0, `stderr=${result.stderr}`);
    assert.equal(result.stdout, '');
    const state = readStateFile(home, 'c3');
    assert.equal(state.pendingConfirm, undefined);
    assert.equal(state.promateTurn, false);
  } finally {
    cleanup();
  }
});

test('确认词判定：去首尾空白和结尾标点，只认整条「确认/确定」', () => {
  const { home, cleanup } = makeHome();
  try {
    const accepted = ['确认', '确定', '  确认  ', '确认。', '确定！', '确定!'];
    accepted.forEach((prompt, index) => {
      const sessionId = `w-ok-${index}`;
      writeStateFile(home, sessionId, pendingState());
      const result = runHook('route.mjs', { session_id: sessionId, prompt }, { home });
      assert.equal(result.stdout, '');
      assert.equal(readStateFile(home, sessionId).pendingConfirm.confirmed, true, `${prompt} 应算确认`);
    });
    const rejected = ['确认一下', '确认是哪条', '好的', 'OK'];
    rejected.forEach((prompt, index) => {
      const sessionId = `w-no-${index}`;
      writeStateFile(home, sessionId, pendingState());
      const result = runHook('route.mjs', { session_id: sessionId, prompt }, { home });
      assert.equal(result.stdout, '');
      assert.equal(readStateFile(home, sessionId).pendingConfirm, undefined, `${prompt} 不应算确认`);
    });
  } finally {
    cleanup();
  }
});

test('没有待确认时回「确认」：不注入路由、不写待确认', () => {
  const { home, cleanup } = makeHome();
  try {
    const result = runHook('route.mjs', { session_id: 'c4', prompt: '确认' }, { home });
    assert.equal(result.status, 0, `stderr=${result.stderr}`);
    assert.equal(result.stdout, '');
    const state = readStateFile(home, 'c4');
    assert.equal(state.pendingConfirm, undefined);
    assert.equal(state.promateTurn, false);
  } finally {
    cleanup();
  }
});

test('route 合并更新：不丢状态里的其它字段', () => {
  const { home, cleanup } = makeHome();
  try {
    writeStateFile(home, 'm1', { promateTurn: true, promateCalled: false, at: Date.now(), extra: 'keep' });
    runHook('route.mjs', { session_id: 'm1', prompt: '项目 8 有哪些需求？' }, { home });
    const state = readStateFile(home, 'm1');
    assert.equal(state.extra, 'keep');
    assert.equal(state.promateTurn, true);
    assert.equal(state.promateCalled, false);
  } finally {
    cleanup();
  }
});

// guard.mjs（PreToolUse 冲突拦截）+ mark.mjs（PostToolUse 记录）自测。
// 对应自检表 S8–S11。

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeHome, readStateFile, runHook, writeConfig, writeStateFile } from './helpers.mjs';

function decisionOf(result) {
  assert.equal(result.status, 0, `退出码应为 0；stderr=${result.stderr}`);
  if (!result.stdout.trim()) return null;
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, 'PreToolUse');
  return output.hookSpecificOutput;
}

function skillEvent(sessionId, toolInput) {
  return { session_id: sessionId, hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: toolInput };
}

test('S8 冲突技能先 deny，调过 promate 工具后放行', () => {
  const { home, cleanup } = makeHome();
  try {
    writeStateFile(home, 'g1', { promateTurn: true, promateCalled: false, at: Date.now() });
    const denied = decisionOf(runHook('guard.mjs', skillEvent('g1', { skill: 'requirement-board' }), { home }));
    assert.equal(denied.permissionDecision, 'deny');
    assert.ok(denied.permissionDecisionReason.includes('promate MCP 工具'), denied.permissionDecisionReason);

    // 模拟调用过一次 promate 工具：mark.mjs 把 promateCalled 置为 true
    const mark = runHook('mark.mjs', {
      session_id: 'g1',
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__promate__my_projects',
      tool_input: {},
      tool_response: {},
    }, { home });
    assert.equal(mark.status, 0);
    assert.equal(mark.stdout, '');
    assert.equal(readStateFile(home, 'g1').promateCalled, true);

    assert.equal(decisionOf(runHook('guard.mjs', skillEvent('g1', { skill: 'requirement-board' }), { home })), null);
  } finally {
    cleanup();
  }
});

test('配置页工具没有取业务数据：mark 不解除本轮 guard', () => {
  const { home, cleanup } = makeHome();
  try {
    writeStateFile(home, 'configure', { promateTurn: true, promateCalled: false, at: Date.now() });
    const mark = runHook('mark.mjs', {
      session_id: 'configure', hook_event_name: 'PostToolUse', tool_name: 'mcp__promate__configure_key',
      tool_input: {}, tool_response: {},
    }, { home });
    assert.equal(mark.status, 0);
    assert.equal(readStateFile(home, 'configure').promateCalled, false);
    assert.equal(decisionOf(runHook('guard.mjs', skillEvent('configure', { skill: 'requirement-board' }), { home }))?.permissionDecision, 'deny');
  } finally { cleanup(); }
});

test('S9 白名单技能永远放行', () => {
  const { home, cleanup } = makeHome();
  try {
    writeStateFile(home, 'g2', { promateTurn: true, promateCalled: false, at: Date.now() });
    for (const skill of ['pm-weekly-monitor', 'requirement-entry', 'promate', 'product-agent', 'telemetry-tracker']) {
      assert.equal(decisionOf(runHook('guard.mjs', skillEvent('g2', { skill }), { home })), null, `${skill} 应放行`);
    }
  } finally {
    cleanup();
  }
});

test('S10 Bash 直调 Promate 接口 deny，普通命令放行', () => {
  const { home, cleanup } = makeHome();
  try {
    writeStateFile(home, 'g3', { promateTurn: true, promateCalled: false, at: Date.now() });
    const denied = decisionOf(runHook('guard.mjs', {
      session_id: 'g3',
      tool_name: 'Bash',
      tool_input: { command: 'curl http://localhost:8080/api/requirements?projectId=8' },
    }, { home }));
    assert.equal(denied.permissionDecision, 'deny');
    assert.equal(denied.permissionDecisionReason, '请使用 promate MCP 工具获取 Promate 数据，不要直接调用平台接口。');

    assert.equal(decisionOf(runHook('guard.mjs', {
      session_id: 'g3',
      tool_name: 'Bash',
      tool_input: { command: 'ls -la' },
    }, { home })), null);
  } finally {
    cleanup();
  }
});

test('公开市场只放行禁用 curlrc 的整条 GET，复合/伪装/写操作均不豁免', () => {
  const { home, cleanup } = makeHome();
  try {
    writeStateFile(home, 'market', { promateTurn: true, promateCalled: false });
    writeConfig(home, { url: 'https://platform.example.test/api/mcp' });
    const check = (command) => decisionOf(runHook('guard.mjs', {
      session_id: 'market', tool_name: 'Bash', tool_input: { command },
    }, { home }));
    for (const path of ['latest', 'marketplace.zip']) {
      assert.equal(check(`curl -q https://platform.example.test/api/skills/plugins/${path}`), null);
    }
    for (const command of [
      'curl https://platform.example.test/api/skills/plugins/latest', // 未禁用 curlrc，隐藏选项不可控
      'curl -q https://platform.example.test/api/skills/plugins/latest; curl https://platform.example.test/api/projects',
      'curl -q https://platform.example.test/api/skills/plugins/latest && curl https://platform.example.test/api/mcp',
      'curl -L https://platform.example.test/api/skills/plugins/latest',
      'curl -X POST https://platform.example.test/api/skills/plugins/latest',
      'curl -H "Authorization: Bearer fake" https://platform.example.test/api/skills/plugins/latest',
      'curl https://platform.example.test/api/skills/plugins/latest?next=1',
      'curl https://platform.example.test/api/skills/plugins/latest/evil',
      'curl https://platform.example.test.evil.test/api/skills/plugins/latest',
      'curl https://other.example.test/api/skills/plugins/marketplace.zip',
      'curl https://platform.example.test/api/requirements',
    ]) assert.equal(check(command)?.permissionDecision, 'deny', command);
  } finally { cleanup(); }
});

test('S11 非 Promate 轮次放行；没有 session_id 也放行', () => {
  const { home, cleanup } = makeHome();
  try {
    writeStateFile(home, 'g4', { promateTurn: false, promateCalled: false, at: Date.now() });
    assert.equal(decisionOf(runHook('guard.mjs', skillEvent('g4', { skill: 'requirement-board' }), { home })), null);
    assert.equal(decisionOf(runHook('guard.mjs', skillEvent('', { skill: 'requirement-board' }), { home })), null);
    // 没有状态文件同样放行
    assert.equal(decisionOf(runHook('guard.mjs', skillEvent('g-missing', { skill: 'requirement-board' }), { home })), null);
  } finally {
    cleanup();
  }
});

test('Skill 的 command 入参也参与判定，命中描述类关键词的 deny', () => {
  const { home, cleanup } = makeHome();
  try {
    writeStateFile(home, 'g5', { promateTurn: true, promateCalled: false, at: Date.now() });
    assert.equal(decisionOf(runHook('guard.mjs', skillEvent('g5', { command: '/feishu-sync' }), { home })).permissionDecision, 'deny');
    assert.equal(decisionOf(runHook('guard.mjs', skillEvent('g5', { command: 'excel-helper' }), { home })), null);
  } finally {
    cleanup();
  }
});

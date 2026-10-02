// confirm.mjs（PreToolUse 写操作）自测：
// - 所有权限模式四个写操作一律对话确认，标题查得到就带上；
// - 对话模式（bypassPermissions 等）第一次 deny 并记待确认，用户确认且参数一致才 allow 一次。
// 对应自检表 S1、S2、S3、S4、S5、S8、S9。
//
// 这些用例要让 hook 请求测试进程里的 stub，所以必须用 runHookAsync（spawnSync 会阻塞事件循环）。

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeHome, readStateFile, runHook, runHookAsync, startStub, unusedPort, writeConfig } from './helpers.mjs';

function decisionOf(result) {
  assert.equal(result.status, 0, `退出码应为 0；stderr=${result.stderr}`);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, 'PreToolUse');
  return output.hookSpecificOutput;
}

function reasonOf(result) {
  const decision = decisionOf(result);
  assert.equal(decision.permissionDecision, 'deny');
  return decision.permissionDecisionReason.split('\n')[1];
}

function requirementStub(title) {
  return startStub(({ path, request, headers }) => {
    assert.equal(path, '/api/mcp', '确认标题不得直调业务接口');
    assert.equal(headers['x-promate-capabilities'],'mcp-tools-v2');
    if (request?.params?.name === 'get_requirement' && request.params.arguments.requirementId === 13) {
      return { body: { jsonrpc:'2.0',id:request.id,result:{structuredContent:{id:13,title},content:[{type:'text',text:JSON.stringify({id:13,title})}],isError:false} } };
    }
    return { status: 404, body: { code: 'NOT_FOUND' } };
  });
}

function markDoneEvent(sessionId, extra = {}) {
  return {
    session_id: sessionId,
    hook_event_name: 'PreToolUse',
    tool_name: 'mcp__promate__mark_done',
    tool_input: { requirementId: 13 },
    ...extra,
  };
}

test('S6 mark_done：查到标题，原因带书名号', async () => {
  const { home, cleanup } = makeHome();
  const stub = await requirementStub('权限模型重构');
  try {
    writeConfig(home, { url: stub.url, key: 'st_test_token' });
    const result = await runHookAsync('confirm.mjs', markDoneEvent('c1', { permission_mode: 'default' }), { home });
    assert.equal(reasonOf(result), '将需求 13《权限模型重构》标记为已完成，并回写飞书需求表');
  } finally {
    await stub.close();
    cleanup();
  }
});

test('S7 平台连不上：仍须对话确认，标题退回「需求 13」', async () => {
  const { home, cleanup } = makeHome();
  try {
    const port = await unusedPort();
    writeConfig(home, { url: `http://127.0.0.1:${port}/api/mcp`, key: 'st_test_token' });
    const result = await runHookAsync('confirm.mjs', markDoneEvent('c2', { permission_mode: 'default' }), { home });
    assert.equal(reasonOf(result), '将需求 13 标记为已完成，并回写飞书需求表');
  } finally {
    cleanup();
  }
});

test('set_stage / add_artifact / upload_skill 文案', async () => {
  const { home, cleanup } = makeHome();
  const stub = await requirementStub('权限模型重构');
  try {
    writeConfig(home, { url: stub.url, key: 'st_test_token' });
    const setStage = await runHookAsync('confirm.mjs', {
      session_id: 'c3',
      permission_mode: 'default',
      tool_name: 'mcp__promate__set_stage',
      tool_input: { requirementId: 13, stage: 'DELIVERED' },
    }, { home });
    assert.equal(reasonOf(setStage), '将需求 13《权限模型重构》标记为已交付研发，并回写飞书需求表');

    const addArtifact = await runHookAsync('confirm.mjs', {
      session_id: 'c3',
      permission_mode: 'default',
      tool_name: 'mcp__promate__add_artifact',
      tool_input: { requirementId: 13, title: 'PRD 文档', documentUrl: 'https://example.com/prd' },
    }, { home });
    assert.equal(reasonOf(addArtifact), '给需求 13《权限模型重构》登记产出物「PRD 文档」（https://example.com/prd）');

    const uploadSkill = await runHookAsync('confirm.mjs', {
      session_id: 'c3',
      permission_mode: 'default',
      tool_name: 'mcp__promate__upload_skill',
      tool_input: { name: '竞品分析', filePath: join(home,'fixture.md') },
    }, { home });
    assert.match(reasonOf(uploadSkill), /^上传技能「竞品分析」（fixture\.md），提交管理员审核；大小 \d+ bytes；SHA-256 [a-f0-9]{64}$/);
  } finally {
    await stub.close();
    cleanup();
  }
});

test('没配 Key 仍须对话确认，标题退回「需求 13」', async () => {
  const { home, cleanup } = makeHome();
  try {
    const result = await runHookAsync('confirm.mjs', markDoneEvent('c4', { permission_mode: 'default' }), { home });
    assert.equal(reasonOf(result), '将需求 13 标记为已完成，并回写飞书需求表');
  } finally {
    cleanup();
  }
});

test('查标题失败（HTTP 400）也必须确认', async () => {
  const { home, cleanup } = makeHome();
  const stub = await startStub(() => ({ status: 400, body: { code: 'BAD_REQUEST' } }));
  try {
    writeConfig(home, { url: stub.url, key: 'st_test_token' });
    const result = await runHookAsync('confirm.mjs', {
      session_id: 'c5',
      permission_mode: 'default',
      tool_name: 'mcp__promate__set_stage',
      tool_input: { requirementId: 99 },
    }, { home });
    assert.equal(reasonOf(result), '将需求 99 标记为已交付研发，并回写飞书需求表');
  } finally {
    await stub.close();
    cleanup();
  }
});

test('S1 曾被视为弹窗的四种模式一律 deny；输入异常也不能放行', async () => {
  const { home, cleanup } = makeHome();
  try {
    for (const mode of ['default', 'acceptEdits', 'plan', 'work']) {
      const result = await runHookAsync('confirm.mjs', markDoneEvent('c6', { permission_mode: mode }), { home });
      assert.equal(reasonOf(result), '将需求 13 标记为已完成，并回写飞书需求表', `${mode} 应 deny 并等待独立用户确认`);
    }
    const broken = await runHookAsync('confirm.mjs', { permission_mode: 'default' }, { home });
    assert.equal(decisionOf(broken).permissionDecision, 'deny');
    assert.equal(readStateFile(home, 'c6').pendingConfirm.confirmed, false);
  } finally {
    cleanup();
  }
});

test('S2 bypassPermissions：第一次调用 deny 并写入 pendingConfirm', async () => {
  const { home, cleanup } = makeHome();
  const stub = await requirementStub('权限模型重构');
  try {
    writeConfig(home, { url: stub.url, key: 'st_test_token' });
    const result = await runHookAsync('confirm.mjs', markDoneEvent('p2', { permission_mode: 'bypassPermissions' }), { home });
    const decision = decisionOf(result);
    assert.equal(decision.permissionDecision, 'deny');
    assert.ok(decision.permissionDecisionReason.startsWith('【需要用户确认】'), decision.permissionDecisionReason);
    assert.ok(decision.permissionDecisionReason.includes('将需求 13《权限模型重构》标记为已完成，并回写飞书需求表'));

    const pending = readStateFile(home, 'p2').pendingConfirm;
    assert.equal(pending.confirmed, false);
    assert.equal(pending.tool, 'mcp__promate__mark_done');
    assert.ok(pending.text.startsWith('将需求 13《权限模型重构》标记为已完成，并回写飞书需求表'));
    assert.equal(pending.argsHash, 'ad56ee3697c394e607083877de3cb74fb18fa24693ff69652d696543a5078aaf');
    assert.match(pending.argsHash, /^[0-9a-f]{64}$/);
    assert.equal(typeof pending.createdAt, 'number');
  } finally {
    await stub.close();
    cleanup();
  }
});

test('S3/S4 用户确认后同参数 allow 一次并清掉记录，再调重新确认', async () => {
  const { home, cleanup } = makeHome();
  const stub = await requirementStub('权限模型重构');
  try {
    writeConfig(home, { url: stub.url, key: 'st_test_token' });
    const first = await runHookAsync('confirm.mjs', markDoneEvent('p3', { permission_mode: 'bypassPermissions' }), { home });
    assert.equal(decisionOf(first).permissionDecision, 'deny');

    // 用户回「确认」：route 只记 confirmed，不输出路由指令
    const routed = runHook('route.mjs', { session_id: 'p3', prompt: '确认' }, { home });
    assert.equal(routed.status, 0, `stderr=${routed.stderr}`);
    assert.equal(routed.stdout, '');
    assert.equal(readStateFile(home, 'p3').pendingConfirm.confirmed, true);

    // 同样的工具和参数：放行一次
    const allowed = await runHookAsync('confirm.mjs', markDoneEvent('p3', { permission_mode: 'bypassPermissions' }), { home });
    assert.equal(decisionOf(allowed).permissionDecision, 'allow');
    assert.equal(readStateFile(home, 'p3').pendingConfirm, undefined, '放行后应清掉记录');

    // 模型再调一次：又要重新确认
    const again = await runHookAsync('confirm.mjs', markDoneEvent('p3', { permission_mode: 'bypassPermissions' }), { home });
    assert.equal(decisionOf(again).permissionDecision, 'deny');
    assert.equal(readStateFile(home, 'p3').pendingConfirm.confirmed, false);
  } finally {
    await stub.close();
    cleanup();
  }
});

test('S5 确认以后换参数：deny，要重新确认', async () => {
  const { home, cleanup } = makeHome();
  try {
    const first = await runHookAsync('confirm.mjs', markDoneEvent('p5', { permission_mode: 'bypassPermissions' }), { home });
    assert.equal(decisionOf(first).permissionDecision, 'deny');
    runHook('route.mjs', { session_id: 'p5', prompt: '确定。' }, { home });
    assert.equal(readStateFile(home, 'p5').pendingConfirm.confirmed, true);

    const changed = await runHookAsync('confirm.mjs', {
      session_id: 'p5',
      permission_mode: 'bypassPermissions',
      tool_name: 'mcp__promate__mark_done',
      tool_input: { requirementId: 14 },
    }, { home });
    const decision = decisionOf(changed);
    assert.equal(decision.permissionDecision, 'deny');
    assert.ok(decision.permissionDecisionReason.includes('将需求 14 标记为已完成'), decision.permissionDecisionReason);
    assert.equal(readStateFile(home, 'p5').pendingConfirm.confirmed, false);
  } finally {
    cleanup();
  }
});

test('参数 key 顺序不同也算一模一样（哈希前递归排序）', async () => {
  const { home, cleanup } = makeHome();
  try {
    const first = await runHookAsync('confirm.mjs', {
      session_id: 'p6',
      permission_mode: 'bypassPermissions',
      tool_name: 'mcp__promate__set_stage',
      tool_input: { requirementId: 13, stage: 'DELIVERED' },
    }, { home });
    assert.equal(decisionOf(first).permissionDecision, 'deny');
    runHook('route.mjs', { session_id: 'p6', prompt: '确认' }, { home });

    const second = await runHookAsync('confirm.mjs', {
      session_id: 'p6',
      permission_mode: 'bypassPermissions',
      tool_name: 'mcp__promate__set_stage',
      tool_input: { stage: 'DELIVERED', requirementId: 13 },
    }, { home });
    assert.equal(decisionOf(second).permissionDecision, 'allow');
  } finally {
    cleanup();
  }
});

test('S8 permission_mode 缺失 / auto / dontAsk / fullAccess / 没见过的值都走对话确认', async () => {
  const { home, cleanup } = makeHome();
  try {
    const modes = [undefined, 'auto', 'dontAsk', 'fullAccess', 'someNewMode'];
    for (const [index, mode] of modes.entries()) {
      const sessionId = `p8-${index}`;
      const event = markDoneEvent(sessionId, mode === undefined ? {} : { permission_mode: mode });
      const result = await runHookAsync('confirm.mjs', event, { home });
      const decision = decisionOf(result);
      assert.equal(decision.permissionDecision, 'deny', `${mode ?? '缺失'} 应走对话确认`);
      assert.ok(decision.permissionDecisionReason.startsWith('【需要用户确认】'), decision.permissionDecisionReason);
      assert.equal(readStateFile(home, sessionId).pendingConfirm.confirmed, false);
    }
  } finally {
    cleanup();
  }
});

test('S9 对话模式下没有 session_id：deny 并提示到网页操作', async () => {
  const { home, cleanup } = makeHome();
  try {
    const result = await runHookAsync('confirm.mjs', {
      hook_event_name: 'PreToolUse',
      permission_mode: 'bypassPermissions',
      tool_name: 'mcp__promate__mark_done',
      tool_input: { requirementId: 13 },
    }, { home });
    const decision = decisionOf(result);
    assert.equal(decision.permissionDecision, 'deny');
    assert.ok(decision.permissionDecisionReason.includes('请到 Promate 网页上操作'), decision.permissionDecisionReason);
    assert.equal(existsSync(join(home, 'state')), false, '没有 session_id 不应写状态');
  } finally {
    cleanup();
  }
});

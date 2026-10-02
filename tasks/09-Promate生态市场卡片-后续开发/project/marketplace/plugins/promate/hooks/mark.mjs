#!/usr/bin/env node
// PostToolUse hook：调用过 Promate 业务工具后，把状态里的 promateCalled 置为 true。
// 之后 guard.mjs 就会放行本轮其它技能和 Bash 命令（冲突拦截只拦第 1 步）。
// 什么都不输出；出错只记 stderr。

import { log, readStdinJson, withSessionState, writeState } from './lib.mjs';

function main() {
  const event = readStdinJson();
  if (!event) return;
  const sessionId = typeof event.session_id === 'string' && event.session_id.trim()
    ? event.session_id.trim() : '';
  // configure_key 仅打开本机设置页，没有查询平台；不得据此放松本轮业务 guard。
  if (!sessionId || event.tool_name === 'mcp__promate__configure_key') return;
  withSessionState(sessionId, (state) => {
    if (!Object.keys(state).length) return;
    writeState(sessionId, { ...state, promateCalled: true });
  });
}

try {
  main();
} catch (error) {
  log(`mark hook 异常（忽略）：${error.stack || error.message}`);
}

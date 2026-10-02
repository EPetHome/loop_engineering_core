#!/usr/bin/env node
// SessionStart hook：报告钩子自身版本；仅在有效待配置请求下启动短期私密页；
// 顺手清掉超过 24 小时的本轮状态文件。
//
// 只往 stdout 写一行 JSON（systemMessage）。hook 出错会阻塞对话，所以这里所有异常
// 都必须吞掉，版本查询失败时仍然输出「已加载」并以 0 退出。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupStateFiles, log, platformBase, readConfig, requestKey, resolveUrl } from './lib.mjs';
import { resumeFirstConnect } from './first-connect.mjs';

const TIMEOUT_MS = 3000;

// 插件清单在插件根目录的 .codebuddy-plugin/plugin.json；兼容平铺写法。
function localVersion() {
  const root = process.env.CODEBUDDY_PLUGIN_ROOT;
  if (!root) return '';
  for (const file of [join(root, '.codebuddy-plugin', 'plugin.json'), join(root, 'plugin.json')]) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      const version = typeof parsed.version === 'string' ? parsed.version.trim() : '';
      if (version) return version;
    } catch {
      // 换下一个候选路径
    }
  }
  return '';
}

function isNewer(latest, current) {
  const left = latest.split('.').map((part) => Number(part));
  const right = current.split('.').map((part) => Number(part));
  if (left.some(Number.isNaN) || right.some(Number.isNaN)) return latest !== current;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const a = left[i] ?? 0;
    const b = right[i] ?? 0;
    if (a !== b) return a > b;
  }
  return false;
}

async function main() {
  try {
    cleanupStateFiles();
  } catch (error) {
    log(`清理过期状态失败（忽略）：${error.message}`);
  }
  const version = localVersion();
  const hook = version ? `Promate 会话钩子版本 v${version}` : 'Promate 会话钩子版本未确认';
  let message = hook;
  const continuation = version && process.env.CODEBUDDY_PLUGIN_ROOT
    ? await resumeFirstConnect({ pluginRoot: process.env.CODEBUDDY_PLUGIN_ROOT, version }) : null;
  if (continuation === 'PRIVATE_PAGE_STARTING') message += '；本次私密配置页正在启动（是否可达和浏览器是否打开须分别确认）';
  else if (continuation === 'PRIVATE_PAGE_UNAVAILABLE') message += '；本次私密配置页启动失败，可从网页重新接入';
  let newer = false;
  try {
    const base = platformBase(readConfig(true));
    const response = await fetch(`${base}/api/skills/plugins/latest`, {
      signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error',
    });
    if (response.ok) {
      const payload = await response.json();
      // 接口约定是平铺 JSON；兼容将来可能包一层 data 的写法。
      const latest = payload.version ?? payload.data?.version;
      if (version && typeof latest === 'string' && /^\d+\.\d+\.\d+$/.test(latest.trim()) && isNewer(latest.trim(), version)) {
        newer = true;
        message = `${hook}；平台有新版本 v${latest.trim()}，请从 Promate 网页接入更新；安装程序会说明本次是否需由用户重启 WorkBuddy`;
      }
    }
  } catch (error) {
    log('版本检查失败（忽略），不阻断会话');
  }
  // 只有实际加载提供私密配置页的版本且有显式有效地址，才提示下一步；
  // 真正的本机监听/来源绑定由无参数工具在生成链接时再次检查。
  if (version && !newer && !['PRIVATE_PAGE_STARTING', 'PRIVATE_PAGE_UNAVAILABLE'].includes(continuation)) {
    try {
      const config = readConfig(true);
      if (!config.url) message += '。请从 Promate 网页点击「接入 WorkBuddy」，由程序配置公开平台地址';
      else {
        const url = resolveUrl(config);
        const key = requestKey(config);
        if (!key) message += `。平台地址 ${url} 已配置；请从 Promate 网页接入，由插件打开本机私密配置页（聊天不要包含 Key）`;
      }
    } catch {
      message += '。平台地址或凭据来源未就绪：请从 Promate 网页重新接入，原有 Key 不会跨来源发送';
    }
  }
  process.stdout.write(JSON.stringify({ systemMessage: `${message}。钩子版本不证明 MCP 代理版本或身份连接；请勿在聊天发送 Key。` }) + '\n', () => process.exit(0));
}

main();

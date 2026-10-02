#!/usr/bin/env node
// PreToolUse hook：本轮是 Promate 问题、且还没调用过 promate MCP 工具时，
// 拦下会绕过 Promate 的 skill 和直接调平台接口的 Bash 命令。
//
// 判定见「提示词-插件第二步」6.5：
// - 白名单技能永远放行；技能名或它的 SKILL.md 描述命中冲突正则就 deny。
// - Bash 命令出现「下载工具 + Promate 接口」的组合就 deny。
// - 状态不对、读不到状态、脚本自身出错一律放行。

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { log, platformBase, readConfig, readState, readStdinJson } from './lib.mjs';

/** 这些技能不会绕过 Promate，永远放行。 */
const SKILL_WHITELIST = new Set([
  'promate',
  'pm-weekly-monitor',
  'requirement-entry',
  'product-agent',
  'telemetry-tracker',
]);

/** 技能名或描述命中这个正则就当作「会和 Promate 抢数据」的技能。 */
const CONFLICT_PATTERN = /requirement|需求|feishu|飞书|bitable/i;
/** 直接调 Promate 接口的 Bash 命令：下载工具 + Promate 路径/端口。 */
const BASH_CONFLICT_PATTERN = /(curl|wget|fetch|requests\.|http\.client|urllib).*(\/api\/(mcp|requirements|projects|skills)|:8080)/i;

// -q 必须是 curl 第一个参数：禁用用户 curlrc 隐含的重定向/凭据头等设置。
// 整条命令只能是一次无其它选项的公开 GET；不把允许 URL 当成复合 shell 的通行证。
function isPublicMarketplaceRead(command) {
  const match = /^curl -q (?:'([^'\r\n]+)'|"([^"\r\n]+)"|(https?:\/\/[^\s;&|`$<>]+))$/.exec(command);
  if (!match) return false;
  try {
    const config = readConfig(true);
    if (!config.url) return false; // 没有显式配置不能把开发机回退当作可信来源。
    const base = platformBase(config);
    return [
      `${base}/api/skills/plugins/latest`,
      `${base}/api/skills/plugins/marketplace.zip`,
    ].includes(match[1] || match[2] || match[3]);
  } catch { return false; }
}

const SKILL_DENY_REASON = '这一轮是 Promate 的问题，请先用 promate MCP 工具（例如 mcp__promate__list_requirements）从 Promate 拿到数据，拿到以后再使用其它技能。';
const BASH_DENY_REASON = '请使用 promate MCP 工具获取 Promate 数据，不要直接调用平台接口。';

function textOf(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 技能名的各种可能写法：原样、第一个词、去掉开头斜杠、去掉命名空间前缀。 */
function skillNameCandidates(raw) {
  const candidates = new Set();
  const full = textOf(raw);
  if (!full) return [];
  candidates.add(full);
  candidates.add(full.split(/\s+/)[0]);
  for (const value of [...candidates]) {
    candidates.add(value.replace(/^\/+/, ''));
    const colon = value.lastIndexOf(':');
    if (colon >= 0) candidates.add(value.slice(colon + 1));
    const slash = value.lastIndexOf('/');
    if (slash >= 0) candidates.add(value.slice(slash + 1));
  }
  return [...candidates].filter(Boolean);
}

/** 从 SKILL.md 的 YAML frontmatter 里取 description（兼容多行写法）。 */
function readSkillDescription(name) {
  const skillsDir = process.env.PROMATE_SKILLS_DIR || join(homedir(), '.workbuddy', 'skills');
  const file = join(skillsDir, name, 'SKILL.md');
  if (!existsSync(file)) return '';
  try {
    const text = readFileSync(file, 'utf8');
    const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!frontmatter) return '';
    const lines = frontmatter[1].split(/\r?\n/);
    const index = lines.findIndex((line) => /^description\s*:/.test(line));
    if (index < 0) return '';
    let value = lines[index].replace(/^description\s*:/, '').trim();
    if (value === '' || value === '>' || value === '|' || value === '>-' || value === '|-') {
      const parts = [];
      for (let i = index + 1; i < lines.length; i++) {
        if (!/^\s+\S/.test(lines[i])) break;
        parts.push(lines[i].trim());
      }
      value = parts.join(' ');
    }
    return value.replace(/^["']|["']$/g, '').trim();
  } catch (error) {
    log(`读取技能描述失败（忽略）：${file}：${error.message}`);
    return '';
  }
}

function skillConflicts(rawName) {
  const candidates = skillNameCandidates(rawName);
  if (candidates.some((name) => SKILL_WHITELIST.has(name))) return false;
  if (candidates.some((name) => CONFLICT_PATTERN.test(name))) return true;
  return candidates.some((name) => CONFLICT_PATTERN.test(readSkillDescription(name)));
}

function decide(event) {
  const toolName = typeof event.tool_name === 'string' ? event.tool_name : '';
  const toolInput = event.tool_input && typeof event.tool_input === 'object' ? event.tool_input : {};
  if (toolName === 'Skill') {
    const name = textOf(toolInput.skill) || textOf(toolInput.command);
    return name && skillConflicts(name) ? SKILL_DENY_REASON : '';
  }
  if (toolName === 'Bash') {
    const command = textOf(toolInput.command);
    return command && BASH_CONFLICT_PATTERN.test(command) && !isPublicMarketplaceRead(command) ? BASH_DENY_REASON : '';
  }
  return '';
}

function main() {
  const event = readStdinJson();
  if (!event) return;
  const sessionId = typeof event.session_id === 'string' && event.session_id.trim()
    ? event.session_id.trim() : '';
  if (!sessionId) return; // 没有 session_id 就没有状态，一律放行
  const state = readState(sessionId);
  if (!state || state.promateTurn !== true || state.promateCalled === true) return;

  const reason = decide(event);
  if (!reason) return;
  const output = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
  process.stdout.write(JSON.stringify(output) + '\n');
}

try {
  main();
} catch (error) {
  log(`guard hook 异常，按放行处理：${error.stack || error.message}`);
}

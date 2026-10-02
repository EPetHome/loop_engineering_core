// Promate 插件 hook 的公共逻辑：读配置、读写状态、推平台地址、日志。
//
// 约定（见「提示词-插件第二步」6.1）：
// - 本地数据目录默认 ~/.promate，可用 PROMATE_HOME 改到别处；配置文件是
//   $PROMATE_HOME/config.json（PROMATE_CONFIG 优先级更高）。
// - 本轮状态放 $PROMATE_HOME/state/<session_id>.json，先写临时文件再 rename。
// - 所有日志一律写 stderr，stdout 留给 hook 的正式输出。

import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const DEFAULT_URL = 'http://localhost:8080/api/mcp';
/** 状态文件超过这个时间就当作过期，SessionStart 时删掉。 */
export const STATE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** 待确认的写操作超过这个时间就失效。 */
export const PENDING_CONFIRM_TTL_MS = 10 * 60 * 1000;

export function redact(message, key = '') {
  let text = String(message);
  if (key) text = text.split(key).join('[凭据已隐藏]');
  return text.replace(/\b(?:pk|st)_[A-Za-z0-9]+/g, '[凭据已隐藏]');
}

export function log(message) {
  process.stderr.write(`[promate-hook] ${redact(message)}\n`);
}

/** 插件本地数据目录：PROMATE_HOME 优先，默认 ~/.promate。 */
export function promateHome() {
  const custom = process.env.PROMATE_HOME;
  return custom && custom.trim() ? custom.trim() : join(homedir(), '.promate');
}

/** 配置文件路径：PROMATE_CONFIG 优先（兼容第一版），否则 $PROMATE_HOME/config.json。 */
export function configPath() {
  const custom = process.env.PROMATE_CONFIG;
  return custom && custom.trim() ? custom.trim() : join(promateHome(), 'config.json');
}

/** 读配置：不存在、不是 JSON 对象、解析失败都返回 {}，绝不抛错。 */
export function readConfig(strict = false) {
  const file = configPath();
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
    if (strict) throw new Error('配置格式错误，请在本地修复；未覆盖原文件');
    log('配置文件不是 JSON 对象，按未配置处理');
  } catch (error) {
    if (strict && error.code !== 'ENOENT') throw new Error('配置读取失败，请在本地修复；未覆盖原文件');
    log('配置未就绪，请先核对平台地址');
  }
  return {};
}

/** 配置里的 Key；没配或不是字符串都按空处理。 */
export function configKey(config) {
  return config && typeof config.key === 'string' ? config.key.trim() : '';
}

/** 显式地址优先；无地址只供本机开发回退，坏地址绝不退回 localhost。 */
export function resolveUrl(config) {
  const configured = config && Object.hasOwn(config, 'url');
  const raw = configured ? config.url : DEFAULT_URL;
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('平台地址未配置');
  let url;
  try { url = new URL(raw.trim()); } catch { throw new Error('平台地址无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || /(?:pk|st)_/i.test(raw)) throw new Error('平台地址不能包含凭据、查询参数或片段');
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/api/mcp') ? path : `${path}/api/mcp`;
  return url.href;
}

/** Key 绑定服务来源；切换地址时保留旧 Key，但绝不跨来源自动发送。 */
export function requestKey(config) {
  const key = configKey(config);
  if (key && config.keyOrigin && config.keyOrigin !== new URL(resolveUrl(config)).origin) {
    throw new Error('服务来源已变化，旧 Key 已保留但不会发送；请在 WorkBuddy 打开插件本机「配置 Key」页面');
  }
  return key;
}

export function writeConfigUrl(url) {
  const config = readConfig(true);
  const nextUrl = resolveUrl({ url });
  if (configKey(config) && !config.keyOrigin) config.keyOrigin = new URL(resolveUrl(config)).origin;
  config.url = nextUrl;
  saveConfig(config);
}

/**
 * 平台根地址：MCP 地址去掉 /api/mcp 后缀就是平台入口。
 * 配置里直接写根地址（不带 /api/mcp）时原样返回。
 */
export function platformBase(config) {
  const url = resolveUrl(config);
  const base = url.replace(/\/api\/mcp\/?$/, '').replace(/\/+$/, '');
  return base || url;
}

/** 保存 Key 到配置文件：保留其它字段，目录 700、文件 600，写临时文件再 rename。 */
export function writeConfigKey(key, expectedUrl) {
  const config = readConfig(true);
  if (!config.url) throw new Error('请先配置并确认平台地址，再保存 Key');
  const url = resolveUrl(config);
  if (expectedUrl && url !== expectedUrl) throw new Error('平台地址在输入期间已变化，未保存 Key；请核对地址后重新运行');
  config.key = key;
  config.keyOrigin = new URL(url).origin;
  saveConfig(config);
}

function saveConfig(config) {
  const file = configPath();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  try {
    chmodSync(dirname(file), 0o700);
  } catch (error) {
    throw new Error('无法保护配置目录权限，已停止保存');
  }
  const temporary = `${file}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, file);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* 临时文件可能不存在 */ }
    throw new Error('配置未能安全保存，原有配置未覆盖');
  }
}

/** 状态目录。 */
export function stateDir() {
  return join(promateHome(), 'state');
}

/** session_id 可能含路径分隔符，落盘前统一清洗。 */
function safeSessionId(sessionId) {
  const raw = String(sessionId);
  const safe = raw.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  return safe === raw ? safe : `${safe}-${createHash('sha256').update(raw).digest('hex')}`;
}

export function statePath(sessionId) {
  return join(stateDir(), `${safeSessionId(sessionId)}.json`);
}

/**
 * 用户消息代次单独追加，不争用状态锁，也不被 mark 的旧状态快照覆盖。
 * 只保存随机 ID（无消息正文/Key），不是待处理队列。追加顺序就是代次顺序，
 * 不能用「先读再覆盖」的单个标记文件，否则并发旧消息会覆盖较新的撤销。
 */
export function recordUserMessage(sessionId) {
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  const id = randomUUID();
  appendFileSync(`${statePath(sessionId)}.messages`, `${id}\n`, { encoding: 'utf8', mode: 0o600 });
  return id;
}

/** 缺文件表示尚无用户消息；损坏/不可读必须抛错，不能当成初始代次。 */
export function readUserMessageHead(sessionId) {
  let text;
  try { text = readFileSync(`${statePath(sessionId)}.messages`, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return { current: null, previous: null };
    throw error;
  }
  const ids = text.split('\n');
  if (ids.pop() !== '' || !ids.length || ids.some((id) => !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id))) {
    throw new Error('用户消息代次损坏，不能复用确认');
  }
  return { current: ids.at(-1), previous: ids.at(-2) ?? null };
}

/** 读状态：没有、解析失败都返回 null，调用方按「没有状态」处理。 */
export function readState(sessionId) {
  if (!sessionId) return null;
  try {
    const parsed = JSON.parse(readFileSync(statePath(sessionId), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 写状态：先写临时文件再 rename，避免读到半截 JSON。 */
export function writeState(sessionId, state) {
  if (!sessionId) return;
  const file = statePath(sessionId);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, JSON.stringify(state) + '\n', { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, file);
}

/** 在已有状态上合并字段；没有状态文件时也写一份。 */
export function updateState(sessionId, patch) {
  if (!sessionId) return;
  withSessionState(sessionId, (state) => writeState(sessionId, { ...state, ...patch }));
}

/** 从 stdin 读一个 JSON 对象；读不到或解析失败返回 null。 */
export function readStdinJson() {
  try {
    const raw = readFileSync(0, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (error) {
    log('读取 hook 输入失败');
    return null;
  }
}

/** 把值里的对象 key 递归排序，保证同一份 tool_input 换个书写顺序也得到同一个哈希。 */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const sorted = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      sorted[key] = canonicalize(value[key]);
    }
    return sorted;
  }
  return value;
}

/** tool_input 的 sha256：key 递归排序 → JSON.stringify → sha256（用于「参数一模一样」判定）。 */
export function argsHash(toolInput) {
  const input = toolInput && typeof toolInput === 'object' && !Array.isArray(toolInput) ? toolInput : {};
  return createHash('sha256').update(JSON.stringify(canonicalize(input))).digest('hex');
}

/** 用户整条消息是不是「确认」或「确定」：去掉首尾空白和结尾标点后精确比较。 */
export function isConfirmWord(prompt) {
  if (typeof prompt !== 'string') return false;
  const normalized = prompt.trim().replace(/[。！!]+$/u, '').trim();
  return normalized === '确认' || normalized === '确定';
}

/** 待确认记录是否已过期；createdAt 缺失或不是数字也按过期处理。 */
export function isPendingExpired(pending, now = Date.now()) {
  const createdAt = pending && typeof pending.createdAt === 'number' ? pending.createdAt : NaN;
  if (!Number.isFinite(createdAt) || createdAt > now) return true;
  return now - createdAt > PENDING_CONFIRM_TTL_MS;
}

/** 同一会话的确认读改写互斥；锁异常时由写操作 fail closed，不回收未知活动锁。 */
export function withSessionState(sessionId, action) {
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  const lock = `${statePath(sessionId)}.lock`;
  mkdirSync(lock, { mode: 0o700 });
  try { return action(readState(sessionId) || {}); }
  finally { rmdirSync(lock); }
}

/** SessionStart 时清掉超过 24 小时的状态文件；出错只记日志。 */
export function cleanupStateFiles() {
  const dir = stateDir();
  if (!existsSync(dir)) return;
  const deadline = Date.now() - STATE_MAX_AGE_MS;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json') && !name.endsWith('.json.messages')) continue;
    const file = join(dir, name);
    try {
      if (statSync(file).mtimeMs < deadline) unlinkSync(file);
    } catch (error) {
      log(`清理过期状态失败（忽略）：${file}：${error.message}`);
    }
  }
}

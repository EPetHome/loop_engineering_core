// Program requests only: no package bytes or credentials are returned to the model.
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { argsHash, readConfig, redact, requestKey, resolveUrl } from '../hooks/lib.mjs';

export const CAPABILITY = 'mcp-tools-v2';
export const UPLOAD_LIMIT = 10 * 1024 * 1024;
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function profilePath() {
  return resolve(process.env.CODEBUDDY_CONFIG_DIR?.trim() || process.env.WORKBUDDY_CONFIG_DIR?.trim() || join(homedir(), '.workbuddy'));
}
export function skillsPath() { return resolve(process.env.PROMATE_SKILLS_DIR || join(profilePath(), 'skills')); }
export function context(config = readConfig(true)) {
  const url = resolveUrl(config), key = requestKey(config), profile = profilePath();
  return { url, key, profile, credential: argsHash({ url, key, profile }) };
}
export function stillCurrent(ctx) {
  try { return context().credential === ctx.credential; } catch { return false; }
}
export function headers(ctx) {
  return { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${ctx.key}`, 'X-Promate-Capabilities': CAPABILITY };
}
export async function jsonRequest(ctx, url, body, { method = 'POST', limit = 2 * 1024 * 1024, timeout = 120000 } = {}) {
  if (!ctx.key) throw Error('尚未配置 Promate Key');
  if (!stillCurrent(ctx)) throw Error('平台或 Key 已变化，本次操作停止；请重新发起');
  let response;
  try { response = await fetch(url, { method, headers: headers(ctx), body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(timeout) }); }
  catch { throw Error('连不上 Promate 或请求超时，结果未确认'); }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    const error = Error([404,405].includes(response.status) ? '平台尚未升级：缺少 MCP 程序接口' : `Promate 拒绝或暂不可用（HTTP ${response.status}）`);
    error.status = response.status; throw error;
  }
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw Error('平台响应超出大小限制，未返回大文件内容');
    chunks.push(chunk);
  }
  let text = Buffer.concat(chunks).toString('utf8');
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    text = text.split(/\r?\n/).filter(x => x.startsWith('data:')).map(x => x.slice(5).trim()).find(x => x && x !== '[DONE]') || '';
  }
  try { return JSON.parse(text); } catch { throw Error('平台响应格式无效'); }
}
export async function requireModern(ctx,options={}) {
  // No cached answer: probe this request's exact platform/profile/credential before legacy side effects.
  const reply=await jsonRequest(ctx,ctx.url,{jsonrpc:'2.0',id:'promate-program-check',method:'initialize',params:{}},{timeout:5000,...options});
  if(reply.error&&reply.error.code!==-32601)throw Error(redact(reply.error.message||'平台初始化失败，能力未确认',ctx.key));
  if(reply.error?.code===-32601||reply.result?.capabilities?.promate?.toolset!==CAPABILITY||reply.result.capabilities.promate.programApi!==1)throw Error('平台尚未升级：缺少本批 MCP 工具和程序接口，未执行操作');
}
export async function rpc(ctx, name, args = {}, options) {
  if(name==='get_skill')await requireModern(ctx,options);
  const reply = await jsonRequest(ctx, ctx.url, { jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name, arguments: args } }, options);
  if (reply.error || reply.result?.isError) throw Error(redact(reply.error?.message || reply.result?.errorMessage || reply.result?.content?.[0]?.text || '平台拒绝操作', ctx.key));
  if (!reply.result) throw Error('平台 MCP 返回缺失');
  const data = reply.result.structuredContent ?? JSON.parse(reply.result.content?.[0]?.text || '{}');
  if (containsPackage(data)) throw Error('平台尚未升级：工具返回了安装包，已阻止进入对话');
  return data;
}
export async function program(ctx, path, body, options) {
  const reply = await jsonRequest(ctx, `${ctx.url}/resources/${path}`, body, options);
  if (reply.success !== true || reply.code !== 'OK') throw Error(redact(reply.message || '平台拒绝程序请求', ctx.key));
  return reply.data;
}
export function containsPackage(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([k,v]) => /^(contentBase64|fileContentBase64|packageBase64)$/i.test(k) || containsPackage(v));
}
export function toolResult(data, isError = false) {
  return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data) }],
    ...(typeof data === 'object' && data !== null ? { structuredContent: data } : {}), isError };
}
export function readUpload(filePath) {
  if (typeof filePath !== 'string' || !isAbsolute(filePath)) throw Error('filePath 必须是本机绝对文件路径');
  const extension = extname(filePath).toLowerCase();
  if (!['.md','.zip'].includes(extension)) throw Error('文件格式不对，仅支持 .md 或 .zip');
  let fd;
  try {
    fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1) throw Error('必须是普通文件，拒绝符号链接或硬链接');
    if (before.size <= 0 || before.size > UPLOAD_LIMIT) throw Error('文件为空或超过 10MB');
    const bytes = readFileSync(fd), after = fstatSync(fd);
    if (bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || bytes.length > UPLOAD_LIMIT) throw Error('读取时文件发生变化，请重新确认');
    if (extension === '.zip' && (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50)) throw Error('文件不是有效的 zip');
    return { bytes, fileName: basename(filePath), path: realpathSync(filePath), size: bytes.length, sha256: sha256(bytes) };
  } catch (error) {
    if (error.code === 'ENOENT') throw Error('本机文件不存在');
    throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}

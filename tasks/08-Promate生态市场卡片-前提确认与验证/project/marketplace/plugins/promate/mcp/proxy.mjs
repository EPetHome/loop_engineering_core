#!/usr/bin/env node
// Promate 插件本地 MCP 代理：把 WorkBuddy 发来的 JSON-RPC 消息逐行转发给平台 /api/mcp。
//
// 设计约束（见「提示词-插件第二步」6.7）：
// - 只用 Node 自带模块，不装任何依赖；stdout 只写 JSON-RPC 消息，日志一律写 stderr。
// - 每次请求重新读配置（PROMATE_HOME / PROMATE_CONFIG 可隔离）；本机私密页保存后无需重启代理。
// - 没配 Key、Key 失效（401）、连不上平台时，用 mcp/tools.json 的本地副本完成握手和
//   工具列表，真正调用工具时回一个 isError 的正常结果提示用户，而不是抛 JSON-RPC 错误。
// - 本地副本只在上面三种情况下使用；有 Key 时一律以平台为准。平台改了工具定义，
//   要同步更新 mcp/tools.json（见插件 README）。

import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { configPath, readConfig, redact, requestKey, resolveUrl } from '../hooks/lib.mjs';
import { CONFIG_TOOL } from './local-config.mjs';
import { getRecoveryPage } from './recovery-page.mjs';
import { noteProxyStarted } from './first-connect.mjs';
import { CAPABILITY, context, containsPackage, headers, readUpload, requireModern, stillCurrent, toolResult } from './client.mjs';
import { consumeApproval, WRITE_NAMES } from './approval.mjs';
import { annotateSkills, LOCAL_NAMES, resourceTool } from './resources.mjs';
import { uploadSnapshot, UPLOAD_TOOLS, writebackSnapshot } from './snapshots.mjs';

// 工具调用可能要等平台读写数据库，给足超时；超时按「连不上」处理。
const REQUEST_TIMEOUT_MS = 120_000;
const NO_KEY_MESSAGE = '尚未配置 Promate Key：请在 WorkBuddy 请求「Promate 配置 Key」，用插件的 configure_key 无参数工具打开本机私密配置页。勿在聊天或工具参数里发送 Key；保存后再查 my_projects 验证身份。';
const INVALID_KEY_MESSAGE = 'Promate 身份验证未通过（401）：当前保存的 Key 可能已被重置、撤销或失效，也可能是账号状态不允许访问；不能断言 Key 过期，不要为排查而自动重新生成。保存 Key 不等于身份验证成功。';

function log(message) {
  process.stderr.write(`[promate-proxy] ${message}\n`);
}

// 平台 tools/list 和 initialize 的本地副本；缺失时退化成最小可用的握手。
function loadLocalTools() {
  const file = join(dirname(fileURLToPath(import.meta.url)), 'tools.json');
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed && Array.isArray(parsed.tools)) return parsed;
    log(`本地工具定义格式不对，按空列表处理：${file}`);
  } catch (error) {
    log(`读取本地工具定义失败，按空列表处理：${file}：${error.message}`);
  }
  return {
    protocolVersion: '2024-11-05',
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: 'promate-mcp', version: '0.0.0' },
    instructions: '',
    tools: [],
  };
}

const LOCAL = loadLocalTools();

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

// 通知（没有 id）不回复；只有带 id 的请求才写错误响应。
function sendError(id, code, message) {
  if (id === undefined) return;
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

/** 本地回应的工具调用文案，按「没配 Key / Key 失效 / 连不上」区分。 */
function localToolCallMessage(reason, url) {
  if (reason === 'unauthorized') return INVALID_KEY_MESSAGE;
  if (reason === 'offline') return '连不上 Promate 或请求超时，结果未确认；写操作不要直接重试，请先查询状态。';
  if (reason === 'config') return '平台地址或凭据来源配置无效；旧 Key 不会跨来源发送，请从 Promate 网页复制公开地址，在 WorkBuddy 单独发送「Promate 平台地址：<公开 MCP 地址>」。';
  return NO_KEY_MESSAGE;
}

/** 不连平台也能完成的本地回应：握手、工具列表、工具调用的 isError 结果。 */
function respondLocal(request, id, reason, url) {
  if (id === undefined) return;
  const method = typeof request.method === 'string' ? request.method : '';
  let result = {};
  if (method === 'initialize') {
    result = {
      protocolVersion: LOCAL.protocolVersion || '2024-11-05',
      capabilities: LOCAL.capabilities || { tools: { listChanged: false } },
      serverInfo: LOCAL.serverInfo || { name: 'promate-mcp', version: '0.0.0' },
      instructions: `【本地目录降级：平台连接未验证】${localToolCallMessage(reason, url)}\n${LOCAL.instructions || ''}`,
    };
  } else if (method === 'tools/list') {
    result = { tools: [...LOCAL.tools, ...(LOCAL.localTools || []), CONFIG_TOOL] };
  } else if (method === 'tools/call') {
    result = {
      content: [{ type: 'text', text: localToolCallMessage(reason, url) }],
      isError: true,
    };
  }
  send({ jsonrpc: '2.0', id, result });
}

let activePage;
let pageCreation;
let configGeneration = 0;
let shuttingDown = false;
// Local-only generation: an atomic rewrite with identical Key/URL is still a newer credential.
// Neither the Key nor this file identity is sent to tools, the model or logs.
function configRevision() {
  try {
    const stat = statSync(configPath(), { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.size}`;
  } catch { return null; }
}
function sameCredentials(url, key, revision) {
  try {
    if (configRevision() !== revision) return false;
    const config = readConfig(true);
    return configRevision() === revision && resolveUrl(config) === url && requestKey(config) === key;
  } catch { return false; }
}
async function ensureConfigPage(url, stillNeeded = () => true) {
  const checkCurrent = () => {
    try {
      if (!shuttingDown && stillNeeded() && resolveUrl(readConfig(true)) === url) return;
    } catch { /* malformed or replaced source cannot authorize this caller */ }
    throw Error('CONFIG_REQUEST_SUPERSEDED');
  };
  checkCurrent();
  while (pageCreation) {
    const waitingFor = pageCreation;
    let pending;
    try { pending = await waitingFor; }
    catch { /* a failed page may be rebuilt only if this caller is still current */ }
    checkCurrent(); // outside catch: never close someone else's page for a stale 401
    if (pending?.platform === url && pending.isAvailable() && await pending.probe()) {
      checkCurrent(); return pending;
    }
    if (pageCreation === waitingFor) break; // another generation exists: wait for it instead of replacing it
  }
  checkCurrent(); // before reading/closing activePage or incrementing the shared generation
  if (activePage?.platform === url && activePage.isAvailable() && await activePage.probe()) {
    checkCurrent(); return activePage;
  }
  checkCurrent();
  const generation = ++configGeneration;
  activePage = undefined; // never close a detached page already delivered to another conversation
  const creation = (async () => {
    const created = await getRecoveryPage(url);
    if (generation !== configGeneration || shuttingDown || !stillNeeded()
      || created.platform !== url || !created.isAvailable() || !await created.probe()) {
      // Its independently owned record remains bounded; a future proxy can validate and reuse it.
      throw Error('CONFIG_PAGE_SUPERSEDED');
    }
    activePage = created;
    return created;
  })();
  pageCreation = creation;
  try { return await creation; }
  finally { if (pageCreation === creation) pageCreation = undefined; }
}
function unauthorizedResult(request, id, message, local) {
  if (id === undefined) return;
  if (request.method === 'tools/call') {
    send({ jsonrpc: '2.0', id, result: { ...local, content: [{ type: 'text', text: message }, ...(local?.content || [])], isError: true } });
  } else respondLocal(request, id, 'unauthorized');
}
async function handleLocalConfig(request, id) {
  if (request?.method !== 'tools/call' || request.params?.name !== CONFIG_TOOL.name) return false;
  if (id === undefined) return true;
  const args = request.params?.arguments;
  if (args !== undefined && (args === null || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length)) {
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: '配置 Key 工具不接收任何参数；请勿把 Key 放进工具调用或聊天。' }], isError: true } });
    return true;
  }
  try {
    const url = resolveUrl(readConfig(true));
    const created = await ensureConfigPage(url);
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `请在 WorkBuddy 打开[配置 Key](${created.url})本机页面。仅在页面里粘贴 Key；链接最多五分钟有效，失败可在页内重试，切勿在聊天输入 Key。页面保存后自动显示连接结果。` }] } });
  } catch {
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: '尚不能打开配置 Key 页面：请先在 WorkBuddy 保存正确的 Promate 平台地址，再重试。' }], isError: true } });
  }
  return true;
}

function localResult(data,ctx) {
  // Local metadata uses the same credential redaction as forwarded tool replies.
  return toolResult(JSON.parse(redact(JSON.stringify(data),ctx.key)));
}
function modelTool(tool) {
  if (!UPLOAD_TOOLS.has(tool.name)) return tool;
  const schema = { ...tool.inputSchema, properties: { ...tool.inputSchema.properties } };
  delete schema.properties.fileName; delete schema.properties.contentBase64;
  schema.properties.filePath = LOCAL.tools.find(item => item.name === tool.name)?.inputSchema.properties.filePath
    || { type: 'string', description: '本机 .md 或 .zip 的绝对路径，≤10MB' };
  schema.required = [...new Set([...(schema.required || []).filter(key => !['fileName','contentBase64'].includes(key)), 'filePath'])];
  return { ...tool, inputSchema: schema };
}
function withConfigTool(message) {
  if (message?.result && Array.isArray(message.result.tools)) {
    const tools = message.result.tools.filter(item => !['invoke_skill','set_stage',CONFIG_TOOL.name,...LOCAL_NAMES].includes(item.name)).map(modelTool);
    const upgraded = LOCAL.tools.every(item => tools.some(remote => remote.name === item.name));
    return { ...message, result: { ...message.result, tools: [...tools, ...(LOCAL.localTools || []), CONFIG_TOOL],
      ...(!upgraded ? { _meta: { promate: { platformUpgraded:false, message:'平台尚未升级：缺少本批 MCP 工具；不要用旧 get_skill 安装' } } } : {}) } };
  }
  return message;
}
function outgoing(request, message, ctx) {
  if(request.method==='initialize' && message.result && message.result.capabilities?.promate?.toolset!==CAPABILITY) {
    return {...message,result:{...message.result,instructions:`平台尚未升级：新插件所需工具／程序接口缺失，不要用旧 get_skill 安装。\n${LOCAL.instructions}`}};
  }
  if(request.method==='tools/list') return withConfigTool(message);
  if(request.method==='tools/call') {
    const legacyTextPackage=(message.result?.content||[]).some(block=>{
      if(block.type!=='text')return false;
      try{return containsPackage(JSON.parse(block.text));}catch{return false;}
    });
    if(containsPackage(message.result) || legacyTextPackage)
      return {jsonrpc:'2.0',id:request.id,result:toolResult('平台尚未升级：工具返回了安装包，已阻止进入对话；安装请用 install_resource',true)};
    if(message.error?.code===-32601 || ['MCP_TOOL_NOT_FOUND','TOOL_NOT_FOUND'].includes(message.result?.errorCode))
      return {jsonrpc:'2.0',id:request.id,result:toolResult('平台尚未升级或工具已下线：缺少所请求工具；未报告操作成功',true)};
    if(request.params?.name==='list_skills' && message.result && !message.result.isError) {
      let original=message.result.structuredContent;
      if(!original){try{original=JSON.parse(message.result.content?.[0]?.text||'');}catch{return message;}}
      const data=annotateSkills(original,ctx);
      return {...message,result:{...message.result,structuredContent:data,content:[{type:'text',text:JSON.stringify(data)},...(message.result.content || []).slice(1)]}};
    }
  }
  return message;
}

function ssePayloads(body) {
  const payloads = [];
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice('data:'.length).trim();
    if (payload && payload !== '[DONE]') payloads.push(payload);
  }
  return payloads;
}

async function handleLine(line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch (error) {
    log('忽略无法解析的消息');
    return;
  }
  const id = request && typeof request === 'object' && request.id !== undefined && request.id !== null
    ? request.id : undefined;
  if (request.method === 'notifications/initialized') {
    try {
      const root = join(dirname(fileURLToPath(import.meta.url)), '..');
      const { version } = JSON.parse(readFileSync(join(root, '.codebuddy-plugin/plugin.json'), 'utf8'));
      noteProxyStarted(root, version);
    } catch { /* proxy readiness not provable; business tools continue normally */ }
    return;
  }
  if (await handleLocalConfig(request, id)) return;
  let key;
  let url;
  let revision;
  try {
    const before = configRevision();
    const config = readConfig(true);
    url = resolveUrl(config);
    key = requestKey(config);
    revision = configRevision();
    if (before !== revision) throw Error('CONFIG_CHANGED');
  } catch {
    respondLocal(request, id, 'config');
    return;
  }
  const ctx = context({ url, key });
  if (request.method === 'tools/call' && request.params?.name === 'invoke_skill') {
    if (id !== undefined) send({jsonrpc:'2.0',id,result:toolResult('工具不存在：invoke_skill 已下线；技能加载由 Skill 钩子如实上报',true)});
    return;
  }
  let response,installedResult;
  if (request.method === 'tools/call' && request.params?.name === 'my_installed') {
    try {
      installedResult=await resourceTool('my_installed',request.params.arguments || {},ctx);
      if(installedResult.unauthorized)response={status:401};
      else {if(id!==undefined)send({jsonrpc:'2.0',id,result:localResult(installedResult,ctx)});return;}
    }catch(error){if(id!==undefined)send({jsonrpc:'2.0',id,result:toolResult(redact(error.message,key),true)});return;}
  }
  if (!key) {
    log('未配置 Key，用本地目录回应（不代表平台连接成功）');
    respondLocal(request, id, 'no-key', url);
    return;
  }

  let bodyLine = line;
  if (request.method === 'tools/call'&&!response) {
    const name=request.params?.name, input=request.params?.arguments || {};
    try {
      if(LOCAL_NAMES.has(name)) {
        const data=await resourceTool(name,input,ctx);
        if(id!==undefined)send({jsonrpc:'2.0',id,result:localResult(data,ctx)});
        return;
      }
      if(name==='get_skill'){
        await requireModern(ctx);
        if(!stillCurrent(ctx)||!sameCredentials(url,key,revision))throw Error('平台或 Key 已变化，预览未执行；请重新发起');
      }
      if(UPLOAD_TOOLS.has(name)) {
        await requireModern(ctx);
        if(containsPackage(input) || Object.hasOwn(input,'fileName'))throw Error('插件上传只接受 filePath，不接受模型提供的文件内容或 fileName');
        const file=readUpload(input.filePath); // read once; these exact bytes are checked and sent
        consumeApproval(name,input,ctx,uploadSnapshot(file));
        const args={...input,fileName:file.fileName,contentBase64:file.bytes.toString('base64')};delete args.filePath;
        bodyLine=JSON.stringify({...request,params:{...request.params,arguments:args}});
      } else if(name==='retry_writeback') {
        const snapshot=await writebackSnapshot(input,ctx);consumeApproval(name,input,ctx,snapshot);
      } else if(WRITE_NAMES.has(name))consumeApproval(name,input,ctx,{});
      if(WRITE_NAMES.has(name)&&(!stillCurrent(ctx)||!sameCredentials(url,key,revision)))throw Error('平台／profile 或 Key 已变化，旧确认失效；请重新发起并确认');
    } catch(error) {
      if(error.status===401)response={status:401};
      else {if(id!==undefined)send({jsonrpc:'2.0',id,result:toolResult(redact(error.message,key),true)});return;}
    }
  }
  try {
    if (!response) response = await fetch(url, {
      method: 'POST',
      headers: headers(ctx),
      body: bodyLine,
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    log('请求失败，结果未确认；不自动重试');
    respondLocal(request, id, 'offline', url);
    return;
  }

  if (response.status === 401) {
    const deny=message=>unauthorizedResult(request,id,message,installedResult?localResult(installedResult,ctx):undefined);
    void response.body?.cancel().catch(() => {}); // do not log upstream body or retain an unread 401 stream
    log('平台返回 401；本次请求未自动重试');
    if (id === undefined) return;
    if (!sameCredentials(url, key, revision)) {
      deny('本次请求使用的旧配置收到 Promate 401；本地凭据已变化，不会重放刚才的操作。请按当前配置重新发起。');
      return;
    }
    let page;
    try { page = await ensureConfigPage(url, () => sameCredentials(url, key, revision)); }
    catch (error) {
      if (error.message === 'CONFIG_REQUEST_SUPERSEDED' || !sameCredentials(url, key, revision)) {
        deny('本次 Promate 401 的配置入口请求已过时或会话已关闭；不会替换现有页面或重放刚才的操作。');
      } else {
        deny(`${INVALID_KEY_MESSAGE}\n本机私密配置页暂无法启动，未生成链接；稍后重试或明确请求「Promate 配置 Key」。写操作不会自动重放。`);
      }
      return;
    }
    if (!sameCredentials(url, key, revision) || !page.isAvailable()) {
      deny('本次请求使用的旧配置收到 Promate 401；本地配置或页面已变化，不会重放刚才的操作。');
      return;
    }
    deny(`${INVALID_KEY_MESSAGE}\n请打开[配置 Key](${page.url})在本机页面更新凭据，无需重新安装插件。配置成功后回到这里继续；刚才的操作不会自动重放。`);
    return;
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    log(`平台返回 HTTP ${response.status}`);
    sendError(id, -32603, response.status === 403 ? 'Promate 拒绝访问（403）：当前账号无权限或会话需修改密码'
      : response.status === 503 ? 'Promate 身份验证或服务暂不可用（503）：不能断言 Key 无效或过期；结果未确认，请稍后重试只读查询'
        : `Promate 服务异常（HTTP ${response.status}），结果未确认；写操作请先查询状态，不直接重试`);
    return;
  }

  const contentType = response.headers.get('content-type') || '';
  const chunks=[];let size=0;
  for await(const chunk of response.body || []){
    size+=chunk.length;
    if(size>2*1024*1024){sendError(id,-32603,'Promate 工具响应超过 2MB（平台可能尚未升级或响应异常），已阻止大文件进入对话；结果未确认，请查询状态，不直接重放写操作');return;}
    chunks.push(chunk);
  }
  const body = redact(Buffer.concat(chunks).toString('utf8'), key);
  if (id === undefined) return; // 通知：平台照常处理，但不往 stdout 写任何东西
  if (!body.trim()) {
    log('平台返回了空响应');
    sendError(id, -32603, 'Promate 返回了空响应');
    return;
  }
  if (contentType.includes('text/event-stream')) {
    for (const payload of ssePayloads(body)) {
      try { send(outgoing(request,JSON.parse(payload),ctx)); }
      catch { sendError(id, -32603, 'Promate 返回了无法解析的响应'); }
    }
    return;
  }
  try {
    const result = JSON.parse(body);
    send(outgoing(request,result,ctx));
  } catch (error) {
    log('平台返回了非 JSON 响应，未输出响应原文');
    sendError(id, -32603, 'Promate 返回了无法解析的响应');
  }
}

const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
reader.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  handleLine(trimmed).catch(() => {
    log('处理响应失败，结果未知');
    try { sendError(JSON.parse(trimmed)?.id, -32603, 'Promate 响应中断，结果未确认；写操作请先查询状态，不直接重试'); }
    catch { /* 无法解析的消息无可回复 ID */ }
  });
});
// stdin 关闭时代理退出；已交付的短期配置页由独立进程持有，不随代理关闭。
reader.on('close', () => {
  shuttingDown = true;
  configGeneration++;
  activePage = undefined;
});

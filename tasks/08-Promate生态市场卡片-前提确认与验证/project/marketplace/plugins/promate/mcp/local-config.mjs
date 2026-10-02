// 插件私有配置页：只有 loopback 的浏览器 POST 能提交 Key；不经 MCP 参数或聊天。
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { readConfig, requestKey, resolveUrl, writeConfigKey } from '../hooks/lib.mjs';

export const CONFIG_TOOL = {
  name: 'configure_key',
  description: '打开 Promate 插件本机「配置 Key」页面。无需参数，不要在聊天或工具参数中提供 Key；页面保存后自动检查只读身份并显示连接结果。',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};
const TTL_MS = 5 * 60 * 1000;
const MAX_BODY = 512;
const CHECK_TIMEOUT_MS = 5000;
const CHECK_MAX_BYTES = 64 * 1024;

// 页面直接用新保存的凭据作一次只读身份检查；不通过模型/工具参数，也不输出上游响应或 Key。
async function checkConnection(address, key, signal = AbortSignal.timeout(CHECK_TIMEOUT_MS)) {
  try {
    const res = await fetch(address, {
      method: 'POST', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'promate-connect-check', method: 'tools/call',
        params: { name: 'my_projects', arguments: {} } }),
    });
    if (res.status === 401) return { kind: 'unauthorized', detail: '身份验证被拒绝（401）' };
    if (!res.ok) return { kind: 'unavailable', detail: `平台未能完成连接检查（HTTP ${res.status}）` };
    if (Number(res.headers.get('content-length')) > CHECK_MAX_BYTES)
      return { kind: 'unavailable', detail: '连接检查响应过大' };
    if (!res.body) return { kind: 'unavailable', detail: '连接检查结果未确认' };
    const parts = []; let size = 0;
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > CHECK_MAX_BYTES) {
        return { kind: 'unavailable', detail: '连接检查响应过大' };
      }
      parts.push(chunk);
    }
    const payload = JSON.parse(Buffer.concat(parts).toString('utf8'));
    if (payload?.id !== 'promate-connect-check' || payload?.error || !payload?.result
        || payload.result.isError === true || !Array.isArray(payload.result.content)) {
      return { kind: 'unavailable', detail: '连接检查结果未确认' };
    }
    return { kind: 'connected' }; // An empty project list is still authenticated.
  } catch {
    return { kind: 'unavailable', detail: '平台暂不可达或响应无效' };
  }
}
const token = () => randomBytes(32).toString('hex');
const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const same = (a, b) => typeof a === 'string' && typeof b === 'string'
  && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
function page(address, nonce, hasKey, notice = '') {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="referrer" content="same-origin"><title>Promate · 配置 Key</title></head><body>
<main><h1>配置 Key</h1><p>目标平台：<strong>${escapeHtml(address)}</strong></p><p>仅在此本机页面粘贴，勿在 WorkBuddy 聊天发送 Key。保存后本页自动检查连接并显示结果。</p>
<p role="status">${escapeHtml(notice || (hasKey ? '已保留原有 Key，可直接检查连接或更换。' : '尚未配置 Key，请输入个人 Key。'))}</p>
${hasKey ? `<p>已保留原有 Key，无需重复输入。可先检查连接；不会重新生成或清除 Key。</p><form method="post"><input type="hidden" name="nonce" value="${nonce}"><button type="submit" name="action" value="check">使用原有 Key 检查连接</button></form>` : ''}
<form method="post" autocomplete="off"><input type="hidden" name="nonce" value="${nonce}"><label for="key">${hasKey ? '更换 Key（可选）' : '个人 Key'}</label><input id="key" name="key" type="password" autocomplete="off" spellcheck="false" required maxlength="131"><button type="submit" name="action" value="save">保存 Key</button></form>
<form method="post"><input type="hidden" name="nonce" value="${nonce}"><button type="submit" name="action" value="cancel">取消</button></form></main></body></html>`;
}
function completedPage(text) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Promate · 配置 Key</title></head><body><main><h1>配置 Key</h1><p role="status">${escapeHtml(text)}</p></main></body></html>`;
}
function response(res, status, content, html = false) {
  res.writeHead(status, {
    'Content-Type': html ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0', Pragma: 'no-cache',
    'Referrer-Policy': 'same-origin', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  });
  res.end(content);
}

/** 每次只开放一个短期配置页；clock/ttlMs 仅供隔离测试可控过期。 */
export async function startConfigPage({ now = Date.now, ttlMs = TTL_MS, keepAlive = false,
  isCurrent = () => true, onDone = () => {}, requestedUrl, ownerTag,
  withSubmission = action => action() } = {}) {
  const config = readConfig(true);
  if (!config.url) throw new Error('请先在 WorkBuddy 保存 Promate 平台地址');
  const expectedUrl = resolveUrl(config);
  if (requestedUrl !== undefined && requestedUrl !== expectedUrl) throw Error('HANDOFF_SOURCE_CHANGED');
  const id = token();
  let nonce = token();
  const expires = now() + ttlMs;
  let finished = false, processing = false;
  const inFlight = new AbortController();
  const hasUsableKey = () => {
    try { return Boolean(requestKey(readConfig(true))); } catch { return false; }
  };
  const sourceStillBound = () => {
    try {
      const current = readConfig(true);
      return !!current.url && resolveUrl(current) === expectedUrl;
    } catch { return false; }
  };
  let port;
  const path = `/configure/${id}`;
  const server = createServer(async (req, res) => {
    const origin = `http://127.0.0.1:${port}`;
    // 完全一致的 Host/Origin；禁止 DNS rebinding、跨站表单和跨站脚本读页面。
    if (req.headers.host !== `127.0.0.1:${port}` || (req.headers.origin && req.headers.origin !== origin)
        || (req.headers['sec-fetch-site'] && !['none', 'same-origin'].includes(req.headers['sec-fetch-site']))) {
      response(res, 403, '拒绝非本机同源请求'); return;
    }
    if (req.url !== path || !['GET', 'POST'].includes(req.method)) {
      response(res, 404, '页面不存在'); return;
    }
    const expired = () => finished || now() >= expires || !isCurrent() || !sourceStillBound();
    const rejectExpired = () => {
      finished = true;
      if (keepAlive) {
        const reason = now() >= expires
          ? processing ? 'PRIVATE_PAGE_INCOMPLETE' : 'PRIVATE_PAGE_EXPIRED' : 'PRIVATE_PAGE_FAILED';
        res.once('finish', () => close(reason));
      }
      response(res, 410, '此配置页已失效，请从 WorkBuddy 重新接入');
    };
    if (expired()) { rejectExpired(); return; }
    if (req.method === 'GET') {
      if (ownerTag) res.setHeader('X-Promate-Page-Owner', ownerTag);
      response(res, 200, page(expectedUrl, nonce, hasUsableKey(),
        processing ? '正在检查连接；如需取消，可在本页取消本次配置。' : ''), true);
      return;
    }
    if (req.headers.origin !== origin) { response(res, 403, '缺少同源证明'); return; }
    if (!/^application\/x-www-form-urlencoded(?:;|$)/i.test(req.headers['content-type'] || '')) {
      response(res, 415, '提交格式不支持'); return;
    }
    if (Number(req.headers['content-length']) > MAX_BODY) {
      response(res, 413, '提交内容过长'); req.resume(); return;
    }
    let raw = '';
    try {
      for await (const chunk of req) {
        raw += chunk.toString('utf8');
        if (Buffer.byteLength(raw) > MAX_BODY) throw new Error('提交内容过长');
      }
    } catch { response(res, 413, '提交内容过长'); return; }
    if (expired()) { rejectExpired(); return; }
    const values = new URLSearchParams(raw);
    const fields = [...values.keys()];
    const action = values.get('action');
    if (fields.length !== new Set(fields).size || !['save', 'cancel', 'check'].includes(action)
        || fields.some(field => !['nonce', 'key', 'action'].includes(field))
        || (action !== 'save' && values.has('key')) || (action === 'save' && !values.has('key'))) {
      response(res, 400, '配置请求无效'); return;
    }
    if (!same(values.get('nonce'), nonce)) { response(res, 409, '提交已失效，请使用本页最新表单'); return; }
    if (action === 'cancel') {
      nonce = token(); finished = true;
      if (keepAlive) clearTimeout(timer);
      inFlight.abort();
      if (keepAlive) {
        res.once('finish', () => close('PRIVATE_PAGE_CANCELLED'));
        res.once('close', () => close('PRIVATE_PAGE_CANCELLED'));
      }
      response(res, 200, processing ? '已取消检查；此前已开始的Key保存可能已写入，但不会将迟到检查记为成功'
        : '已取消，原有 Key 未变更');
      return;
    }
    if (processing) { response(res, 409, '检查正在进行，请等待结果或取消'); return; }
    // One valid action at a time. Rotate nonce before any async network work: stale POSTs cannot replay.
    processing = true; nonce = token();
    const retry = (status, notice) => response(res, status, page(expectedUrl, nonce, hasUsableKey(), notice), true);
    try {
      let key, saved = false;
      if (action === 'check') {
        key = withSubmission(() => {
          const current = readConfig(true);
          if (resolveUrl(current) !== expectedUrl) throw Error('SOURCE_CHANGED');
          return requestKey(current);
        });
        if (!key) { retry(400, '尚未配置 Key，请输入个人 Key。'); return; }
      } else {
        key = values.get('key');
        if (typeof key !== 'string' || !/^pk_[A-Za-z0-9]{16,128}$/.test(key)) {
          retry(400, 'Key 格式无效，未保存。请在本页纠正后重试。'); return;
        }
        withSubmission(() => writeConfigKey(key, expectedUrl));
        saved = true;
      }
      const checked = await checkConnection(expectedUrl, key,
        AbortSignal.any([AbortSignal.timeout(CHECK_TIMEOUT_MS), inFlight.signal]));
      if (expired()) { rejectExpired(); return; } // includes cancel, expiry, replacement and source change
      if (checked.kind === 'connected') {
        finished = true;
        if (keepAlive) {
          clearTimeout(timer);
          res.once('finish', () => close('PRIVATE_PAGE_CONNECTED'));
          res.once('close', () => close('PRIVATE_PAGE_INCOMPLETE'));
        }
        response(res, 200, completedPage(`${saved ? 'Key 已保存' : '原有 Key 已保留'}，身份连接成功；项目列表为空也属于连接成功。`), true);
        return;
      }
      const notice = checked.kind === 'unauthorized'
        ? saved ? 'Key 已保存；尚未完成身份配置：身份验证被拒绝（401），请更换 Key 或重试。'
          : '原有 Key 已保留；尚未完成身份配置，现有 Key 未通过验证（401），请输入或更换 Key。'
        : `${saved ? 'Key 已保存' : '原有 Key 已保留'}；${checked.detail}，身份连接尚未确认，可继续输入或重新检查。`;
      retry(200, notice);
    } catch {
      if (expired()) { rejectExpired(); return; }
      retry(409, action === 'save' ? 'Key 未能安全保存，原有配置未被覆盖；请在本页核对后重试。'
        : '原有 Key 未变更；暂不能安全检查，请在本页重试。');
    } finally { processing = false; }
  });
  // A detached hook process must not survive indefinitely due to a half-open browser socket.
  const sockets = new Set();
  if (keepAlive) server.on('connection', socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    port = server.address().port;
    if (!keepAlive) server.unref();
  } catch (error) {
    server.close();
    throw new Error('本机私密配置页无法启动');
  }
  let closed = false;
  const close = (reason = 'PRIVATE_PAGE_EXPIRED') => {
    const inProgress = processing;
    finished = true;
    inFlight.abort();
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    server.close();
    if (keepAlive) {
      if (reason === 'PRIVATE_PAGE_EXPIRED') for (const socket of sockets) socket.destroy();
      onDone(reason === 'PRIVATE_PAGE_EXPIRED' && inProgress ? 'PRIVATE_PAGE_INCOMPLETE' : reason);
    }
  };
  const timer = setTimeout(close, ttlMs);
  if (!keepAlive) timer.unref();
  return { url: `http://127.0.0.1:${port}${path}`, platform: expectedUrl, expiresAt: expires, close,
    isAvailable: () => !closed && !finished && now() < expires && isCurrent() && sourceStillBound() };
}

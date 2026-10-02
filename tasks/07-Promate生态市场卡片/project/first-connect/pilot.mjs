#!/usr/bin/env node
// Experimental first-connect pilot for the explicitly owned WorkBuddy 5.6.2 test target.
// No credential input, registry edits, extraction, private host imports, or model decisions.
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, lstatSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const APP = '/Applications/WorkBuddy.app/Contents';
const ID = 'promate@promate';
const BUNDLE_SHA = 'b340564b2410d99846397776a25fd99e11d86647a7c219ad06fedc441e364ddd';
const sha = b => createHash('sha256').update(b).digest('hex');
const steps = [];
let stage = 'target';
class Failure extends Error {
  constructor(code, detail) { super(detail); this.code = code; }
}
function check(value, code, detail) { if (!value) throw new Failure(code, detail); }
function publicUrl(raw, loopback = false) {
  const u = new URL(raw);
  check(['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash,
    'INVALID_PUBLIC_URL', 'Only public addresses without credentials/query/fragment are accepted');
  check(u.protocol === 'https:' || ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname),
    'INSECURE_DELIVERY', 'HTTP is permitted only on loopback');
  if (loopback) check(u.hostname === '127.0.0.1' && u.port, 'TARGET_NOT_LOOPBACK', 'Host target must be explicit IPv4 loopback');
  return u.href.replace(/\/$/, '');
}
async function bytes(url, max) {
  const r = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15000) });
  check(r.ok, 'DOWNLOAD_HTTP', `Download returned HTTP ${r.status}`);
  const chunks = []; let size = 0;
  for await (const chunk of r.body) {
    size += chunk.length;
    check(size <= max, 'DOWNLOAD_TOO_LARGE', 'Artifact exceeds fixed size limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function exactFile(path, parent) {
  const p = resolve(path);
  check(p.startsWith(realpathSync(parent) + sep) && realpathSync(p) === p && !lstatSync(p).isSymbolicLink(),
    'PATH_OUTSIDE_TARGET', 'Path is not a canonical target-owned file');
  return p;
}

try {
  const input = JSON.parse(process.argv[2] || '{}');
  check(Object.keys(input).sort().join(',') === 'host,marketplace,packageSha256,platform,root,target,version',
    'INVALID_INPUT', 'Expected only fixed public delivery data and test target identity');
  const { root, target, version, packageSha256 } = input;
  check(version === '0.2.7' && /^[a-f0-9]{64}$/.test(packageSha256), 'UNSUPPORTED_ARTIFACT', 'Expected pinned Promate 0.2.7');
  check(typeof root === 'string' && /^\/private\/tmp\/promate-first-[A-Za-z0-9_-]+$/.test(root)
    && realpathSync(root) === root && !lstatSync(root).isSymbolicLink(), 'TARGET_NOT_OWNED', 'Only an owned canonical test root is supported');
  check(readFileSync(join(root, '.owner'), 'utf8') === target, 'TARGET_ID_MISMATCH', 'Test target ownership mismatch');
  const host = publicUrl(input.host, true), marketplace = publicUrl(input.marketplace), platform = publicUrl(input.platform);
  check(platform.endsWith('/api/mcp'), 'INVALID_PLATFORM_PATH', 'Expected the public MCP address');
  const profile = join(root, 'profile');
  check(process.env.CODEBUDDY_CONFIG_DIR === profile && process.env.WORKBUDDY_CONFIG_DIR === profile
    && process.env.PROMATE_HOME === join(root, 'promate') && process.env.PROMATE_CONFIG === join(root, 'promate/config.json'),
    'PROFILE_MISMATCH', 'Inherited target paths are incomplete; no default personal profile fallback');
  check(/<key>CFBundleShortVersionString<\/key>\s*<string>5\.6\.2<\/string>/.test(readFileSync(join(APP, 'Info.plist'), 'utf8'))
    && sha(readFileSync(join(APP, 'Resources/app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs'))) === BUNDLE_SHA,
    'UNSUPPORTED_HOST', 'Unverified WorkBuddy build; refusing to guess installation APIs');

  // --serve creates its own local gateway password. Read ONLY this owned test profile;
  // it is not a Promate Key, never an input, model parameter, URL, result, or log value.
  const gateway = JSON.parse(readFileSync(exactFile(join(profile, 'settings.json'), profile), 'utf8')).gateway;
  check(gateway?.auth === 'password' && typeof gateway.password === 'string' && gateway.password.length >= 16,
    'HOST_AUTH_NOT_READY', 'Isolated host has not initialized its native local authentication');
  async function api(path, body) {
    const r = await fetch(host + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-codebuddy-request': '1', 'Content-Type': 'application/json', 'x-access-token': gateway.password },
      body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(40000) });
    const text = await r.text();
    let data; try { data = text ? JSON.parse(text) : null; } catch { throw new Failure('HOST_INVALID_RESPONSE', 'Host returned non-JSON response'); }
    steps.push({ stage, path, status: r.status });
    check(r.ok, 'HOST_ACTION_REJECTED', `Host rejected ${path}: HTTP ${r.status}`);
    return data && Object.hasOwn(data, 'data') ? data.data : data;
  }
  const identity = await api('/api/v1/envs');
  check(identity.PROMATE_FIRST_TARGET === target && identity.CODEBUDDY_CONFIG_DIR === profile
    && identity.WORKBUDDY_CONFIG_DIR === profile && identity.PROMATE_HOME === process.env.PROMATE_HOME
    && identity.PROMATE_CONFIG === process.env.PROMATE_CONFIG && identity.CLIENT_INFO_PRODUCT_VERSION === '2.147.0',
    'HOST_IDENTITY_MISMATCH', 'Host API does not belong to the expected isolated runtime');
  stage = 'state';
  const installed = await api('/api/v1/plugins');
  check(Array.isArray(installed), 'HOST_STATE_FORMAT', 'Installed plugins response is not a list');
  let plugin = installed.find(p => p.name === 'promate' && p.marketplace === 'promate');
  check(!plugin || plugin.version === version, 'VERSION_CONFLICT', 'Pilot does not silently upgrade or replace another version');
  const initial = plugin ? 'installed' : 'absent';
  if (!plugin) {
    stage = 'download';
    const pack = await bytes(marketplace, 8 * 1024 * 1024);
    check(sha(pack) === packageSha256, 'PACKAGE_SHA256_MISMATCH', 'Package integrity check failed; native installation was not invoked');
    const dir = join(root, 'downloads');
    if (existsSync(dir)) check(realpathSync(dir) === dir && !lstatSync(dir).isSymbolicLink(), 'PATH_OUTSIDE_TARGET', 'Download directory must not be a symlink');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const packPath = join(dir, `marketplace-${packageSha256}.zip`);
    if (existsSync(packPath)) check(sha(readFileSync(exactFile(packPath, root))) === packageSha256, 'PACKAGE_LOCAL_CONFLICT', 'Existing downloaded artifact changed');
    else writeFileSync(packPath, pack, { flag: 'wx', mode: 0o600 });
    steps.push({ stage, source: marketplace, sha256: packageSha256, bytes: pack.length });
    stage = 'marketplace';
    const markets = await api('/api/v1/plugins/marketplaces');
    const market = markets.find(m => m.name === 'promate');
    if (market) {
      const known = JSON.parse(readFileSync(join(profile, 'plugins/known_marketplaces.json'), 'utf8'));
      const source = known.promate?.source;
      check(source?.path === packPath || source?.url === packPath, 'MARKETPLACE_CONFLICT', 'Partial state has an unrelated/unknown marketplace source');
    } else await api('/api/v1/plugins/marketplaces', { source: packPath, name: 'promate', autoUpdate: false });
    stage = 'install';
    await api('/api/v1/plugins', { plugin: ID, options: { scope: 'user', waitForApply: true } });
  }
  stage = 'enable';
  plugin = (await api('/api/v1/plugins')).find(p => p.name === 'promate' && p.marketplace === 'promate');
  check(plugin?.version === version, 'INSTALL_NOT_CONFIRMED', 'Target version is not installed');
  if (plugin.status !== 'enabled') await api('/api/v1/plugins/enable', { plugin: ID, persist: true });
  stage = 'configuration';
  const pluginPath = exactFile(plugin.installedPath, join(profile, 'plugins'));
  const manifest = JSON.parse(readFileSync(join(pluginPath, '.codebuddy-plugin/plugin.json'), 'utf8'));
  check(manifest.name === 'promate' && manifest.version === version, 'INSTALLED_VERSION_MISMATCH', 'Installed manifest differs from target');
  // Use the installed plugin's existing atomic public-address setter; never receive a Key.
  const lib = await import(pathToFileURL(exactFile(join(pluginPath, 'hooks/lib.mjs'), pluginPath)).href);
  if (lib.readConfig(true).url !== platform) lib.writeConfigUrl(platform);
  stage = 'load';
  const reload = await api('/api/v1/plugins/reload', {});
  check(reload.plugins === 1 && reload.mcpServers === 1 && reload.hooks === 10 && reload.errors === 0,
    'RUNTIME_NOT_LOADED', 'Native runtime did not activate the isolated target components cleanly');
  plugin = (await api('/api/v1/plugins')).find(p => p.name === 'promate' && p.marketplace === 'promate');
  const registry = JSON.parse(readFileSync(join(profile, 'plugins/installed_plugins.json'), 'utf8'));
  const entry = registry.plugins?.[ID]; // Do NOT read registry.plugins.promate or truncate the object.
  const entries = Array.isArray(entry) ? entry : entry ? [entry] : [];
  const enabled = JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8')).enabledPlugins?.[ID];
  check(entries.some(e => e.version === version && e.installPath === pluginPath) && enabled === true,
    'REGISTRATION_NOT_CONFIRMED', 'Exact native registration or enablement is missing');
  // Runtime refresh projects MCP config; the native connection finishes asynchronously.
  // Poll only the authoritative status with a fixed deadline, never infer readiness from files.
  const deadline = Date.now() + 10000;
  let status;
  do {
    status = await api('/internal/mcp/status', { name: 'promate', scope: 'plugin' });
    if (status.status === 'connected') break;
    check(status.status === 'connecting', 'MCP_CONNECTION_FAILED', 'Native MCP connection failed or is absent');
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  const tools = await api('/internal/mcp/listTools', { name: 'promate', scope: 'plugin' });
  const configure = Array.isArray(tools) ? tools.find(t => t.name === 'mcp__promate__configure_key') : null;
  check(status.status === 'connected' && configure && configure.inputSchema?.type === 'object'
    && Object.keys(configure.inputSchema.properties || {}).length === 0 && (configure.inputSchema.required || []).length === 0,
    'MCP_NOT_READY', 'Host did not discover the connected credential-free configure_key tool');
  check(plugin?.version === version, 'RUNTIME_VERSION_MISMATCH', 'Host target version changed during loading');
  console.log(JSON.stringify({ ok: true, code: 'LOADED_CONFIGURE_KEY_NEXT', initial, target, version,
    installed: true, enabled: true, loaded: true, authenticated: false, configureKeyHasArguments: false,
    message: '插件已加载，下一步配置 Key；尚未进行业务认证。', reload, mcpStatus: status.status, steps }));
} catch (error) {
  // Do not echo host response bodies or arbitrary underlying IO/network errors.
  console.log(JSON.stringify({ ok: false, stage, code: error instanceof Failure ? error.code : 'PILOT_IO_ERROR',
    message: error instanceof Failure ? error.message : '先导运行失败，未宣称安装完成；请查看隔离技术证据。', steps }));
  process.exitCode = 1;
}

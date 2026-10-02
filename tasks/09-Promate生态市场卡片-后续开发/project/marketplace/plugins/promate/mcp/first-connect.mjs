// One-shot, public handoff. The installer writes a request; only the verified installed
// SessionStart hook can claim it. A page receipt never asserts that MCP was loaded.
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { readConfig, requestKey, resolveUrl, writeConfigUrl } from '../hooks/lib.mjs';

export const HANDOFF_TTL_MS = 24 * 60 * 60 * 1000;
const parse = file => JSON.parse(readFileSync(file, 'utf8'));
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
function safeFile(file) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw Error('HANDOFF_FILE_UNSAFE');
  return parse(file);
}
function hostRegistry(file) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o022)) throw Error('HOST_REGISTRY_UNSAFE');
  return parse(file);
}
function live(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
// Single-file, short critical section shared by installer, hooks and page processes.
// Unknown/live owners are never stolen. Recover only a proven dead owner under an exclusive guard.
function withIdentityLock(dir, action) {
  const lock = join(dir, 'identity.lock'), guard = join(dir, 'identity.recover');
  let owner;
  for (let attempt = 0; attempt < 2; attempt++) {
    owner = { id: randomUUID(), pid: process.pid, uid: process.getuid() };
    try { writeFileSync(lock, JSON.stringify(owner), { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (attempt) throw Error('HANDOFF_BUSY');
      const recovery = { id: randomUUID(), pid: process.pid, uid: process.getuid() };
      try { writeFileSync(guard, JSON.stringify(recovery), { flag: 'wx', mode: 0o600 }); }
      catch { throw Error('HANDOFF_BUSY'); }
      try {
        const previous = safeFile(lock);
        if (previous.uid !== process.getuid() || !uuid(previous.id) || live(previous.pid)) throw Error('HANDOFF_BUSY');
        if (safeFile(lock).id !== previous.id) throw Error('HANDOFF_BUSY');
        unlinkSync(lock);
      } finally {
        if (safeFile(guard).id === recovery.id) unlinkSync(guard);
      }
      continue;
    }
    if (existsSync(guard)) {
      if (safeFile(lock).id === owner.id) unlinkSync(lock);
      throw Error('HANDOFF_BUSY');
    }
    let failure;
    try { return action(); }
    catch (error) { failure = error; throw error; }
    finally {
      try {
        if (safeFile(lock).id !== owner.id) throw Error('HANDOFF_OWNER_UNPROVEN');
        unlinkSync(lock);
      } catch (error) { if (!failure) throw error; }
    }
  }
  throw Error('HANDOFF_BUSY');
}
function currentMatches(dir, request) {
  const path = join(dir, 'current.json');
  if (!existsSync(path)) return false; // legacy claims have no provable generation
  const value = safeFile(path);
  return value.state === 'pending' && ['id', 'uid', 'profile', 'version', 'platform', 'marketplace', 'createdAt']
    .every(key => value[key] === request[key]);
}
function currentId(dir, id, includeSourceChange = false) {
  const path = join(dir, 'current.json');
  if (!existsSync(path)) return false;
  const value = safeFile(path);
  return value.id === id && (value.state === 'pending' || (includeSourceChange && value.state === 'source_changed'));
}
function sourceMatches(request) {
  try {
    const config = readConfig(true);
    return !!config.url && resolveUrl(config) === request.platform;
  } catch { return false; }
}
function sourceChanged(dir, request) {
  if (!currentMatches(dir, request)) return;
  atomic(join(dir, 'current.json'), { ...request, state: 'source_changed' });
  atomic(join(dir, 'result.json'), { id: request.id, version: request.version,
    platform: request.platform, marketplace: request.marketplace, code: 'HANDOFF_SOURCE_CHANGED',
    loaded: false, authenticated: false, pageReachable: false, createdAt: Date.now() });
}
function directory(profile) {
  if (!profile || realpathSync(profile) !== profile || lstatSync(profile).uid !== process.getuid()) throw Error('PROFILE_UNPROVEN');
  const dir = join(profile, 'plugins/.promate-first-connect');
  if (realpathSync(dir) !== dir || lstatSync(dir).uid !== process.getuid() || (lstatSync(dir).mode & 0o077)) throw Error('HANDOFF_DIRECTORY_UNSAFE');
  return dir;
}
export function atomic(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try { writeFileSync(temp, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 }); renameSync(temp, file); }
  finally { try { unlinkSync(temp); } catch { /* committed */ } }
}
export function requestFirstConnect({ profile, version, platform, marketplace, now = Date.now() }) {
  const dir = directory(profile);
  const url = resolveUrl({ url: platform });
  if (!/^\d+\.\d+\.\d+$/.test(version) || !marketplace || new URL(marketplace).origin !== new URL(url).origin) throw Error('HANDOFF_SOURCE_INVALID');
  return withIdentityLock(dir, () => {
    const config = readConfig(true);
    if (resolveUrl(config) !== url || !config.url) writeConfigUrl(url);
    const previousId = pendingFirstConnect({ profile, version, platform: url, marketplace, now });
    if (previousId) return previousId;
    const request = { id: randomUUID(), uid: process.getuid(), profile, version, platform: url, marketplace, createdAt: now };
    // Switch identity first. If interrupted, neither an older page nor a legacy request can regain authority.
    atomic(join(dir, 'current.json'), { ...request, state: 'pending' });
    atomic(join(dir, 'request.json'), request);
    return request.id;
  });
}
export function pendingFirstConnect({ profile, version, platform, marketplace, now = Date.now() }) {
  try {
    const pending = join(directory(profile), 'request.json');
    if (!existsSync(pending)) return null;
    const value = safeFile(pending);
    return currentMatches(directory(profile), value) && uuid(value.id) && value.uid === process.getuid() && value.profile === profile
      && value.version === version && value.platform === platform && value.marketplace === marketplace
      && value.createdAt <= now && now - value.createdAt < HANDOFF_TTL_MS ? value.id : null;
  } catch { return null; }
}
export function canReuseFirstConnect({ profile, version, platform, marketplace }) {
  try {
    const result = safeFile(join(directory(profile), 'result.json'));
    const config = readConfig(true);
    return currentId(directory(profile), result.id) && result.code === 'PRIVATE_PAGE_CONNECTED' && result.version === version && result.platform === platform
      && result.marketplace === marketplace && resolveUrl(config) === platform && Boolean(requestKey(config));
  } catch { return false; }
}
export function readFirstConnectResult(profile, id) {
  const file = join(directory(profile), 'result.json');
  if (!existsSync(file)) return null;
  const value = safeFile(file);
  return value.id === id && currentId(directory(profile), value.id, true) ? value : null;
}
// Derive profile solely from the canonical plugin cache root, never from an untrusted env fallback.
export function installedContext(pluginRoot, version) {
  const root = realpathSync(pluginRoot);
  if (root !== pluginRoot || !lstatSync(root).isDirectory() || lstatSync(root).uid !== process.getuid()) throw Error('PLUGIN_PATH_UNPROVEN');
  const parent = dirname(root);
  const profile = dirname(dirname(dirname(dirname(parent))));
  if (root !== join(profile, 'plugins/cache/promate/promate', version) || !root.startsWith(profile + sep)) throw Error('PLUGIN_PATH_UNPROVEN');
  const entry = hostRegistry(join(profile, 'plugins/installed_plugins.json')).plugins?.['promate@promate'];
  const entries = Array.isArray(entry) ? entry : [entry];
  if (entries.length !== 1 || entries[0]?.version !== version || entries[0]?.scope !== 'user' || entries[0]?.installPath !== root) throw Error('PLUGIN_REGISTRATION_UNPROVEN');
  return { root, profile, dir: directory(profile) };
}
function valid(request, context, version, now, verifySource = true) {
  if (!uuid(request?.id) || request.uid !== process.getuid() || request.profile !== context.profile || request.version !== version
    || !Number.isFinite(request.createdAt) || request.createdAt > now || now - request.createdAt >= HANDOFF_TTL_MS
    || typeof request.platform !== 'string' || resolveUrl({ url: request.platform }) !== request.platform
    || typeof request.marketplace !== 'string' || !/^https?:$/.test(new URL(request.marketplace).protocol)
    || new URL(request.marketplace).origin !== new URL(request.platform).origin) return false;
  const market = hostRegistry(join(context.profile, 'plugins/known_marketplaces.json')).promate;
  return market?.manifestName === 'promate' && market?.source?.url === request.marketplace
    && (!verifySource || sourceMatches(request));
}
export function claimFirstConnect({ pluginRoot, version, now = Date.now() }) {
  const context = installedContext(pluginRoot, version);
  const file = join(context.dir, 'request.json');
  return withIdentityLock(context.dir, () => {
    // Only recover this generation's proven dead claim. Never resurrect a replaced request.
    if (!existsSync(file)) for (const name of readdirSync(context.dir)) {
      if (!/^claimed-[0-9a-f-]{36}\.json$/.test(name)) continue;
      const stale = join(context.dir, name);
      const value = safeFile(stale);
      if (!currentMatches(context.dir, value) || value.version !== version || !valid(value, context, version, now, false)) continue;
      if (!sourceMatches(value)) { sourceChanged(context.dir, value); continue; }
      const receipt = readFirstConnectResult(context.profile, value.id);
      if (['PRIVATE_PAGE_CONNECTED', 'PRIVATE_PAGE_FINISHED', 'PRIVATE_PAGE_CANCELLED', 'PRIVATE_PAGE_EXPIRED', 'PRIVATE_PAGE_INCOMPLETE', 'PRIVATE_PAGE_FAILED'].includes(receipt?.code)) continue;
      if (live(receipt?.pagePid) || (receipt?.code !== 'PRIVATE_PAGE_OPENED' && live(value.claimPid))
        || now - lstatSync(stale).mtimeMs < 10000) continue;
      renameSync(stale, file);
      break;
    }
    if (!existsSync(file)) return null;
    const value = safeFile(file);
    if (!currentMatches(context.dir, value) || !valid(value, context, version, now, false)) return null;
    if (!sourceMatches(value)) { sourceChanged(context.dir, value); return null; }
    const claim = join(context.dir, `claimed-${randomUUID()}.json`);
    renameSync(file, claim);
    if (JSON.stringify(safeFile(claim)) !== JSON.stringify(value)) throw Error('HANDOFF_CHANGED');
    atomic(claim, { ...value, claimPid: process.pid });
    return { ...context, request: value, claim };
  });
}
// Written by the actual MCP proxy, never by the installer or SessionStart hook.
export function noteProxyStarted(pluginRoot, version, env = process.env) {
  if (env.CODEBUDDY_HOST !== 'workbuddy-desktop') return;
  try {
    const context = installedContext(pluginRoot, version);
    atomic(join(context.dir, 'runtime.json'), { uid: process.getuid(), pid: process.pid,
      processStartedAt: Math.floor(Date.now() - process.uptime() * 1000), profile: context.profile,
      pluginRoot: context.root, version });
  } catch { /* an unverifiable runtime cannot be recorded as ready */ }
}
export function runtimeReady(profile, pluginRoot, version) {
  try {
    const value = safeFile(join(directory(profile), 'runtime.json'));
    if (value.uid !== process.getuid() || value.profile !== profile || value.pluginRoot !== pluginRoot
      || value.version !== version || !live(value.pid) || !Number.isSafeInteger(value.processStartedAt)) return false;
    // PID reuse cannot turn a stale marker into evidence. Inspect ONLY start time and command;
    // never print the command line (other processes may have credentials in their argv).
    const started = Date.parse(execFileSync('/bin/ps', ['-p', String(value.pid), '-o', 'lstart='],
      { encoding: 'utf8', timeout: 2000 }).trim());
    const command = execFileSync('/bin/ps', ['-p', String(value.pid), '-o', 'command='],
      { encoding: 'utf8', timeout: 2000 });
    return Number.isFinite(started) && Math.abs(started - value.processStartedAt) < 3000
      && command.includes(join(pluginRoot, 'mcp/proxy.mjs'));
  } catch { return false; }
}
function claimIsCurrent(claim) {
  return currentMatches(claim.dir, claim.request) && !existsSync(join(claim.dir, 'request.json'))
    && currentMatches(claim.dir, safeFile(claim.claim))
    && Date.now() - claim.request.createdAt < HANDOFF_TTL_MS;
}
export function activeFirstConnect(claim) {
  try {
    if (!claimIsCurrent(claim)) return false;
    if (sourceMatches(claim.request)) return true;
    withIdentityLock(claim.dir, () => {
      if (claimIsCurrent(claim) && !sourceMatches(claim.request)) sourceChanged(claim.dir, claim.request);
    });
    return false;
  } catch { return false; }
}
// One synchronous critical section around current generation, source and local Key access.
// Explicit configure_key pages call startConfigPage without this guard.
export function withCurrentSubmission(claim, action) {
  return withIdentityLock(claim.dir, () => {
    if (!claimIsCurrent(claim)) throw Error('HANDOFF_REPLACED');
    if (!sourceMatches(claim.request)) {
      sourceChanged(claim.dir, claim.request);
      throw Error('HANDOFF_SOURCE_CHANGED');
    }
    return action();
  });
}
function publishLocked(claim, code, extra) {
  if (!claimIsCurrent(claim)) return false;
  if (!sourceMatches(claim.request)) { sourceChanged(claim.dir, claim.request); return false; }
  const { dir, request } = claim;
  atomic(join(dir, 'result.json'), { id: request.id, version: request.version,
    platform: request.platform, marketplace: request.marketplace, code,
    loaded: false, authenticated: code === 'PRIVATE_PAGE_CONNECTED',
    pageReachable: code === 'PRIVATE_PAGE_OPENED', createdAt: Date.now(), ...extra });
  return true;
}
export function publishFirstConnect(claim, code, extra = {}) {
  return withIdentityLock(claim.dir, () => publishLocked(claim, code, extra));
}
export function finishFirstConnect(claim, code) {
  return withIdentityLock(claim.dir, () => {
    if (!publishLocked(claim, code, {})) return false;
    unlinkSync(claim.claim);
    return true;
  });
}
export function failFirstConnect(claim) {
  return withIdentityLock(claim.dir, () => {
    if (!claimIsCurrent(claim)) return false;
    if (!publishLocked(claim, 'PRIVATE_PAGE_UNAVAILABLE', {})) return false;
    renameSync(claim.claim, join(claim.dir, 'request.json'));
    return true;
  });
}
export function restoreFirstConnect(claim) {
  return withIdentityLock(claim.dir, () => {
    if (!claimIsCurrent(claim)) return false;
    if (!sourceMatches(claim.request)) { sourceChanged(claim.dir, claim.request); return false; }
    renameSync(claim.claim, join(claim.dir, 'request.json'));
    return true;
  });
}

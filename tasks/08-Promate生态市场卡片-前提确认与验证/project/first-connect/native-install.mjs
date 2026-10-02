#!/usr/bin/env node
// Native CLI installer. It manages the verified user's on-disk profile, NOT a discovered HTTP runtime.
// Native install and desktop loading are separate facts; the user may need one full desktop restart.
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { userInfo } from 'node:os';
import { pathToFileURL } from 'node:url';

const APP = '/Applications/WorkBuddy.app/Contents';
const CLI = join(APP, 'Resources/app.asar.unpacked/cli/bin/codebuddy');
const BUNDLE = join(APP, 'Resources/app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs');
const HOST_SHA = 'b340564b2410d99846397776a25fd99e11d86647a7c219ad06fedc441e364ddd';
export const ID = 'promate@promate';
export const digest = b => createHash('sha256').update(b).digest('hex');
export class InstallFailure extends Error { constructor(code) { super(code); this.code = code; } }
export function check(ok, code) { if (!ok) throw new InstallFailure(code); }
const json = p => {
  const kind = p.endsWith('installed_plugins.json') ? 'REGISTRY' : p.endsWith('known_marketplaces.json') ? 'MARKETS'
    : p.endsWith('owner.json') || p.endsWith('install.lock') || p.endsWith('recover.lock') ? 'LOCK' : 'MANIFEST';
  let raw;
  try { raw = readFileSync(p, 'utf8'); } catch { throw new InstallFailure(`LOCAL_${kind}_UNREADABLE`); }
  try { return JSON.parse(raw); } catch { throw new InstallFailure(`LOCAL_${kind}_INVALID_JSON`); }
};
function nativeList(target, env, command = nativeCommand) {
  const output = command(target, ['list', '--json'], env);
  let data;
  try { data = JSON.parse(output); } catch { throw new InstallFailure('NATIVE_LIST_INVALID_JSON'); }
  check(Array.isArray(data), 'NATIVE_LIST_NOT_ARRAY');
  return data;
}
export function publicUrl(raw) {
  const u = new URL(raw);
  check((u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)))
    && !u.username && !u.password && !u.search && !u.hash, 'DELIVERY_URL_INVALID');
  return u.href;
}
export function targetContext(env = process.env) {
  check(process.platform === 'darwin' && !process.versions.electron && Number(process.versions.node.split('.')[0]) >= 22,
    'NATIVE_NODE_REQUIRED');
  check(process.getuid() === process.geteuid() && process.getuid() !== 0, 'CURRENT_USER_INVALID');
  check(!!env.CODEBUDDY_CONFIG_DIR && (!env.WORKBUDDY_CONFIG_DIR || env.WORKBUDDY_CONFIG_DIR === env.CODEBUDDY_CONFIG_DIR),
    'PROFILE_CONTEXT_UNPROVEN');
  const raw = resolve(env.CODEBUDDY_CONFIG_DIR);
  const profile = realpathSync(raw);
  check(profile === raw && lstatSync(profile).isDirectory() && !lstatSync(profile).isSymbolicLink()
    && lstatSync(profile).uid === process.getuid() && !(lstatSync(profile).mode & 0o022), 'PROFILE_OWNER_UNPROVEN');
  check(realpathSync(env.HOME) === realpathSync(userInfo().homedir), 'CURRENT_HOME_CONFLICT');
  check(/<key>CFBundleShortVersionString<\/key>\s*<string>5\.6\.2<\/string>/.test(readFileSync(join(APP, 'Info.plist'), 'utf8'))
    && digest(readFileSync(BUNDLE)) === HOST_SHA, 'HOST_BUILD_UNSUPPORTED');
  // Optional explicit port for this NEW one-shot CLI's self-call, useful under fixed-port OS sandboxes.
  // It never identifies or grants control of an existing desktop runtime.
  const cliPort = env.PROMATE_NATIVE_CLI_PORT ? Number(env.PROMATE_NATIVE_CLI_PORT) : undefined;
  check(cliPort === undefined || (Number.isInteger(cliPort) && cliPort > 1023 && cliPort <= 65535), 'NATIVE_SELF_PORT_INVALID');
  return { profile, node: process.execPath, uid: process.getuid(), cliPort };
}
function ownedDirectory(path, parent) {
  check(path.startsWith(parent + sep), 'PATH_OUTSIDE_PROFILE');
  let current = parent;
  for (const part of path.slice(parent.length + 1).split(sep)) {
    current = join(current, part);
    if (!existsSync(current)) mkdirSync(current, { mode: 0o700 });
    const stat = lstatSync(current);
    check(stat.isDirectory() && !stat.isSymbolicLink() && realpathSync(current) === current
      && stat.uid === process.getuid() && !(stat.mode & 0o022), 'PATH_OWNER_UNPROVEN');
  }
  return path;
}
export function nativeCommand(target, args, env = process.env) {
  const cwd = ownedDirectory(join(target.profile, 'plugins/.promate-first-connect/workspace'), target.profile);
  // No shell, no model, no desktop gateway credential; the native one-shot CLI creates its own endpoint.
  // Keep the current user's native profile/policy. Do not copy its settings or personal credentials.
  const childEnv = {};
  for (const key of ['HOME', 'USER', 'LANG', 'PATH', 'TMPDIR', 'TMP', 'TEMP', 'SHELL',
    'CODEBUDDY_CREDENTIALS_IN_MEMORY', 'CODEBUDDY_DATA_ROOT', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME',
    'PROMATE_HOME', 'PROMATE_CONFIG', 'PROMATE_SKILLS_DIR']) {
    if (env[key]) childEnv[key] = env[key];
  }
  Object.assign(childEnv, { CODEBUDDY_CONFIG_DIR: target.profile, WORKBUDDY_CONFIG_DIR: target.profile,
    CODEBUDDY_FORCE_LITE_WB_BUNDLE: '1', CODEBUDDY_DISABLE_COMPILE_CACHE: '1', DISABLE_TELEMETRY: '1',
    CODEBUDDY_CREDENTIALS_IN_MEMORY: '1', CODEBUDDY_API_KEY_HELPER_DISABLED: '1',
    CODEBUDDY_DISABLE_LOCAL_STORAGE: '1',
    CODEBUDDY_SKIP_BUILTIN_MARKETPLACE: '1' });
  // This is a fresh one-shot CLI bind, never a connection to a discovered host process.
  if (target.cliPort) childEnv.SERVER__PORT = String(target.cliPort);
  childEnv.SERVER__HOST = '127.0.0.1';
  const run = spawnSync(target.node, [CLI, 'plugin', ...args],
    { cwd, env: childEnv, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 });
  check(!run.error && !run.signal, 'NATIVE_COMMAND_TIMEOUT_OR_IO');
  // WorkBuddy 5.6.2 sometimes exits zero after reporting a command error. Never rely on exit zero alone.
  if (run.status !== 0 || /[✘✗]|Failed to /i.test(run.stdout)) {
    const output = run.stdout + run.stderr;
    const category = /unknown option/i.test(output) ? 'OPTION'
      : /Cannot find module|MODULE_NOT_FOUND/.test(output) ? 'MODULE'
      : /EPERM|EACCES|[Pp]ermission denied|[Oo]peration not permitted/.test(output) ? 'PERMISSION'
      : /sandbox|broker/i.test(output) ? 'SANDBOX'
      : /login|sign in|unauthorized/i.test(output) ? 'AUTH'
      : /ENOENT|not found/i.test(output) ? 'PATH' : 'OTHER';
    throw new InstallFailure(`NATIVE_COMMAND_REJECTED_${category}_${Number.isInteger(run.status) ? run.status : 'UNKNOWN'}`);
  }
  return run.stdout;
}
export function registered(target) {
  const file = join(target.profile, 'plugins/installed_plugins.json');
  const registry = existsSync(file) ? json(file) : { plugins: {} };
  const entry = registry.plugins?.[ID];
  const list = Array.isArray(entry) ? entry : entry ? [entry] : [];
  check(list.length <= 1 && list.every(e => e.scope === 'user'), 'PLUGIN_SCOPE_CONFLICT');
  return list[0];
}
function foreignState(target) {
  const registryFile = join(target.profile, 'plugins/installed_plugins.json');
  const marketsFile = join(target.profile, 'plugins/known_marketplaces.json');
  const registry = existsSync(registryFile) ? json(registryFile).plugins : {};
  const markets = existsSync(marketsFile) ? json(marketsFile) : {};
  const others = Object.fromEntries(Object.entries(registry || {}).filter(([key]) => key !== ID));
  const otherMarkets = Object.fromEntries(Object.entries(markets || {}).filter(([key]) => key !== 'promate'));
  return digest(JSON.stringify([others, otherMarkets]));
}
export function verifyInstalled(target, entry, release,
  markerIO = { stat: lstatSync, list: readdirSync, read: readFileSync }) {
  check(entry?.version === release.version, 'INSTALLED_VERSION_MISMATCH');
  const path = entry.installPath;
  check(typeof path === 'string' && path.startsWith(join(target.profile, 'plugins/cache/promate/promate') + sep)
    && realpathSync(path) === path, 'INSTALLED_PATH_UNPROVEN');
  const actual = [];
  function walk(dir, prefix = '') {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name), rel = prefix + name;
      const runtimeDir = !prefix && name === '.in_use';
      let stat;
      try { stat = runtimeDir ? markerIO.stat(p) : lstatSync(p); }
      catch (error) {
        if (runtimeDir && error.code === 'ENOENT') continue; // Host removed its empty marker dir.
        throw error;
      }
      check(!stat.isSymbolicLink(), 'INSTALLED_SYMLINK_REJECTED');
      if (runtimeDir) {
        // WorkBuddy 5.6.2 writes .in_use/<PID>.tmp.<millis>.<base36> then renames to <PID>.
        // Its cleanup can remove a marker/directory between enumeration and stat/read.
        check(stat.isDirectory() && stat.uid === process.getuid() && !(stat.mode & 0o022),
          'INSTALLED_RUNTIME_MARKER_INVALID');
        let markers;
        try { markers = markerIO.list(p); }
        catch (error) {
          if (error.code === 'ENOENT') continue;
          throw error;
        }
        for (const marker of markers) {
          const runtimeName = /^([1-9]\d{0,9})(?:\.tmp\.([1-9]\d{12})\.([a-z0-9]{1,24}))?$/.exec(marker);
          check(runtimeName, 'INSTALLED_RUNTIME_MARKER_INVALID');
          const markerPath = join(p, marker);
          let markerStat;
          try { markerStat = markerIO.stat(markerPath); }
          catch (error) {
            if (error.code === 'ENOENT') continue;
            throw error;
          }
          check(!markerStat.isSymbolicLink(), 'INSTALLED_SYMLINK_REJECTED');
          check(markerStat.isFile() && markerStat.uid === process.getuid()
            && !(markerStat.mode & 0o022) && markerStat.size <= 4096, 'INSTALLED_RUNTIME_MARKER_INVALID');
          if (runtimeName[2]) continue; // The temporary JSON may be incomplete until the host renames it.
          let data;
          try { data = JSON.parse(markerIO.read(markerPath, 'utf8')); }
          catch (error) {
            if (error.code === 'ENOENT') continue;
            throw new InstallFailure('INSTALLED_RUNTIME_MARKER_INVALID');
          }
          check(data && typeof data === 'object' && !Array.isArray(data)
            && data.pid === Number(runtimeName[1]) && Object.keys(data).every(key => ['pid', 'procStart'].includes(key))
            && (data.procStart === undefined || (typeof data.procStart === 'string'
              && data.procStart.length > 0 && data.procStart.length <= 256)), 'INSTALLED_RUNTIME_MARKER_INVALID');
        }
        continue;
      }
      if (stat.isDirectory()) walk(p, rel + '/');
      else { check(stat.isFile(), 'INSTALLED_FILE_INVALID'); actual.push(rel); }
    }
  }
  walk(path);
  const found = new Set(actual);
  const expected = new Set(Object.keys(release.files));
  if (actual.length !== expected.size || actual.some(name => !expected.has(name))) {
    const error = new InstallFailure('INSTALLED_FILES_MISMATCH');
    // Only plugin-relative names under the verified cache root; never emit arbitrary paths or credentials.
    const safe = name => /^[A-Za-z0-9._/-]{1,160}$/.test(name)
      && !/(?:pk_|st_|key|token|secret|password)/i.test(name);
    error.missing = [...expected].filter(name => !found.has(name) && safe(name)).slice(0, 50);
    error.extra = actual.filter(name => !expected.has(name) && safe(name)).slice(0, 50);
    error.fileCounts = { actual: actual.length, expected: expected.size };
    throw error;
  }
  for (const [name, sha] of Object.entries(release.files)) {
    check(digest(readFileSync(join(path, name))) === sha, 'INSTALLED_INTEGRITY_MISMATCH');
  }
  const manifest = json(join(path, '.codebuddy-plugin/plugin.json'));
  check(manifest.name === 'promate' && manifest.version === release.version, 'INSTALLED_MANIFEST_MISMATCH');
  return path;
}
export function validateRelease(input) {
  check(input && /^\d+\.\d+\.\d+$/.test(input.version) && /^[a-f0-9]{64}$/.test(input.packageSha256), 'RELEASE_INVALID');
  const url = publicUrl(input.marketplace);
  check(new URL(url).pathname.endsWith(`/marketplace-${input.packageSha256}.zip`), 'IMMUTABLE_MARKET_REQUIRED');
  check(input.files && typeof input.files === 'object' && !Array.isArray(input.files)
    && Object.keys(input.files).length > 0 && Object.keys(input.files).length <= 50, 'RELEASE_FILES_INVALID');
  for (const [name, sha] of Object.entries(input.files)) check(typeof name === 'string'
    && !name.startsWith('/') && !name.split('/').some(p => !p || p === '..' || p === '.')
    && !name.includes('\\') && name !== '.in_use' && !name.startsWith('.in_use/')
    && /^[a-f0-9]{64}$/.test(sha), 'RELEASE_FILES_INVALID');
  return input;
}
async function downloadVerified(release) {
  const response = await fetch(release.marketplace, { redirect: 'error', signal: AbortSignal.timeout(15000) });
  check(response.ok && response.body, 'PACKAGE_DOWNLOAD_FAILED');
  const parts = []; let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length; check(total <= 8 * 1024 * 1024, 'PACKAGE_TOO_LARGE'); parts.push(chunk);
  }
  check(digest(Buffer.concat(parts)) === release.packageSha256, 'PACKAGE_SHA256_MISMATCH');
}
export function acquireInstallLock(control, releaseFile = unlinkSync) {
  const lock = join(control, 'install.lock'), recovery = join(control, 'recover.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    check(!existsSync(recovery), 'INSTALL_RECOVERY_BUSY');
    const owner = { pid: process.pid, uid: process.getuid(), id: randomUUID() };
    let created = false;
    // One exclusive file: the host supports file unlink, but brokered directory rmdir becomes EISDIR.
    // Never delete the owner record before removing the lock itself.
    try { writeFileSync(lock, JSON.stringify(owner), { flag: 'wx', mode: 0o600 }); created = true; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (created) {
      const release = () => {
        const stat = lstatSync(lock);
        check(stat.isFile() && !stat.isSymbolicLink() && stat.uid === owner.uid
          && json(lock).id === owner.id, 'INSTALL_OWNER_UNPROVEN');
        releaseFile(lock);
      };
      if (existsSync(recovery)) { release(); throw new InstallFailure('INSTALL_RECOVERY_BUSY'); }
      return release;
    }
    if (attempt) throw new InstallFailure('INSTALL_BUSY');
    const guard = { pid: process.pid, uid: process.getuid(), id: randomUUID() };
    try { writeFileSync(recovery, JSON.stringify(guard), { flag: 'wx', mode: 0o600 }); }
    catch { throw new InstallFailure('INSTALL_RECOVERY_BUSY'); }
    let failure;
    try {
      check(existsSync(lock) && realpathSync(lock) === lock, 'INSTALL_OWNER_UNPROVEN');
      const stat = lstatSync(lock);
      check(stat.uid === process.getuid() && !(stat.mode & 0o077) && !stat.isSymbolicLink()
        && (stat.isFile() || stat.isDirectory()), 'INSTALL_OWNER_UNPROVEN');
      // Support proven, exited legacy directory owners; unknown empty directories are never stolen.
      const legacy = stat.isDirectory();
      const ownerFile = legacy ? join(lock, 'owner.json') : lock;
      check(existsSync(ownerFile) && (!legacy || readdirSync(lock).length === 1), 'INSTALL_OWNER_UNPROVEN');
      const fileStat = lstatSync(ownerFile);
      check(fileStat.isFile() && !fileStat.isSymbolicLink() && fileStat.uid === process.getuid()
        && !(fileStat.mode & 0o077), 'INSTALL_OWNER_UNPROVEN');
      const previous = json(ownerFile);
      check(previous.uid === process.getuid() && Number.isInteger(previous.pid) && previous.pid > 1
        && /^[0-9a-f-]{36}$/.test(previous.id), 'INSTALL_OWNER_UNPROVEN');
      let dead = false;
      try { process.kill(previous.pid, 0); } catch (error) { dead = error.code === 'ESRCH'; }
      check(dead, 'INSTALL_BUSY');
      // A legacy directory is removed as one operation; no owner.json unlink before rmdir.
      if (legacy) {
        check(readdirSync(lock).length === 1 && json(ownerFile).id === previous.id, 'INSTALL_OWNER_UNPROVEN');
        rmSync(lock, { recursive: true });
      }
      else unlinkSync(lock);
    } catch (error) { failure = error; throw error; }
    finally {
      try {
        const recoveryStat = lstatSync(recovery);
        check(recoveryStat.isFile() && !recoveryStat.isSymbolicLink() && recoveryStat.uid === guard.uid
          && json(recovery).id === guard.id, 'INSTALL_RECOVERY_BUSY');
        unlinkSync(recovery);
      } catch (error) { if (!failure) throw error; }
    }
  }
  throw new InstallFailure('INSTALL_BUSY');
}
function verifiedMarket(target, release) {
  const file = join(target.profile, 'plugins/known_marketplaces.json');
  const market = existsSync(file) ? json(file).promate : null;
  if (!market) return null;
  const source = market.source?.url || market.source?.path;
  const targetUrl = new URL(release.marketplace);
  let previous;
  try { previous = typeof source === 'string' ? new URL(publicUrl(source)) : null; }
  catch { throw new InstallFailure('MARKETPLACE_SOURCE_CONFLICT'); }
  const base = targetUrl.pathname.slice(0, targetUrl.pathname.lastIndexOf('/') + 1);
  check(market.manifestName === 'promate' && market.type === 'zip' && previous?.origin === targetUrl.origin
    && previous.pathname.startsWith(base)
    && /^marketplace(?:-[a-f0-9]{64})?\.zip$/.test(previous.pathname.slice(base.length)),
  'MARKETPLACE_SOURCE_CONFLICT');
  return market;
}
function verifyMarketContent(target, release) {
  const market = verifiedMarket(target, release);
  check(market && (market.source?.url || market.source?.path) === release.marketplace,
    'MARKETPLACE_REGISTRATION_UNCONFIRMED');
  const root = join(target.profile, 'plugins/marketplaces/promate');
  check(market.installLocation === root && realpathSync(root) === root && lstatSync(root).isDirectory()
    && lstatSync(root).uid === process.getuid(), 'MARKETPLACE_PATH_UNPROVEN');
  const manifest = json(join(root, '.codebuddy-plugin/marketplace.json'));
  check(manifest.name === 'promate' && manifest.owner?.name === 'Promate'
    && manifest.metadata?.version === release.version && Array.isArray(manifest.plugins) && manifest.plugins.length === 1
    && manifest.plugins[0].name === 'promate' && manifest.plugins[0].version === release.version
    && manifest.plugins[0].source === './plugins/promate', 'MARKETPLACE_CONTENT_MISMATCH');
  for (const [name, sha] of Object.entries(release.files)) {
    const path = join(root, 'plugins/promate', name);
    check(realpathSync(path) === path && lstatSync(path).isFile() && digest(readFileSync(path)) === sha,
      'MARKETPLACE_CONTENT_MISMATCH');
  }
}
export async function installNative(target, input, env = process.env, lockFactory = acquireInstallLock, command = nativeCommand) {
  const release = validateRelease(input);
  const control = ownedDirectory(join(target.profile, 'plugins/.promate-first-connect'), target.profile);
  const releaseLock = lockFactory(control);
  const steps = [];
  let operation = 'foreign-state';
  let failure;
  try {
    const before = foreignState(target);
    operation = 'native-list';
    const nativeBefore = nativeList(target, env, command);
    const foreignPlugins = list => JSON.stringify(list.filter(p => p.id !== ID).sort((a, b) => a.id.localeCompare(b.id)));
    operation = 'registration';
    let entry = registered(target);
    const initial = !entry ? 'absent' : entry.version === release.version ? 'installed' : 'upgrade';
    if (entry && initial === 'upgrade') {
      const a = entry.version.split('.').map(Number), b = release.version.split('.').map(Number);
      const first = a.findIndex((v, i) => v !== b[i]);
      check(first >= 0 && a[first] < b[first], 'DOWNGRADE_REFUSED');
    }
    operation = 'marketplace-state';
    const market = verifiedMarket(target, release);
    const marketSource = market?.source?.url || market?.source?.path;
    // A same-version market with different content/source is not a valid reuse.
    if (market && marketSource !== release.marketplace && initial === 'installed') {
      check(false, 'MARKETPLACE_SOURCE_CONFLICT');
    }
    if (!market || marketSource !== release.marketplace || initial !== 'installed') {
      operation = 'package-download';
      await downloadVerified(release);
    }
    if (entry && initial !== 'installed') {
      // Recovery contains ONLY Promate's public registration/source and enable flag, no settings/Key copy.
      writeFileSync(join(control, `recovery-${Date.now()}.json`), JSON.stringify({
        version: entry.version, installPath: entry.installPath, scope: entry.scope,
        marketplace: marketSource || null,
        enabled: nativeBefore.find(p => p.id === ID)?.enabled === true,
      }) + '\n', { flag: 'wx', mode: 0o600 });
    }
    if (!market || marketSource !== release.marketplace) {
      operation = 'marketplace-add';
      command(target, ['marketplace', 'add', release.marketplace, '--name', 'promate'], env);
      steps.push('marketplace');
    }
    operation = 'marketplace-verification';
    verifyMarketContent(target, release);
    if (initial !== 'installed') {
      operation = 'native-install';
      command(target, [initial === 'upgrade' ? 'update' : 'install', ID, '--scope', 'user'], env);
      steps.push(initial === 'upgrade' ? 'upgrade' : 'install');
    }
    operation = 'verification';
    entry = registered(target);
    const pluginPath = verifyInstalled(target, entry, release);
    operation = 'native-list';
    let list = steps.some(step => step === 'install' || step === 'upgrade') ? nativeList(target, env, command) : nativeBefore;
    if (!list.find(p => p.id === ID)?.enabled) {
      operation = 'native-enable';
      command(target, ['enable', ID, '--scope', 'user'], env); steps.push('enable');
      list = nativeList(target, env, command);
    }
    const native = list.filter(p => p.id === ID);
    check(native.length === 1 && native[0].version === release.version && native[0].enabled === true
      && native[0].scope === 'user' && native[0].installPath === pluginPath, 'NATIVE_REGISTRATION_UNCONFIRMED');
    operation = 'foreign-state';
    check(foreignState(target) === before && foreignPlugins(nativeBefore) === foreignPlugins(list), 'NON_PROMATE_STATE_CHANGED');
    return { ok: true, code: 'INSTALL_WRITTEN', initial, version: release.version,
      installed: true, enabled: true, loaded: false, steps, pluginPath };
  } catch (error) {
    failure = error;
    error.operation = operation;
    throw error;
  } finally {
    try { releaseLock(); }
    catch (error) {
      // A cleanup failure must not erase the actual install failure.
      if (!failure) { error.operation = 'lock-release'; throw error; }
    }
  }
}
// A zero-exit, valid JSON intermediate state means disk installation, not desktop completion.
export function finalizeHandoffResult(result, runtimeConfirmed = false) {
  if (result.ok && !result.loaded) {
    result.code = runtimeConfirmed ? 'INSTALLED_TARGET_PROXY_READY' : 'INSTALL_WRITTEN_RESTART_REQUIRED';
    result.stage = runtimeConfirmed ? 'awaiting_normal_session' : 'awaiting_user_restart';
    result.requestPending = true;
    result.message = runtimeConfirmed
      ? '目标版本 MCP 代理已由程序核实运行；无需再次安装或重启。进入普通会话后会话钩子将接续私密配置；身份连接由页面确认。'
      : 'Promate市场和插件已写入并启用。请先结束其他任务，再由您完全退出并重新打开 WorkBuddy 一次；进入普通会话后插件将接续私密配置。无需重发安装命令，不要在聊天输入 Key。桌面代理及身份连接尚未确认。';
  }
  return result;
}
async function main() {
  let stage = 'target';
  try {
    check(process.env.CODEBUDDY_HOST === 'workbuddy-desktop', 'DESKTOP_CONTEXT_REQUIRED');
    const target = targetContext();
    if (process.argv[2] === '--preflight') {
      const list = JSON.parse(nativeCommand(target, ['list', '--json']));
      const plugin = list.filter(p => p.id === ID);
      console.log(JSON.stringify({ ok: true, code: 'NATIVE_PROFILE_CONFIRMED', hostVersion: '5.6.2',
        currentUser: true, profileOwned: true, pluginRegistered: plugin.length > 0,
        pluginVersion: plugin[0]?.version || null, installed: 'not attempted', loaded: 'not checked' }));
      return;
    }
    let input;
    stage = 'metadata';
    if (process.argv[2] === '--connect') {
      const metaUrl = publicUrl(process.argv[3]);
      const response = await fetch(metaUrl, { redirect: 'error', signal: AbortSignal.timeout(10000) });
      check(response.ok, 'METADATA_UNAVAILABLE');
      const parts = []; let length = 0;
      for await (const part of response.body) { length += part.length; check(length <= 65536, 'METADATA_TOO_LARGE'); parts.push(part); }
      input = JSON.parse(Buffer.concat(parts).toString('utf8'));
      input.marketplace = new URL(input.marketplace, metaUrl).href;
      input.platform = new URL(input.platform, metaUrl).href;
      check(new URL(input.marketplace).origin === new URL(metaUrl).origin
        && new URL(input.platform).origin === new URL(metaUrl).origin, 'DELIVERY_SOURCE_CONFLICT');
      check(input.pilotSha256 === digest(readFileSync(process.argv[1])), 'PILOT_VERSION_CHANGED');
    } else input = JSON.parse(process.argv[2] || '{}');
    stage = 'install';
    const result = await installNative(target, input);
    if (input.platform) {
      stage = 'handoff';
      const platform = publicUrl(input.platform);
      check(platform.endsWith('/api/mcp'), 'PLATFORM_PATH_INVALID');
      const handoff = await import(pathToFileURL(join(result.pluginPath, 'mcp/first-connect.mjs')).href);
      const runtimeConfirmed = result.initial === 'installed' && result.steps.length === 0
        && handoff.runtimeReady(target.profile, result.pluginPath, result.version);
      result.proxyLoaded = runtimeConfirmed;
      result.authenticated = false; // no personal identity check during installation
      if (runtimeConfirmed && !existsSync(join(target.profile, 'plugins/.promate-first-connect/request.json'))
        && handoff.canReuseFirstConnect({ profile: target.profile, version: result.version,
          platform, marketplace: input.marketplace })) {
        result.loaded = true;
        result.stage = 'config_reused'; result.code = 'CONFIG_REUSED_TARGET_PROXY_READY';
        result.message = '目标版本代理已核实运行，原有配置保持不变；无需重新安装、重启或重复输入 Key。身份连接仍需以私密页只读检查为准。';
      } else {
        const priorId = handoff.pendingFirstConnect({ profile: target.profile, version: result.version,
          platform, marketplace: input.marketplace });
        const id = handoff.requestFirstConnect({ profile: target.profile, version: result.version, platform,
          marketplace: input.marketplace });
        result.requestId = id;
        finalizeHandoffResult(result, runtimeConfirmed);
        if (priorId === id && !runtimeConfirmed) {
          result.code = 'RESTART_ALREADY_PENDING';
          result.message = '本次市场和插件此前已写入，原接续请求仍有效；无需重复安装或重复提示重启。待其他任务结束后由您完成此前的一次 WorkBuddy 完全退出并重新打开。';
        }
      }
    }
    delete result.pluginPath;
    console.log(JSON.stringify(result));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, stage, code: error instanceof InstallFailure ? error.code : 'NATIVE_INSTALL_IO',
      io: ['EACCES', 'EPERM', 'ENOENT', 'EROFS', 'ENOTDIR', 'ENOTEMPTY', 'EBUSY'].includes(error.code) ? error.code : undefined,
      errorType: ['TypeError', 'SyntaxError', 'Error'].includes(error.name) ? error.name : undefined,
      operation: error.operation,
      missing: error instanceof InstallFailure ? error.missing : undefined,
      extra: error instanceof InstallFailure ? error.extra : undefined,
      fileCounts: error instanceof InstallFailure ? error.fileCounts : undefined,
      loaded: false }));
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();

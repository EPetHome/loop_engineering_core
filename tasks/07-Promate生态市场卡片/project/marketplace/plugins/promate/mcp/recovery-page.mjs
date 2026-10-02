#!/usr/bin/env node
// Short-lived, independently owned recovery page for daily 401 / explicit configure_key.
// The MCP proxy only receives a verified loopback link; it never owns or opens the listener.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configPath, readConfig, resolveUrl } from '../hooks/lib.mjs';
import { startConfigPage } from './local-config.mjs';

const PAGE_MS = 5 * 60 * 1000;
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
function rootDir() {
  const parent = realpathSync(dirname(configPath()));
  const stat = lstatSync(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o022)) throw Error('RECOVERY_HOME_UNSAFE');
  const dir = join(parent, '.promate-recovery');
  if (!existsSync(dir)) mkdirSync(dir, { mode: 0o700 });
  const owned = lstatSync(dir);
  if (!owned.isDirectory() || owned.isSymbolicLink() || realpathSync(dir) !== dir
    || owned.uid !== process.getuid() || (owned.mode & 0o077)) throw Error('RECOVERY_DIRECTORY_UNSAFE');
  return dir;
}
function ownedJson(file) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw Error('RECOVERY_FILE_UNSAFE');
  return JSON.parse(readFileSync(file, 'utf8'));
}
function atomic(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try { writeFileSync(temp, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 }); renameSync(temp, file); }
  finally { try { unlinkSync(temp); } catch { /* committed */ } }
}
function record(dir) {
  const file = join(dir, 'page.json');
  return existsSync(file) ? ownedJson(file) : null;
}
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return true; // unknown owner is never proven dead
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
function current(dir, entry, platform) {
  try {
    const latest = record(dir);
    const address = new URL(entry.url);
    return uuid(entry.id) && entry.uid === process.getuid() && latest?.uid === entry.uid
      && entry.id === latest.id && entry.profile === dir && latest.profile === dir
      && entry.platform === platform && latest.platform === platform && entry.url === latest.url
      && entry.pid === latest.pid && entry.createdAt === latest.createdAt && Number.isSafeInteger(entry.pid)
      && entry.expiresAt === latest.expiresAt && Date.now() < entry.expiresAt
      && entry.expiresAt - entry.createdAt > 0 && entry.expiresAt - entry.createdAt <= PAGE_MS
      && address.protocol === 'http:' && address.hostname === '127.0.0.1' && !address.username
      && !address.password && !address.search && !address.hash && /^\/configure\/[a-f0-9]{64}$/.test(address.pathname)
      && resolveUrl(readConfig(true)) === platform && alive(entry.pid);
  } catch { return false; }
}
async function probe(dir, entry, platform) {
  if (!entry || !current(dir, entry, platform)) return false;
  try {
    const result = await fetch(entry.url, { redirect: 'error', signal: AbortSignal.timeout(1500) });
    const valid = result.status === 200 && result.headers.get('x-promate-page-owner') === entry.id
      && result.headers.get('content-type')?.startsWith('text/html');
    void result.body?.cancel().catch(() => {});
    return valid && current(dir, entry, platform);
  } catch { return false; }
}
function handle(dir, entry) {
  return { url: entry.url, platform: entry.platform, expiresAt: entry.expiresAt,
    isAvailable: () => current(dir, entry, entry.platform),
    probe: () => probe(dir, entry, entry.platform) };
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
// macOS O_EXLOCK is an OS-owned, nonblocking advisory lock (0x20); the kernel releases it
// even when the holder is SIGKILLed. Never unlink the mutex inode: an unlink/recreate
// cycle would let two processes hold locks on different inodes at the same path.
const O_EXLOCK = 0x20;
export async function withMutex(dir, name, action) {
  if (process.platform !== 'darwin') throw Error('RECOVERY_LOCK_UNSUPPORTED');
  const file = join(dir, name), until = Date.now() + 7000;
  for (;;) {
    try { writeFileSync(file, '', { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    let fd;
    try {
      const before = lstatSync(file);
      if (!before.isFile() || before.isSymbolicLink() || before.uid !== process.getuid()
        || (before.mode & 0o077) || before.nlink !== 1) throw Error('RECOVERY_FILE_UNSAFE');
      fd = openSync(file, constants.O_RDWR | constants.O_NONBLOCK | O_EXLOCK | constants.O_NOFOLLOW);
      const after = fstatSync(fd);
      if (before.dev !== after.dev || before.ino !== after.ino || after.uid !== process.getuid()
        || (after.mode & 0o077) || after.nlink !== 1) throw Error('RECOVERY_FILE_UNSAFE');
      return await action();
    } catch (error) {
      if (!['EAGAIN', 'EWOULDBLOCK'].includes(error.code)) throw error;
      if (Date.now() >= until) throw Error('RECOVERY_BUSY');
    } finally { if (fd !== undefined) closeSync(fd); }
    await wait(40);
  }
}
function present(file) {
  try { lstatSync(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function clearLegacyLock(dir) {
  // 0.2.14 used a start lock plus a recovery guard. Both formats carry uid/id/pid.
  // Under the kernel start mutex only a proven dead owner may be removed; an active
  // legacy process or malformed/unknown state fails closed, never by file age.
  const stale = ['page.recover', 'page.lock'].flatMap(name => {
    const file = join(dir, name);
    if (!present(file)) return [];
    const owner = ownedJson(file);
    if (owner.uid !== process.getuid() || !uuid(owner.id) || !Number.isSafeInteger(owner.pid)
      || owner.pid <= 1) throw Error('RECOVERY_OWNER_UNPROVEN');
    if (alive(owner.pid)) throw Error('RECOVERY_BUSY');
    return [{ file, id: owner.id }];
  });
  for (const { file, id } of stale) {
    if (ownedJson(file).id !== id) throw Error('RECOVERY_OWNER_CHANGED');
    unlinkSync(file);
  }
}
async function withStartLock(dir, action) {
  return withMutex(dir, 'page.start.mutex', async () => { clearLegacyLock(dir); return action(); });
}
const withRecordLock = (dir, action) => withMutex(dir, 'page.record.mutex', action);
async function removeOwnRecord(dir, id) {
  return withRecordLock(dir, () => {
    if (record(dir)?.id === id) unlinkSync(join(dir, 'page.json'));
  });
}
async function stopOwnedChild(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode) return;
  const exited = () => child.exitCode !== null || Boolean(child.signalCode);
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    child.kill(signal); // exclusively the child spawned by this launch
    if (exited()) return;
    await new Promise(resolve => {
      const finished = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { child.off('exit', finished); resolve(); }, 1000);
      child.once('exit', finished);
    });
    if (exited()) return;
  }
  throw Error('RECOVERY_CHILD_EXIT_UNCONFIRMED');
}
function childEnv(env) {
  const result = {};
  for (const name of ['HOME', 'USER', 'PATH', 'LANG', 'PROMATE_HOME', 'PROMATE_CONFIG']) {
    if (env[name]) result[name] = env[name];
  }
  return result;
}
async function launch(dir, platform, env) {
  const id = randomUUID();
  const script = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [script, '--page', id, platform], {
    detached: true, cwd: dirname(script), env: childEnv(env), stdio: ['ignore', 'pipe', 'ignore'],
  });
  let stdout = '';
  try {
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('RECOVERY_START_TIMEOUT')), 5000);
      const fail = () => { clearTimeout(timer); reject(Error('RECOVERY_START_FAILED')); };
      child.once('error', fail); child.once('exit', fail);
      child.stdout.on('data', chunk => {
        stdout += chunk.toString('utf8');
        if (stdout.length > 2048) { fail(); return; }
        const newline = stdout.indexOf('\n');
        if (newline < 0) return;
        clearTimeout(timer);
        try { resolve(JSON.parse(stdout.slice(0, newline))); }
        catch { reject(Error('RECOVERY_RESULT_INVALID')); }
      });
    });
    if (!ready?.ok || ready.id !== id || ready.pid !== child.pid || ready.platform !== platform
      || !current(dir, ready, platform) || !await probe(dir, ready, platform)) throw Error('RECOVERY_NOT_READY');
    child.stdout.destroy();
    child.unref();
    return handle(dir, ready);
  } catch (error) {
    // Only our freshly spawned child; never touch an unknown WB process.
    await stopOwnedChild(child); // a late child must not republish after the parent releases its start lock
    try { await removeOwnRecord(dir, id); } catch { /* guarded next use */ }
    throw error;
  }
}
export async function getRecoveryPage(platform, env = process.env) {
  const dir = rootDir();
  if (resolveUrl(readConfig(true)) !== platform) throw Error('RECOVERY_SOURCE_CHANGED');
  return withStartLock(dir, async () => {
    const existing = record(dir);
    if (await probe(dir, existing, platform)) return handle(dir, existing);
    if (resolveUrl(readConfig(true)) !== platform) throw Error('RECOVERY_SOURCE_CHANGED');
    return launch(dir, platform, env);
  });
}
async function serve(id, platform) {
  const dir = rootDir();
  if (!uuid(id) || resolveUrl(readConfig(true)) !== platform) throw Error('RECOVERY_SOURCE_CHANGED');
  let entry, page, watcher;
  page = await startConfigPage({ keepAlive: true, requestedUrl: platform, ownerTag: id,
    isCurrent: () => entry ? current(dir, entry, platform) : false,
    onDone: () => {
      clearInterval(watcher);
      void removeOwnRecord(dir, id).catch(() => { /* next request validates record and owner */ });
    } });
  entry = { id, uid: process.getuid(), pid: process.pid, profile: dir, platform, url: page.url,
    createdAt: Date.now(), expiresAt: page.expiresAt };
  try {
    await withRecordLock(dir, () => atomic(join(dir, 'page.json'), entry));
    if (!await probe(dir, entry, platform)) throw Error('RECOVERY_PAGE_UNREACHABLE');
    watcher = setInterval(() => { if (!current(dir, entry, platform)) page.close('PRIVATE_PAGE_FAILED'); }, 500);
    // The IPC pipe carries only a short-lived local URL/status and closes before the proxy replies.
    process.stdout.write(JSON.stringify({ ...entry, ok: true }) + '\n', () => process.stdout.end());
  } catch (error) {
    page.close('PRIVATE_PAGE_UNAVAILABLE');
    try { await removeOwnRecord(dir, id); } catch { /* guarded next use */ }
    throw error;
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv[2] === '--page') {
  serve(process.argv[3], process.argv[4]).catch(() => { process.exitCode = 1; });
}

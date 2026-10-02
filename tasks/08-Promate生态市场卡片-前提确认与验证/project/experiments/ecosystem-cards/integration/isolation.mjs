import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, chmodSync, writeFileSync, unlinkSync, symlinkSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { requireSafe } from '../fs-safety.mjs';

export const APP = '/Applications/WorkBuddy.app/Contents';
export const ELECTRON = APP + '/MacOS/Electron';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function allocatePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
export function createIsolation() {
  const root = mkdtempSync('/private/tmp/loop-card-host-'); chmodSync(root, 0o700);
  const token = randomUUID(); writeFileSync(join(root, '.owner'), token, { flag: 'wx', mode: 0o600 });
  for (const name of ['home', 'profile', 'user-data', 'tmp', 'workspace', 'data', 'xdg']) mkdirSync(join(root, name), { mode: 0o700 });
  return { root, token, profile: join(root, 'profile') };
}
export function sandboxPolicy(root, ports) {
  const quote = JSON.stringify;
  return [
    '(version 1)', '(allow default)',
    `(deny file-read-data file-read-xattr (subpath "/Users") (subpath "/Volumes") (subpath "/private/var/root") (subpath "/private/var/folders") (subpath "/private/var/tmp") (subpath "/Library/Keychains") (require-all (subpath "/private/tmp") (require-not (subpath ${quote(root)}))))`,
    `(deny file-write* (require-all (require-not (subpath ${quote(root)})) (require-not (literal "/dev/null")) (require-not (literal "/dev/tty"))))`,
    '(deny network-outbound (require-all ' + ports.map(p => `(require-not (remote ip "localhost:${p}"))`).join(' ')
      + ` (require-not (remote unix-socket (subpath ${quote(root)})))))`,
    ...['network-bind', 'network-inbound'].map(op => `(deny ${op} (require-all ${ports.map(p => `(require-not (local ip "localhost:${p}"))`).join(' ')} (require-not (local unix-socket (subpath ${quote(root)})))))`),
    '(deny user-preference-read user-preference-write)',
    '(deny ipc-posix-shm-read-data ipc-posix-shm-write-data (ipc-posix-name-regex #"^apple\\\\.cfprefs"))',
    '(deny mach-lookup (global-name "com.apple.securityd") (global-name "com.apple.security.agent") (global-name "com.apple.cfprefsd.agent"))',
    '(deny appleevent-send)',
    '(deny process-info* (target others))',
  ].join('\n') + '\n';
}
export function environment(root, cdpPort) {
  // Allowlist, not an inherited environment: no account, token, proxy, hooks or model configuration.
  return {
    HOME: join(root, 'home'), USER: 'loop-card-test', PATH: '/usr/bin:/bin:/usr/sbin:/sbin', SHELL: '/bin/bash', LANG: 'en_US.UTF-8',
    TMPDIR: join(root, 'tmp'), TMP: join(root, 'tmp'), TEMP: join(root, 'tmp'),
    // Native Chromium on macOS uses this supported temp override, not Node's TMPDIR.
    // Keep its Singleton socket inside the same sandbox; do not disable the native lock.
    MAC_CHROMIUM_TMPDIR: join(root, 'tmp'),
    WORKBUDDY_CONFIG_DIR: join(root, 'profile'), CODEBUDDY_CONFIG_DIR: join(root, 'profile'),
    WORKBUDDY_USER_DATA_DIR: join(root, 'user-data'), WORKBUDDY_REMOTE_DEBUGGING_PORT: String(cdpPort),
    // The vendor's E2E switch prevents its detached startup-repair job; it does not disable the sandbox or lock.
    WB_E2E_DISABLE_STARTUP_REPAIR: 'true',
    CODEBUDDY_DATA_ROOT: join(root, 'data'), XDG_CONFIG_HOME: join(root, 'xdg'), XDG_CACHE_HOME: join(root, 'xdg/cache'),
    CODEBUDDY_DISABLE_COMPILE_CACHE: '1', CODEBUDDY_CREDENTIALS_IN_MEMORY: '1', CODEBUDDY_API_KEY_HELPER_DISABLED: '1',
    CODEBUDDY_DISABLE_LOCAL_STORAGE: '1', CODEBUDDY_SKIP_BUILTIN_MARKETPLACE: '1', DISABLE_TELEMETRY: '1',
  };
}
export async function runBounded(command, args, options, timeout = 15000) {
  const child = spawn(command, args, { ...options, detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', error, timedOut = false;
  child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
  child.on('error', e => { error = e.message; });
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeout);
  const killer = setTimeout(() => { child.kill('SIGKILL'); }, timeout + 3000);
  const exit = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  clearTimeout(timer); clearTimeout(killer);
  return { pid: child.pid, ...exit, timedOut, error, stdout, stderr };
}
export async function confirmBoundary(isolation, cdpPort) {
  const { root } = isolation;
  const canaryRoot = mkdtempSync('/private/tmp/loop-card-canary-'); chmodSync(canaryRoot, 0o700);
  const canary = join(canaryRoot, 'fictional.txt'), link = join(root, 'outside-link');
  writeFileSync(canary, 'fictional isolation canary'); symlinkSync(canary, link);
  const blocked = createServer(), allowed = createServer(socket => { socket.end('owned-loopback'); });
  const outsideSocket = join(canaryRoot, 'outside.sock'), outsideUnix = createServer(socket => socket.end('must-not-connect'));
  await new Promise(resolve => blocked.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => allowed.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => outsideUnix.listen(outsideSocket, resolve));
  const allowPort = allowed.address().port, blockedPort = blocked.address().port;
  const sandbox = join(root, 'sandbox.sb');
  writeFileSync(sandbox, sandboxPolicy(root, [cdpPort, allowPort]), { mode: 0o600 });
  const code = String.raw`
const fs=require('fs'),cp=require('child_process'),net=require('net');
const [root,canary,link,allowPort,blockedPort,outsideSocket]=process.argv.slice(1), result={};
const denied=operation=>{try{operation();return false;}catch(e){return ['EPERM','EACCES'].includes(e.code);}};
result.outsideRead=denied(()=>fs.readFileSync(canary)); result.symlinkRead=denied(()=>fs.readFileSync(link));
result.outsideWrite=denied(()=>fs.writeFileSync(canary,'forbidden'));
fs.writeFileSync(root+'/inside-canary','owned');result.insideReadWrite=fs.readFileSync(root+'/inside-canary','utf8')==='owned';
const c=cp.spawnSync('/bin/cat',[canary],{encoding:'utf8'});result.inheritedChildBoundary=c.status!==0&&!c.stdout&&/permitted|denied/i.test(c.stderr);
async function connect(port,allowed){return new Promise(resolve=>{const c=net.connect({host:'127.0.0.1',port:Number(port)});let text='';c.on('data',b=>text+=b);c.on('end',()=>resolve(allowed&&text==='owned-loopback'));c.on('error',e=>resolve(!allowed&&['EPERM','EACCES'].includes(e.code)));c.setTimeout(2000,()=>{c.destroy();resolve(false);});});}
async function unixRoundtrip(){const path=root+'/tmp/boundary.sock',server=net.createServer(c=>c.end('owned-unix'));return new Promise(resolve=>{server.on('error',()=>resolve(false));server.listen(path,()=>{const c=net.connect(path);let text='';c.on('data',b=>text+=b);c.on('end',()=>server.close(()=>resolve(text==='owned-unix')));c.on('error',()=>server.close(()=>resolve(false)));});});}
async function deniedUnix(){return new Promise(resolve=>{const c=net.connect(outsideSocket);c.on('connect',()=>{c.destroy();resolve(false);});c.on('error',e=>resolve(['EPERM','EACCES'].includes(e.code)));c.setTimeout(2000,()=>{c.destroy();resolve(false);});});}
(async()=>{result.ownedLoopback=await connect(allowPort,true);result.otherLoopbackDenied=await connect(blockedPort,false);result.ownedUnixSocket=await unixRoundtrip();result.otherUnixSocketDenied=await deniedUnix();console.log(JSON.stringify({node:process.version,electron:process.versions.electron,uid:process.getuid(),checks:result}));process.exit(Object.values(result).every(Boolean)?0:1);})();
`;
  let result;
  try {
    result = await runBounded('/usr/bin/sandbox-exec', ['-f', sandbox, ELECTRON, '-e', code, root, canary, link, String(allowPort), String(blockedPort), outsideSocket],
      { cwd: join(root, 'workspace'), env: { ...environment(root, cdpPort), ELECTRON_RUN_AS_NODE: '1' } });
    result.canaryUnchanged = readFileSync(canary, 'utf8') === 'fictional isolation canary';
    result.pass = result.code === 0 && !result.signal && !result.timedOut && result.canaryUnchanged;
  } finally {
    await Promise.all([new Promise(r => blocked.close(r)), new Promise(r => allowed.close(r)), new Promise(r => outsideUnix.close(r))]);
    unlinkSync(link);
  }
  // Preserve the canary and policy for independent inspection; remove the temporary link only.
  return { ...result, canaryRoot, sandboxPolicy: readFileSync(sandbox, 'utf8') };
}
function processRows() {
  const run = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,uid=,lstart=,command='], { encoding: 'utf8', timeout: 5000 });
  requireSafe(run.status === 0, 'PROCESS_INVENTORY_FAILED');
  return run.stdout.trim().split('\n').map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.{24})\s+(.*)$/.exec(line);
    return match && { pid: +match[1], ppid: +match[2], pgid: +match[3], uid: +match[4], start: match[5], command: match[6] };
  }).filter(Boolean);
}
export class ManagedDesktop {
  constructor(isolation, port, log) { this.isolation = isolation; this.port = port; this.log = log; this.owned = new Map(); }
  track() {
    const rows = processRows();
    const known = new Set(rows.filter(p => this.owned.get(p.pid)?.start === p.start && p.uid === process.getuid()).map(p => p.pid));
    if (this.child?.pid && !this.exit && !this.owned.has(this.child.pid)) known.add(this.child.pid);
    let added;
    do {
      added = false;
      for (const p of rows) if (p.uid === process.getuid() && (known.has(p.pid) || known.has(p.ppid))) {
        if (!known.has(p.pid)) { known.add(p.pid); added = true; }
        const previous = this.owned.get(p.pid);
        if (!previous || previous.start === p.start) this.owned.set(p.pid, p);
      }
    } while (added);
    const live = rows.filter(p => this.owned.get(p.pid)?.start === p.start);
    if (this.parentGroup !== undefined && live.some(p => p.pgid !== this.parentGroup)) this.detachedDetected = true;
    return live;
  }
  start() {
    const parent = processRows().find(p => p.pid === process.pid && p.uid === process.getuid());
    requireSafe(parent, 'PARENT_PROCESS_IDENTITY_UNPROVEN'); this.parentGroup = parent.pgid;
    const { root } = this.isolation;
    this.child = spawn('/usr/bin/sandbox-exec', ['-f', join(root, 'sandbox.sb'), ELECTRON, '--user-data-dir=' + join(root, 'user-data')],
      { cwd: join(root, 'workspace'), env: environment(root, this.port), detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child.stdout.on('data', b => this.log('stdout', b)); this.child.stderr.on('data', b => this.log('stderr', b));
    this.child.on('error', e => { this.error = e.message; });
    this.closed = new Promise(resolve => this.child.once('close', (code, signal) => { this.exit = { code, signal }; resolve(this.exit); }));
    this.tracker = setInterval(() => { try { this.track(); } catch (e) { this.trackingError = e.message; } }, 250);
    this.track();
  }
  proveListener() {
    const owned = this.track();
    requireSafe(!this.detachedDetected && !this.trackingError, 'CHILD_PROCESS_BOUNDARY_UNPROVEN');
    const run = spawnSync('/usr/sbin/lsof', ['-nP', '-a', '-iTCP:' + this.port, '-sTCP:LISTEN', '-Fp'], { encoding: 'utf8', timeout: 5000 });
    const pids = [...run.stdout.matchAll(/^p(\d+)$/gm)].map(m => Number(m[1]));
    return pids.length === 1 && owned.some(p => p.pid === pids[0]) ? { port: this.port, pid: pids[0], process: owned.find(p => p.pid === pids[0]) } : null;
  }
  async stop() {
    clearInterval(this.tracker);
    requireSafe(readFileSync(join(this.isolation.root, '.owner'), 'utf8') === this.isolation.token, 'CLEANUP_ROOT_OWNER_UNPROVEN');
    let live = this.track();
    const signal = (rows, name) => { for (const p of rows.sort((a, b) => b.pid - a.pid)) {
      // Re-check start-time to avoid signalling an unrelated process after PID reuse.
      if (processRows().some(q => q.pid === p.pid && q.start === p.start && q.uid === p.uid)) try { process.kill(p.pid, name); } catch (e) { if (e.code !== 'ESRCH') throw e; }
    } };
    signal(live, 'SIGTERM');
    for (let i = 0; i < 30; i++) { await wait(100); live = this.track(); if (!live.length) break; }
    if (live.length) { signal(live, 'SIGKILL'); await wait(500); }
    if (this.child && !this.exit) await Promise.race([this.closed, wait(3000)]);
    const remaining = this.track();
    return { stopped: remaining.length === 0 && !this.trackingError && (!this.child || !!this.exit), remaining,
      exit: this.exit, processes: [...this.owned.values()], trackingError: this.trackingError,
      parentProcessGroup: this.parentGroup, detachedDetected: !!this.detachedDetected };
  }
}

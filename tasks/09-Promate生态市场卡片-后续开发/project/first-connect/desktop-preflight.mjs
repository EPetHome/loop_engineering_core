#!/usr/bin/env node
// Read-only WorkBuddy desktop diagnostic. Never print environment values, process commands or credentials.
import { execFileSync } from 'node:child_process';
import { realpathSync, lstatSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export class PreflightFailure extends Error {
  constructor(code, stage) { super(code); this.code = code; this.stage = stage; }
}
const requireCondition = (ok, code, stage) => { if (!ok) throw new PreflightFailure(code, stage); };
export function inspectContext(env) {
  requireCondition(env.CODEBUDDY_HOST === 'workbuddy-desktop', 'DESKTOP_HOST_CONTEXT_MISSING', 'context');
  requireCondition(!!env.CODEBUDDY_CONFIG_DIR && !!env.WORKBUDDY_CONFIG_DIR, 'PROFILE_CONTEXT_MISSING', 'profile');
  requireCondition(env.CODEBUDDY_CONFIG_DIR === env.WORKBUDDY_CONFIG_DIR, 'PROFILE_CONTEXT_CONFLICT', 'profile');
  // Brokered shell deliberately removes SERVER__PORT and gateway auth on some host versions.
  // Without an authenticated binding to THIS session, never guess a listener or read settings credentials.
  requireCondition(!!env.SERVER__PORT && !!env.SERVER__HOST, 'LISTENER_CONTEXT_MISSING', 'listener');
  const port = Number(env.SERVER__PORT);
  requireCondition(env.SERVER__HOST === '127.0.0.1' && Number.isInteger(port) && port > 0 && port <= 65535,
    'LISTENER_CONTEXT_INVALID', 'listener');
  requireCondition(env.CODEBUDDY_GATEWAY_AUTH === 'password' && !!env.CODEBUDDY_GATEWAY_PASSWORD,
    'CONTROL_CONTEXT_MISSING', 'control');
  return port;
}
const ps = (pid, field) => execFileSync('/bin/ps', ['-p', String(pid), '-o', `${field}=`],
  { encoding: 'utf8', timeout: 2500 }).trim();
async function run() {
  let stage = 'context';
  try {
    const env = process.env;
    const port = inspectContext(env);
    stage = 'profile';
    const profile = realpathSync(env.CODEBUDDY_CONFIG_DIR);
    requireCondition(!lstatSync(env.CODEBUDDY_CONFIG_DIR).isSymbolicLink()
      && lstatSync(profile).uid === process.getuid(), 'PROFILE_IDENTITY_UNPROVEN', stage);
    stage = 'listener';
    let listenerOutput;
    try {
      listenerOutput = execFileSync('/usr/sbin/lsof', ['-nP', '-a', '-iTCP:' + port, '-sTCP:LISTEN', '-F', 'p'],
        { encoding: 'utf8', timeout: 2500 });
    } catch { throw new PreflightFailure('LISTENER_OWNER_UNPROVEN', stage); }
    const owners = [...new Set((listenerOutput.match(/^p\d+$/gm) || []).map(x => Number(x.slice(1))))];
    requireCondition(owners.length === 1, 'LISTENER_OWNER_UNPROVEN', stage);
    const pid = owners[0];
    stage = 'process';
    let parent = process.pid;
    let bound = false;
    try {
      for (let depth = 0; depth < 16 && parent > 1; depth++) {
        if (parent === pid) { bound = true; break; }
        parent = Number(ps(parent, 'ppid'));
      }
    } catch { throw new PreflightFailure('SESSION_OWNER_UNPROVEN', stage); }
    requireCondition(bound, 'SESSION_OWNER_UNPROVEN', stage);
    let command;
    try { command = ps(pid, 'command'); }
    catch { throw new PreflightFailure('HOST_RUNTIME_UNSUPPORTED', stage); }
    requireCondition(command.includes('/Applications/WorkBuddy.app/Contents/') && command.includes('--serve'),
      'HOST_RUNTIME_UNSUPPORTED', stage);
    stage = 'control';
    let response;
    try {
      response = await fetch(`http://127.0.0.1:${port}/api/v1/envs`, {
        headers: { 'x-codebuddy-request': '1', Authorization: `Bearer ${env.CODEBUDDY_GATEWAY_PASSWORD}` },
        redirect: 'error', signal: AbortSignal.timeout(3000),
      });
    } catch { throw new PreflightFailure('CONTROL_API_UNAVAILABLE', stage); }
    requireCondition(response.ok, response.status === 401 || response.status === 403
      ? 'CONTROL_AUTH_REJECTED' : 'CONTROL_API_UNAVAILABLE', stage);
    stage = 'identity';
    let identity;
    try { identity = await response.json(); }
    catch { throw new PreflightFailure('CONTROL_RESPONSE_INVALID', stage); }
    const data = identity?.data ?? identity;
    requireCondition(data && typeof data === 'object' && !Array.isArray(data), 'CONTROL_RESPONSE_INVALID', stage);
    requireCondition(data?.CODEBUDDY_HOST === 'workbuddy-desktop'
      && data.CODEBUDDY_CONFIG_DIR === profile && data.WORKBUDDY_CONFIG_DIR === profile
      && String(data.SERVER__PORT) === String(port), 'CONTROL_IDENTITY_UNPROVEN', stage);
    const registry = join(profile, 'plugins/installed_plugins.json');
    const manifest = existsSync(registry)
      ? JSON.parse(readFileSync(registry, 'utf8')) : { plugins: {} };
    const entry = manifest.plugins?.['promate@promate'];
    console.log(JSON.stringify({ ok: true, stage: 'desktop-target', code: 'DESKTOP_READ_ONLY_CONFIRMED',
      pluginRegistered: Boolean(entry), permission: 'read-only', installation: 'not attempted' }));
  } catch (error) {
    // Parsing failures, filesystem errors and fetch failures never expose input or response bodies.
    console.log(JSON.stringify({ ok: false, stage: error instanceof PreflightFailure ? error.stage : stage,
      code: error instanceof PreflightFailure ? error.code : 'DESKTOP_DIAGNOSTIC_ERROR' }));
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await run();

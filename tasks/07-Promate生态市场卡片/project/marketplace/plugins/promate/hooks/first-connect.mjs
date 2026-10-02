// SessionStart continuation; it never reads the Key, controls WorkBuddy or claims MCP readiness.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { claimFirstConnect, failFirstConnect } from '../mcp/first-connect.mjs';

export async function resumeFirstConnect({ pluginRoot, version, spawnPage = spawn } = {}) {
  let claim;
  try { claim = claimFirstConnect({ pluginRoot, version }); }
  catch { return 'HANDOFF_UNAVAILABLE'; }
  if (!claim) return null;
  const env = {};
  for (const key of ['HOME', 'USER', 'PATH', 'LANG', 'PROMATE_HOME', 'PROMATE_CONFIG']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return new Promise(resolve => {
    let settled = false, timer;
    const finish = ready => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!ready) {
        try { failFirstConnect(claim); } catch { /* retain claim for controlled recovery */ }
      }
      resolve(ready ? 'PRIVATE_PAGE_STARTING' : 'PRIVATE_PAGE_UNAVAILABLE');
    };
    try {
      const child = spawnPage(process.execPath, [join(claim.root, 'mcp/handoff-page.mjs'),
        Buffer.from(JSON.stringify(claim)).toString('base64url')],
      { cwd: claim.root, env, detached: true, stdio: ['ignore', 'ignore', 'ignore'] });
      // Bind before inspecting pid; ENOENT/EACCES can arrive on the next tick.
      child.on('error', () => finish(false));
      child.once('exit', () => finish(false));
      child.once('spawn', () => {
        if (!child.pid) { finish(false); return; }
        try { child.unref(); finish(true); } // spawn only, not page/browser/MCP readiness
        catch { finish(false); }
      });
      timer = setTimeout(() => finish(false), 1200);
    } catch { finish(false); }
  });
}

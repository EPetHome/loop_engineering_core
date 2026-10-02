#!/usr/bin/env node
// Short-lived detached page owner. Never log or hand the private URL to the model.
import { spawnSync } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { activeFirstConnect, finishFirstConnect, publishFirstConnect, restoreFirstConnect,
  withCurrentSubmission } from './first-connect.mjs';
import { startConfigPage } from './local-config.mjs';

export async function serveHandoffPage(claim, open = spawnSync) {
  if (!activeFirstConnect(claim)) throw Error('HANDOFF_REPLACED');
  let started = false;
  const page = await startConfigPage({ keepAlive: true, requestedUrl: claim.request.platform,
    isCurrent: () => activeFirstConnect(claim), withSubmission: action => withCurrentSubmission(claim, action),
    onDone: code => {
      if (!started) {
        try { publishFirstConnect(claim, 'PRIVATE_PAGE_UNAVAILABLE'); restoreFirstConnect(claim); }
        catch { /* next connect can retry */ }
        return;
      }
      try { finishFirstConnect(claim, code); }
      catch { /* A failure cannot authorize another request. */ }
      try { if (existsSync(claim.claim)) unlinkSync(claim.claim); } catch { /* only our claim */ }
    } });
  try {
    const reply = await fetch(page.url, { signal: AbortSignal.timeout(1500) });
    if (reply.status !== 200 || !activeFirstConnect(claim)) throw Error('PAGE_NOT_REACHABLE');
    const run = open('/usr/bin/open', [page.url], { stdio: 'ignore', timeout: 5000 });
    const dispatched = !run.error && run.status === 0;
    // /usr/bin/open's exit status only proves dispatch, not a visible browser window.
    if (!dispatched || !publishFirstConnect(claim, 'PRIVATE_PAGE_OPENED', { pagePid: process.pid,
      browserLaunchRequested: true })) throw Error('PAGE_LAUNCH_FAILED');
    started = true;
    // Receipt is stored locally; never print the private link or claim success to the hook.
    return page;
  } catch {
    page.close('PRIVATE_PAGE_UNAVAILABLE');
    throw Error('PAGE_LAUNCH_FAILED');
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const claim = JSON.parse(Buffer.from(process.argv[2], 'base64url').toString('utf8'));
  serveHandoffPage(claim).catch(() => {
    try {
      publishFirstConnect(claim, 'PRIVATE_PAGE_UNAVAILABLE');
      restoreFirstConnect(claim);
    } catch { /* only a newer explicit request can retry if ownership was lost */ }
    process.exitCode = 1;
  });
}

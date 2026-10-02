import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { confirmCandidate } from './candidate.mjs';

const root = mkdtempSync('/private/tmp/loop-card-preflight-');
let checks = 0;
try {
  const code = join(root, 'mixedCase'), script = join(code, 'experiments/ecosystem-cards/integration/index.mjs');
  mkdirSync(dirname(script), { recursive: true }); writeFileSync(script, '// isolated identity fixture\n');
  const correct = { moduleURL: pathToFileURL(script).href, entryPath: script, cwd: code };
  const verified = confirmCandidate(correct);
  assert.equal(verified.candidateCodeRoot, code); checks++;
  const outside = join(root, 'outside'); mkdirSync(outside);
  assert.throws(() => confirmCandidate({ ...correct, cwd: outside }), /CANDIDATE_CWD_CONFLICT/); checks++;
  const wrongScript = join(root, 'wrong.mjs'); writeFileSync(wrongScript, '// not the candidate\n');
  assert.throws(() => confirmCandidate({ ...correct, entryPath: wrongScript }), /CANDIDATE_ENTRY_CONFLICT/); checks++;
  symlinkSync(code, join(root, 'link'));
  assert.throws(() => confirmCandidate({ ...correct, cwd: join(root, 'link') }), /SYMLINK_REJECTED/); checks++;
  if (process.platform === 'darwin') {
    // Only accept this alias if the filesystem actually resolves it to the same directory.
    const variant = code.replace('mixedCase', 'MIXEDCASE');
    const result = confirmCandidate({ ...correct, entryPath: script.replace(code, variant), cwd: variant });
    assert.equal(result.moduleRoot.ino, result.workingRoot.ino);
    assert.equal(result.candidateCodeRoot, variant); checks++;
  }
  const entry = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');
  for (const mode of ['full', 'preflight']) {
    const workspace = join(root, mode), reportPath = join(workspace, 'host-result.json');
    const run = spawnSync(process.execPath, [entry, '--workspace', workspace, '--report', reportPath,
      ...(mode === 'preflight' ? ['--preflight-only'] : [])], { cwd: outside, encoding: 'utf8', timeout: 10000 });
    assert.equal(run.status, 1); assert.equal(run.signal, null);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.equal(report.mode, mode); assert.equal(report.status, 'UNKNOWN');
    assert.equal(report.failure.reason, 'CANDIDATE_CWD_CONFLICT');
    assert.equal(report.candidateBoundaryConfirmed, false); assert.equal(report.desktopStartAttempted, false);
    assert.equal(report.profile, null); assert.equal(report.managedProcessesStopped, true);
    assert.equal(report.otherResourcesUnchanged, null);
    assert.equal(report.steps.length, 7);
    for (const step of report.steps) {
      assert.equal(step.status, 'UNKNOWN'); assert.equal(step.screenshotPath, null); assert.equal(step.attempted, false);
      const raw = JSON.parse(readFileSync(step.rawEvidencePath, 'utf8'));
      assert.equal(raw.attempted, false); assert.equal(raw.reason, 'CANDIDATE_CWD_CONFLICT');
    }
    if (mode === 'preflight') {
      const raw = JSON.parse(readFileSync(report.preflight.rawEvidencePath, 'utf8'));
      assert.equal(raw.mode, mode); assert.equal(raw.status, 'UNKNOWN');
      assert.equal(raw.businessStepsAttempted, false); assert.equal(raw.desktopStartAttempted, false);
      assert.equal(raw.actualLaunch, null); assert.equal(raw.plannedLaunch, null);
      assert.equal(raw.preflight.profileIsolated, null); assert.equal(raw.preflight.nativeProtectionRetained, null);
      assert.equal(raw.preflight.marketPanelVisible, null); assert.equal(raw.preflight.screenshotPath, null);
      assert.equal(raw.failure.reason, 'CANDIDATE_CWD_CONFLICT'); assert.equal(raw.cleanup.stopped, true);
    }
    assert.equal(JSON.parse(readFileSync(join(report.evidenceRoot, 'recovery.json'), 'utf8')).isolationRoot, null);
    checks++;
  }
  console.log(JSON.stringify({ status: 'PASS', checks, scope: 'filesystem alias identity and preflight failure reports; no desktop started' }));
} finally { rmSync(root, { recursive: true, force: true }); }

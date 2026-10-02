// Direct-execution guard fixtures ONLY; no desktop, sandbox probe, model or external service starts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const code = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const acceptance = join(code, 'acceptance/check.mjs'), entry = join(code, 'experiments/ecosystem-cards/integration/index.mjs');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const run = (script, args, cwd = code) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', timeout: 30000 });
function root(t) {
  const path = mkdtempSync('/private/tmp/loop-card-direct-unit-');
  t.after(() => rmSync(path, { recursive: true, force: true })); return path;
}

test('direct full entry persists a naming block before creating a profile or launching desktop', t => {
  const workspace = root(t), reportPath = join(workspace, 'report.json');
  const child = run(entry, ['--workspace', workspace, '--report', reportPath]);
  assert.equal(child.status, 1); assert.equal(child.signal, null);
  const report = json(reportPath);
  assert.equal(report.failure.reason, 'NAME_SCHEME_UNCONFIRMED');
  assert.equal(report.verificationScope, 'unconfirmed-product-name'); assert.equal(report.businessAcceptance, 'NOT_VERIFIED');
  assert.equal(report.candidateBoundaryConfirmed, true); assert.equal(report.candidateUnchanged, true);
  assert.equal(report.desktopStartAttempted, false); assert.equal(report.profile, null);
  assert.equal(report.managedProcessesStopped, true); assert.equal(report.nonTargetBaselineConfirmed, false);
  assert.equal(report.otherResourcesUnchanged, null);
  assert.ok(report.steps.every(step => step.attempted === false && step.status === 'UNKNOWN'));
});

test('host guard executes genuine core checks in a direct workspace without a Loop receipt', t => {
  const workspace = root(t), child = run(acceptance, ['host', code, workspace]);
  assert.equal(child.status, 1); assert.equal(child.signal, null);
  assert.match(child.stderr, /NAME_SCHEME_UNCONFIRMED/); assert.doesNotMatch(child.stderr, /G1|G2|invoked by Loop/);
  const core = json(join(workspace, 'core-result.json'));
  assert.equal(core.status, 'PASS'); assert.equal(core.exitCode, 0); assert.equal(core.candidateUnchanged, true);
  assert.equal(core.candidateCodeRoot, code); assert.match(core.candidateDigest, /^[a-f0-9]{64}$/);
  const output = readFileSync(join(workspace, 'core.stdout.log'), 'utf8');
  for (const label of ['PASS A', 'PASS B', 'PASS resources']) assert.ok(output.includes(label), label);
  assert.equal(existsSync(join(workspace, 'host-result.json')), false);
  assert.equal(existsSync(join(workspace, 'host.stdout.log')), false);
});

test('a failing core prevents even an explicitly requested technical host probe', t => {
  const fixture = root(t), fakeCode = join(fixture, 'code'), workspace = join(fixture, 'evidence');
  const feature = join(fakeCode, 'experiments/ecosystem-cards');
  mkdirSync(join(feature, 'card-generation'), { recursive: true, mode: 0o700 });
  mkdirSync(join(feature, 'integration'), { recursive: true, mode: 0o700 });
  writeFileSync(join(feature, 'card-generation/index.mjs'), "export async function generateMarket(){throw new Error('intentional core fixture failure');}\n");
  // Reuse the actual filesystem fingerprint implementation, not a fabricated core receipt.
  writeFileSync(join(feature, 'integration/evidence.mjs'), `export {fingerprint,sha} from ${JSON.stringify(pathToFileURL(join(code, 'experiments/ecosystem-cards/integration/evidence.mjs')).href)};\n`);
  const marker = join(fixture, 'would-have-launched');
  writeFileSync(join(feature, 'integration/index.mjs'), `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},'fixture invoked');\n`);
  const child = run(acceptance, ['host', fakeCode, workspace, '--technical-probe'], fakeCode);
  assert.equal(child.status, 1); assert.equal(child.signal, null); assert.match(child.stderr, /CORE_CHECKS_FAILED/);
  const core = json(join(workspace, 'core-result.json'));
  assert.equal(core.status, 'FAIL'); assert.equal(core.exitCode, 1);
  assert.match(readFileSync(join(workspace, 'core.stderr.log'), 'utf8'), /intentional core fixture failure/);
  assert.equal(existsSync(marker), false); assert.equal(existsSync(join(workspace, 'host-result.json')), false);
});

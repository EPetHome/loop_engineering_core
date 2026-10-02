import { test } from 'node:test';
import { spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync, existsSync, lstatSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest, validateRelease, verifyInstalled, registered, publicUrl, acquireInstallLock, installNative, finalizeHandoffResult } from '../first-connect/native-install.mjs';
import { buildBootstrapCommand } from '../first-connect/bootstrap-template.mjs';
const sha = 'a'.repeat(64);
const release = { version: '0.2.8', packageSha256: sha,
  marketplace: `https://example.test/api/skills/plugins/marketplace-${sha}.zip`, files: { 'mcp/proxy.mjs': sha } };

test('native release requires immutable public transport, exact hashes and safe paths', () => {
  assert.equal(validateRelease(release), release);
  for (const marketplace of ['http://evil.test/package.zip', 'https://user:password@example.test/package.zip',
    'https://example.test/marketplace.zip', release.marketplace + '?key=fictional', release.marketplace + '#fragment']) {
    assert.throws(() => validateRelease({ ...release, marketplace }));
  }
  for (const name of ['../config.json', '/tmp/file', 'hooks/../../settings.json', 'hooks\\guard.mjs', 'a//b', '.in_use', '.in_use/76603']) {
    assert.throws(() => validateRelease({ ...release, files: { [name]: sha } }));
  }
  assert.throws(() => publicUrl('file:///tmp/marketplace.zip'));
});

test('downloaded pilot invoked through a path alias still executes main and fails closed outside desktop', () => {
  const root = mkdtempSync(join(tmpdir(), 'promate-pilot-alias-'));
  try {
    const alias = join(root, 'pilot.mjs');
    symlinkSync(fileURLToPath(new URL('../first-connect/native-install.mjs', import.meta.url)), alias);
    const result = spawnSync(process.execPath, [alias, '--preflight'], {
      env: { ...process.env, CODEBUDDY_HOST: '' }, encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).code, 'DESKTOP_CONTEXT_REQUIRED');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('fixed bootstrap rejects a zero-exit pilot without a valid JSON result', async () => {
  const code = 'process.exit(0)';
  const hash = digest(code);
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(req.url === '/connect' ? JSON.stringify({ pilotUrl: `/pilot-${hash}.mjs`, pilotSha256: hash }) : code);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/connect`;
    const run = await promisify(execFile)('/bin/bash', ['-c', buildBootstrapCommand(url)], {
      env: { ...process.env, PATH: `${process.execPath.slice(0, process.execPath.lastIndexOf('/'))}:${process.env.PATH}` },
      timeout: 10000,
    }).then(value => ({ ...value, exit: 0 }), error => ({ stdout: error.stdout, exit: error.code }));
    assert.equal(run.exit, 1);
    assert.equal(JSON.parse(run.stdout).code, 'BOOTSTRAP_PROGRAM_RESULT_MISSING');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('single-file lock retains its ownership record until deletion; retry cannot find an ownerless directory', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'promate-single-lock-')));
  try {
    const unlock = acquireInstallLock(root);
    const path = join(root, 'install.lock');
    assert.equal(lstatSync(path).isFile(), true);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).pid, process.pid);
    assert.throws(() => acquireInstallLock(root), { code: 'INSTALL_BUSY' });
    unlock();
    assert.equal(existsSync(path), false);
    const retry = acquireInstallLock(root);
    retry();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('exited single-file owner is recovered under an exclusive recovery guard', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'promate-file-recovery-')));
  try {
    const ended = spawnSync(process.execPath, ['-e', ''], { timeout: 5000 });
    writeFileSync(join(root, 'install.lock'), JSON.stringify({ pid: ended.pid, uid: process.getuid(),
      id: '11111111-1111-4111-8111-111111111111' }), { mode: 0o600 });
    const unlock = acquireInstallLock(root);
    assert.equal(lstatSync(join(root, 'install.lock')).isFile(), true);
    assert.equal(existsSync(join(root, 'recover.lock')), false);
    unlock();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('same-version installation repairs missing market using native add; repeated run preserves settings', async () => {
  const profile = realpathSync(mkdtempSync(join(tmpdir(), 'promate-repair-market-')));
  const manifest = JSON.stringify({ name: 'promate', version: '0.2.8' });
  const pinned = { ...release, files: { '.codebuddy-plugin/plugin.json': digest(manifest) } };
  const plugin = join(profile, 'plugins/cache/promate/promate/0.2.8');
  const marketRoot = join(profile, 'plugins/marketplaces/promate');
  const entry = { version: '0.2.8', scope: 'user', installPath: plugin };
  mkdirSync(join(plugin, '.codebuddy-plugin'), { recursive: true, mode: 0o700 });
  writeFileSync(join(plugin, '.codebuddy-plugin/plugin.json'), manifest);
  writeFileSync(join(profile, 'plugins/installed_plugins.json'), JSON.stringify({ plugins: { 'promate@promate': [entry] } }));
  writeFileSync(join(profile, 'config.json'), 'fictional untouched settings');
  const before = readFileSync(join(profile, 'config.json'), 'utf8');
  const server = createServer((_req, res) => res.end('fictional market transport'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  pinned.packageSha256 = digest('fictional market transport');
  pinned.marketplace = `http://127.0.0.1:${server.address().port}/marketplace-${pinned.packageSha256}.zip`;
  const calls = [];
  const command = (_target, args) => {
    calls.push(args.join(' '));
    if (args[0] === 'list') return JSON.stringify([{ id: 'promate@promate', version: '0.2.8', scope: 'user', installPath: plugin, enabled: true }]);
    assert.deepEqual(args, ['marketplace', 'add', pinned.marketplace, '--name', 'promate']);
    mkdirSync(join(marketRoot, '.codebuddy-plugin'), { recursive: true });
    mkdirSync(join(marketRoot, 'plugins/promate/.codebuddy-plugin'), { recursive: true });
    writeFileSync(join(marketRoot, '.codebuddy-plugin/marketplace.json'), JSON.stringify({ name: 'promate', owner: { name: 'Promate' },
      metadata: { version: '0.2.8' }, plugins: [{ name: 'promate', version: '0.2.8', source: './plugins/promate' }] }));
    writeFileSync(join(marketRoot, 'plugins/promate/.codebuddy-plugin/plugin.json'), manifest);
    writeFileSync(join(profile, 'plugins/known_marketplaces.json'), JSON.stringify({ promate: { manifestName: 'promate', type: 'zip',
      source: { url: pinned.marketplace }, installLocation: marketRoot } }));
    return '';
  };
  try {
    const repaired = await installNative({ profile }, pinned, process.env, undefined, command);
    assert.deepEqual(repaired.steps, ['marketplace']);
    assert.equal(repaired.initial, 'installed');
    const repeated = await installNative({ profile }, pinned, process.env, undefined, command);
    assert.deepEqual(repeated.steps, []);
    assert.equal(readFileSync(join(profile, 'config.json'), 'utf8'), before);
    assert.equal(calls.filter(call => call.startsWith('marketplace add')).length, 1);
    const manifestFile = join(marketRoot, '.codebuddy-plugin/marketplace.json');
    const marketManifest = readFileSync(manifestFile, 'utf8');
    writeFileSync(manifestFile, JSON.stringify({ ...JSON.parse(marketManifest), owner: { name: 'other' } }));
    await assert.rejects(installNative({ profile }, pinned, process.env, undefined, command), { code: 'MARKETPLACE_CONTENT_MISMATCH' });
    writeFileSync(manifestFile, marketManifest);
    writeFileSync(join(profile, 'plugins/known_marketplaces.json'), JSON.stringify({ promate: { manifestName: 'promate',
      type: 'zip', source: { url: 'https://other.example.test/marketplace.zip' }, installLocation: marketRoot } }));
    await assert.rejects(installNative({ profile }, pinned, process.env, undefined, command), { code: 'MARKETPLACE_SOURCE_CONFLICT' });
    writeFileSync(join(profile, 'plugins/known_marketplaces.json'), JSON.stringify({ promate: { manifestName: 'promate',
      type: 'zip', source: { url: `http://127.0.0.1:${server.address().port}/another-platform/marketplace.zip` }, installLocation: marketRoot } }));
    await assert.rejects(installNative({ profile }, pinned, process.env, undefined, command), { code: 'MARKETPLACE_SOURCE_CONFLICT' });
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(profile, { recursive: true, force: true }); }
});

test('native installation reports an intermediate restart state, never desktop/identity completion', () => {
  const pending = finalizeHandoffResult({ ok: true, code: 'INSTALL_WRITTEN',
    installed: true, enabled: true, loaded: false, version: '0.2.9' });
  assert.equal(pending.ok, true);
  assert.equal(pending.stage, 'awaiting_user_restart');
  assert.equal(pending.code, 'INSTALL_WRITTEN_RESTART_REQUIRED');
  assert.equal(pending.requestPending, true);
  assert.match(pending.message, /完全退出并重新打开/);
  assert.equal(pending.continueUrl, undefined);
  const reused = finalizeHandoffResult({ ok: true, code: 'INSTALL_WRITTEN', loaded: false, steps: [] }, true);
  assert.equal(reused.stage, 'awaiting_normal_session');
  assert.equal(reused.code, 'INSTALLED_TARGET_PROXY_READY');
  assert.match(reused.message, /无需再次安装或重启/);
});

test('installer lock rejects active and unknown owners, recovers only a proven exited process', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'promate-installer-lock-')));
  try {
    const release = acquireInstallLock(root);
    assert.throws(() => acquireInstallLock(root), { code: 'INSTALL_BUSY' });
    release();
    mkdirSync(join(root, 'install.lock'), { mode: 0o700 });
    assert.throws(() => acquireInstallLock(root), { code: 'INSTALL_OWNER_UNPROVEN' });
    assert.equal(existsSync(join(root, 'install.lock')), true); // unknown empty locks are never stolen
    const ended = spawnSync(process.execPath, ['-e', ''], { timeout: 5000 });
    writeFileSync(join(root, 'install.lock/owner.json'), JSON.stringify({ pid: ended.pid, uid: process.getuid(), id: '11111111-1111-4111-8111-111111111111' }), { mode: 0o600 });
    const recovered = acquireInstallLock(root);
    recovered();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('malformed local registry fails with a typed operation and releases only its own lock', async () => {
  const profile = realpathSync(mkdtempSync(join(tmpdir(), 'promate-native-io-')));
  try {
    mkdirSync(join(profile, 'plugins'), { mode: 0o700 });
    writeFileSync(join(profile, 'plugins/installed_plugins.json'), '{broken');
    await assert.rejects(installNative({ profile }, release), { code: 'LOCAL_REGISTRY_INVALID_JSON', operation: 'foreign-state' });
    assert.equal(existsSync(join(profile, 'plugins/.promate-first-connect/install.lock')), false);
  } finally { rmSync(profile, { recursive: true, force: true }); }
});

test('brokered cleanup interruption retains owner; original verification error survives and retry refuses active owner', async () => {
  const profile = realpathSync(mkdtempSync(join(tmpdir(), 'promate-native-release-')));
  const path = join(profile, 'plugins/.promate-first-connect/install.lock');
  try {
    mkdirSync(join(profile, 'plugins'), { mode: 0o700 });
    writeFileSync(join(profile, 'plugins/installed_plugins.json'), '{broken');
    let attempts = 0;
    const lockFactory = control => acquireInstallLock(control, file => {
      attempts++;
      if (attempts === 1) throw Object.assign(new Error('brokered unlink denied'), { code: 'EACCES' });
      unlinkSync(file);
    });
    await assert.rejects(installNative({ profile }, release, process.env, lockFactory),
      { code: 'LOCAL_REGISTRY_INVALID_JSON', operation: 'foreign-state' });
    assert.equal(lstatSync(path).isFile(), true);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).pid, process.pid);
    assert.throws(() => acquireInstallLock(join(profile, 'plugins/.promate-first-connect')), { code: 'INSTALL_BUSY' });
    // Only this test's owned lock is removed, after the owner was verified above.
    unlinkSync(path);
    const retry = acquireInstallLock(join(profile, 'plugins/.promate-first-connect'));
    retry();
  } finally { rmSync(profile, { recursive: true, force: true }); }
});

test('host .in_use PID marker is runtime state, not release payload; unknown files and links remain rejected', () => {
  const profile = realpathSync(mkdtempSync(join(tmpdir(), 'promate-runtime-marker-')));
  const plugin = join(profile, 'plugins/cache/promate/promate/0.2.8');
  const markerDir = join(plugin, '.in_use');
  mkdirSync(join(plugin, '.codebuddy-plugin'), { recursive: true });
  mkdirSync(markerDir);
  const manifest = JSON.stringify({ name: 'promate', version: '0.2.8' });
  writeFileSync(join(plugin, '.codebuddy-plugin/plugin.json'), manifest);
  const pinned = { ...release, files: { '.codebuddy-plugin/plugin.json': digest(manifest) } };
  const entry = { version: '0.2.8', scope: 'user', installPath: plugin };
  try {
    writeFileSync(join(markerDir, '76603'), JSON.stringify({ pid: 76603, procStart: 'fictional-start-id' }));
    assert.equal(verifyInstalled({ profile }, entry, pinned), plugin);
    const temporary = join(markerDir, '76603.tmp.1790690000000.abc123');
    writeFileSync(temporary, '{"pid":'); // Host writes JSON to this temporary path before atomic rename.
    assert.equal(verifyInstalled({ profile }, entry, pinned), plugin);
    rmSync(temporary);
    writeFileSync(join(plugin, '.codebuddy-plugin/plugin.json'), JSON.stringify({ name: 'promate', version: '0.2.8', changed: true }));
    assert.throws(() => verifyInstalled({ profile }, entry, pinned), { code: 'INSTALLED_INTEGRITY_MISMATCH' });
    writeFileSync(join(plugin, '.codebuddy-plugin/plugin.json'), manifest);
    assert.throws(() => verifyInstalled({ profile }, entry, { ...pinned,
      files: { ...pinned.files, 'mcp/missing.mjs': sha } }), { code: 'INSTALLED_FILES_MISMATCH' });
    writeFileSync(join(plugin, 'unknown.mjs'), 'not a published file');
    assert.throws(() => verifyInstalled({ profile }, entry, pinned), { code: 'INSTALLED_FILES_MISMATCH', extra: ['unknown.mjs'] });
    rmSync(join(plugin, 'unknown.mjs'));
    writeFileSync(join(plugin, '.other'), 'not a runtime marker');
    assert.throws(() => verifyInstalled({ profile }, entry, pinned), { code: 'INSTALLED_FILES_MISMATCH', extra: ['.other'] });
    rmSync(join(plugin, '.other'));
    writeFileSync(join(markerDir, 'unknown'), 'not a PID marker');
    assert.throws(() => verifyInstalled({ profile }, entry, pinned), { code: 'INSTALLED_RUNTIME_MARKER_INVALID' });
    rmSync(join(markerDir, 'unknown'));
    writeFileSync(join(markerDir, '76603.tmp.bad'), '{}');
    assert.throws(() => verifyInstalled({ profile }, entry, pinned), { code: 'INSTALLED_RUNTIME_MARKER_INVALID' });
    rmSync(join(markerDir, '76603.tmp.bad'));
    symlinkSync('/dev/null', temporary);
    assert.throws(() => verifyInstalled({ profile }, entry, pinned), { code: 'INSTALLED_SYMLINK_REJECTED' });
    rmSync(temporary);
    writeFileSync(join(markerDir, '76604'), JSON.stringify({ pid: 90000, procStart: 'wrong owner' }));
    assert.throws(() => verifyInstalled({ profile }, entry, pinned), { code: 'INSTALLED_RUNTIME_MARKER_INVALID' });
    rmSync(join(markerDir, '76604'));
    symlinkSync('/dev/null', join(markerDir, '76604'));
    assert.throws(() => verifyInstalled({ profile }, entry, pinned), { code: 'INSTALLED_SYMLINK_REJECTED' });
    rmSync(join(markerDir, '76604'));
    rmSync(markerDir, { recursive: true });
    symlinkSync('/tmp', markerDir);
    assert.throws(() => verifyInstalled({ profile }, entry, pinned), { code: 'INSTALLED_SYMLINK_REJECTED' });
  } finally { rmSync(profile, { recursive: true, force: true }); }
});

test('only the host runtime marker disappearing after enumeration is tolerated deterministically', () => {
  const profile = realpathSync(mkdtempSync(join(tmpdir(), 'promate-marker-race-')));
  const plugin = join(profile, 'plugins/cache/promate/promate/0.2.8');
  const markerDir = join(plugin, '.in_use');
  mkdirSync(join(plugin, '.codebuddy-plugin'), { recursive: true });
  mkdirSync(markerDir);
  const manifest = JSON.stringify({ name: 'promate', version: '0.2.8' });
  writeFileSync(join(plugin, '.codebuddy-plugin/plugin.json'), manifest);
  writeFileSync(join(markerDir, '76603'), JSON.stringify({ pid: 76603, procStart: 'fixture' }));
  const pinned = { ...release, files: { '.codebuddy-plugin/plugin.json': digest(manifest) } };
  const entry = { version: '0.2.8', scope: 'user', installPath: plugin };
  const gone = () => Object.assign(new Error('marker removed by WorkBuddy'), { code: 'ENOENT' });
  try {
    for (const [name, overrides] of [
      ['directory-stat', { stat: file => file === markerDir ? (() => { throw gone(); })() : lstatSync(file) }],
      ['directory-list', { list: file => file === markerDir ? (() => { throw gone(); })() : readdirSync(file) }],
      ['marker-stat', { stat: file => file === join(markerDir, '76603') ? (() => { throw gone(); })() : lstatSync(file) }],
      ['marker-read', { read: file => file === join(markerDir, '76603') ? (() => { throw gone(); })() : readFileSync(file, 'utf8') }],
    ]) {
      let calls = 0;
      const io = { stat: file => lstatSync(file), list: file => readdirSync(file), read: file => readFileSync(file, 'utf8') };
      for (const [op, method] of Object.entries(overrides)) io[op] = (...args) => { calls++; return method(...args); };
      assert.equal(verifyInstalled({ profile }, entry, pinned, io), plugin, name);
      assert.ok(calls > 0, name);
    }
    writeFileSync(join(markerDir, 'unknown'), 'not a host marker');
    assert.throws(() => verifyInstalled({ profile }, entry, pinned, {
      stat: file => file === join(markerDir, 'unknown') ? (() => { throw gone(); })() : lstatSync(file),
      list: readdirSync, read: readFileSync,
    }), { code: 'INSTALLED_RUNTIME_MARKER_INVALID' });
  } finally { rmSync(profile, { recursive: true, force: true }); }
});

test('exact registration and full payload verification reject scopes, drift and symlink files', () => {
  const root = mkdtempSync(join(tmpdir(), 'promate-native-test-'));
  const profile = root;
  const plugin = join(profile, 'plugins/cache/promate/promate/0.2.8');
  mkdirSync(join(plugin, '.codebuddy-plugin'), { recursive: true });
  const text = JSON.stringify({ name: 'promate', version: '0.2.8' });
  writeFileSync(join(plugin, '.codebuddy-plugin/plugin.json'), text);
  const entry = { version: '0.2.8', scope: 'user', installPath: plugin };
  const registry = join(profile, 'plugins/installed_plugins.json');
  const pinned = { ...release, files: { '.codebuddy-plugin/plugin.json': digest(text) } };
  try {
    writeFileSync(registry, JSON.stringify({ plugins: { 'promate@promate': [entry], unrelated: [] } }));
    assert.deepEqual(registered({ profile }), entry);
    // macOS tmpdir may alias /private/var; use canonical paths for authoritative payload checks.
    const canonical = realpathSync(profile), path = realpathSync(plugin);
    assert.equal(verifyInstalled({ profile: canonical }, { ...entry, installPath: path }, pinned), path);
    writeFileSync(join(plugin, 'unexpected.mjs'), 'unverified');
    assert.throws(() => verifyInstalled({ profile: canonical }, { ...entry, installPath: path }, pinned),
      { code: 'INSTALLED_FILES_MISMATCH', missing: [], extra: ['unexpected.mjs'], fileCounts: { actual: 2, expected: 1 } });
    assert.throws(() => verifyInstalled({ profile: canonical }, { ...entry, installPath: path },
      { ...pinned, files: { ...pinned.files, 'missing.mjs': sha } }),
    { code: 'INSTALLED_FILES_MISMATCH', missing: ['missing.mjs'], extra: ['unexpected.mjs'] });
    rmSync(join(plugin, 'unexpected.mjs'));
    symlinkSync('/dev/null', join(plugin, 'outside'));
    assert.throws(() => verifyInstalled({ profile: canonical }, { ...entry, installPath: path }, pinned), { code: 'INSTALLED_SYMLINK_REJECTED' });
    writeFileSync(registry, JSON.stringify({ plugins: { 'promate@promate': [{ ...entry, scope: 'project' }] } }));
    assert.throws(() => registered({ profile }), { code: 'PLUGIN_SCOPE_CONFLICT' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

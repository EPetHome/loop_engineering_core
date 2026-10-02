import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { inspectContext } from '../first-connect/desktop-preflight.mjs';

const program = fileURLToPath(new URL('../first-connect/desktop-preflight.mjs', import.meta.url));
const base = { CODEBUDDY_HOST: 'workbuddy-desktop', CODEBUDDY_CONFIG_DIR: '/private/tmp/owned',
  WORKBUDDY_CONFIG_DIR: '/private/tmp/owned', SERVER__PORT: '12345', SERVER__HOST: '127.0.0.1',
  CODEBUDDY_GATEWAY_AUTH: 'password', CODEBUDDY_GATEWAY_PASSWORD: 'fictional-control-secret-not-real' };

test('context diagnostic separates host, profile, listener and control without returning credentials', () => {
  const cases = [
    [{ CODEBUDDY_HOST: '' }, 'DESKTOP_HOST_CONTEXT_MISSING'],
    [{ CODEBUDDY_CONFIG_DIR: '' }, 'PROFILE_CONTEXT_MISSING'],
    [{ WORKBUDDY_CONFIG_DIR: '/private/tmp/other' }, 'PROFILE_CONTEXT_CONFLICT'],
    [{ SERVER__PORT: '' }, 'LISTENER_CONTEXT_MISSING'],
    [{ SERVER__PORT: '0' }, 'LISTENER_CONTEXT_INVALID'],
    [{ CODEBUDDY_GATEWAY_PASSWORD: '' }, 'CONTROL_CONTEXT_MISSING'],
  ];
  for (const [overrides, expected] of cases) {
    assert.throws(() => inspectContext({ ...base, ...overrides }), { code: expected });
  }
  assert.equal(inspectContext(base), 12345);
});

test('ordinary terminal and fabricated desktop context fail closed without leaking credential', () => {
  for (const [overrides, code] of [[{ CODEBUDDY_HOST: '' }, 'DESKTOP_HOST_CONTEXT_MISSING'],
    [base, 'DESKTOP_DIAGNOSTIC_ERROR']]) {
    const run = spawnSync(process.execPath, [program], { env: { ...process.env, ...overrides }, encoding: 'utf8', timeout: 10000 });
    assert.equal(run.status, 1);
    assert.equal(JSON.parse(run.stdout.trim()).code, code);
    assert.ok(!(run.stdout + run.stderr).includes(base.CODEBUDDY_GATEWAY_PASSWORD));
  }
});

// Read-only comparison of this replica's inputs; never follows links or consults another checkout.
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireSafe, safePath } from './fs-safety.mjs';

const feature = dirname(fileURLToPath(import.meta.url)), code = resolve(feature, '../..');
const beforePath = join(feature, 'protected-r003-before.json'), afterPath = join(feature, 'protected-r003-after.json');
function inventory() {
  const entries = {};
  function walk(dir) {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name), rel = relative(code, path), stat = lstatSync(path);
      if (rel === 'experiments/ecosystem-cards') continue;
      if (stat.isSymbolicLink()) entries[rel] = { kind: 'symlink', target: readlinkSync(path), mode: stat.mode & 0o777 };
      else if (stat.isDirectory()) walk(path);
      else {
        requireSafe(stat.isFile(), 'PROTECTED_INPUT_KIND_INVALID');
        entries[rel] = { kind: 'file', bytes: stat.size, mode: stat.mode & 0o777,
          sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
      }
    }
  }
  walk(code); return entries;
}
const entries = inventory(), base = { attempt_id: 'developer-r003-d9bd63d9c00c', codeRoot: code,
  capturedAt: new Date().toISOString(), scope: 'all replica inputs outside experiments/ecosystem-cards; current round only', entries };
if (process.argv[2] === 'before') {
  safePath(beforePath, { missing: true });
  writeFileSync(beforePath, JSON.stringify(base, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ phase: 'before', files: Object.keys(entries).length }));
} else {
  requireSafe(process.argv[2] === 'after', 'AUDIT_PHASE_REQUIRED');
  const before = JSON.parse(readFileSync(beforePath, 'utf8'));
  requireSafe(before.attempt_id === base.attempt_id, 'AUDIT_ATTEMPT_CONFLICT');
  const changed = [...new Set([...Object.keys(before.entries), ...Object.keys(entries)])]
    .filter(path => JSON.stringify(before.entries[path]) !== JSON.stringify(entries[path]));
  writeFileSync(afterPath, JSON.stringify({ ...base, beforePath: relative(code, beforePath),
    beforeSha256: createHash('sha256').update(readFileSync(beforePath)).digest('hex'), changed,
    status: changed.length ? 'FAIL' : 'PASS' }, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ phase: 'after', files: Object.keys(entries).length, changed }));
  process.exitCode = changed.length ? 1 : 0;
}

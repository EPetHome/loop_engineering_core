import { constants, lstatSync, openSync, closeSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function requireSafe(ok, reason) { if (!ok) throw new Error(reason); }
export function segment(value, label = 'NAME') {
  requireSafe(typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,95}$/.test(value), `${label}_INVALID`);
  return value;
}
export function text(value, label, max = 1024) {
  requireSafe(typeof value === 'string' && value.trim().length > 0 && value.length <= max
    && !/[\u0000-\u001f\u007f]/u.test(value), `${label}_INVALID`);
  return value;
}
export function version(value) {
  requireSafe(typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)
    && value.length <= 40, 'VERSION_INVALID');
  return value;
}
export function contained(parent, child) {
  const part = relative(parent, child);
  return !!part && part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part);
}
export function absolutePath(raw) {
  requireSafe(typeof raw === 'string' && isAbsolute(raw) && !raw.includes('\0') && !raw.includes('\\')
    && !raw.split('/').some(p => p === '.' || p === '..'), 'PATH_INVALID');
  // macOS's two system aliases only; arbitrary caller-created symlinks are never followed.
  const canonicalAlias = process.platform === 'darwin'
    ? raw.replace(/^\/tmp(?=\/|$)/, '/private/tmp').replace(/^\/var(?=\/|$)/, '/private/var') : raw;
  return resolve(canonicalAlias);
}
export function safePath(raw, { missing = false, directory = false, owned = false, ownedFrom = null } = {}) {
  const path = absolutePath(raw);
  if (ownedFrom) {
    ownedFrom = absolutePath(ownedFrom);
    requireSafe(path === ownedFrom || contained(ownedFrom, path), 'OWNERSHIP_BOUNDARY_INVALID');
  }
  let current = '/';
  for (const part of path.split('/').filter(Boolean)) {
    current = join(current, part);
    let stat;
    try { stat = lstatSync(current); }
    catch (e) { if (missing && e.code === 'ENOENT') return { path, exists: false }; throw e; }
    requireSafe(!stat.isSymbolicLink(), 'SYMLINK_REJECTED');
    if (ownedFrom && (current === ownedFrom || contained(ownedFrom, current))) {
      requireSafe(stat.uid === process.getuid() && !(stat.mode & 0o022), 'PATH_OWNER_UNPROVEN');
      requireSafe((stat.mode & (stat.isDirectory() ? 0o500 : 0o400)) === (stat.isDirectory() ? 0o500 : 0o400), 'PATH_UNREADABLE');
    }
    if (current !== path) requireSafe(stat.isDirectory(), 'PARENT_NOT_DIRECTORY');
    else {
      requireSafe(directory ? stat.isDirectory() : (stat.isDirectory() || stat.isFile()), 'PATH_KIND_INVALID');
      if (owned) requireSafe(stat.uid === process.getuid() && !(stat.mode & 0o022), 'PATH_OWNER_UNPROVEN');
      requireSafe((stat.mode & (stat.isDirectory() ? 0o500 : 0o400)) === (stat.isDirectory() ? 0o500 : 0o400), 'PATH_UNREADABLE');
    }
  }
  requireSafe(realpathSync(path) === path, 'PATH_NON_CANONICAL');
  return { path, exists: true };
}
export function readSafeFile(path) {
  safePath(path);
  const before = lstatSync(path);
  requireSafe(before.isFile() && before.size <= 2 * 1024 * 1024, 'FILE_KIND_OR_SIZE_INVALID');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return readFileSync(fd); } finally { closeSync(fd); }
}
export function readJSON(path) {
  const value = JSON.parse(readSafeFile(path).toString('utf8'));
  requireSafe(record(value), 'JSON_NOT_OBJECT');
  return value;
}

import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, relative } from 'node:path';
import { safePath, readSafeFile, readJSON, segment, text, version, requireSafe, record } from '../fs-safety.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const encode = data => JSON.stringify(data, null, 2) + '\n';
const markerName = '.loop-card-owner.json';
function inventory(root, allowedDirectories) {
  const files = {};
  function walk(dir) {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry), stat = lstatSync(path);
      requireSafe(!stat.isSymbolicLink() && stat.uid === process.getuid() && !(stat.mode & 0o022), 'OUTPUT_OWNER_UNPROVEN');
      if (stat.isDirectory()) {
        requireSafe(allowedDirectories.has(relative(root, path)), 'OUTPUT_DIRECTORY_UNKNOWN');
        walk(path);
      } else { requireSafe(stat.isFile(), 'OUTPUT_KIND_INVALID'); files[relative(root, path)] = sha(readSafeFile(path)); }
    }
  }
  walk(root);
  return files;
}
function verifyExisting(root, identity) {
  safePath(root, { directory: true, owned: true });
  const owner = readJSON(join(root, markerName));
  requireSafe(owner.format === 1 && ['ownerId', 'marketName', 'resourceId', 'pluginName'].every(k => owner[k] === identity[k]), 'OUTPUT_OWNERSHIP_CONFLICT');
  requireSafe(record(owner.files), 'OUTPUT_OWNERSHIP_INVALID');
  const allowedDirectories = new Set();
  for (const file of Object.keys(identity.files)) {
    const parts = file.split('/');
    for (let i = 1; i < parts.length; i++) allowedDirectories.add(parts.slice(0, i).join('/'));
  }
  const actual = inventory(root, allowedDirectories); delete actual[markerName];
  const names = Object.keys(actual).sort(), expected = Object.keys(identity.files).sort();
  requireSafe(JSON.stringify(names) === JSON.stringify(expected)
    && JSON.stringify(Object.keys(owner.files).sort()) === JSON.stringify(expected)
    && names.every(n => actual[n] === owner.files[n]), 'OUTPUT_CHANGED_OR_UNKNOWN');
  const manifest = readJSON(join(root, '.codebuddy-plugin/marketplace.json'));
  const plugin = readJSON(join(root, 'plugins', identity.pluginName, '.codebuddy-plugin/plugin.json'));
  requireSafe(manifest.name === identity.marketName && manifest.plugins?.length === 1
    && manifest.plugins[0].name === identity.pluginName && plugin.name === identity.pluginName, 'OUTPUT_IDENTITY_CONFLICT');
  return actual;
}

/** One directory market, one manifest-only card. No host registration is written here. */
export async function generateMarket({ outputRoot, ownerId, marketName, card } = {}) {
  text(ownerId, 'OWNER', 128); segment(marketName, 'MARKET');
  requireSafe(record(card), 'CARD_INVALID');
  text(card.resourceId, 'RESOURCE', 256); text(card.name, 'CARD_NAME', 128);
  text(card.description, 'DESCRIPTION'); version(card.version);
  const rootInfo = safePath(outputRoot, { directory: true, missing: true, owned: true });
  const root = rootInfo.path;
  if (!rootInfo.exists) {
    // Require an existing, proven parent; do not recursively invent caller paths.
    const parent = root.slice(0, root.lastIndexOf('/')) || '/';
    safePath(parent, { directory: true });
    mkdirSync(root, { mode: 0o700 });
  }
  safePath(root, { directory: true, owned: true });
  const pluginName = 'loop-card-' + sha(card.resourceId).slice(0, 32);
  const marketRoot = join(root, marketName);
  const pluginFile = `plugins/${pluginName}/.codebuddy-plugin/plugin.json`;
  const files = {
    '.codebuddy-plugin/marketplace.json': encode({ name: marketName, owner: { name: ownerId }, plugins: [{
      name: pluginName, source: './plugins/' + pluginName, description: card.description, version: card.version,
      displayName: card.name,
    }] }),
    [pluginFile]: encode({ name: pluginName, displayName: card.name, description: card.description, version: card.version }),
  };
  const identity = { format: 1, ownerId, marketName, resourceId: card.resourceId, pluginName,
    files: Object.fromEntries(Object.entries(files).map(([n, b]) => [n, sha(b)])) };
  const lock = join(root, `.${marketName}.lock`), token = randomUUID();
  writeFileSync(lock, encode({ token, pid: process.pid }), { flag: 'wx', mode: 0o600 });
  let stage, backup, moved = false, published = false;
  try {
    const exists = safePath(marketRoot, { missing: true, directory: true, owned: true }).exists;
    if (exists) {
      const old = verifyExisting(marketRoot, identity);
      if (Object.keys(old).every(n => old[n] === identity.files[n])) return { marketRoot, marketName, pluginName, resourceId: card.resourceId, version: card.version };
    }
    stage = join(root, `.${marketName}.stage-${token}`);
    mkdirSync(stage, { mode: 0o700 });
    for (const [name, body] of Object.entries(files)) {
      const dest = join(stage, name);
      mkdirSync(dest.slice(0, dest.lastIndexOf('/')), { recursive: true, mode: 0o700 });
      writeFileSync(dest, body, { flag: 'wx', mode: 0o600 });
    }
    writeFileSync(join(stage, markerName), encode(identity), { flag: 'wx', mode: 0o600 });
    verifyExisting(stage, identity);
    if (exists) {
      // A second ownership/integrity check immediately before the switch.
      verifyExisting(marketRoot, identity);
      backup = join(root, `.${marketName}.previous-${token}`);
      renameSync(marketRoot, backup); moved = true;
    }
    try { renameSync(stage, marketRoot); published = true; }
    catch (e) { if (moved) { renameSync(backup, marketRoot); moved = false; } throw e; }
    // Keep last-good recovery material. It is outside the market and cannot appear as a second card.
    return { marketRoot, marketName, pluginName, resourceId: card.resourceId, version: card.version };
  } finally {
    if (stage && !published) rmSync(stage, { recursive: true, force: true });
    requireSafe(readJSON(lock).token === token, 'LOCK_OWNERSHIP_CONFLICT');
    unlinkSync(lock);
  }
}

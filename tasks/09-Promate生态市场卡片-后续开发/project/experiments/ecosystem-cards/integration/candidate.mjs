import { lstatSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireSafe, safePath } from '../fs-safety.mjs';

function identity(path, directory = false) {
  const checked = safePath(path, { directory }).path;
  const stat = lstatSync(checked, { bigint: true });
  requireSafe(directory ? stat.isDirectory() : stat.isFile(), 'CANDIDATE_PATH_KIND_INVALID');
  return { path: checked, dev: String(stat.dev), ino: String(stat.ino), uid: String(stat.uid) };
}
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid;

/** Accept different spelling only when no link is involved and filesystem identity agrees. */
export function confirmCandidate({ moduleURL, entryPath, cwd }) {
  const moduleFile = identity(fileURLToPath(moduleURL));
  const entryFile = identity(resolve(entryPath));
  const moduleRoot = identity(resolve(dirname(moduleFile.path), '../../..'), true);
  const entryRoot = identity(resolve(dirname(entryFile.path), '../../..'), true);
  const workingRoot = identity(cwd, true);
  requireSafe(same(moduleFile, entryFile), 'CANDIDATE_ENTRY_CONFLICT');
  requireSafe(same(moduleRoot, entryRoot) && same(moduleRoot, workingRoot), 'CANDIDATE_CWD_CONFLICT');
  // Retain the invocation spelling for the frozen gate's exact code-argument comparison.
  return { candidateCodeRoot: entryRoot.path, moduleFile, entryFile, moduleRoot, entryRoot, workingRoot,
    agreement: 'same dev/ino/uid; each path independently checked for symlinks' };
}

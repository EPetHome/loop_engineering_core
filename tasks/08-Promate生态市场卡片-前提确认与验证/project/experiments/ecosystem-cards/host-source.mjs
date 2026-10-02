// Read only installed application artifacts, never any user profile or credential store.
import { openSync, closeSync, readSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { requireSafe } from './fs-safety.mjs';

export function readHostArchive(paths) {
  const fd = openSync('/Applications/WorkBuddy.app/Contents/Resources/app.asar', 'r');
  try {
    const prefix = Buffer.alloc(16);
    requireSafe(readSync(fd, prefix, 0, 16, 0) === 16, 'ASAR_UNREADABLE');
    const size = prefix.readUInt32LE(12);
    requireSafe(size > 0 && size <= 16 * 1024 * 1024, 'ASAR_HEADER_SIZE_INVALID');
    const header = Buffer.alloc(size);
    requireSafe(readSync(fd, header, 0, size, 16) === size, 'ASAR_HEADER_UNREADABLE');
    const tree = JSON.parse(header.toString()), base = 8 + prefix.readUInt32LE(4), entries = {};
    for (const path of paths) {
      requireSafe(typeof path === 'string' && path.split('/').every(p => p && p !== '.' && p !== '..'), 'ASAR_PATH_INVALID');
      let node = tree;
      for (const part of path.split('/')) node = node.files?.[part];
      requireSafe(node && !node.unpacked && node.size > 0 && node.size < 32 * 1024 * 1024, 'ASAR_ENTRY_INVALID');
      const bytes = Buffer.alloc(node.size);
      requireSafe(readSync(fd, bytes, 0, bytes.length, base + Number(node.offset)) === bytes.length, 'ASAR_ENTRY_UNREADABLE');
      entries[path] = { text: bytes.toString(), sha256: createHash('sha256').update(bytes).digest('hex') };
    }
    return { headerSha256: createHash('sha256').update(header).digest('hex'), entries };
  } finally { closeSync(fd); }
}

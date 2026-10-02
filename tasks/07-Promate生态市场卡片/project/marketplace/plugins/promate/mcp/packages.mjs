// Single-skill .md/.zip validation. No shell unzip, dependencies, links or unchecked paths.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { UPLOAD_LIMIT } from './client.mjs';
const EXPANDED_LIMIT = 50 * 1024 * 1024;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export function skillName(text) {
  const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const names = front?.[1].split(/\r?\n/).filter(x => /^name\s*:/.test(x)) || [];
  const value = names[0]?.replace(/^name\s*:\s*/, '').trim().replace(/^(['"])(.*)\1$/, '$2');
  if (names.length !== 1 || !NAME.test(value || '') || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(value)) throw Error('SKILL.md 的 name 缺失或不合法（1–64 位字母数字、下划线或连字符）');
  return value;
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zipEntries(bytes) {
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) throw Error('zip 格式错误或多磁盘包');
  const count = bytes.readUInt16LE(end + 10), length = bytes.readUInt32LE(end + 12), start = bytes.readUInt32LE(end + 16);
  if (!count || count > 1000 || count !== bytes.readUInt16LE(end + 8) || start + length !== end) throw Error('zip 条目过多、ZIP64 或目录无效');
  const entries = [], names = new Set(), ranges = []; let pos = start, expanded = 0;
  for (let i = 0; i < count; i++) {
    if (pos + 46 > end || bytes.readUInt32LE(pos) !== 0x02014b50) throw Error('zip 中央目录损坏');
    const flags = bytes.readUInt16LE(pos + 8), method = bytes.readUInt16LE(pos + 10), crc = bytes.readUInt32LE(pos + 16);
    const compressed = bytes.readUInt32LE(pos + 20), size = bytes.readUInt32LE(pos + 24);
    const n = bytes.readUInt16LE(pos + 28), extra = bytes.readUInt16LE(pos + 30), comment = bytes.readUInt16LE(pos + 32);
    const mode = bytes.readUInt32LE(pos + 38) >>> 16, local = bytes.readUInt32LE(pos + 42);
    if (pos + 46 + n + extra + comment > end || flags & 1 || ![0,8].includes(method) || bytes.readUInt16LE(pos + 34)) throw Error('zip 加密、压缩方式或条目错误');
    const raw = bytes.subarray(pos + 46, pos + 46 + n), path = raw.toString('utf8');
    if (!Buffer.from(path).equals(raw) || !path || path.length > 240 || /[\\\x00-\x1f:]/.test(path) || path.startsWith('/') || path.split('/').some((p,j,a) => p === '..' || p === '.' || !p && j !== a.length - 1)) throw Error('zip 含路径穿越、绝对路径或非法路径');
    const key = path.replace(/\/$/, '').toLowerCase();
    if (names.has(key)) throw Error('zip 含重复或大小写冲突路径');
    names.add(key);
    const kind = mode & 0xf000, dir = path.endsWith('/');
    if (kind && kind !== (dir ? 0x4000 : 0x8000)) throw Error('zip 含符号链接或特殊文件');
    if (local + 30 > start || bytes.readUInt32LE(local) !== 0x04034b50 || bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method) throw Error('zip 本地条目无效');
    const ln = bytes.readUInt16LE(local + 26), lx = bytes.readUInt16LE(local + 28), dataStart = local + 30 + ln + lx, dataEnd = dataStart + compressed;
    if (dataEnd > start || !bytes.subarray(local + 30, local + 30 + ln).equals(raw) || ranges.some(([a,b]) => local < b && dataEnd > a)) throw Error('zip 路径或条目范围冲突');
    ranges.push([local, dataEnd]); expanded += size;
    if (size > EXPANDED_LIMIT || expanded > EXPANDED_LIMIT || dir && size) throw Error('zip 解压总大小超过 50MB 或目录含内容');
    let content;
    try { content = method === 0 ? bytes.subarray(dataStart,dataEnd) : inflateRawSync(bytes.subarray(dataStart,dataEnd), { maxOutputLength: Math.max(1,size) }); }
    catch { throw Error('zip 压缩内容损坏或超出声明大小'); }
    if (content.length !== size || crc32(content) !== crc) throw Error('zip 文件大小或 CRC 校验失败');
    entries.push({ path, dir, content }); pos += 46 + n + extra + comment;
  }
  if (pos !== end) throw Error('zip 中央目录大小错误');
  return entries;
}
export function unpackSkill(bytes, extension, stage) {
  if (!bytes.length || bytes.length > UPLOAD_LIMIT) throw Error('安装包为空或超过 10MB');
  let entries;
  if (extension.toLowerCase() === '.md') entries = [{ path:'SKILL.md', content:bytes, dir:false }];
  else if (extension.toLowerCase() === '.zip') entries = zipEntries(bytes);
  else throw Error('仅支持 .md 或单技能 .zip');
  const skills = entries.filter(x => !x.dir && /(?:^|\/)SKILL\.md$/.test(x.path));
  if (skills.length !== 1) throw Error('zip 必须且只能包含一个 SKILL.md');
  const prefix = skills[0].path.slice(0, -'SKILL.md'.length);
  if (prefix.split('/').filter(Boolean).length > 1 || entries.some(x => !x.path.startsWith(prefix))) throw Error('zip 只能是根目录技能或单个顶层技能目录');
  const name = skillName(skills[0].content.toString('utf8'));
  for (const item of entries) {
    const relative = item.path.slice(prefix.length);
    if (!relative) continue;
    if (relative.split('/').some(p => p.toLowerCase() === '.promate-owner.json')) throw Error('安装包包含保留的归属文件');
    const target = join(stage, relative);
    mkdirSync(item.dir ? target : dirname(target), { recursive:true, mode:0o700 });
    if (!item.dir) writeFileSync(target,item.content,{flag:'wx',mode:0o600});
  }
  return name;
}

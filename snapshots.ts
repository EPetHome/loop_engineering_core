/** 独立、只读取源项目的评审快照；内容保存在本机，复原不依赖源 Git 对象或模型。 */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, readSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { EXT_DIR } from "./config.ts";
import { createGitEvidence, gitBlobHash as blobHash, type Exec, type Snapshot } from "./git.ts";
import { checkedMaterialPath } from "./resources.ts";

export { blobHash };
export const UNTRACKED_CONTENT_LIMIT = 256 * 1024;
export const REVIEW_SNAPSHOTS = "review-snapshots";
export const sha256 = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");

export interface SnapshotFile {
  path: string;
  kind: "tracked" | "untracked";
  mode: "100644" | "100755" | "120000";
  size: number;
  /** 原始工作区字节的 Git blob SHA-1；不做 clean/smudge 或换行转换。 */
  hash: string;
  content: string | null;
  missingContent?: string;
}
export interface ReviewSnapshot {
  format: "loop-review-snapshot-v1";
  retention: "keep";
  createdAt: string;
  project: string;
  repository: string;
  gitDir: string;
  workDir: string;
  session: string;
  round: number;
  loopCommit: string;
  baseline: string;
  candidate: Snapshot;
  reviewInput: string;
  inputSha256: string;
  originalInput: string;
  complete: boolean;
  files: SnapshotFile[];
}

// 引擎加载时固定版本；不能误读接入项目的 GIT_DIR，或在稍后发布分支移动后才取版本。
const loopCommit = (() => {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_") && !["GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL"].includes(key)) delete env[key];
  try { return execFileSync("git", ["-C", EXT_DIR, "rev-parse", "--verify", "HEAD"], { env, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }).trim(); }
  catch { return ""; }
})();

const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
};
function canonicalFuture(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  return parent === path ? path : join(canonicalFuture(parent), relative(parent, path));
}
function safePath(path: string): void {
  if (typeof path !== "string" || !path || isAbsolute(path) || path.includes("\\") || path.includes("\0")
    || path.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) throw new Error(`快照路径不安全：${path}`);
}
const stamp = (path: string): string => {
  const s = lstatSync(path);
  return [s.dev, s.ino, s.mode, s.size, s.mtimeMs, s.ctimeMs].join(":");
};

/** 用文件描述符读大文件哈希，不把超限的未跟踪内容写到任何位置。 */
function hashLargeFile(path: string, size: number): string {
  const fd = openSync(path, "r");
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`不是普通文件：${path}`);
    const hash = createHash("sha1").update(`blob ${size}\0`), buffer = Buffer.alloc(64 * 1024);
    let total = 0, count: number;
    while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) { hash.update(buffer.subarray(0, count)); total += count; }
    if (total !== size) throw new Error(`保存快照期间文件大小变化：${path}`);
    return hash.digest("hex");
  } finally { closeSync(fd); }
}

export async function saveReviewSnapshot(options: {
  exec: Exec; cwd: string; session: string; round: number; baseline: string; candidate: Snapshot;
  input: string; inputPath: string; root?: string; signal?: AbortSignal;
}): Promise<string> {
  const { exec, cwd, candidate, signal } = options;
  const git = async (args: string[], dir = cwd): Promise<string> => {
    signal?.throwIfAborted();
    const res = await exec("git", ["-c", "core.quotePath=false", ...args], { cwd: dir, timeout: 30_000, signal });
    signal?.throwIfAborted();
    if (res.code !== 0 || res.killed) throw new Error(`保存评审快照失败：git ${args[0]}：${res.stderr || res.stdout}`);
    return res.stdout;
  };
  if (!/^[0-9a-f]{40}$/.test(loopCommit)) throw new Error("无法确定运行中的 Loop 提交号，未开始评审");
  const repository = realpathSync((await git(["rev-parse", "--show-toplevel"])).trim());
  const gitDir = resolve(cwd, (await git(["rev-parse", "--absolute-git-dir"])).trim());
  const root = canonicalFuture(resolve(options.root ?? join(dirname(options.inputPath), REVIEW_SNAPSHOTS)));
  if (inside(repository, root)) throw new Error("评审快照必须保存在项目外的本机数据目录");
  const tree = await git(["ls-tree", "-r", "--full-tree", "-z", candidate.tree]);
  const untrackedPaths = async (): Promise<string[]> => (await git(["ls-files", "--others", "--exclude-standard", "-z"], repository)).split("\0").filter(Boolean).sort();
  const untracked = await untrackedPaths();
  const tracked = tree.split("\0").filter(Boolean).map((line) => {
    const match = /^(\d+) (\w+) [0-9a-f]+\t([\s\S]+)$/.exec(line);
    if (!match || match[2] !== "blob") throw new Error(`无法完整保存子模块或未知 Git 条目：${line}`);
    return match[3];
  });
  const sessionKey = sha256(JSON.stringify([repository, options.session])).slice(0, 24);
  const parent = join(root, sessionKey), id = `r${options.round}-${randomUUID()}`;
  const staging = join(parent, `.${id}.tmp`), target = join(parent, id);
  mkdirSync(parent, { recursive: true, mode: 0o700 }); checkedMaterialPath(root, parent);
  mkdirSync(staging, { mode: 0o700 });
  try {
    mkdirSync(join(staging, "contents"), { mode: 0o700 });
    const files: SnapshotFile[] = [], checks: { path: string; stamp: string }[] = [];
    const paths = [...tracked.map((path) => ({ path, kind: "tracked" as const })), ...untracked.map((path) => ({ path, kind: "untracked" as const }))];
    for (const { path, kind } of paths) {
      signal?.throwIfAborted(); safePath(path);
      const absolute = join(repository, path);
      // 父目录不得经过链接；链接本身保存目标字节，不读取目标内容。
      checkedMaterialPath(repository, dirname(absolute));
      const before = stamp(absolute), info = lstatSync(absolute);
      if (!info.isFile() && !info.isSymbolicLink()) throw new Error(`快照不支持特殊文件：${path}`);
      const mode = info.isSymbolicLink() ? "120000" : (info.mode & 0o111) ? "100755" : "100644";
      const missing = kind === "untracked" && info.size > UNTRACKED_CONTENT_LIMIT;
      const bytes = missing ? undefined : info.isSymbolicLink() ? readlinkSync(absolute, { encoding: "buffer" }) : readFileSync(absolute);
      const hash = bytes ? blobHash(bytes) : hashLargeFile(absolute, info.size);
      const file: SnapshotFile = { path, kind, mode, size: bytes?.length ?? info.size, hash,
        content: missing ? null : `contents/${hash}`, ...(missing ? { missingContent: "未跟踪文件超过 256 KiB，未保存内容" } : {}) };
      if (bytes && !existsSync(join(staging, file.content!))) writeFileSync(join(staging, file.content!), bytes, { flag: "wx", mode: 0o600 });
      if (stamp(absolute) !== before) throw new Error(`保存快照期间文件变化：${path}`);
      checks.push({ path: absolute, stamp: before }); files.push(file);
    }
    // 不能把两个时间点拼成一份“可回放”候选；取证失败与中断都在调用模型前停止。
    const after = await createGitEvidence(exec, cwd, signal).snapshot();
    if (after.fingerprint !== candidate.fingerprint || JSON.stringify(untracked) !== JSON.stringify(await untrackedPaths())
      || checks.some((item) => stamp(item.path) !== item.stamp)) throw new Error("保存评审快照期间工作区变化，未开始评审");
    const prefix = relative(repository, realpathSync(cwd));
    const captured = files.filter((file) => file.kind === "untracked");
    for (const file of candidate.untracked) {
      const match = captured.find((entry) => entry.path === join(prefix, file.path).split(sep).join("/"));
      if (!match || match.hash !== file.hash || match.mode !== file.mode) throw new Error(`未跟踪文件与评审候选不符：${file.path}`);
    }
    const manifest: ReviewSnapshot = {
      format: "loop-review-snapshot-v1", retention: "keep", createdAt: new Date().toISOString(), project: repository, repository, gitDir,
      workDir: resolve(cwd), session: options.session, round: options.round, loopCommit, baseline: options.baseline, candidate,
      reviewInput: "review-input.md", inputSha256: sha256(options.input), originalInput: options.inputPath,
      complete: files.every((file) => file.content !== null), files,
    };
    writeFileSync(join(staging, manifest.reviewInput), options.input, { mode: 0o600 });
    writeFileSync(join(staging, "snapshot.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    signal?.throwIfAborted(); renameSync(staging, target);
    return join(target, "snapshot.json");
  } catch (error) { rmSync(staging, { recursive: true, force: true }); throw error; }
}

/** 校验结构、内容哈希及路径；缺内容可以登记，但不允许冒充完整复原。 */
export function readReviewSnapshot(path: string): ReviewSnapshot {
  const dir = dirname(resolve(path)); checkedMaterialPath(dir, resolve(path));
  const data = JSON.parse(readFileSync(path, "utf8")) as ReviewSnapshot;
  if (data.format !== "loop-review-snapshot-v1" || data.retention !== "keep" || !Array.isArray(data.files)
    || !Number.isInteger(data.round) || data.round < 1 || typeof data.session !== "string"
    || !/^[0-9a-f]{40}$/.test(data.loopCommit) || !/^[0-9a-f]{40}$/.test(data.baseline) || !/^[0-9a-f]{40}$/.test(data.candidate?.ref)
    || ![data.project, data.repository, data.gitDir, data.workDir].every((value) => typeof value === "string" && isAbsolute(value))
    || data.reviewInput !== "review-input.md") throw new Error("评审快照格式或身份无效");
  checkedMaterialPath(dir, join(dir, data.reviewInput));
  if (sha256(readFileSync(join(dir, data.reviewInput))) !== data.inputSha256) throw new Error("评审输入哈希不匹配");
  const seen = new Set<string>();
  for (const file of data.files) {
    safePath(file.path);
    if (seen.has(file.path) || !["tracked", "untracked"].includes(file.kind) || !["100644", "100755", "120000"].includes(file.mode)
      || !/^[0-9a-f]{40}$/.test(file.hash) || !Number.isSafeInteger(file.size) || file.size < 0) throw new Error("快照文件条目无效或重复");
    seen.add(file.path);
    if (file.content === null) {
      if (file.kind !== "untracked" || file.size <= UNTRACKED_CONTENT_LIMIT || !file.missingContent) throw new Error("快照缺内容标记无效");
      continue;
    }
    if (file.content !== `contents/${file.hash}` || file.missingContent) throw new Error("快照内容路径无效");
    const content = join(dir, file.content); checkedMaterialPath(dir, content);
    if (!lstatSync(content).isFile()) throw new Error("快照内容不是普通文件");
    const bytes = readFileSync(content);
    if (bytes.length !== file.size || blobHash(bytes) !== file.hash) throw new Error(`快照内容哈希不匹配：${file.path}`);
  }
  if (data.complete !== data.files.every((file) => file.content !== null)) throw new Error("快照完整性标记不一致");
  for (const path of seen) {
    let parent = dirname(path);
    while (parent !== ".") {
      if (seen.has(parent)) throw new Error(`快照文件路径互相覆盖：${path}`);
      parent = dirname(parent);
    }
  }
  return data;
}

/** 只写新的空目录；先验证全部材料，最后创建链接，决不跟随链接向目录外写文件。 */
export function restoreReviewSnapshot(source: string, destination: string): string {
  source = resolve(source);
  const document = JSON.parse(readFileSync(source, "utf8"));
  const path = document.format === "loop-review-snapshot-v1" ? source : typeof document.snapshot === "string" ? resolve(dirname(source), document.snapshot) : undefined;
  if (!path) throw new Error("案例草稿没有可用快照");
  if (document.snapshotSha256 && sha256(readFileSync(path)) !== document.snapshotSha256) throw new Error("案例指向的快照哈希不匹配");
  const snapshot = readReviewSnapshot(path);
  if (!snapshot.complete) throw new Error(`快照缺内容，不能完整复原：${snapshot.files.filter((file) => !file.content).map((file) => file.path).join("、")}`);
  const target = resolve(destination);
  if (existsSync(target) && (lstatSync(target).isSymbolicLink() || !lstatSync(target).isDirectory() || readdirSync(target).length)) throw new Error("复原目标必须是新目录或空目录");
  const parent = realpathSync(dirname(target));
  if (!existsSync(target)) mkdirSync(target, { mode: 0o700 });
  const writeRoot = join(parent, relative(dirname(target), target));
  for (const file of [...snapshot.files].sort((a, b) => Number(a.mode === "120000") - Number(b.mode === "120000"))) {
    const output = join(writeRoot, file.path);
    mkdirSync(dirname(output), { recursive: true }); checkedMaterialPath(writeRoot, dirname(output));
    const bytes = readFileSync(join(dirname(path), file.content!));
    if (file.mode === "120000") symlinkSync(bytes.toString(), output);
    else {
      const mode = file.mode === "100755" ? 0o755 : 0o644;
      writeFileSync(output, bytes, { flag: "wx", mode }); chmodSync(output, mode);
    }
  }
  return target;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [source, target, extra] = process.argv.slice(2);
    if (!source || !target || extra) throw new Error("用法：node snapshots.ts <案例草稿.json|snapshot.json> <新的复原目录>");
    console.log(`已复原（未调用模型）：${restoreReviewSnapshot(source, target)}`);
  } catch (error) { console.error((error as Error).message); process.exitCode = 1; }
}

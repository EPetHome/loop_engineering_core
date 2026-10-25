/** git 取证：不改索引；所有失败都显式上抛，路径只按 NUL 拆分。 */
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { resolve } from "node:path";

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}
export type Exec = (
  command: string,
  args: string[],
  /** role：需要登记的长进程角色（评审、验收方），宿主 Hook 被杀后据此清理。 */
  options: { cwd: string; timeout: number; signal?: AbortSignal; role?: string; env?: NodeJS.ProcessEnv },
) => Promise<ExecResult>;

export interface Snapshot {
  ref: string;
  head: string;
  tree: string;
  untracked: { path: string; hash: string; mode: string }[];
  fingerprint: string;
}

export class GitReadError extends Error {
  constructor(detail: string) {
    super(`无法读取工作区状态：${detail}`);
    this.name = "GitReadError";
  }
}

const pathsFromNul = (text: string): string[] => text.split("\0").filter((path) => path !== "");

/**
 * git diff 输出的是仓库根相对路径，ls-files 的未跟踪文件是当前目录相对路径；
 * 统一换算成会话工作目录相对路径（用 git 的 --show-prefix 做纯字符串换算，不碰文件系统）。
 */
function fromRepoRoot(path: string, prefix: string): string {
  if (!prefix || path.startsWith(prefix)) return path.slice(prefix.length);
  return `${"../".repeat(prefix.split("/").filter(Boolean).length)}${path}`;
}
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
const objectId = (text: string, source: string): string => {
  const id = text.trim();
  if (!/^[a-f0-9]{40}$/.test(id)) throw new GitReadError(`${source} 没有返回 40 位对象 id`);
  return id;
};

export function createGitEvidence(exec: Exec, cwd: string, signal?: AbortSignal) {
  let prefix: string | undefined;

  const raw = async (args: string[], timeout = 30_000): Promise<ExecResult> => {
    signal?.throwIfAborted();
    try {
      const res = await exec("git", ["-c", "core.quotePath=false", ...args], { cwd, timeout, signal });
      signal?.throwIfAborted();
      return res;
    } catch (error) {
      signal?.throwIfAborted();
      throw new GitReadError(`git ${args.join(" ")}：${errorText(error).slice(-300)}`);
    }
  };
  const checked = (res: ExecResult, args: string[]): string => {
    if (res.code !== 0 || res.killed) {
      const detail = (res.stderr || res.stdout || "无错误输出").trim().slice(-300);
      throw new GitReadError(`git ${args.join(" ")}（退出码 ${res.code}${res.killed ? "，被终止" : ""}）：${detail}`);
    }
    return res.stdout;
  };
  const run = async (args: string[]): Promise<string> => checked(await raw(args), args);
  const readHead = async (): Promise<string> => objectId(await run(["rev-parse", "--verify", "HEAD"]), "HEAD");
  const differs = async (args: string[]): Promise<boolean> => {
    const res = await raw(args);
    // diff --quiet 的 1 仅在无诊断且未被终止时表示有差异；读取错误仍上抛。
    if (res.code === 1 && !res.killed && !res.stderr.trim()) return true;
    checked(res, args);
    return false;
  };

  return {
    async isRepository(): Promise<boolean> {
      const args = ["rev-parse", "--git-dir"];
      const res = await raw(args, 10_000);
      if (!res.killed && res.code !== 0 && /not a git repository/i.test(res.stderr)) return false;
      checked(res, args);
      return true;
    },
    async initialHead(): Promise<string | undefined> {
      const args = ["rev-parse", "--verify", "HEAD"];
      const res = await raw(args, 10_000);
      if (!res.killed && res.code !== 0) return undefined;
      return objectId(checked(res, args), "HEAD");
    },
    async snapshot(): Promise<Snapshot> {
      const head = await readHead();
      // 验证批可能完全没有产品改动；确认索引和工作区均干净时无需创建新对象。
      const changed = await differs(["diff", "--cached", "--quiet", head, "--"])
        || await differs(["diff", "--quiet", "--"]);
      const stash = changed ? (await run(["stash", "create"])).trim() : "";
      const ref = stash ? objectId(stash, "stash create") : head;
      const tree = objectId(await run(["rev-parse", "--verify", `${ref}^{tree}`]), "tree");
      const paths = pathsFromNul(await run(["ls-files", "--others", "--exclude-standard", "-z"])).sort();
      const untracked: Snapshot["untracked"] = [];
      for (const path of paths) {
        const hash = objectId(await run(["hash-object", "--", path]), `hash-object ${path}`);
        // 冻结当时的模式；后续文件被 chmod 或提交不能改写旧快照的完成依据。
        const info = lstatSync(resolve(cwd, path));
        const mode = info.isSymbolicLink() ? "120000" : (info.mode & 0o111) !== 0 ? "100755" : "100644";
        untracked.push({ path, hash, mode });
      }
      const fingerprint = createHash("sha256")
        .update(JSON.stringify([head, tree, untracked.map(({ path, hash, mode }) => [path, hash, mode])]))
        .digest("hex");
      return { head, ref, tree, untracked, fingerprint };
    },
    /**
     * 有效内容指纹：树里的文件加上未跟踪文件的内容。自动提交把未跟踪文件转成已跟踪时，
     * HEAD 和原始指纹会变，但这里保持不变；内容或模式真正改变时仍会变。
     */
    async contentFingerprint(snapshot: Snapshot): Promise<string> {
      if (prefix === undefined) prefix = (await run(["rev-parse", "--show-prefix"])).replace(/\r?\n$/, "");
      const entries = new Map<string, string>();
      // --full-tree：子目录会话也取完整候选；输出路径本来就是仓库根相对，不再转换。
      const tree = await run(["ls-tree", "-r", "--full-tree", "-z", snapshot.tree]);
      for (const item of tree.split("\0")) {
        if (!item) continue;
        const match = /^(\d+) \w+ ([0-9a-f]+)\t([\s\S]*)$/.exec(item);
        if (!match) continue;
        entries.set(match[3], `${match[1]} ${match[2]}`);
      }
      for (const file of snapshot.untracked) {
        const path = `${prefix}${file.path}`;
        entries.set(path, `${file.mode || "100644"} ${file.hash}`);
      }
      return createHash("sha256")
        .update(JSON.stringify([...entries.entries()].sort(([a], [b]) => a.localeCompare(b))))
        .digest("hex");
    },
    async diff(from: string, to: string): Promise<{ diff: string; stat: string }> {
      objectId(from, "diff 基线"); objectId(to, "diff 当前快照");
      return {
        diff: await run(["diff", from, to, "--"]),
        stat: await run(["diff", "--stat", from, to, "--"]),
      };
    },
    newUntrackedFiles(current: Snapshot, baseline: string[]): string[] {
      const seen = new Set(baseline);
      return current.untracked.map(({ path }) => path).filter((path) => !seen.has(path));
    },
    async changedFiles(before: Snapshot, after: Snapshot): Promise<string[]> {
      const files = new Set<string>();
      const beforeMap = new Map(before.untracked.map(({ path, hash }) => [path, hash]));
      const afterMap = new Map(after.untracked.map(({ path, hash }) => [path, hash]));
      for (const [path, hash] of afterMap) if (beforeMap.get(path) !== hash) files.add(path);
      for (const path of beforeMap.keys()) if (!afterMap.has(path)) files.add(path);
      if (before.tree !== after.tree) {
        // --no-renames：重命名要报出前后两个路径；否则范围校验会看不到被移走的旧路径，
        // 可能把「非来源文件重命名进来源目录」误判成纯来源变化（来源豁免与准备修改范围校验都依赖这份列表）。
        const diff = await run(["diff", "--name-only", "--no-renames", "-z", before.ref, after.ref, "--"]);
        if (prefix === undefined) prefix = (await run(["rev-parse", "--show-prefix"])).replace(/\r?\n$/, "");
        for (const path of pathsFromNul(diff)) files.add(fromRepoRoot(path, prefix));
      }
      return [...files].sort();
    },
    /** 某个快照（或提交）之后 HEAD 上新增的提交数。 */
    async commitsSince(base: string): Promise<number> {
      objectId(base, "提交数基线");
      const count = Number.parseInt((await run(["rev-list", "--count", `${base}..HEAD`])).trim(), 10);
      return Number.isFinite(count) ? count : 0;
    },
    async statusShort(): Promise<string> {
      return pathsFromNul(await run(["status", "--short", "-z"])).join("\n");
    },
  };
}

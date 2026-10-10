/** git 取证：不改索引；所有失败都显式上抛，路径只按 NUL 拆分。 */
import { createHash } from "node:crypto";

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
  options: { cwd: string; timeout: number; signal?: AbortSignal; role?: string },
) => Promise<ExecResult>;

export interface Snapshot {
  ref: string;
  head: string;
  tree: string;
  untracked: { path: string; hash: string }[];
  fingerprint: string;
}

export class GitReadError extends Error {
  constructor(detail: string) {
    super(`无法读取工作区状态：${detail}`);
    this.name = "GitReadError";
  }
}

const pathsFromNul = (text: string): string[] => text.split("\0").filter((path) => path !== "");
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
const objectId = (text: string, source: string): string => {
  const id = text.trim();
  if (!/^[a-f0-9]{40}$/.test(id)) throw new GitReadError(`${source} 没有返回 40 位对象 id`);
  return id;
};

export function createGitEvidence(exec: Exec, cwd: string, signal?: AbortSignal) {
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
      const stash = (await run(["stash", "create"])).trim();
      const ref = stash ? objectId(stash, "stash create") : head;
      const tree = objectId(await run(["rev-parse", "--verify", `${ref}^{tree}`]), "tree");
      const paths = pathsFromNul(await run(["ls-files", "--others", "--exclude-standard", "-z"])).sort();
      const untracked: Snapshot["untracked"] = [];
      for (const path of paths) {
        const hash = objectId(await run(["hash-object", "--", path]), `hash-object ${path}`);
        untracked.push({ path, hash });
      }
      const fingerprint = createHash("sha256")
        .update(JSON.stringify([head, tree, untracked.map(({ path, hash }) => [path, hash])]))
        .digest("hex");
      return { head, ref, tree, untracked, fingerprint };
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
        const diff = await run(["diff", "--name-only", "-z", before.ref, after.ref, "--"]);
        for (const path of pathsFromNul(diff)) files.add(path);
      }
      return [...files].sort();
    },
    async statusShort(): Promise<string> {
      return pathsFromNul(await run(["status", "--short", "-z"])).join("\n");
    },
  };
}

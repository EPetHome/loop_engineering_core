/** 仅优化测试工具启动：使用同一Apple Git的真实二进制，不缓存Git结果或改变产品取证。 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { before, after } from "node:test";

type GitProbe = (command: string, args: string[], options: { env: NodeJS.ProcessEnv; encoding: "utf8"; timeout: number }) => { status: number | null; stdout?: string | Buffer };

/** 非macOS、用户自定Git或探测失败均不覆盖PATH；xcrun沿用调用方的DEVELOPER_DIR。 */
export function resolveDirectGit(env: NodeJS.ProcessEnv = process.env, run: GitProbe = spawnSync, platform = process.platform): string | undefined {
  if (platform !== "darwin") return;
  const command = (file: string, args: string[]) => {
    try {
      const result = run(file, args, { env, encoding: "utf8", timeout: 5000 });
      return result.status === 0 ? String(result.stdout ?? "").trim() : undefined;
    } catch { return undefined; }
  };
  const current = command("/bin/sh", ["-c", "command -v git"]);
  if (current !== "/usr/bin/git") return;
  const direct = command("xcrun", ["--find", "git"]);
  if (!direct || !isAbsolute(direct) || direct === current) return;
  const version = command(current, ["--version"]), execPath = command(current, ["--exec-path"]);
  if (!version || !execPath || command(direct, ["--version"]) !== version || command(direct, ["--exec-path"]) !== execPath) return;
  return direct;
}

let bin: string | undefined;
before(() => {
  const direct = resolveDirectGit();
  if (!direct) return;
  bin = mkdtempSync(join(tmpdir(), "loop-test-git-"));
  const git = join(bin, "git");
  // Apple Git按argv[0]寻找子工具；用exec保留真实路径，不能用会改变exec-path的符号链接。
  writeFileSync(git, `#!/bin/sh\nexec '${direct.replace(/'/g, "'\\''")}' "$@"\n`);
  chmodSync(git, 0o755);
  const expected = spawnSync(direct, ["--exec-path"], { encoding: "utf8" });
  const actual = spawnSync(git, ["--exec-path"], { encoding: "utf8" });
  if (expected.status !== 0 || actual.status !== 0 || actual.stdout !== expected.stdout) {
    rmSync(bin, { recursive: true, force: true }); bin = undefined; return;
  }
  // 私有bin只包含git，不把整个工具链目录前置而意外替换python等其他命令。
  process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
});
after(() => {
  if (!bin) return;
  process.env.PATH = process.env.PATH?.split(delimiter).filter((part) => part !== bin).join(delimiter);
  rmSync(bin, { recursive: true, force: true });
});

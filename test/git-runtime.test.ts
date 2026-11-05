/** 测试工具选择契约：不更换Git版本，不越过故障替身，不改其他命令的PATH。 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { resolveDirectGit } from "./helpers/git-runtime.ts";

const originalPATH = process.env.PATH;

test("测试Git／同版本同工具目录才启用，定制Git及探测异常保持原环境", async (t) => {
  const cases = [
    { name: "同版本及exec-path", expected: "/toolchain/bin/git" },
    { name: "非macOS", platform: "linux", expected: undefined },
    { name: "用户自定Git", selected: "/custom/bin/git", expected: undefined },
    { name: "Git不可执行", failure: "/bin/sh", expected: undefined },
    { name: "xcrun失败", failure: "xcrun", expected: undefined },
    { name: "xcrun抛错", throws: true, expected: undefined },
    { name: "查找为空", direct: "", expected: undefined },
    { name: "相对路径不替换", direct: "relative/git", expected: undefined },
    { name: "仍是系统启动器", direct: "/usr/bin/git", expected: undefined },
    { name: "版本不同", versionMismatch: true, expected: undefined },
    { name: "工具目录不同", execPathMismatch: true, expected: undefined },
  ] as const;
  for (const row of cases) await t.test(row.name, () => {
    const item = { platform: "darwin" as NodeJS.Platform, selected: "/usr/bin/git", direct: "/toolchain/bin/git", failure: "", throws: false, versionMismatch: false, execPathMismatch: false, ...row };
    const env = { PATH: "/original/bin", DEVELOPER_DIR: "/selected/sdk" }, before = { ...env };
    let calls = 0;
    const probe: NonNullable<Parameters<typeof resolveDirectGit>[1]> = (command, args, options) => {
      calls++; assert.equal(options.env, env);
      if (command === item.failure) return { status: 1, stdout: "" };
      if (command === "/bin/sh") return { status: 0, stdout: item.selected };
      if (command === "xcrun") { if (item.throws) throw new Error("xcrun不可用"); return { status: 0, stdout: item.direct }; }
      return { status: 0, stdout: args[0] === "--version"
        ? command === "/usr/bin/git" || !item.versionMismatch ? "git version identical" : "git version other"
        : command === "/usr/bin/git" || !item.execPathMismatch ? "/toolchain/libexec/git-core" : "/other/git-core" };
    };
    assert.equal(resolveDirectGit(env, probe, item.platform), item.expected);
    assert.deepEqual(env, before);
    if (item.platform !== "darwin") assert.equal(calls, 0);
    if (item.selected !== "/usr/bin/git") assert.equal(calls, 1, "不越过用户的自定Git继续探测");
  });
});

test("测试Git／真实工具保持版本与exec-path，私有故障Git仍优先执行", (t) => {
  const selected = spawnSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  const direct = resolveDirectGit({ ...process.env, PATH: originalPATH });
  if (direct && selected !== "/usr/bin/git") {
    assert.equal(process.env.PATH?.split(delimiter).filter((part) => part !== dirname(selected)).join(delimiter), originalPATH);
    for (const arg of ["--version", "--exec-path"]) {
      const actual = spawnSync("git", [arg], { encoding: "utf8" }), expected = spawnSync(direct, [arg], { encoding: "utf8" });
      assert.equal(actual.status, 0); assert.equal(actual.stdout, expected.stdout);
    }
  } else assert.equal(process.env.PATH, originalPATH, "无法确认一致性时保持原环境");
  t.diagnostic(`实际Git入口：${selected}`);
  const bin = mkdtempSync(join(tmpdir(), "loop-git-failure-"));
  try {
    const git = join(bin, "git"); writeFileSync(git, "#!/bin/sh\nprintf 'GIT_FAILURE_SENTINEL' >&2\nexit 42\n"); chmodSync(git, 0o755);
    const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` };
    assert.equal(resolveDirectGit(env), undefined);
    const failed = spawnSync("git", ["status"], { encoding: "utf8", env });
    assert.equal(failed.status, 42); assert.match(failed.stderr, /GIT_FAILURE_SENTINEL/);
    const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
    const actualRepo = join(bin, "actual"), expectedRepo = join(bin, "expected");
    for (const [command, repo] of [["git", actualRepo], [direct ?? selected, expectedRepo]]) {
      const initialized = spawnSync(command, ["init", "-q", repo], { encoding: "utf8", env: gitEnv });
      assert.equal(initialized.status, 0, initialized.stderr);
    }
    const files = (repo: string) => readdirSync(join(repo, ".git"), { recursive: true }).map(String).sort();
    assert.deepEqual(files(actualRepo), files(expectedRepo), "不能为提速改变模板或hooks布局");
    for (const path of files(actualRepo)) {
      const actual = join(actualRepo, ".git", path), expected = join(expectedRepo, ".git", path);
      assert.equal(statSync(actual).mode & 0o777, statSync(expected).mode & 0o777);
      if (statSync(actual).isFile()) assert.deepEqual(readFileSync(actual), readFileSync(expected));
    }
  } finally { rmSync(bin, { recursive: true, force: true }); }
});

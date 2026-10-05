/** git 取证补充回归；临时目录内布置仓库，不调用模型。 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGitEvidence, GitReadError, type Exec } from "../git.ts";

function repository() {
  const cwd = mkdtempSync(join(tmpdir(), "autoreview-git-"));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  const git = (...args: string[]) => {
    const res = spawnSync("git", args, { cwd, env, encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr);
    return res.stdout.trim();
  };
  git("init", "-q"); git("config", "user.email", "git@example.com"); git("config", "user.name", "git-test");
  writeFileSync(join(cwd, "tracked.txt"), "base\n"); git("add", "tracked.txt"); git("commit", "-qm", "baseline");
  const calls: string[][] = [];
  const exec: Exec = async (command, args, options) => {
    calls.push(args);
    const res = spawnSync(command, args, { cwd: options.cwd, env, encoding: "utf8" });
    return { stdout: res.stdout || "", stderr: res.stderr || "", code: res.status ?? 1, killed: Boolean(res.signal) };
  };
  return { cwd, exec, calls, git, close: () => rmSync(cwd, { recursive: true, force: true }) };
}

test("G1 补充：两个特殊路径的内容分别影响指纹，路径字节保留", async () => {
  const r = repository();
  try {
    const git = createGitEvidence(r.exec, r.cwd);
    for (const path of ["说明.md", 'a "b".txt', " leading\ttrailing \n.txt", "-option.txt"]) writeFileSync(join(r.cwd, path), "A");
    const before = await git.snapshot();
    assert.deepEqual(before.untracked.map(({ path }) => path).sort(), ["说明.md", 'a "b".txt', " leading\ttrailing \n.txt", "-option.txt"].sort());
    for (const path of ["说明.md", 'a "b".txt']) {
      writeFileSync(join(r.cwd, path), "B");
      assert.notEqual((await git.snapshot()).fingerprint, before.fingerprint);
      writeFileSync(join(r.cwd, path), "A");
      assert.equal((await git.snapshot()).fingerprint, before.fingerprint);
    }
    assert.ok(r.calls.every((args) => args[0] === "-c" && args[1] === "core.quotePath=false"));
    assert.ok(r.calls.filter((args) => args.includes("ls-files")).every((args) => args.includes("-z")));
  } finally { r.close(); }
});

test("G2 补充：tree、stat、变化列表、status 失败及 exec rejection 不可吞掉", async () => {
  const r = repository();
  try {
    const clean = createGitEvidence(r.exec, r.cwd);
    const before = await clean.snapshot();
    writeFileSync(join(r.cwd, "tracked.txt"), "changed\n");
    const after = await clean.snapshot();
    for (const failure of ["tree", "stat", "names", "status", "rejection"]) {
      const exec: Exec = async (command, args, options) => {
        const hit = failure === "tree" ? args.some((arg) => arg.endsWith("^{tree}"))
          : failure === "stat" ? args.includes("--stat")
          : failure === "names" ? args.includes("--name-only")
          : failure === "status" ? args.includes("status") : true;
        if (!hit) return r.exec(command, args, options);
        if (failure === "rejection") throw new Error("exec FAIL_SENTINEL");
        return { stdout: "", stderr: "FAIL_SENTINEL", code: 1, killed: false };
      };
      const git = createGitEvidence(exec, r.cwd);
      const operation = failure === "stat" ? git.diff(before.ref, after.ref)
        : failure === "names" ? git.changedFiles(before, after)
        : failure === "status" ? git.statusShort() : git.snapshot();
      await assert.rejects(operation, (error: unknown) => error instanceof GitReadError && /无法读取工作区状态.*FAIL_SENTINEL/.test(error.message));
    }
    const changed = await clean.changedFiles(before, after);
    assert.deepEqual(changed, ["tracked.txt"]);
    assert.ok(r.calls.filter((args) => args.includes("--name-only") || args.includes("status")).every((args) => args.includes("-z")));
  } finally { r.close(); }
});

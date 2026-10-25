/** git 取证补充回归；临时目录内布置仓库，不调用模型。 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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


test("G4 补充：子目录会话下 changedFiles 统一为工作目录相对路径（已跟踪与未跟踪一致）", async () => {
  const r = repository();
  try {
    mkdirSync(join(r.cwd, "sub"));
    writeFileSync(join(r.cwd, "sub", "need.md"), "v1\n");
    r.git("add", "sub/need.md"); r.git("commit", "-qm", "add sub source");
    const git = createGitEvidence(r.exec, join(r.cwd, "sub"));
    const before = await git.snapshot();
    writeFileSync(join(r.cwd, "sub", "need.md"), "v2\n");   // 已跟踪，git diff 输出仓库根相对
    writeFileSync(join(r.cwd, "sub", "new.md"), "new\n");   // 未跟踪，ls-files 输出工作目录相对
    writeFileSync(join(r.cwd, "tracked.txt"), "changed\n"); // 会话目录之外
    const after = await git.snapshot();
    assert.deepEqual(await git.changedFiles(before, after), ["../tracked.txt", "need.md", "new.md"]);
    // 仓库根会话输出保持原样，现有调用方的消息不变。
    const rootGit = createGitEvidence(r.exec, r.cwd);
    const rootBefore = await rootGit.snapshot();
    writeFileSync(join(r.cwd, "sub", "need.md"), "v3\n");
    const rootAfter = await rootGit.snapshot();
    assert.deepEqual(await rootGit.changedFiles(rootBefore, rootAfter), ["sub/need.md"]);
  } finally { r.close(); }
});

test("G6 补充：有效内容指纹覆盖子目录会话的完整候选，并冻结未跟踪文件模式", async () => {
  const r = repository();
  try {
    mkdirSync(join(r.cwd, "sub"));
    const git = createGitEvidence(r.exec, join(r.cwd, "sub"));
    writeFileSync(join(r.cwd, "sub", "new.txt"), "new\n");
    writeFileSync(join(r.cwd, "tracked.txt"), "outside change\n");
    const before = await git.snapshot();
    r.git("add", "-A"); r.git("commit", "-qm", "commit candidate");
    const after = await git.snapshot();
    assert.equal(await git.contentFingerprint(before), await git.contentFingerprint(after), "提交前后有效内容一致");
    writeFileSync(join(r.cwd, "tracked.txt"), "outside real change\n");
    const changed = await git.snapshot();
    assert.notEqual(await git.contentFingerprint(after), await git.contentFingerprint(changed), "目录外候选改动不能被漏掉");

    const modeRepo = repository();
    try {
      mkdirSync(join(modeRepo.cwd, "sub"));
      const modeGit = createGitEvidence(modeRepo.exec, join(modeRepo.cwd, "sub"));
      writeFileSync(join(modeRepo.cwd, "sub", "run.sh"), "#!/bin/sh\n");
      chmodSync(join(modeRepo.cwd, "sub", "run.sh"), 0o755);
      const executable = await modeGit.snapshot();
      assert.equal(executable.untracked[0].mode, "100755", "快照冻结可执行模式");
      chmodSync(join(modeRepo.cwd, "sub", "run.sh"), 0o644);
      modeRepo.git("add", "-A"); modeRepo.git("commit", "-qm", "commit nonexec");
      const committed = await modeGit.snapshot();
      assert.notEqual(await modeGit.contentFingerprint(executable), await modeGit.contentFingerprint(committed), "历史模式不能被当前磁盘改写");
    } finally { modeRepo.close(); }
  } finally { r.close(); }
});

test("G5 补充：暂存的重命名报出前后两端，范围校验不会漏掉旧路径", async () => {
  const r = repository();
  try {
    mkdirSync(join(r.cwd, "sub"));
    writeFileSync(join(r.cwd, "sub", "server.ts"), "export const x = 1;\n");
    r.git("add", "sub/server.ts"); r.git("commit", "-qm", "add server");
    mkdirSync(join(r.cwd, "sub", "docs"));
    const git = createGitEvidence(r.exec, join(r.cwd, "sub"));
    const rootGit = createGitEvidence(r.exec, r.cwd);
    const before = await git.snapshot();
    const rootBefore = await rootGit.snapshot();
    r.git("mv", "sub/server.ts", "sub/docs/server.ts");   // git mv 已暂存重命名
    const after = await git.snapshot();
    const rootAfter = await rootGit.snapshot();
    assert.deepEqual(await git.changedFiles(before, after), ["docs/server.ts", "server.ts"], "重命名前后两个路径都要在列表里");
    assert.deepEqual(await rootGit.changedFiles(rootBefore, rootAfter), ["sub/docs/server.ts", "sub/server.ts"]);
  } finally { r.close(); }
});

test("G3：干净仓库直接复用 HEAD，未跟踪文件仍参与指纹，dirty 取证失败不吞掉", async () => {
  const r = repository();
  try {
    const exec: Exec = async (command, args, options) => args.includes("stash")
      ? { stdout: "", stderr: "", code: 1, killed: false } : r.exec(command, args, options);
    const git = createGitEvidence(exec, r.cwd);
    const clean = await git.snapshot();
    assert.equal(clean.ref, r.git("rev-parse", "HEAD"));
    assert.ok(!r.calls.some((args) => args.includes("stash")));
    writeFileSync(join(r.cwd, "new.txt"), "A");
    const added = await git.snapshot();
    assert.equal(added.ref, clean.ref);
    assert.notEqual(added.fingerprint, clean.fingerprint);
    writeFileSync(join(r.cwd, "new.txt"), "B");
    assert.notEqual((await git.snapshot()).fingerprint, added.fingerprint);
    for (const staged of [false, true]) {
      writeFileSync(join(r.cwd, "tracked.txt"), staged ? "staged\n" : "working\n");
      if (staged) r.git("add", "tracked.txt");
      await assert.rejects(git.snapshot(), /stash create.*退出码 1/);
    }
    r.git("reset", "--hard", "HEAD");
    for (const failure of [
      { stdout: "", stderr: "READ_FAIL", code: 128, killed: false },
      { stdout: "", stderr: "READ_FAIL", code: 1, killed: false },
      { stdout: "", stderr: "", code: 0, killed: true },
    ]) {
      const failed = createGitEvidence(async (cmd, args, opts) => args.includes("--quiet") ? failure : r.exec(cmd, args, opts), r.cwd);
      await assert.rejects(failed.snapshot(), GitReadError);
    }
  } finally { r.close(); }
});

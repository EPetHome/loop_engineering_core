/** A1–A5：无模型评审、完整字节快照、漏网 CLI 与离线复原；只使用系统临时目录。 */
import "./test-env.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { renderSummary } from "../core.ts";
import { createGitEvidence, type Exec } from "../git.ts";
import { appendLedgerRecord, pendingWritebackCount, projectRootOf } from "../ledger.ts";
import { materialSession, recordMaterialSession } from "../materials.ts";
import { newReviewState, runReviewRound } from "../review.ts";
import { changedSince } from "../scope.ts";
import { blobHash, readReviewSnapshot, restoreReviewSnapshot, sha256, UNTRACKED_CONTENT_LIMIT } from "../snapshots.ts";

const LOOP = fileURLToPath(new URL("../bin/loop", import.meta.url));
const SNAPSHOTS = fileURLToPath(new URL("../snapshots.ts", import.meta.url));
const PASS = "## 结论：通过\n## 必修\n无\n## 小问题\n- 无\n## 需求疑问\n- 无\n## 上轮必修复查\n- 无\n";
const required = "id/type/project/repository/gitDir/baseline/candidate/reviewInput/defect/location/discovery/evidence/replayable/replayReason".split("/");

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "loop-snapshots-")), repo = join(root, "repo"), home = join(root, "home");
  mkdirSync(repo); mkdirSync(home);
  const previousHome = process.env.HOME; process.env.HOME = home;
  t.after(() => { if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome; rmSync(root, { recursive: true, force: true }); });
  const data = join(home, ".pi-autoreview"), material = join(data, "repo"), ledger = join(data, "交付记录.md");
  const env = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  const git = (...args: string[]) => {
    const r = spawnSync("git", args, { cwd: repo, env, encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  const put = (path: string, content: string | Buffer) => { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), content); };
  git("init", "-q"); git("config", "user.email", "snapshot@example.com"); git("config", "user.name", "snapshot");
  put("tracked.txt", "base\n"); put("delete.txt", "remove\n"); put("sub/code.ts", "export const value = 0;\n");
  put(".gitignore", "ignored/\nnode_modules/\n"); put(".gitattributes", "*.crlf text eol=crlf\n");
  git("add", "."); git("commit", "-qm", "base");
  const state = newReviewState(); state.requirement = "# 快照验收";
  const exec: Exec = async (command, args, options) => {
    assert.equal(command, "git", "确定性测试不允许调用模型或其他命令");
    const r = spawnSync(command, args, { cwd: options.cwd, env, encoding: "utf8" });
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? 1, killed: Boolean(r.signal) };
  };
  let calls = 0;
  const run = async (id = "claude-capture", cwd = repo) => {
    const result = await runReviewRound({ cwd, devSessionId: id, round: state.rounds.length + 1,
      deliveryNote: "已完成", state, exec, config: { maxRepairs: 4, reviewerModel: "never-call", reviewerThinking: "", reviewTimeoutMin: 60, reviewerCmd: "" },
      saveState: () => {}, writeInput: (name, text) => { mkdirSync(material, { recursive: true }); const path = join(material, name); writeFileSync(path, text); return path; },
      callReviewer: async (_session, _round, _timeout, input) => { calls++; assert.ok(existsSync(input)); return { stdout: PASS, stderr: "", code: 0, killed: false }; },
    });
    assert.equal(result.kind, "done");
    state.phase = "done";
    return state.rounds.at(-1)!.snapshot!;
  };
  const persist = (id = "claude-capture", native: "hook" | "pi" = "hook", cwd = repo) => {
    const summary = join(material, `${id}.md`); mkdirSync(material, { recursive: true });
    writeFileSync(summary, renderSummary({ cwd, devSessionId: id, reviewerSessionId: "reviewer", status: "完成", rounds: state.rounds, repairs: state.repairs, gitStatusShort: "" }));
    recordMaterialSession(materialSession(id, cwd, summary, state.phase));
    const file = native === "hook" ? join(material, `${id}.state.json`) : join(home, ".pi", "agent", "sessions", "test-project", `date_${id}.jsonl`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, native === "hook" ? JSON.stringify(state) : [JSON.stringify({ type: "session", id, cwd }), JSON.stringify({ type: "custom", customType: "autoreview-state", data: state }), ""].join("\n"));
    return { summary, file };
  };
  const cli = (...args: string[]) => spawnSync(LOOP, args, { cwd: root, env, encoding: "utf8" });
  return { root, repo, home, data, material, ledger, env, git, put, exec, run, persist, state, cli, calls: () => calls };
}

function rawFiles(repository: string, snapshot: ReturnType<typeof readReviewSnapshot>): Map<string, Buffer> {
  return new Map(snapshot.files.map((file) => [file.path, file.mode === "120000" ? Buffer.from(readlinkSync(join(repository, file.path))) : readFileSync(join(repository, file.path))]));
}
function assertRestored(target: string, snapshot: ReturnType<typeof readReviewSnapshot>, expected: Map<string, Buffer>) {
  for (const file of snapshot.files) {
    const path = join(target, file.path), bytes = file.mode === "120000" ? Buffer.from(readlinkSync(path)) : readFileSync(path);
    assert.deepEqual(bytes, expected.get(file.path), file.path); assert.equal(blobHash(bytes), file.hash);
    if (file.mode !== "120000") assert.equal(lstatSync(path).mode & 0o111, file.mode === "100755" ? 0o111 : 0);
  }
  assert.equal(existsSync(join(target, "ignored")), false);
  assert.equal(existsSync(join(target, "node_modules")), false);
  assert.equal(existsSync(join(target, "delete.txt")), false);
}

test("A1/A3/A4/A5：完整原始字节、忽略排除、Loop 版本、追加漏网、仅凭草稿和快照离线复原", async (t) => {
  const h = fixture(t);
  h.put("tracked.txt", "staged\n"); h.git("add", "tracked.txt"); h.put("tracked.txt", "unstaged after staging\r\n");
  h.put("staged-new.crlf", "new\r\nfile\r\n"); h.git("add", "staged-new.crlf");
  h.put("tracked-large.bin", Buffer.alloc(UNTRACKED_CONTENT_LIMIT + 17, 3)); h.git("add", "tracked-large.bin");
  rmSync(join(h.repo, "delete.txt"));
  h.put("未跟踪 目录/-file\t\n.bin", Buffer.from([0, 255, 13, 10, 128]));
  h.put("boundary.bin", Buffer.alloc(UNTRACKED_CONTENT_LIMIT, 7)); h.put("run.sh", "#!/bin/sh\necho hi\n"); chmodSync(join(h.repo, "run.sh"), 0o755);
  const external = join(h.root, "private-target"); writeFileSync(external, "MUST_NOT_COPY_TARGET"); symlinkSync(external, join(h.repo, "link"));
  symlinkSync("not-present", join(h.repo, "broken-link"));
  h.put("ignored/private", "DO_NOT_SAVE"); h.put("node_modules/private", "DO_NOT_SAVE");
  const before = h.git("status", "--porcelain=v1", "-z"), index = h.git("ls-files", "--stage", "-z");
  const snapshotPath = await h.run(), snapshot = readReviewSnapshot(snapshotPath);
  const expected = rawFiles(h.repo, snapshot);
  assert.equal(snapshot.complete, true); assert.match(snapshot.loopCommit, /^[a-f0-9]{40}$/);
  const actualLoop = spawnSync("git", ["-C", dirname(LOOP), "rev-parse", "HEAD"], { encoding: "utf8" });
  assert.equal(snapshot.loopCommit, actualLoop.stdout.trim());
  assert.equal(snapshot.retention, "keep"); assert.equal(snapshot.session, "claude-capture"); assert.equal(snapshot.round, 1);
  assert.equal(h.calls(), 1); assert.equal(h.git("status", "--porcelain=v1", "-z"), before); assert.equal(h.git("ls-files", "--stage", "-z"), index, "保留暂存内容；Git 可刷新 TREE/stat 缓存");
  assert.equal(snapshot.files.some((file) => /ignored|node_modules|delete\.txt/.test(file.path)), false);
  assert.equal(snapshot.files.find((file) => file.path === "link")!.hash, blobHash(Buffer.from(external)));
  assert.equal([...expected.values()].some((bytes) => bytes.includes("MUST_NOT_COPY_TARGET")), false, "不跟随源链接复制外部资料");
  const persisted = h.persist(), stateBefore = readFileSync(persisted.file), summaryBefore = readFileSync(persisted.summary);
  appendLedgerRecord({ project: projectRootOf(h.repo), session: "claude-capture", task: "旧交付", result: "完成", summary: persisted.summary, pending: [] });
  const oldLedger = readFileSync(h.ledger, "utf8");
  const preview = h.cli("漏网", h.repo, "claude-capture", "丢失撤权检查", "后续静态核对", "--dry-run", "--json");
  assert.equal(preview.status, 0, preview.stderr + preview.stdout); assert.equal(readFileSync(h.ledger, "utf8"), oldLedger);
  assert.equal(existsSync(JSON.parse(preview.stdout).draftPath), false);
  const registered = h.cli("漏网", h.repo, "claude-capture", "丢失撤权检查\n需要修复", "后续静态核对", "--json");
  assert.equal(registered.status, 0, registered.stderr + registered.stdout);
  const result = JSON.parse(registered.stdout), draft = JSON.parse(readFileSync(result.draftPath, "utf8"));
  for (const key of required) assert.ok(Object.hasOwn(draft, key), key);
  assert.equal(draft.location, null); assert.equal(draft.round, 1); assert.equal(draft.loopCommit, snapshot.loopCommit);
  assert.equal(draft.snapshot, snapshotPath); assert.equal(draft.replayable, true);
  assert.equal(draft.inputSha256, sha256(readFileSync(draft.reviewInput)));
  const ledger = readFileSync(h.ledger, "utf8"); assert.ok(ledger.startsWith(oldLedger));
  assert.match(ledger.slice(oldLedger.length), /类型：漏网[\s\S]*轮次：1[\s\S]*问题：丢失撤权检查 需要修复/);
  assert.ok(ledger.includes(h.repo)); assert.ok(ledger.includes("会话 claude-capture"));
  assert.equal(pendingWritebackCount(ledger, h.repo), 1);
  assert.deepEqual(readFileSync(persisted.file), stateBefore); assert.deepEqual(readFileSync(persisted.summary), summaryBefore);
  const cleanup = h.cli("清理", "--json"); assert.equal(cleanup.status, 0, cleanup.stderr + cleanup.stdout);
  const plan = JSON.parse(cleanup.stdout);
  assert.ok(plan.retained.some((item: any) => snapshotPath.startsWith(realpathSync(item.path))));
  assert.equal(plan.paths.some((path: string) => path.includes("review-snapshots")), false);
  // 删除整个源仓库和原输入：复原不可能再借用源 Git 对象或当前内容。
  rmSync(h.repo, { recursive: true }); rmSync(snapshot.originalInput);
  const target = join(h.root, "restored");
  const restored = spawnSync(process.execPath, [SNAPSHOTS, result.draftPath, target], { cwd: h.root,
    env: { ...h.env, GIT_DIR: join(h.root, "does-not-exist"), PI_BIN: "/never-call-model" }, encoding: "utf8" });
  assert.equal(restored.status, 0, restored.stderr); assert.match(restored.stdout, /未调用模型/);
  assertRestored(target, snapshot, expected);
  const empty = join(h.root, "empty"); mkdirSync(empty); restoreReviewSnapshot(result.draftPath, empty); assertRestored(empty, snapshot, expected);
  assert.throws(() => restoreReviewSnapshot(result.draftPath, target), /新目录或空目录/);
});

test("A2：超 256 KiB 只记哈希并明确缺内容；完整复原拒绝，等于上限仍保留", async (t) => {
  const h = fixture(t); h.put("large.bin", Buffer.alloc(UNTRACKED_CONTENT_LIMIT + 1, 5)); h.put("exact.bin", Buffer.alloc(UNTRACKED_CONTENT_LIMIT, 6));
  const path = await h.run(), snapshot = readReviewSnapshot(path), large = snapshot.files.find((file) => file.path === "large.bin")!;
  assert.equal(snapshot.complete, false); assert.equal(large.content, null); assert.match(large.missingContent!, /256 KiB/);
  assert.equal(large.hash, blobHash(readFileSync(join(h.repo, "large.bin")))); assert.equal(existsSync(join(dirname(path), "contents", large.hash)), false);
  assert.ok(snapshot.files.find((file) => file.path === "exact.bin")!.content);
  h.persist(); const registered = h.cli("漏网", h.repo, "claude-capture", "缺陷", "人工发现", "--json");
  assert.equal(registered.status, 0, registered.stdout); const result = JSON.parse(registered.stdout);
  assert.equal(result.draft.replayable, false); assert.match(result.draft.replayReason, /large\.bin/);
  const target = join(h.root, "not-written"); assert.throws(() => restoreReviewSnapshot(result.draftPath, target), /快照缺内容/); assert.equal(existsSync(target), false);
});

test("Pi 原生状态、指定历史轮次、默认最后一轮和同轮输入对应；原始历史内容不被后轮覆盖", async (t) => {
  const h = fixture(t), id = "pi-capture";
  h.put("extra.txt", "round one"); const r1 = await h.run(id); h.put("extra.txt", "round two"); const r2 = await h.run(id); h.persist(id, "pi");
  const input = (round?: string) => h.cli("漏网", h.repo, id, "历史缺陷", "测试发现", ...(round ? ["--round", round] : []), "--json");
  const first = input("1"); assert.equal(first.status, 0, first.stdout); const firstCase = JSON.parse(first.stdout);
  const last = input(); assert.equal(last.status, 0, last.stdout); const lastCase = JSON.parse(last.stdout);
  assert.equal(firstCase.draft.snapshot, r1); assert.equal(lastCase.draft.snapshot, r2); assert.equal(lastCase.draft.round, 2);
  const a = readReviewSnapshot(r1), b = readReviewSnapshot(r2);
  assert.notEqual(a.files.find((f) => f.path === "extra.txt")!.hash, b.files.find((f) => f.path === "extra.txt")!.hash);
  assert.equal(firstCase.draft.baseline, a.baseline); assert.equal(lastCase.draft.baseline, b.baseline);
  assert.equal(b.baseline, a.candidate.ref, "返修轮使用真实输入基线，不猜会话初始基线");
  assert.equal(input("99").status, 1); assert.equal(input("0").status, 2); assert.equal(input("-1").status, 2);
  assert.equal(h.cli("状态", "--round", "1", "--json").status, 2);
});

test("子目录评审仍保存全仓库代码和目录外未跟踪文件", async (t) => {
  const h = fixture(t), cwd = join(h.repo, "sub"); h.put("outside.txt", "not in session cwd"); h.put("sub/inside.txt", "inside");
  const path = await h.run("subdir", cwd), snapshot = readReviewSnapshot(path);
  assert.ok(snapshot.files.some((file) => file.path === "outside.txt")); assert.ok(snapshot.files.some((file) => file.path === "sub/inside.txt"));
  const expected = rawFiles(h.repo, snapshot), target = join(h.root, "subdir-restored"); restoreReviewSnapshot(path, target);
  for (const [file, bytes] of expected) assert.deepEqual(readFileSync(join(target, file)), bytes);
});

test("缺历史快照的草稿未知字段为 null；未完成、项目不匹配、无效轮次不得追加", async (t) => {
  const h = fixture(t); await h.run();
  delete h.state.rounds[0].snapshot; delete h.state.reviewSnapshots; const persisted = h.persist();
  const args = ["漏网", h.repo, "claude-capture", "问题", "事后发现", "--json"];
  const legacy = h.cli(...args); assert.equal(legacy.status, 0, legacy.stdout); const draft = JSON.parse(legacy.stdout).draft;
  for (const key of required) assert.ok(Object.hasOwn(draft, key));
  for (const key of ["snapshot", "candidate", "baseline", "gitDir", "loopCommit", "location", "untracked"]) assert.equal(draft[key], null, key);
  assert.equal(draft.replayable, false); assert.match(draft.replayReason, /历史轮次/);
  const ledger = readFileSync(h.ledger), drafts = readdirSync(join(h.data, "replay-drafts"));
  h.state.phase = "paused"; writeFileSync(persisted.file, JSON.stringify(h.state)); assert.equal(h.cli(...args).status, 1);
  assert.equal(h.cli("漏网", h.root, "claude-capture", "问题", "发现", "--json").status, 1);
  assert.deepEqual(readFileSync(h.ledger), ledger); assert.deepEqual(readdirSync(join(h.data, "replay-drafts")), drafts);
});

test("快照内容、输入或身份损坏时拒绝登记/复原；路径穿越和路径互相覆盖不能写出目录", async (t) => {
  const h = fixture(t); h.put("extra.txt", "content"); const path = await h.run(); h.persist();
  const snapshot = readReviewSnapshot(path), original = readFileSync(path), blob = join(dirname(path), snapshot.files[0].content!), bytes = readFileSync(blob);
  writeFileSync(blob, "tampered");
  const result = h.cli("漏网", h.repo, "claude-capture", "问题", "发现", "--json"); assert.equal(result.status, 1); assert.equal(existsSync(h.ledger), false);
  assert.throws(() => restoreReviewSnapshot(path, join(h.root, "failed")), /哈希不匹配/); assert.equal(existsSync(join(h.root, "failed")), false);
  writeFileSync(blob, bytes); snapshot.files[0].path = "../escape"; writeFileSync(path, JSON.stringify(snapshot));
  assert.throws(() => restoreReviewSnapshot(path, join(h.root, "failed")), /路径不安全/);
  writeFileSync(path, original); const replaced = readReviewSnapshot(path); replaced.files.push({ ...replaced.files[0], path: `${replaced.files[0].path}/nested` });
  writeFileSync(path, JSON.stringify(replaced)); assert.throws(() => restoreReviewSnapshot(path, join(h.root, "failed")), /互相覆盖/);
  writeFileSync(path, original); const wrong = readReviewSnapshot(path); wrong.round = 9; writeFileSync(path, JSON.stringify(wrong));
  assert.equal(h.cli("漏网", h.repo, "claude-capture", "问题", "发现", "--json").status, 1); assert.equal(existsSync(h.ledger), false);
});

test("开工快照与越界检查的哈希口径一致：原始 CRLF 与悬空链接未变则豁免，变了仍报出", async (t) => {
  const h = fixture(t); h.put("unchanged.crlf", "line\r\n"); symlinkSync("missing", join(h.repo, "link"));
  const baseline = await createGitEvidence(h.exec, h.repo).snapshot();
  assert.deepEqual(await changedSince(h.exec, h.repo, baseline.ref, { baselineUntracked: baseline.untracked }), []);
  h.put("unchanged.crlf", "line\n"); rmSync(join(h.repo, "link")); symlinkSync("other-missing", join(h.repo, "link"));
  assert.deepEqual(await changedSince(h.exec, h.repo, baseline.ref, { baselineUntracked: baseline.untracked }), ["link", "unchanged.crlf"]);
});

test("工作区取证或快照写入失败不得调用评审模型；快照根不能指向项目内", async (t) => {
  const h = fixture(t), candidate = await createGitEvidence(h.exec, h.repo).snapshot();
  const options = { cwd: h.repo, devSessionId: "failure", round: 1, state: newReviewState(), deliveryNote: "",
    config: { maxRepairs: 4, reviewerModel: "never", reviewerThinking: "", reviewTimeoutMin: 60, reviewerCmd: "" }, exec: h.exec,
    writeInput: () => join(h.material, "input.md"), saveState: () => {},
    callReviewer: async () => { assert.fail("快照失败不能调用模型"); return { stdout: PASS, stderr: "", code: 0, killed: false }; } };
  await assert.rejects(() => runReviewRound({ ...options, snapshotDir: join(h.repo, "snapshots") }), /必须保存在项目外/);
  const errorExec: Exec = (command, args, execOptions) => args.includes("ls-tree")
    ? Promise.resolve({ stdout: "", stderr: "cannot read tree", code: 1, killed: false }) : h.exec(command, args, execOptions);
  await assert.rejects(() => runReviewRound({ ...options, state: newReviewState(), exec: errorExec }), /保存评审快照失败/);
  assert.equal((await createGitEvidence(h.exec, h.repo).snapshot()).fingerprint, candidate.fingerprint);
});

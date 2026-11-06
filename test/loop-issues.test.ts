/** 问题单 A3–A8：复用开工/合入队列夹具，所有仓库及外部单子在私有系统临时目录。 */
import "./test-env.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { queueCommitSummary } from "../merge-queue.ts";
import { autoComplete, fixture, ROOT } from "./helpers/merge-queue-fixture.ts";

type Fixture = ReturnType<typeof fixture>;
const issuePath = "issues/示例.md";
const original = "# 示例\n排期：普通\n关联单：无\n状态：修复中·批次0\n## 问题描述\n原始正文\n\n## 环境与证据\n原始证据\n";
const content = (path: string) => readFileSync(path, "utf8");

function register(f: Fixture, paths: string[], tracked = [issuePath]): void {
  for (const rel of tracked) {
    mkdirSync(dirname(join(f.repo, rel)), { recursive: true });
    writeFileSync(join(f.repo, rel), original);
  }
  const file = f.batches[0].file, raw = JSON.parse(content(file));
  writeFileSync(file, JSON.stringify({ ...raw, issues: paths }));
  f.git(f.repo, "add", "--", ...tracked, relative(f.repo, file));
  f.git(f.repo, "commit", "-qm", "register issues");
  writeFileSync(join(f.root, "summary-0.md"), "# 交付报告\n\n测试用完成记录，不代表业务验收。\n");
}
function open(f: Fixture) {
  const opened = f.cli("开工", f.batches[0].file);
  assert.equal(opened.ok, true, JSON.stringify(opened));
  return opened;
}
async function completeAndMerge(f: Fixture) {
  f.write(0, "src/feature.txt", "implemented\n"); f.complete(0);
  await f.ready(0);
  const tested = f.queue().entries[0];
  const result = f.cli("合入", f.batches[0].file);
  assert.equal(result.ok, true, JSON.stringify(result));
  await f.idle();
  assert.equal(f.git(f.repo, "rev-parse", "HEAD"), tested.result, "发布的就是测过的提交，不能追加回写提交");
  return f.queue().entries[0];
}

test("A3/A4/A7 仓库内单头在批次文档提交预写，压缩不改树，合入相同测过提交，撤回恢复", async () => {
  const f = fixture(1, 0);
  try {
    register(f, [issuePath]);
    const base = f.git(f.repo, "rev-parse", "HEAD");
    // 此项明确通过用户入口 bin/loop，不替换开工或 Git 行为。
    const run = spawnSync(join(ROOT, "bin", "loop"), ["开工", f.batches[0].file, "--json"], { cwd: f.repo, env: process.env, encoding: "utf8", timeout: 30_000 });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    const opened = JSON.parse(run.stdout), dev = f.batches[0].cwd;
    assert.equal(opened.batchDocs.committed, true);
    assert.deepEqual(opened.batchDocs.files, [issuePath]);
    assert.deepEqual(opened.batchDocs.restore, [], "问题单不是从运行版移走的文档");
    assert.match(f.git(dev, "show", "-s", "--format=%s%n%b", "HEAD"), /feat: 批次文档/);
    const prepared = content(join(dev, issuePath));
    assert.match(prepared, /状态：已合入待验·批次0；未验证项见本批交付总表.*Loop 总结/);
    assert.equal(prepared.replace(/^状态[^\n]*/m, "状态：修复中·批次0"), original, "除状态行之外逐字保留");
    assert.equal(content(join(f.repo, issuePath)), original);
    assert.equal(f.git(f.repo, "rev-parse", "HEAD"), base);
    assert.equal(f.git(f.repo, "status", "--porcelain"), "");
    assert.equal(f.git(dev, "status", "--porcelain"), "");
    f.write(0, "src/feature.txt", "implemented\n");
    const tree = f.devEvidence(dev).tree;
    f.complete(0); await f.ready(0);
    assert.equal(f.queue().batches[0].commits![0].tree, tree, "整批压缩前后候选树不变");
    const tested = f.queue().entries[0];
    const result = f.cli("合入", f.batches[0].file); assert.equal(result.ok, true, JSON.stringify(result));
    await f.idle();
    assert.equal(f.git(f.repo, "rev-parse", "HEAD"), tested.result);
    assert.equal(f.git(f.repo, "rev-parse", "HEAD^{tree}"), tested.tree);
    assert.equal(content(join(f.repo, issuePath)), prepared);
    assert.equal(f.git(f.repo, "status", "--porcelain"), "");
    assert.match(content(join(f.root, "summary-0.md")), /回写已随本批提交进入目标分支/);
    const withdrawn = f.cli("撤回", f.batches[0].file); assert.equal(withdrawn.ok, true, JSON.stringify(withdrawn));
    assert.equal(f.git(f.repo, "rev-parse", "HEAD"), base);
    assert.equal(content(join(f.repo, issuePath)), original);
    assert.equal(f.git(f.repo, "status", "--porcelain"), "");
  } finally { await f.close(); }
});

test("问题单 dry-run 不建工作区、不预写、不动仓库外单子，CRLF 和正文里的状态字段保留", async () => {
  const f = fixture(1, 0);
  try {
    const outside = join(f.root, "external.md"); writeFileSync(outside, original);
    register(f, [issuePath, outside]);
    const crlf = `${original}\n状态：正文里的例子，不是单头\n`.replace(/\n/g, "\r\n");
    writeFileSync(join(f.repo, issuePath), crlf);
    f.git(f.repo, "add", issuePath); f.git(f.repo, "commit", "-qm", "issue CRLF");
    const before = f.git(f.repo, "rev-parse", "HEAD");
    const dry = f.cli("开工", f.batches[0].file, "--dry-run");
    assert.equal(dry.ok, true, JSON.stringify(dry));
    assert.match(dry.lines.join("\n"), /将随批次文档预写.*未执行/);
    assert.deepEqual(dry.batchDocs.files, [issuePath]);
    assert.equal(existsSync(f.batches[0].cwd), false);
    assert.equal(f.git(f.repo, "rev-parse", "HEAD"), before);
    assert.equal(content(join(f.repo, issuePath)), crlf); assert.equal(content(outside), original);
    open(f);
    assert.equal(content(join(f.batches[0].cwd, issuePath)).replace(/^状态[^\r\n]*/m, "状态：修复中·批次0"), crlf);
  } finally { await f.close(); }
});

test("A5 不存在、未跟踪、只读及链接单子只提示，开工和后续合入不受影响", async () => {
  const f = fixture(1, 0);
  try {
    const readonly = "issues/只读.md", local = "issues/未跟踪.md", linked = "issues/链接.md";
    register(f, ["issues/不存在.md", local, readonly, linked], [readonly]);
    writeFileSync(join(f.repo, local), original);
    const outside = join(f.root, "outside.md"); writeFileSync(outside, original);
    symlinkSync(outside, join(f.repo, linked));
    f.git(f.repo, "add", linked); f.git(f.repo, "commit", "-qm", "issue symlink");
    f.git(f.repo, "worktree", "add", "-b", f.batches[0].branch, f.batches[0].cwd, "main");
    chmodSync(join(f.batches[0].cwd, readonly), 0o444);
    const opened = open(f);
    assert.match(opened.lines.join("\n"), /找不到文件，不会回写/);
    assert.match(opened.lines.join("\n"), /未纳入本仓库/);
    assert.match(opened.lines.join("\n"), /文件只读/);
    assert.match(opened.lines.join("\n"), /符号链接/);
    assert.equal(content(outside), original);
    assert.equal(f.git(f.batches[0].cwd, "status", "--porcelain"), "");
    const entry = await completeAndMerge(f);
    assert.equal(content(join(f.repo, readonly)), original);
    assert.match(content(entry.ledger!), /找不到文件[\s\S]*未纳入本仓库[\s\S]*文件只读/);
    assert.match(content(join(f.root, "summary-0.md")), /找不到文件[\s\S]*未纳入本仓库/);
    assert.equal(content(join(f.repo, local)), original);
  } finally { await f.close(); }
});

test("回写 git add 或批次文档提交失败时撤销附带改动，不新增开工卡点", async (t) => {
  for (const failure of ["add", "commit"] as const) await t.test(failure, async () => {
    const f = fixture(1, 0);
    try {
      register(f, [issuePath]);
      // 另有必须搬运的文档，回写提交失败后仍须保留并提交它。
      writeFileSync(join(f.repo, "prompt.md"), "本批修改后的提示词\n");
      const realGit = spawnSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
      const wrapper = join(f.root, "bin", "git"), once = join(f.root, "failed-once");
      writeFileSync(wrapper, `#!/bin/sh\ncase " $* " in\n *" ${failure} "*) if [ "$PWD" = '${f.batches[0].cwd}' ] && [ ! -f '${once}' ]; then : > '${once}'; echo ISSUE_WRITE_FAILED >&2; exit 1; fi;;\nesac\nexec '${realGit}' "$@"\n`);
      chmodSync(wrapper, 0o755);
      const opened = open(f);
      assert.match(opened.lines.join("\n"), /ISSUE_WRITE_FAILED/);
      assert.equal(content(join(f.batches[0].cwd, issuePath)), original);
      assert.equal(content(join(f.batches[0].cwd, "prompt.md")), "本批修改后的提示词\n");
      assert.equal(f.git(f.batches[0].cwd, "status", "--porcelain"), "");
      assert.equal(f.git(f.repo, "status", "--porcelain"), "");
      await completeAndMerge(f);
      assert.equal(content(join(f.repo, issuePath)), original);
    } finally { await f.close(); }
  });
});

test("A6 仓库外单子只在合入后直接回写，只读失败进入总结和总表，重复收尾不重开已解决单子", async (t) => {
  for (const readonly of [false, true]) await t.test(readonly ? "只读" : "可写", async () => {
    const f = fixture(1, 0);
    const outside = join(f.root, "external.md");
    try {
      writeFileSync(outside, original);
      register(f, [relative(f.repo, outside)], []);
      const opened = open(f);
      assert.match(opened.lines.join("\n"), /仓库外问题单，开工不写/);
      assert.equal(content(outside), original);
      const movedBatch = JSON.parse(content(join(f.batches[0].cwd, "batch-0.json")));
      assert.equal(movedBatch.issues[0], outside, "非同目录开发空间也固定原仓库外相对路径");
      if (readonly) chmodSync(outside, 0o444);
      const entry = await completeAndMerge(f);
      if (readonly) {
        assert.equal(content(outside), original);
        assert.match(content(join(f.root, "summary-0.md")), /仓库外单头没写进去.*只读/);
        assert.match(content(entry.ledger!), /仓库外单头没写进去.*只读/);
      } else {
        assert.match(content(outside), /状态：已合入待验·批次0；未验证项见本批交付总表/);
        assert.equal(content(outside).replace(/^状态[^\n]*/m, "状态：修复中·批次0"), original);
        writeFileSync(outside, original.replace("修复中·批次0", "已解决（关闭原因：完成）"));
        const again = f.cli("合入", f.batches[0].file); assert.equal(again.ok, true);
        await f.idle(); assert.match(content(outside), /已解决（关闭原因：完成）/);
      }
      assert.equal(f.git(f.repo, "status", "--porcelain"), "");
    } finally { chmodSync(outside, 0o644); await f.close(); }
  });
});

test("A8 正文紧邻状态行被目标分支修改时，先合并两者并核对，不冲突退回", async () => {
  const f = fixture(1, 0);
  try {
    register(f, [issuePath]); open(f);
    const advanced = original.replace("## 问题描述\n原始正文", "## 问题描述（补充）\n用户补充的新正文");
    writeFileSync(join(f.repo, issuePath), advanced);
    f.git(f.repo, "add", issuePath); f.git(f.repo, "commit", "-qm", "user updates adjacent issue body");
    const entry = await completeAndMerge(f);
    assert.equal(entry.returnCount ?? 0, 0);
    assert.match(content(join(f.repo, issuePath)), /状态：已合入待验·批次0/);
    assert.match(content(join(f.repo, issuePath)), /## 问题描述（补充）\n用户补充的新正文/);
    assert.equal(f.git(f.repo, "status", "--porcelain"), "");
    assert.equal(f.git(f.repo, "rev-parse", "HEAD^{tree}"), entry.tree);
    assert.equal(entry.testConclusion, "Loop 未运行测试");
    assert.equal(existsSync(join(f.root, "gate-executed")), false);
  } finally { await f.close(); }
});

test("自动状态冲突处理不吞掉真实正文冲突或用户的关单状态", async (t) => {
  for (const kind of ["正文", "状态"] as const) await t.test(kind, async () => {
    const f = fixture(1, 0);
    try {
      register(f, [issuePath]); open(f);
      const target = kind === "正文" ? original.replace("原始正文", "目标分支正文") : original.replace("修复中·批次0", "已解决（关闭原因：不做）");
      writeFileSync(join(f.repo, issuePath), target);
      f.git(f.repo, "add", issuePath); f.git(f.repo, "commit", "-qm", "user changes issue");
      if (kind === "正文") f.write(0, issuePath, content(join(f.batches[0].cwd, issuePath)).replace("原始正文", "本批不同正文"));
      f.complete(0); await f.until(() => f.queue().entries[0]?.status === "returned"); await f.idle();
      assert.equal(content(join(f.repo, issuePath)), target, "不替用户解决真实分歧");
      assert.deepEqual(f.queue().entries[0].conflicts, [issuePath]);
    } finally { await f.close(); }
  });
});

test("自动合入同样回写外部单头并保留部署所需的完整提交身份", async () => {
  const f = fixture(1, 0);
  try {
    const outside = join(f.root, "external.md"); writeFileSync(outside, original);
    const marker = join(f.repo, ".autoreview.json"), config = JSON.parse(content(marker));
    writeFileSync(marker, JSON.stringify({ ...config, release: "dev" }));
    f.git(f.repo, "add", ".autoreview.json"); f.git(f.repo, "commit", "-qm", "use dev release"); f.git(f.repo, "checkout", "-b", "dev");
    register(f, [outside, join(f.repo, issuePath)]); open(f);
    assert.equal(content(outside), original);
    f.write(0, "src/feature.txt", "implemented\n"); autoComplete(f, 0);
    await f.until(() => f.queue().entries[0]?.status === "merged" && Boolean(f.queue().entries[0].mergeNotified)); await f.idle();
    const entry = f.queue().entries[0];
    assert.equal(f.git(f.repo, "rev-parse", "HEAD"), entry.result);
    assert.equal(f.git(f.repo, "rev-parse", "HEAD^{tree}"), entry.tree);
    assert.equal(entry.deployment?.status, "disabled");
    assert.match(content(outside), /状态：已合入待验·批次0/);
    assert.match(content(join(f.repo, issuePath)), /状态：已合入待验·批次0/);
    assert.equal(f.git(f.repo, "status", "--porcelain"), "");
    queueCommitSummary(f.batches[0].cwd, join(f.root, "summary-0.md"), { AUTOREVIEW_BATCH_FILE: f.batches[0].file, AUTOREVIEW_STAGE: "甲" });
    assert.match(content(join(f.root, "summary-0.md")), /合入成功后已直接回写仓库外单头/);
  } finally { await f.close(); }
});

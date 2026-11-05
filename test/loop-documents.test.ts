/** loop／documents：按功能独立运行，夹具与状态不跨测试进程共享。 */
/** bin/loop 的开工、启动、状态、合入；测试仓库、worktree 和 methods.json 都建在系统临时目录。 */
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { parsePlan } from "../pipeline.ts";
import { createChildExec } from "../hosts/review-hook.ts";
import { changedSince, outOfScope } from "../scope.ts";
import { git, fixture, loop, jsonOf } from "./helpers/loop-fixture.ts";

test("A1 开工只要求运行版停在发布分支；批次文档随批次分支提交，无关改动保留", async () => {
  const f = fixture();
  const batch = join(f.repo, "批次-文档.json");
  const prompt = join(f.repo, "提示词-文档.md");
  writeFileSync(prompt, "按本批文档实现\n");
  writeFileSync(batch, JSON.stringify({ name: "文档批次", branch: "feat/文档",
    stages: { 甲: { prompt: "提示词-文档.md", workspace: "dev分支" } }, steps: [["甲"]] }, null, 2));
  writeFileSync(join(f.repo, "README.md"), "dirty runtime\n");
  writeFileSync(join(f.repo, "notes.txt"), "untracked\n");
  const opened = loop(f.repo, ["开工", batch, "--json"]);
  assert.equal(opened.status, 0, `${opened.stdout}\n${opened.stderr}`);
  const result = jsonOf(opened);
  assert.equal(result.ok, true);
  assert.ok(!existsSync(batch), "批次文件已从项目根移走");
  assert.ok(!existsSync(prompt), "提示词已从项目根移走");
  assert.equal(readFileSync(join(f.repo, "README.md"), "utf8"), "dirty runtime\n", "无关的已跟踪改动保留");
  assert.equal(readFileSync(join(f.repo, "notes.txt"), "utf8"), "untracked\n", "无关的未跟踪文件保留");
  assert.deepEqual(result.uncommitted, ["README.md", "notes.txt"].sort());
  const docs = result.batchDocs as Record<string, unknown>;
  assert.deepEqual(docs.files, ["批次-文档.json", "提示词-文档.md"].sort());
  assert.deepEqual(docs.restore, docs.files);
  assert.equal(docs.committed, true);
  assert.equal(docs.commit, git(f.worktree, ["rev-parse", "HEAD"]));
  const log = git(f.worktree, ["show", "-s", "--format=%s%n%b", "HEAD"]);
  assert.match(log, /^feat: 批次文档/m);
  assert.match(log, /批次：文档批次/);
  assert.deepEqual(git(f.worktree, ["show", "--name-only", "--format=", "HEAD"]).split("\n").filter(Boolean).sort(),
    ["批次-文档.json", "提示词-文档.md"].sort());
  const baseline = git(f.worktree, ["rev-parse", "HEAD"]);
  const exec = createChildExec();
  const scope = { allow: ["src/"] };
  assert.deepEqual(outOfScope(await changedSince(exec, f.worktree, baseline), scope), [], "开工文档不算开发越界");
  writeFileSync(join(f.worktree, "越界.txt"), "outside scope\n");
  assert.deepEqual(outOfScope(await changedSince(exec, f.worktree, baseline), scope), ["越界.txt"], "后续越界改动仍会检出");
});

test("A2 发布分支上已跟踪的提示词在项目根改过，也搬进批次分支并恢复", () => {
  const f = fixture();
  const absolutePrompt = join(f.repo, "prompt.md");
  const rawBatch = JSON.parse(readFileSync(f.batch, "utf8"));
  rawBatch.stages.甲.prompt = absolutePrompt;
  writeFileSync(f.batch, JSON.stringify(rawBatch, null, 2));
  git(f.repo, ["add", "batch.json"]); git(f.repo, ["commit", "-qm", "batch absolute prompt"]);
  writeFileSync(absolutePrompt, "修改后的提示词\n");
  const opened = loop(f.repo, ["开工", f.batch, "--json"]);
  assert.equal(opened.status, 0, `${opened.stdout}\n${opened.stderr}`);
  const result = jsonOf(opened);
  const docs = result.batchDocs as Record<string, unknown>;
  assert.deepEqual(docs.files, ["batch.json", "prompt.md"].sort(), "批次文件也因绝对路径改写进入提交");
  assert.equal(readFileSync(join(f.worktree, "prompt.md"), "utf8"), "修改后的提示词\n", "改过的提示词进了批次分支");
  assert.equal(readFileSync(join(f.repo, "prompt.md"), "utf8"), "做一件事\n", "项目根恢复成发布分支的内容");
  assert.deepEqual(result.uncommitted, []);
  assert.match(git(f.worktree, ["show", "-s", "--format=%s%n%b", "HEAD"]), /feat: 批次文档[\s\S]*批次：测试批次/);
  // 批次文件已随绝对提示词改写到开发空间；用开发空间里的批次文件启动时不能读回旧提示词。
  const started = loop(f.repo, ["启动", join(f.worktree, "batch.json"), "--dry-run", "--json"]);
  assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);
  const workspacePrompt = join(f.worktree, "prompt.md").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(String(jsonOf(started).startCommand), new RegExp(workspacePrompt));
  const workspaceBatch = join(f.worktree, "batch.json");
  const plan = parsePlan(JSON.parse(readFileSync(workspaceBatch, "utf8")), f.worktree, process.env,
    { projectRoot: f.repo, batchFile: workspaceBatch });
  assert.equal(plan.stages.get("甲")!.prompt, join(f.worktree, "prompt.md"), "流水线入口解析开发空间批次文件时也指向新提示词");
});

test("A3 开工 --dry-run 列出要搬的批次文档和要恢复的项目根文件，不改任何东西", () => {
  const f = fixture();
  const batch = join(f.repo, "批次-文档.json");
  const prompt = join(f.repo, "提示词-文档.md");
  writeFileSync(prompt, "按本批文档实现\n");
  writeFileSync(batch, JSON.stringify({ name: "文档批次", branch: "feat/文档",
    stages: { 甲: { prompt: "提示词-文档.md", workspace: "dev分支" } }, steps: [["甲"]] }, null, 2));
  writeFileSync(join(f.repo, "README.md"), "dirty runtime\n");
  const before = git(f.repo, ["rev-parse", "HEAD"]);
  const dry = loop(f.repo, ["开工", batch, "--dry-run", "--json"]);
  assert.equal(dry.status, 0, dry.stderr);
  const result = jsonOf(dry);
  const docs = result.batchDocs as Record<string, unknown>;
  assert.deepEqual(docs.files, ["批次-文档.json", "提示词-文档.md"].sort());
  assert.deepEqual(docs.restore, docs.files);
  assert.deepEqual(result.uncommitted, ["README.md"]);
  assert.ok(!existsSync(f.worktree), "dry-run 不建 worktree");
  assert.equal(git(f.repo, ["branch", "--list", "feat/文档"]), "", "dry-run 不建分支");
  assert.equal(git(f.repo, ["rev-parse", "HEAD"]), before);
  assert.ok(existsSync(batch) && existsSync(prompt), "dry-run 不搬文件");
  assert.equal(readFileSync(join(f.repo, "README.md"), "utf8"), "dirty runtime\n");
});

test("多段流水线使用开发空间批次文件，仓库外相对引用保持原目标", () => {
  const f = fixture();
  const workspace = join(f.root, "workspaces", "wt");
  const marker = JSON.parse(readFileSync(join(f.repo, ".autoreview.json"), "utf8"));
  marker.workspaces = { dev分支: workspace };
  writeFileSync(join(f.repo, ".autoreview.json"), JSON.stringify(marker, null, 2));
  git(f.repo, ["add", ".autoreview.json"]); git(f.repo, ["commit", "-qm", "custom workspace"]);
  const batchDir = join(f.repo, "docs", "batches", "多段");
  const internal = join(f.repo, "docs", "prompt", "内部.md");
  const external = join(f.root, "external-prompt.md");
  mkdirSync(batchDir, { recursive: true }); mkdirSync(dirname(internal), { recursive: true });
  writeFileSync(internal, "内部提示词\n");
  writeFileSync(external, "外部提示词\n");
  const batch = join(batchDir, "批次.json");
  writeFileSync(batch, JSON.stringify({ name: "多段", branch: "feat/多段", stages: {
    甲: { prompt: relative(batchDir, external), workspace: "dev分支" },
    乙: { prompt: internal, workspace: "dev分支" },
  }, steps: [["甲"], ["乙"]] }, null, 2));
  const opened = loop(f.repo, ["开工", batch, "--json"]);
  assert.equal(opened.status, 0, `${opened.stdout}\n${opened.stderr}`);
  assert.equal((jsonOf(opened).workspaces as Array<Record<string, unknown>>)[0].path, workspace);
  const movedBatch = join(workspace, "docs", "batches", "多段", "批次.json");
  const moved = JSON.parse(readFileSync(movedBatch, "utf8"));
  assert.equal(moved.stages.甲.prompt, external, "仓库外相对引用改写为原绝对目标");
  assert.equal(moved.stages.乙.prompt, join(workspace, "docs", "prompt", "内部.md"), "仓库内绝对引用改到开发空间");
  const plan = parsePlan(moved, dirname(movedBatch), process.env, { projectRoot: f.repo, batchFile: movedBatch });
  assert.equal(plan.stages.get("甲")!.prompt, external);
  assert.equal(plan.stages.get("乙")!.prompt, join(workspace, "docs", "prompt", "内部.md"));
  assert.equal(plan.steps.length, 2);
});

test("依赖路径与实际搬运范围一致：全局和段级 Ponytail 能启动，验收说明可读取", async (t) => {
  for (const level of ["全局", "段级"] as const) for (const location of ["批次外", "批次内"] as const) {
    for (const pathKind of ["绝对", "相对"] as const) await t.test(`${level}·${location}·${pathKind}`, () => {
      const f = fixture();
      const batchDir = join(f.repo, "docs", "batches", "依赖");
      const resources = location === "批次内" ? join(batchDir, "resources") : join(f.repo, "dependencies");
      mkdirSync(batchDir, { recursive: true }); mkdirSync(resources, { recursive: true });
      const extension = join(resources, "ponytail.js"), guide = join(resources, "guide.md");
      writeFileSync(extension, "// local extension\n");
      writeFileSync(guide, "操作说明原文\n");
      writeFileSync(join(batchDir, "验收.md"), "## 验收标准\nA1. [甲] 操作：执行\n    预期：通过\n");
      const ref = (file: string): string => pathKind === "绝对" ? file : relative(batchDir, file);
      const ponytail = { extension: ref(extension), mode: "full" };
      const batch = join(batchDir, "批次.json");
      writeFileSync(batch, JSON.stringify({ name: "依赖", branch: "feat/依赖",
        ...(level === "全局" ? { pi: { ponytail } } : {}),
        stages: { 甲: { prompt: "../../../prompt.md", workspace: "dev分支", ...(level === "段级" ? { ponytail } : {}) } },
        steps: [["甲"]], acceptance: { workDir: f.repo, criteria: "验收.md", guide: ref(guide) },
      }, null, 2));
      const opened = loop(f.repo, ["开工", batch, "--json"]);
      assert.equal(opened.status, 0, `${opened.stdout}\n${opened.stderr}`);
      const expected = (file: string): string => location === "批次内" ? join(f.worktree, relative(f.repo, file)) : file;
      for (const file of [extension, guide]) {
        assert.equal(existsSync(file), location === "批次外", "只移走本批实际搬运的文件");
        assert.equal(existsSync(join(f.worktree, relative(f.repo, file))), location === "批次内");
      }
      const log = join(f.root, "pi-args.log");
      writeFileSync(process.env.PI_BIN!, `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}'\n`);
      const permission = join(f.root, "home", ".pi", "agent", "extensions", "pi-permission-system");
      mkdirSync(permission, { recursive: true });
      writeFileSync(join(permission, "config.json"), JSON.stringify({ yoloMode: true }));
      const movedBatch = join(f.worktree, relative(f.repo, batch));
      const started = loop(f.repo, ["启动", movedBatch, "--json"]);
      assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);
      assert.ok(readFileSync(log, "utf8").split("\n").includes(expected(extension)), "pi-dev 传入可用的扩展路径");
      const plan = parsePlan(JSON.parse(readFileSync(movedBatch, "utf8")), dirname(movedBatch), process.env,
        { projectRoot: f.repo, batchFile: movedBatch });
      assert.equal(plan.stages.get("甲")!.ponytail!.extension, expected(extension));
      assert.equal(plan.acceptance!.acceptance.guide, expected(guide));
      assert.equal(readFileSync(plan.acceptance!.acceptance.guide!, "utf8"), "操作说明原文\n");
    });
  }
});

test("非同级工作区配合相对 cwd，搬运后能从原目录实际启动", async (t) => {
  for (const entry of ["prompt", "start"] as const) await t.test(entry, () => {
    const f = fixture();
    const workspace = join(f.root, "workspaces", "dev");
    git(f.repo, ["worktree", "add", "-b", "feat/相对目录", workspace, "main"]);
    const batchDir = join(f.repo, "docs", "batches", "相对目录");
    mkdirSync(batchDir, { recursive: true });
    const batch = join(batchDir, "批次.json");
    const log = join(f.root, "started-cwd.log");
    writeFileSync(process.env.PI_BIN!, `#!/bin/sh\npwd > '${log}'\n`);
    const source = { name: "相对目录", branch: "feat/相对目录", stages: {
      甲: { cwd: relative(batchDir, workspace), ...(entry === "prompt"
        ? { prompt: "../../../prompt.md" } : { start: `pwd > '${log}'` }) },
    }, steps: [["甲"]] };
    writeFileSync(batch, JSON.stringify(source, null, 2));
    const opened = loop(f.repo, ["开工", batch, "--json"]);
    assert.equal(opened.status, 0, `${opened.stdout}\n${opened.stderr}`);
    const movedBatch = join(workspace, "docs", "batches", "相对目录", "批次.json");
    const permission = join(f.root, "home", ".pi", "agent", "extensions", "pi-permission-system");
    mkdirSync(permission, { recursive: true });
    writeFileSync(join(permission, "config.json"), JSON.stringify({ yoloMode: true }));
    const started = loop(f.repo, ["启动", movedBatch, "--json"]);
    assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);
    assert.equal(jsonOf(started).cwd, workspace);
    assert.equal(readFileSync(log, "utf8").trim(), workspace, "启动进程实际位于原 cwd");
    const plan = parsePlan(JSON.parse(readFileSync(movedBatch, "utf8")), dirname(movedBatch), process.env,
      { projectRoot: f.repo, batchFile: movedBatch });
    assert.equal(plan.stages.get("甲")!.cwd, workspace, "直接流水线入口也保留原 cwd");
  });
});

test("原生开发空间批次保留相对引用解析，不按 worktree 来源重定位", () => {
  const f = fixture();
  const wt = join(f.root, "dev", "wt");
  git(f.repo, ["worktree", "add", "-b", "feat/原生", wt, "main"]);
  const prompt = join(f.root, "dev", "prompt.md");
  const criteria = join(f.root, "dev", "criteria.md");
  mkdirSync(dirname(prompt), { recursive: true });
  writeFileSync(prompt, "原生提示词\n");
  writeFileSync(criteria, "## 验收标准\n1. 操作：执行\n   预期：通过\n");
  const batch = join(wt, "批次.json");
  writeFileSync(batch, JSON.stringify({ name: "原生", branch: "feat/原生",
    stages: { 甲: { prompt: "../prompt.md", workspace: "dev分支" } }, steps: [["甲"]],
    e2e: { workDir: ".", criteria: "../criteria.md" } }, null, 2));
  const plan = parsePlan(JSON.parse(readFileSync(batch, "utf8")), wt, process.env,
    { batchFile: batch, projectRoot: f.repo });
  assert.equal(plan.stages.get("甲")!.prompt, prompt, "相对提示词按批次所在目录解析");
  assert.equal(plan.acceptance!.criteriaFile, criteria, "相对验收标准按批次所在目录解析");
});

test("被忽略的同名文件不被覆盖：搬运前列出全部未跟踪目标并保留两边文档", async (t) => {
  for (const kind of ["文件", "链接", "悬空链接", "目录"] as const) await t.test(kind, () => {
    const f = fixture();
    git(f.repo, ["worktree", "add", "-b", "feat/测试", f.worktree, "main"]);
    git(f.worktree, ["rm", "prompt.md"]);
    writeFileSync(join(f.worktree, ".gitignore"), ".env.local\nprompt.md\nz-prompt.md\n");
    git(f.worktree, ["add", ".gitignore"]); git(f.worktree, ["commit", "-qm", "ignore local prompts"]);
    const target = join(f.worktree, "prompt.md");
    const outside = join(f.root, "local-prompt.md");
    if (kind === "文件") writeFileSync(target, "local original\n");
    else if (kind === "目录") {
      mkdirSync(target); writeFileSync(join(target, "keep.md"), "local original\n");
    } else {
      if (kind === "链接") writeFileSync(outside, "local original\n");
      symlinkSync(outside, target);
    }
    writeFileSync(join(f.worktree, "z-prompt.md"), "another local original\n");
    writeFileSync(join(f.repo, "prompt.md"), "new batch prompt\n");
    writeFileSync(join(f.repo, "z-prompt.md"), "another batch prompt\n");
    const raw = JSON.parse(readFileSync(f.batch, "utf8"));
    raw.stages.乙 = { prompt: "z-prompt.md" }; raw.steps.push(["乙"]);
    writeFileSync(f.batch, JSON.stringify(raw, null, 2));
    const beforeBatch = readFileSync(join(f.worktree, "batch.json"), "utf8");
    const beforeHead = git(f.worktree, ["rev-parse", "HEAD"]);
    assert.equal(git(f.worktree, ["status", "--porcelain"]), "", "忽略文件不会触发普通脏检查");
    for (const flags of [[], ["--dry-run"]]) {
      const opened = loop(f.repo, ["开工", f.batch, "--json", ...flags]);
      assert.notEqual(opened.status, 0);
      if (kind === "文件") assert.equal(readFileSync(target, "utf8"), "local original\n");
      else if (kind === "目录") assert.equal(readFileSync(join(target, "keep.md"), "utf8"), "local original\n");
      else {
        assert.equal(lstatSync(target).isSymbolicLink(), true, "不替换未跟踪的链接本身");
        assert.equal(readlinkSync(target), outside);
        if (kind === "链接") assert.equal(readFileSync(outside, "utf8"), "local original\n");
        else assert.equal(existsSync(outside), false);
      }
      assert.equal(readFileSync(join(f.worktree, "z-prompt.md"), "utf8"), "another local original\n");
      assert.equal(readFileSync(join(f.worktree, "batch.json"), "utf8"), beforeBatch, "冲突前不写其他批次文档");
      const result = jsonOf(opened);
      assert.match(String(result.error), /未跟踪.*不覆盖/);
      assert.deepEqual(result.files, ["prompt.md", "z-prompt.md"]);
      assert.equal(git(f.worktree, ["rev-parse", "HEAD"]), beforeHead);
      assert.equal(git(f.worktree, ["status", "--porcelain"]), "");
      assert.equal(readFileSync(join(f.repo, "prompt.md"), "utf8"), "new batch prompt\n");
      assert.equal(readFileSync(f.batch, "utf8"), JSON.stringify(raw, null, 2));
    }
  });
});

test("同名文档是被忽略的未跟踪文件时，切换批次分支前就拒绝覆盖", () => {
  const f = fixture();
  git(f.repo, ["branch", "feat/测试", "main"]);
  git(f.repo, ["worktree", "add", "-b", "feat/当前", f.worktree, "main"]);
  git(f.worktree, ["rm", "prompt.md"]);
  writeFileSync(join(f.worktree, ".gitignore"), ".env.local\nprompt.md\n");
  git(f.worktree, ["add", ".gitignore"]); git(f.worktree, ["commit", "-qm", "ignore local prompt"]);
  writeFileSync(join(f.worktree, "prompt.md"), "local original\n");
  writeFileSync(join(f.repo, "prompt.md"), "new batch prompt\n");
  const opened = loop(f.repo, ["开工", f.batch, "--json"]);
  assert.equal(readFileSync(join(f.worktree, "prompt.md"), "utf8"), "local original\n", "checkout 也不能覆盖本地内容");
  assert.notEqual(opened.status, 0);
  assert.deepEqual(jsonOf(opened).files, ["prompt.md"]);
  assert.equal(git(f.worktree, ["branch", "--show-current"]), "feat/当前");
});

test("批次文档从符号链接改成普通文件时安全搬运，外部文件不被覆盖", () => {
  const f = fixture();
  const outside = join(f.root, "outside-prompt.md");
  writeFileSync(outside, "outside original\n");
  rmSync(join(f.repo, "prompt.md"));
  symlinkSync(outside, join(f.repo, "prompt.md"));
  git(f.repo, ["add", "-A"]); git(f.repo, ["commit", "-qm", "prompt symlink"]);
  rmSync(join(f.repo, "prompt.md"));
  writeFileSync(join(f.repo, "prompt.md"), "new prompt\n");
  const opened = loop(f.repo, ["开工", f.batch, "--json"]);
  assert.equal(opened.status, 0, `${opened.stdout}\n${opened.stderr}`);
  assert.equal(readFileSync(outside, "utf8"), "outside original\n", "没有写穿开发空间里的符号链接");
  const target = join(f.worktree, "prompt.md");
  assert.equal(lstatSync(target).isSymbolicLink(), false, "开发空间里保存成普通文件");
  assert.equal(readFileSync(target, "utf8"), "new prompt\n");
  assert.equal(lstatSync(join(f.repo, "prompt.md")).isSymbolicLink(), true, "项目根恢复成发布分支的符号链接");
  assert.equal(readlinkSync(join(f.repo, "prompt.md")), outside);
  assert.match(git(f.worktree, ["show", "--summary", "--format=", "HEAD"]), /mode change 120000 => 100644 prompt\.md/);
});

test("开发空间父路径是符号链接时拒绝搬批次文档，不写仓库外", () => {
  const f = fixture();
  const outside = join(f.root, "outside-docs");
  mkdirSync(outside);
  writeFileSync(join(outside, "prompt.md"), "outside original\n");
  symlinkSync(outside, join(f.repo, "docs"));
  git(f.repo, ["add", "docs"]); git(f.repo, ["commit", "-qm", "docs symlink"]);
  rmSync(join(f.repo, "docs"));
  mkdirSync(join(f.repo, "docs"));
  writeFileSync(join(f.repo, "docs", "prompt.md"), "new prompt\n");
  const rawBatch = JSON.parse(readFileSync(f.batch, "utf8"));
  rawBatch.stages.甲.prompt = "docs/prompt.md";
  writeFileSync(f.batch, JSON.stringify(rawBatch, null, 2));
  git(f.repo, ["add", "batch.json"]); git(f.repo, ["commit", "-qm", "batch under docs"]);
  const opened = loop(f.repo, ["开工", f.batch, "--json"]);
  assert.notEqual(opened.status, 0);
  assert.match(String(jsonOf(opened).error), /父路径是符号链接/);
  assert.equal(readFileSync(join(outside, "prompt.md"), "utf8"), "outside original\n", "没有写到链接目标");
  assert.equal(readFileSync(join(f.repo, "docs", "prompt.md"), "utf8"), "new prompt\n", "拒绝时项目根文件保留");
  assert.equal(lstatSync(join(f.worktree, "docs")).isSymbolicLink(), true, "开发空间里的父路径没有被替换");
});

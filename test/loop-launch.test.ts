/** loop／launch：按功能独立运行，夹具与状态不跨测试进程共享。 */
/** bin/loop 的开工、启动、状态、合入；测试仓库、worktree 和 methods.json 都建在系统临时目录。 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { parsePlan, stageScript } from "../pipeline.ts";
import { readMethodsRecord } from "../methods.ts";
import { queueDir, readMergeQueue } from "../merge-queue.ts";
import { LOOP_ROOT, head, git, fixture, loop, jsonOf, writeStage } from "./helpers/loop-fixture.ts";

test("单一入口 A1/A4：开工、启动 JSON 显示文件和 flag 预算", () => {
  const f = fixture();
  const marker = join(f.repo, ".autoreview.json");
  const original = JSON.parse(readFileSync(marker, "utf8"));
  writeFileSync(marker, JSON.stringify({ ...original, reviewTimeoutMin: 90, gate: { cmd: "true", timeoutMin: 20 }, acceptance: { timeoutMin: 60 } }));
  git(f.repo, ["add", ".autoreview.json"]); git(f.repo, ["commit", "-qm", "budget"]);
  for (const command of ["开工", "启动"]) {
    if (command === "启动") assert.equal(loop(f.repo, ["开工", f.batch, "--json"]).status, 0);
    for (const flags of [[], ["--autoreview-review-timeout-min", "120"]]) {
      const run = loop(f.repo, [command, f.batch, "--dry-run", "--json", ...flags]);
      assert.equal(run.status, 0, run.stderr || run.stdout);
      assert.deepEqual((jsonOf(run).effectiveConfig as any).reviewTimeoutMin,
        flags.length ? { value: 120, source: "flag" } : { value: 90, source: "file" });
    }
    if (command === "开工") assert.ok(!existsSync(f.worktree));
  }
});

test("单一入口：批次 Pi 参数参与提前校验，JSON 取实际段配置而非运行版旧值", () => {
  const f = fixture();
  writeFileSync(join(f.repo, ".autoreview.json"), JSON.stringify({ gate: { cmd: "true", timeoutMin: 20 }, acceptance: { timeoutMin: 60 } }));
  const batch = JSON.parse(readFileSync(f.batch, "utf8"));
  batch.pi = { args: ["--autoreview-review-timeout-min", "120"] };
  writeFileSync(f.batch, JSON.stringify(batch));
  git(f.repo, ["add", ".autoreview.json", "batch.json"]); git(f.repo, ["commit", "-qm", "explicit budget"]);
  for (const flags of [["--dry-run"], []]) {
    const opened = loop(f.repo, ["开工", f.batch, "--json", ...flags]);
    assert.equal(opened.status, 0, opened.stdout || opened.stderr);
    assert.deepEqual((jsonOf(opened).effectiveConfig as any).reviewTimeoutMin, { value: 120, source: "flag" });
  }
  const started = loop(f.repo, ["启动", f.batch, "--dry-run", "--json"]);
  assert.equal(started.status, 0, started.stdout || started.stderr);
  assert.deepEqual((jsonOf(started).effectiveConfig as any).stages.甲.reviewTimeoutMin, { value: 120, source: "flag" });

  const separate = fixture();
  assert.equal(loop(separate.repo, ["开工", separate.batch, "--json"]).status, 0);
  const marker = join(separate.worktree, ".autoreview.json"), config = JSON.parse(readFileSync(marker, "utf8"));
  writeFileSync(marker, JSON.stringify({ ...config, reviewTimeoutMin: 90 }));
  const actual = loop(separate.repo, ["启动", separate.batch, "--dry-run", "--json"]);
  assert.equal(actual.status, 0, actual.stdout || actual.stderr);
  assert.deepEqual((jsonOf(actual).effectiveConfig as any).reviewTimeoutMin, { value: 90, source: "file" });
});

test("单一入口：启动的显式预算实际传到替身会话，不只改变 JSON", () => {
  const f = fixture();
  const seen = join(f.root, "timeout.txt");
  const script = `require('node:fs').writeFileSync(${JSON.stringify(seen)}, process.env.AUTOREVIEW_REVIEW_TIMEOUT_MIN)`;
  writeFileSync(f.batch, JSON.stringify({ name: "预算透传", stages: { 甲: { cwd: f.repo, start: `'${process.execPath}' -e '${script.replace(/'/g, "'\\''")}'` } } }));
  const run = loop(f.repo, ["启动", f.batch, "--json", "--autoreview-review-timeout-min", "120"]);
  assert.equal(run.status, 0, run.stdout || run.stderr);
  assert.equal(readFileSync(seen, "utf8"), "120");
});

test("单一入口 A5/A6：配置预算不足时开工/启动及预览均无副作用", () => {
  const f = fixture();
  const marker = join(f.repo, ".autoreview.json");
  const original = JSON.parse(readFileSync(marker, "utf8"));
  writeFileSync(marker, JSON.stringify({ ...original, gate: { cmd: "true", timeoutMin: 20 }, acceptance: { timeoutMin: 60 } }));
  const branch = git(f.repo, ["branch", "--show-current"]), branches = git(f.repo, ["for-each-ref", "refs/heads"]);
  const trees = git(f.repo, ["worktree", "list", "--porcelain"]), files = git(f.repo, ["status", "--porcelain"]);
  const launched = join(f.root, "launched");
  writeFileSync(process.env.PI_BIN!, `#!/bin/sh\ntouch '${launched}'\n`);
  for (const command of ["开工", "启动"]) for (const dry of [[], ["--dry-run"]]) {
    const run = loop(f.repo, [command, f.batch, ...dry, "--json"]);
    assert.notEqual(run.status, 0);
    assert.equal(jsonOf(run).error, ".autoreview.json 的 acceptance.timeoutMin（60）必须小于一轮总预算 reviewTimeoutMin（60）");
    assert.ok(!existsSync(f.worktree)); assert.ok(!existsSync(launched));
    assert.equal(git(f.repo, ["branch", "--show-current"]), branch);
    assert.equal(git(f.repo, ["for-each-ref", "refs/heads"]), branches);
    assert.equal(git(f.repo, ["worktree", "list", "--porcelain"]), trees);
    assert.equal(git(f.repo, ["status", "--porcelain"]), files);
    assert.ok(!existsSync(join(f.root, "projects")), "配置失败时不执行方法自测");
  }
});

test("单一入口 A7：开发 pi 与原入口逐字相同，含空格参数和 -- 后参数原样透传", () => {
  const f = fixture();
  const prompt = join(f.repo, "prompt.md");
  const args = ["--cwd", f.repo, "--dry-run", prompt, "--", "--autoreview-review-timeout-min", "120", "--name", "含 空格的名称"];
  const direct = spawnSync(join(LOOP_ROOT, "bin/pi-dev"), args, { cwd: f.repo, env: process.env, encoding: "utf8" });
  const wrapped = loop(f.repo, ["开发", "pi", ...args]);
  assert.equal(direct.status, 0, direct.stderr); assert.equal(wrapped.status, 0, wrapped.stderr);
  assert.equal(wrapped.stdout, direct.stdout);
  const invalid = loop(f.repo, ["开发", "unknown", "--dry-run"]);
  assert.notEqual(invalid.status, 0); assert.match(invalid.stderr, /pi\|claude\|codex/);
});

test("A5 开工输出用开发空间里的批次文件路径，loop 启动能取到提示词并经过 bin/pi-dev", () => {
  const f = fixture();
  const dir = join(f.repo, "docs", "batches", "文档批次");
  const batch = join(dir, "批次.json");
  const prompt = join(f.repo, "docs", "prompt", "提示词-文档.md");
  const criteria = join(f.repo, "docs", "prompt", "验收-文档.md");
  mkdirSync(dir, { recursive: true }); mkdirSync(dirname(prompt), { recursive: true });
  writeFileSync(prompt, "按本批文档实现\n");
  writeFileSync(criteria, "## 验收标准\n1. 操作：执行本批\n   预期：通过\n");
  writeFileSync(batch, JSON.stringify({ name: "文档批次", branch: "feat/文档",
    stages: { 甲: { prompt, workspace: "dev分支" } }, steps: [["甲"]],
    acceptance: { workDir: ".", criteria } }, null, 2));
  const opened = jsonOf(loop(f.repo, ["开工", batch, "--json"]));
  const workspaceBatch = join(f.worktree, "docs", "batches", "文档批次", "批次.json");
  assert.ok(existsSync(workspaceBatch));
  const moved = JSON.parse(readFileSync(workspaceBatch, "utf8"));
  assert.equal(moved.stages.甲.prompt, join(f.worktree, "docs", "prompt", "提示词-文档.md"), "批次文件里的绝对提示词路径改到开发空间");
  assert.equal(moved.acceptance.criteria, join(f.worktree, "docs", "prompt", "验收-文档.md"), "批次文件里的绝对验收标准路径改到开发空间");
  const quoted = workspaceBatch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(String(opened.startCommand), new RegExp(quoted));
  assert.match(String(opened.statusCommand), new RegExp(quoted));
  assert.match(String(opened.mergeCommand), new RegExp(quoted));
  const started = loop(f.repo, ["启动", workspaceBatch, "--dry-run", "--json"]);
  assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);
  const startedJson = jsonOf(started);
  assert.match(String(startedJson.startCommand), /bin\/pi-dev/);
  const command = String((startedJson.commands as string[])[0]);
  assert.match(command, /docs\/prompt\/提示词-文档\.md/);
  const status = loop(f.repo, ["状态", workspaceBatch, "--json"]);
  assert.equal(status.status, 0, `${status.stdout}\n${status.stderr}`);
  assert.deepEqual((jsonOf(status).stages as Array<Record<string, unknown>>).map((entry) => entry.stage), ["甲"]);
  const mergeDry = loop(f.repo, ["合入", workspaceBatch, "--dry-run", "--json"]);
  assert.equal(mergeDry.status, 0, `${mergeDry.stdout}\n${mergeDry.stderr}`);
  const fromWorkspace = loop(f.worktree, ["启动", workspaceBatch, "--dry-run", "--json"]);
  assert.equal(fromWorkspace.status, 0, `${fromWorkspace.stdout}\n${fromWorkspace.stderr}`);
});

test("单段启动写入现有流水线状态，loop 状态能读到阶段、轮次、暂停原因和总结", () => {
  const f = fixture();
  const script = join(f.root, "single-status.mjs");
  writeFileSync(script, `import { mkdirSync, writeFileSync } from "node:fs";\nimport { join } from "node:path";\nconst dir = process.env.AUTOREVIEW_PIPELINE_DIR; const stage = process.env.AUTOREVIEW_STAGE;\nmkdirSync(dir, { recursive: true });\nconst summary = join(dir, stage + ".md"); writeFileSync(summary, "# 总结\\n评审 2 次，返修 1 次\\n");\nwriteFileSync(join(dir, stage + ".status.json"), JSON.stringify({ stage, sessionId: "single", summary, event: "paused", pauseReason: "等你决定", seq: 1, inbox: 0, updatedAt: new Date().toISOString() }));\n`);
  writeFileSync(f.batch, JSON.stringify({ name: "单段批次", branch: "feat/单段", stages: { 甲: { workspace: "dev分支", start: `"${process.execPath}" "${script}"` } }, steps: [["甲"]] }, null, 2));
  git(f.repo, ["add", "batch.json"]); git(f.repo, ["commit", "-qm", "single batch"]);
  assert.equal(loop(f.repo, ["开工", f.batch]).status, 0);
  const started = loop(f.repo, ["启动", f.batch, "--json"]);
  assert.equal(started.status, 0, started.stderr);
  assert.equal(jsonOf(started).ok, true);
  const status = jsonOf(loop(f.repo, ["状态", f.batch, "--json"]));
  const entry = (status.stages as Array<Record<string, unknown>>)[0];
  assert.equal(entry.event, "paused");
  assert.equal(entry.pauseReason, "等你决定");
  assert.equal(entry.round, 2);
  assert.match(String(entry.summary), /单段批次\/甲\.md$/);
});

test("A5 串行两段同一个 worktree：中间逐段提交，结束压成一个，甲的完成资格保留", async () => {
  const f = fixture();
  const plan = {
    name: "串行批次", branch: "feat/串行",
    stages: {
      甲: { start: writeStage(f.root, "甲") },
      乙: { start: writeStage(f.root, "乙") },
    },
    steps: [["甲"], ["乙"]], maxParallel: 1,
    dir: join(f.root, "pipeline"),
  };
  writeFileSync(f.batch, JSON.stringify(plan, null, 2));
  git(f.repo, ["add", "batch.json"]); git(f.repo, ["commit", "-qm", "serial batch"]);
  assert.equal(loop(f.repo, ["开工", f.batch]).status, 0);
  const started = loop(f.repo, ["启动", f.batch, "--launcher", "background", "--json"]);
  assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);
  assert.equal(jsonOf(started).ok, true);
  assert.equal(git(f.worktree, ["rev-list", "--count", "main..HEAD"]), "1", "批次结束整体压成一个提交");
  assert.match(String(jsonOf(started).stdout), /甲 完成提交：[\s\S]*乙 完成提交：/, "运行中仍然每段提交");
  const history = git(f.worktree, ["for-each-ref", "--format=%(refname)", "refs/loop/batches/"]);
  assert.match(history, /pre-squash\/1/); assert.equal(git(f.worktree, ["rev-list", "--count", `main..${history}`]), "2", "两个中间提交仍可回放");
  const log = git(f.worktree, ["log", "--format=%s%n%b", "main..HEAD"]);
  assert.match(log, /feat: 串行/);
  assert.match(log, /批次：串行批次/);
  assert.match(log, /段：甲/);
  assert.match(log, /段：乙/);
  const status = JSON.parse(readFileSync(join(f.root, "pipeline", "甲.status.json"), "utf8"));
  assert.equal(status.event, "done");
  assert.ok(status.readyEpoch, "提交后甲的完成资格仍然有效");
  const dir = queueDir(f.repo), deadline = Date.now() + 15_000;
  while (Date.now() < deadline && (readMergeQueue(f.repo)?.entries[0]?.status !== "ready" || existsSync(join(dir, "worker.lock")) || readdirSync(dir).some((name) => /^executor-.*\.json$/.test(name)))) await new Promise((done) => setTimeout(done, 20));
  assert.equal(readMergeQueue(f.repo)?.entries[0]?.status, "ready");
  assert.ok(!existsSync(join(dir, "worker.lock"))); assert.ok(!readdirSync(dir).some((name) => /^executor-.*\.json$/.test(name)), "队列执行器已释放");
});

test("启动前发现工作区分支和批次不一致就停下", () => {
  const f = fixture();
  git(f.repo, ["worktree", "add", "-b", "feat/其他", f.worktree, "main"]);
  const batch = join(f.root, "branch-mismatch.json");
  writeFileSync(batch, JSON.stringify({ name: "分支不符", branch: "feat/要求", stages: { 甲: { start: "true" } }, steps: [["甲"]] }));
  const started = loop(f.repo, ["启动", batch, "--json"]);
  assert.notEqual(started.status, 0);
  assert.match(String(jsonOf(started).error), /批次要求 feat\/要求/);
});

test("A6 并行两段各在自己的 worktree 和分支完成，并各自提交", () => {
  const f = fixture();
  const wtA = join(f.root, "wt-甲"), wtB = join(f.root, "wt-乙");
  git(f.repo, ["worktree", "add", "-b", "feat/甲", wtA, "main"]);
  git(f.repo, ["worktree", "add", "-b", "feat/乙", wtB, "main"]);
  const plan = {
    name: "并行批次",
    stages: {
      甲: { cwd: wtA, branch: "feat/甲", start: writeStage(f.root, "甲") },
      乙: { cwd: wtB, branch: "feat/乙", start: writeStage(f.root, "乙") },
    },
    steps: [["甲", "乙"]], maxParallel: 2,
    dir: join(f.root, "pipeline-parallel"),
  };
  const batch = join(f.root, "parallel.json"); writeFileSync(batch, JSON.stringify(plan, null, 2));
  const started = loop(f.repo, ["启动", batch, "--launcher", "background", "--json"]);
  assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);
  assert.equal(jsonOf(started).ok, true);
  for (const [name, path] of [["甲", wtA], ["乙", wtB]] as const) {
    assert.equal(git(path, ["branch", "--show-current"]), `feat/${name}`);
    assert.match(git(path, ["log", "-1", "--format=%s%n%b"]), new RegExp(`feat: ${name}[\\s\\S]*段：${name}`));
  }
  const launched = ["甲", "乙"].map((name) => {
    const file = join(f.root, "pipeline-parallel", `${name}.events.log`);
    return Number(readFileSync(file, "utf8").split("\n").find((line) => line.includes("launched"))!.split(" ")[0]);
  });
  assert.ok(Math.abs(launched[0] - launched[1]) < 2_000, "两段在同一步里启动");
});

test("A8 流水线写 prompt 的段都经过 bin/pi-dev；ponytail:false 和段级模型覆盖照常", () => {
  const root = head();
  try {
    writeFileSync(join(root, "a.md"), "a"); writeFileSync(join(root, "b.md"), "b");
    const plan = parsePlan({ name: "提示词", stages: {
      甲: { prompt: "a.md", ponytail: false },
      乙: { prompt: "b.md", model: "override/model" },
    } }, root, {});
    const jia = plan.stages.get("甲")!.start, yi = plan.stages.get("乙")!.start;
    assert.match(jia, /bin\/pi-dev/);
    assert.match(jia, /--no-ponytail/);
    assert.doesNotMatch(jia, /--ponytail '/);
    assert.match(yi, /bin\/pi-dev/);
    assert.match(yi, /'--model' 'override\/model'/);
    assert.doesNotMatch(yi, /--no-ponytail/);
    const off = spawnSync(join(LOOP_ROOT, "bin", "pi-dev"), ["--no-ponytail", "--cwd", root, join(root, "a.md"), "--dry-run"], { encoding: "utf8", env: process.env });
    assert.equal(off.status, 0, off.stderr);
    assert.doesNotMatch(off.stdout, /ponytail\.js|PONYTAIL_DEFAULT_MODE/, "--no-ponytail 真的不加载");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("A5 启动入口检查权限自动执行：失败退出、修好后通过、指纹不变时跳过且不改配置", () => {
  const f = fixture();
  try {
    assert.equal(loop(f.repo, ["开工", f.batch]).status, 0);
    mkdirSync(join(f.root, "home", ".pi", "agent"), { recursive: true });
    writeFileSync(join(f.root, "home", ".pi", "agent", "trust.json"), JSON.stringify({ [realpathSync(f.worktree)]: true }));
    const configDir = join(f.worktree, ".pi", "extensions", "pi-permission-system");
    mkdirSync(configDir, { recursive: true });
    const config = join(configDir, "config.json");
    const denied = JSON.stringify({ yoloMode: false, permission: { bash: { "*": "ask" }, edit: "ask", write: "ask" } }, null, 2);
    writeFileSync(config, denied);
    const first = loop(f.repo, ["启动", f.batch, "--json"]);
    assert.notEqual(first.status, 0);
    const failure = jsonOf(first);
    assert.equal(failure.ok, false);
    assert.match(String(failure.stderr), /权限自动执行检查未通过/);
    assert.match(String(failure.stderr), /bash|edit|write/);
    assert.equal(readFileSync(config, "utf8"), denied, "检查不改用户配置");

    writeFileSync(config, JSON.stringify({ yoloMode: true }, null, 2));
    const second = loop(f.repo, ["启动", f.batch, "--json"]);
    assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
    assert.equal(jsonOf(second).ok, true);
    const record = readMethodsRecord(f.worktree, process.env);
    assert.ok(record?.permissionFingerprint, "通过后记下权限检查指纹");

    // 配置改回不能自动执行，但方法指纹没变：跳过检查，不重新拦截。
    writeFileSync(config, denied);
    const third = loop(f.repo, ["启动", f.batch, "--json"]);
    assert.equal(third.status, 0, `${third.stdout}\n${third.stderr}`);
    assert.equal(jsonOf(third).ok, true);
  } finally { /* 根目录由 after 统一清理 */ }
});

test("A5 流水线段启动入口失败时写回 startup-failed，编排程序不必等会话", () => {
  const f = fixture();
  try {
    assert.equal(loop(f.repo, ["开工", f.batch]).status, 0);
    mkdirSync(join(f.root, "home", ".pi", "agent"), { recursive: true });
    writeFileSync(join(f.root, "home", ".pi", "agent", "trust.json"), JSON.stringify({ [realpathSync(f.worktree)]: true }));
    const project = join(f.worktree, ".pi", "extensions", "pi-permission-system");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "config.json"), JSON.stringify({ yoloMode: false, permission: { bash: { "*": "ask" }, edit: "ask", write: "ask" } }, null, 2));
    const pipelineDir = join(f.root, "pipeline-status");
    const run = spawnSync(join(LOOP_ROOT, "bin", "pi-dev"), ["--cwd", f.worktree, "--no-ponytail", join(f.worktree, "prompt.md")], {
      encoding: "utf8", timeout: 30_000,
      env: { ...process.env, AUTOREVIEW_PIPELINE_DIR: pipelineDir, AUTOREVIEW_STAGE: "甲", AUTOREVIEW_PIPELINE_LAUNCH: "1", AUTOREVIEW_PIPELINE_LAUNCH_TOKEN: "1" },
    });
    assert.equal(run.status, 2);
    const status = JSON.parse(readFileSync(join(pipelineDir, "甲.status.json"), "utf8"));
    assert.equal(status.event, "startup-failed");
    assert.match(status.pauseReason, /权限自动执行检查未通过/);
  } finally { /* 根目录由 after 统一清理 */ }
});

test("A5 启动成功后子进程不再持有回报身份，不能覆盖父段状态", () => {
  const f = fixture();
  try {
    assert.equal(loop(f.repo, ["开工", f.batch]).status, 0);
    mkdirSync(join(f.root, "home", ".pi", "agent"), { recursive: true });
    writeFileSync(join(f.root, "home", ".pi", "agent", "trust.json"), JSON.stringify({ [realpathSync(f.worktree)]: true }));
    const project = join(f.worktree, ".pi", "extensions", "pi-permission-system");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "config.json"), JSON.stringify({ yoloMode: false, permission: { bash: { "*": "ask" }, edit: "ask", write: "ask" } }, null, 2));
    const pipelineDir = join(f.root, "parent-pipeline");
    mkdirSync(pipelineDir, { recursive: true });
    const statusFile = join(pipelineDir, "甲.status.json");
    const parent = JSON.stringify({ stage: "甲", sessionId: "parent", summary: "", event: "done", readyEpoch: "e", seq: 3, inbox: 0 });
    writeFileSync(statusFile, parent);
    // 模拟已启动父段里的子进程：仍有流水线目录和段名，但启动回报身份已在父 pi-dev 启动时撤掉。
    const child = spawnSync(join(LOOP_ROOT, "bin", "pi-dev"), ["--cwd", f.worktree, "--no-ponytail", join(f.worktree, "prompt.md")], {
      encoding: "utf8", timeout: 30_000,
      env: { ...process.env, AUTOREVIEW_PIPELINE_DIR: pipelineDir, AUTOREVIEW_STAGE: "甲", AUTOREVIEW_PIPELINE_LAUNCH: "1" },
    });
    assert.equal(child.status, 2);
    assert.equal(readFileSync(statusFile, "utf8"), parent, "子进程权限检查失败不能改写父段状态");
  } finally { /* 根目录由 after 统一清理 */ }
});

test("A5 自定义 start 直接启动 Pi：门禁里的权限失败不能回报父段启动失败", () => {
  const f = fixture();
  try {
    assert.equal(loop(f.repo, ["开工", f.batch]).status, 0);
    mkdirSync(join(f.root, "home", ".pi", "agent"), { recursive: true });
    writeFileSync(join(f.root, "home", ".pi", "agent", "trust.json"), JSON.stringify({ [realpathSync(f.worktree)]: true }));
    const project = join(f.worktree, ".pi", "extensions", "pi-permission-system");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "config.json"), JSON.stringify({ yoloMode: false, permission: { bash: { "*": "ask" }, edit: "ask", write: "ask" } }, null, 2));
    const nested = join(f.worktree, "nested-start.sh");
    writeFileSync(nested, `#!/bin/sh\n# 自定义 start 的 Pi 加载 autoreview 后，扩展会撤掉一次性启动身份\nunset AUTOREVIEW_PIPELINE_LAUNCH_TOKEN\nexec '${join(LOOP_ROOT, "bin", "pi-dev")}' --cwd '${f.worktree}' --no-ponytail '${join(f.worktree, "prompt.md")}'\n`);
    chmodSync(nested, 0o755);
    const pipelineDir = join(f.root, "custom-start-pipeline");
    mkdirSync(pipelineDir, { recursive: true });
    const statusFile = join(pipelineDir, "甲.status.json");
    const parent = JSON.stringify({ stage: "甲", sessionId: "parent", summary: "", event: "done", readyEpoch: "e", seq: 3, inbox: 0 });
    writeFileSync(statusFile, parent);
    const plan = parsePlan({ name: "自定义启动", stages: { 甲: { cwd: f.worktree, start: nested } }, steps: [["甲"]], dir: pipelineDir }, f.repo, {});
    const run = spawnSync("/bin/sh", ["-c", stageScript(plan, plan.stages.get("甲")!)], {
      cwd: f.worktree, encoding: "utf8", env: process.env, timeout: 30_000,
    });
    assert.equal(run.status, 2, `${run.stdout}\n${run.stderr}`);
    assert.equal(readFileSync(statusFile, "utf8"), parent, "自定义启动链路的子进程不能改写父段状态");
  } finally { /* 根目录由 after 统一清理 */ }
});

test("A5 包装脚本调用 pi-dev：启动失败仍回传编排并非零退出，不无限等待", () => {
  const f = fixture();
  try {
    assert.equal(loop(f.repo, ["开工", f.batch]).status, 0);
    mkdirSync(join(f.root, "home", ".pi", "agent"), { recursive: true });
    writeFileSync(join(f.root, "home", ".pi", "agent", "trust.json"), JSON.stringify({ [realpathSync(f.worktree)]: true }));
    const project = join(f.worktree, ".pi", "extensions", "pi-permission-system");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "config.json"), JSON.stringify({ yoloMode: false, permission: { bash: { "*": "ask" }, edit: "ask", write: "ask" } }, null, 2));
    const wrapper = join(f.worktree, "launch.sh");
    writeFileSync(wrapper, `#!/bin/sh\nexec '${join(LOOP_ROOT, "bin", "pi-dev")}' --cwd '${f.worktree}' --no-ponytail '${join(f.worktree, "prompt.md")}'\n`);
    chmodSync(wrapper, 0o755);
    writeFileSync(f.batch, JSON.stringify({ name: "包装启动失败", branch: "feat/测试",
      stages: { 甲: { start: wrapper }, 乙: { start: wrapper } }, steps: [["甲"], ["乙"]], maxParallel: 1 }, null, 2));
    const started = Date.now();
    const run = loop(f.repo, ["启动", f.batch, "--launcher", "background", "--json"]);
    assert.notEqual(run.status, 0);
    assert.ok(Date.now() - started < 15_000, "包装脚本启动失败没有让编排一直等待");
    const result = jsonOf(run);
    assert.equal(result.ok, false);
    assert.match(`${result.stdout}\n${result.stderr}`, /段 甲 启动失败|权限自动执行检查未通过/);
  } finally { /* 根目录由 after 统一清理 */ }
});

test("A6 .autoreview.json 或批次 scope 写错时报字段名和原因，不启动会话", () => {
  const f = fixture();
  const marker = join(f.repo, ".autoreview.json");
  const original = readFileSync(marker, "utf8");
  writeFileSync(marker, JSON.stringify({ methods: { paths: "methods" } }, null, 2));
  const badMethods = loop(f.repo, ["启动", f.batch, "--json"]);
  assert.notEqual(badMethods.status, 0);
  assert.match(String(jsonOf(badMethods).error), /methods\.paths/);
  assert.match(String(jsonOf(badMethods).error), /非空字符串数组/);
  writeFileSync(marker, original);

  const goodBatch = readFileSync(f.batch, "utf8");
  writeFileSync(f.batch, JSON.stringify({ name: "坏 scope", branch: "feat/坏", stages: { 甲: { prompt: "prompt.md", scope: { allow: "src/" } } }, steps: [["甲"]] }, null, 2));
  const badScope = loop(f.repo, ["启动", f.batch, "--json"]);
  assert.notEqual(badScope.status, 0);
  assert.match(String(jsonOf(badScope).error), /stages\.甲\.scope\.allow/);
  assert.match(String(jsonOf(badScope).error), /字符串数组/);
  writeFileSync(f.batch, goodBatch);
});

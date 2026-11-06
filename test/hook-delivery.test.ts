/** hook／delivery：按功能独立运行，夹具与状态不跨测试进程共享。 */
import "./test-env.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { conventionText } from "../core.ts";
import { projectRootOf } from "../ledger.ts";
import { registerAcceptanceMaterials } from "../materials.ts";
import { FAKE, ACC_ENV, fixture } from "./helpers/hook-fixture.ts";

test("PA A1-A4：Claude/Codex Hook 的事件、phase、通知关闭、恢复与 FailureKind", async (t) => {
  for (const host of ["claude", "codex"]) await t.test(host, () => {
    const h = fixture({ marker: JSON.stringify({ preparation: { check: "printf 'AUTOREVIEW_FAILURE=environment PA_ENV_BLOCK\\n'; exit 75", maxRecoveries: 0 } }) });
    try {
      const config = join(h.root, "pa.json"), file = join(h.root, "batch.json"), dir = join(h.home, ".pi-autoreview", "pipelines", "pa"), events = join(h.root, "events");
      writeFileSync(config, JSON.stringify({ pa: { eventsDir: events, localNotify: false } }));
      writeFileSync(file, JSON.stringify({ name: "pa", dir, stages: { 甲: { workflow: "without-acceptance", cwd: h.repo, start: "fake" } } }));
      const env = { AUTOREVIEW_HOST: host, LOOP_PA_CONFIG: config, AUTOREVIEW_BATCH_FILE: file, AUTOREVIEW_PIPELINE_DIR: dir, AUTOREVIEW_STAGE: "甲" };
      const rows = () => readdirSync(events).filter((name) => name.endsWith(".jsonl")).flatMap((name) => readFileSync(join(events, name), "utf8").trim().split("\n").map((line) => JSON.parse(line)));
      h.run(h.event("SessionStart"), { env }); assert.equal(rows()[0].status, "started"); assert.equal(rows()[0].seq, 1);
      h.run(h.event("UserPromptSubmit", { prompt: "需求" }), { env });
      const question = "A. 保留\nB. 改动\n【需要你决定】", stopped = h.run(h.event("Stop", { last_assistant_message: question }), { env });
      const decision = rows().at(-1); assert.equal(decision.status, "needs-decision"); assert.equal(decision.detail.question, question); assert.equal(decision.detail.next, "send");
      assert.ok(stopped.stderr.includes(question)); assert.equal(h.notifications(), "");
      h.run(h.event("SessionStart"), { env }); assert.equal(rows().filter((event) => event.status === "needs-decision").length, 1, "重启不补旧暂停");
      h.run(h.event("UserPromptSubmit", { prompt: "选 A" }), { env }); assert.equal(rows().at(-1).status, "resumed"); assert.equal(rows().at(-1).detail.via, "user");
      h.write("file.txt", "changed\n"); h.run(h.delivered(), { env });
      const paused = rows().at(-1); assert.equal(paused.status, "paused"); assert.equal(paused.reason.category, "环境"); assert.equal(paused.detail.failureKind, "environment"); assert.ok(existsSync(paused.evidence.blocker));
      const query = spawnSync(process.execPath, [fileURLToPath(new URL("../loop.ts", import.meta.url)), "查询", file, "--json"], { cwd: h.root, env: { ...process.env, HOME: h.home, ...env }, encoding: "utf8" });
      assert.equal(query.status, 0, query.stderr + query.stdout); const stage = JSON.parse(query.stdout).batches[0].stages[0];
      assert.equal(stage.pause.category, paused.reason.category); assert.equal(stage.pause.text, paused.reason.text);
      assert.equal(JSON.parse(readFileSync(join(dir, "甲.phase.json"), "utf8")).phase, "paused");
    } finally { h.close(); }
    const h2 = fixture({ marker: JSON.stringify({ maxRepairs: 0 }) });
    try {
      const file = join(h2.root, "batch.json"), dir = join(h2.root, "pipeline"), config = join(h2.root, "pa.json"), events = join(h2.root, "events");
      writeFileSync(file, JSON.stringify({ name: "pa-limit", dir, stages: { 甲: { cwd: h2.repo, start: "fake" } } })); writeFileSync(config, JSON.stringify({ pa: { eventsDir: events, localNotify: false } }));
      const env = { AUTOREVIEW_HOST: host, LOOP_PA_CONFIG: config, AUTOREVIEW_BATCH_FILE: file, AUTOREVIEW_PIPELINE_DIR: dir, AUTOREVIEW_STAGE: "甲" };
      h2.run(h2.event("UserPromptSubmit", { prompt: "需求" }), { env }); h2.write("file.txt", "change\n"); h2.run(h2.delivered(), { env, mode: "always-fix" });
      const rows = readdirSync(events).flatMap((name) => readFileSync(join(events, name), "utf8").trim().split("\n").map((line) => JSON.parse(line))), last = rows.at(-1);
      assert.equal(last.status, "repair-limit"); assert.equal(last.detail.mustFix, h2.readState(host).unresolvedMustFix); assert.ok(last.detail.mustFix.length > 0);
    } finally { h2.close(); }
  });
});

test("A1/A2 Hook 只在真正完成时瘦身登记验收轮次和准备 TMPDIR，总结保留小证据", async (t) => {
  for (const paused of [false, true]) await t.test(paused ? "暂停保留" : "完成瘦身", () => {
    const script = `const fs=require('node:fs'),p=process.env.TMPDIR;fs.writeFileSync(p+'/large.db',Buffer.alloc(300000));fs.writeFileSync(p+'/reuse.sh','echo reuse');fs.writeFileSync(p+'/system.log','keep');`;
    const h = fixture({ marker: JSON.stringify({ preparation: { check: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}` } }) });
    try {
      h.run(h.event("SessionStart")); h.run(h.event("UserPromptSubmit", { prompt: "需求" }));
      const run = join(h.home, ".pi-autoreview", "repo", "acceptance", "claude-s1", "r0");
      mkdirSync(join(run, "node_modules"), { recursive: true });
      registerAcceptanceMaterials("claude-s1", h.repo, run, join(h.home, ".pi-autoreview", "repo", "claude-s1.procs.json"));
      writeFileSync(join(run, "data.db"), Buffer.alloc(300_000)); writeFileSync(join(run, "node_modules", "tiny.js"), "tiny");
      for (const name of ["result.json", "input.md", "screenshot.jpg", "system.log", "reuse.sh"]) writeFileSync(join(run, name), "keep");
      h.write("file.txt", "changed\n");
      const output = h.run(paused ? h.event("Stop", { last_assistant_message: "【需要你决定】" }) : h.delivered());
      assert.equal(output.code, 0, output.stderr);
      assert.equal(h.readState().phase, paused ? "paused" : "done");
      assert.equal(existsSync(join(run, "data.db")), paused); assert.equal(existsSync(join(run, "node_modules")), paused);
      for (const name of ["result.json", "input.md", "screenshot.jpg", "system.log", "reuse.sh"]) assert.ok(existsSync(join(run, name)), name);
      if (paused) assert.ok(!h.summary().includes("运行材料瘦身"));
      else {
        assert.match(h.summary(), /运行材料瘦身：删除 3 个文件，释放约 .*；保留/);
        const root = join(h.home, ".pi-autoreview", "resources");
        const record = readdirSync(root).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(readFileSync(join(root, name), "utf8"))).find((item) => item.label === `preparation:${h.repo}`);
        assert.ok(record); assert.equal(existsSync(join(record.evidenceDir, "large.db")), false);
        assert.ok(existsSync(join(record.evidenceDir, "reuse.sh"))); assert.ok(existsSync(join(record.evidenceDir, "system.log")));
      }
    } finally { h.close(); }
  });
});

test("运行材料删除失败只在完成总结提示，不把 Hook 完成态改成暂停", () => {
  const h = fixture();
  const run = join(h.home, ".pi-autoreview", "repo", "acceptance", "claude-s1", "r0");
  try {
    h.run(h.event("SessionStart")); h.run(h.event("UserPromptSubmit", { prompt: "需求" }));
    mkdirSync(run, { recursive: true });
    registerAcceptanceMaterials("claude-s1", h.repo, run, join(h.home, ".pi-autoreview", "repo", "claude-s1.procs.json"));
    writeFileSync(join(run, "large.db"), Buffer.alloc(300_000)); chmodSync(run, 0o500);
    h.write("file.txt", "changed\n"); const res = h.run(h.delivered());
    assert.equal(res.code, 0, res.stderr); assert.equal(h.readState().phase, "done");
    assert.ok(existsSync(join(run, "large.db"))); assert.match(h.summary(), /删除失败，仅提示：.*large\.db/);
  } finally { if (existsSync(run)) chmodSync(run, 0o700); h.close(); }
});

test("Hook通知／Hook 内部评审错误和提问原文同时保留，恢复后现场不被覆盖", async (t) => {
  for (const host of ["claude", "codex"]) await t.test(host, () => {
    const h = fixture({ marker: JSON.stringify({ gate: { cmd: "true", timeoutMin: 1 } }) });
    try {
      const original = `HOOK_ERROR_BEGIN ${"完整原文".repeat(120)} HOOK_ERROR_END`, question = "应返回空列表还是 404？\n请确认。";
      const reviewer = join(h.root, "broken-reviewer.mjs");
      writeFileSync(reviewer, `#!${process.execPath}\nprocess.stderr.write(${JSON.stringify(original)}); process.exitCode=1;\n`); chmodSync(reviewer, 0o755);
      const file = join(h.root, "batch.json"), dir = join(h.root, "pipeline"), config = join(h.root, "pa.json"), events = join(h.root, "events");
      writeFileSync(file, JSON.stringify({ name: "错误通知", dir, stages: { 甲: { workflow: "without-acceptance", cwd: h.repo, start: "fake" } } }));
      writeFileSync(config, JSON.stringify({ pa: { eventsDir: events, localNotify: true } }));
      const env = { AUTOREVIEW_HOST: host, LOOP_PA_CONFIG: config, AUTOREVIEW_BATCH_FILE: file, AUTOREVIEW_PIPELINE_DIR: dir, AUTOREVIEW_STAGE: "甲", AUTOREVIEW_REVIEWER_CMD: reviewer };
      h.run(h.event("UserPromptSubmit", { prompt: "需求" }), { env }); h.write("file.txt", "changed\n");
      const failed = h.run(h.event("Stop", { last_assistant_message: question }), { env });
      assert.equal(h.readState(host).phase, "paused");
      if (host === "claude") { const message = JSON.parse(failed.stdout).systemMessage; assert.ok(message.includes(original)); assert.ok(message.includes(question)); }
      assert.ok(h.notifications().includes(original)); assert.ok(h.notifications().includes("应返回空列表还是 404？"));
      const rows = readdirSync(events).flatMap((name) => readFileSync(join(events, name), "utf8").trim().split("\n").map((line) => JSON.parse(line)));
      const paused = rows.at(-1); assert.equal(paused.reason.category, "内部错误"); assert.ok(paused.detail.error.includes(original)); assert.equal(paused.detail.question, question);
      const path = paused.evidence.blocker, bytes = readFileSync(path, "utf8");
      const restored = { ...env, AUTOREVIEW_REVIEWER_CMD: FAKE };
      h.run(h.event("UserPromptSubmit", { prompt: "继续" }), { env: restored }); h.run(h.delivered(), { env: restored });
      assert.equal(h.readState(host).phase, "done"); assert.equal(readFileSync(path, "utf8"), bytes); assert.ok(h.summary(host).includes(path));
    } finally { h.close(); }
  });
});

test("H14 Hook 的总结也记录开发方在基线之后新增的提交", () => {
  const h = fixture();
  try {
    h.run(h.event("SessionStart"));
    h.run(h.event("UserPromptSubmit", { prompt: "做点事" }));
    h.write("file.txt", "base\nCOMMITTED\n"); h.git("commit", "-qam", "开发方自己提交了");
    h.run(h.delivered());
    assert.equal(h.readState().phase, "done");
    assert.match(h.summary(), /^- 开发方新增提交：1 个（基线之后，只记录不评判）$/m);
  } finally { h.close(); }
});

test("H18 交付总表：Hook 完成只追加结果与欠项，SessionStart 不再注入回写提醒", async (t) => {
  const marker = JSON.stringify({ acceptance: {} });
  const requirement = "自动评审总表\n## 验收标准\n不授权：A1\n1. [授权] 操作：todo add 买菜\n   预期：已添加\n2. 操作：todo list\n   预期：有买菜\n3. [人工] 操作：看新首页\n   预期：布局和文案是你想要的";
  await t.test("A4 完成写入总表，总结开头带路径，无回写勾，人工项保留勾选", () => {
    const h = fixture({ marker });
    try {
      h.run(h.event("SessionStart"), { env: ACC_ENV });
      assert.ok(!existsSync(h.ledger), "会话开始还没写总表");
      // A2：完成时写入。
      h.run(h.event("UserPromptSubmit", { prompt: requirement }), { env: ACC_ENV });
      h.write("file.txt", "base\nTODO\n");
      const done = JSON.parse(h.run(h.delivered(), { env: ACC_ENV }).stdout);
      assert.equal(h.readState().phase, "done", `pauseReason=${h.readState().pauseReason}`);
      const text = readFileSync(h.ledger, "utf8");
      assert.match(text, new RegExp(`^## .+ · ${projectRootOf(h.repo)} · 会话 claude-s1$`, "m"));
      assert.match(text, /^- 任务：自动评审总表$/m);
      assert.match(text, /^- 结果：完成（部分验证）；评审 1 次，返修 0 次$/m);
      assert.match(text, /^- 总结：.*\/claude-s1\.md$/m);
      assert.doesNotMatch(text, /已回写原单/);
      assert.match(text, /^- \[ \] A1 人工$/m);
      assert.match(text, /^- \[ \] A3 人工$/m);
      const summary = h.summary();
      assert.match(summary, /^# 自动评审总结\n- 已登记到交付总表：.*（A1 人工、A3 人工）$/m);
      assert.doesNotMatch(summary, /待回写原单/);
      assert.ok(done.systemMessage.includes("A1 你没授权"), "不授权的条目照常提示人工验收");

      const first = JSON.parse(h.run(h.event("SessionStart"), { env: ACC_ENV }).stdout);
      assert.equal(first.hookSpecificOutput.additionalContext, conventionText({ acceptance: true }));
      assert.equal(first.systemMessage, undefined);
      assert.equal(readFileSync(h.ledger, "utf8"), text, "开会话不改变总表");
      const passive = h.run(h.event("SessionStart", {}, "s2"), { env: ACC_ENV, devRoot: null });
      assert.equal(passive.stdout, "");
    } finally { h.close(); }
  });

  await t.test("A3 总表不可写：只提示，会话照常完成，不暂停", () => {
    const h = fixture({ marker });
    try {
      // 总表位置被一个目录占着：写入必然失败。
      const blocked = join(h.home, ".pi-autoreview", "交付记录.md");
      mkdirSync(blocked, { recursive: true });
      h.run(h.event("SessionStart"), { env: ACC_ENV });
      h.run(h.event("UserPromptSubmit", { prompt: requirement }), { env: ACC_ENV });
      h.write("file.txt", "base\nTODO\n");
      const res = h.run(h.delivered(), { env: ACC_ENV });
      assert.equal(h.readState().phase, "done", "写入失败不能暂停");
      assert.match(h.notifications(), /交付总表写入失败：.*会话照常完成/);
      assert.match(res.stderr, /交付总表写入失败/);
      assert.equal(h.readState().ledger.path, blocked, "总结仍写明该往哪查");
      assert.match(h.summary(), /^- 交付总表写入失败：.*交付记录\.md（会话照常完成）$/m);
    } finally { h.close(); }
  });

  await t.test("总表不是文件时 SessionStart 仍只注入当前约定，不报错、不拦截", () => {
    const h = fixture({ marker });
    try {
      const blocked = join(h.home, ".pi-autoreview", "交付记录.md");
      mkdirSync(blocked, { recursive: true });
      const res = h.run(h.event("SessionStart"), { env: ACC_ENV });
      assert.equal(res.code, 0);
      assert.equal(JSON.parse(res.stdout).hookSpecificOutput.hookEventName, "SessionStart");
      // 总表被目录占着（读取失败）→ 跳过；格式异常也不报错。
      const weirdFile = join(h.root, "weird.md");
      writeFileSync(weirdFile, "\0\u0001 乱码 ## \n");
      const weird = h.run(h.event("SessionStart"), { env: ACC_ENV });
      assert.equal(weird.code, 0);
      assert.doesNotMatch(JSON.parse(weird.stdout).hookSpecificOutput.additionalContext, /待回写原单/);
    } finally { h.close(); }
  });
});

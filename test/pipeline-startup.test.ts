/** 流水线／启动确认与失败收束：静默、显式失败和已有会话分别保留真实入口。 */
import "./test-env.ts";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { batchInfo, writePhase } from "../events.ts";
import { parsePlan, runPipeline } from "../pipeline.ts";
import { CRITERIA, tempDir, gitRepo, scene, io } from "./helpers/pipeline-fixture.ts";

test("流水线／段暂停后继续：只提醒一次，完成后照常接力", async () => {
  const s = scene({ stages: { 甲: { mode: "pause" }, 乙: {} } });
  try {
    assert.equal(await runPipeline(s.plan, io(s)), 0, s.notes.join("\n"));
    assert.equal(s.notes.filter((note) => /甲 暂停（开发方需要你决定），在它的窗口里处理/.test(note)).length, 1);
  } finally { s.close(); }
});

test("启动确认／超时与并行收束：静默段报失败，已有状态或会话原样保留", async (t) => {
  const cases = ["未执行命令", "真实静默进程", "silent", "started", "paused", "done", "phase-only", "phase-first"];
  for (const kind of cases) await t.test(kind, async () => {
    const single = kind === "未执行命令" || kind === "真实静默进程";
    const s = scene({ stages: single ? { 甲: { mode: "silent" } } : { 甲: {}, 乙: {} }, ...(single ? { criteria: CRITERIA.replace("[乙]", "[甲]") } : {}) });
    const oldHome = process.env.HOME, oldPA = process.env.LOOP_PA_CONFIG;
    process.env.HOME = s.root; process.env.LOOP_PA_CONFIG = join(s.root, "pa.json");
    try {
      const file = join(s.root, "batch.json"), launched: string[] = [];
      writeFileSync(file, JSON.stringify({ name: s.plan.name, dir: s.plan.dir, startupTimeoutSec: 1,
        stages: Object.fromEntries([...s.plan.stages].map(([name, stage]) => [name, { start: stage.start, cwd: stage.cwd }])) }));
      s.plan.file = file;
      writeFileSync(process.env.LOOP_PA_CONFIG, JSON.stringify({ pa: { eventsDir: join(s.root, "events"), localNotify: false } }));
      let originalStatus: string | undefined, originalPhase: string | undefined;
      const realIO = io(s, 200), started = Date.now();
      const code = await runPipeline(s.plan, { ...realIO, silenceMs: 100, launch: (stage, script) => {
        launched.push(stage.name);
        if (kind === "真实静默进程") return realIO.launch(stage, script);
        if (kind === "phase-first" && stage.name === "甲") {
          writeFileSync(join(s.plan.dir, "甲.phase.json"), JSON.stringify({ phase: "running", session: { host: "pi", id: "real-session" } }));
          originalPhase = readFileSync(join(s.plan.dir, "甲.phase.json"), "utf8"); return;
        }
        if (stage.name !== "乙" || ["silent", "phase-first"].includes(kind)) return;
        writePhase(batchInfo(file, stage.cwd, s.plan.dir), "乙", kind === "paused" ? "paused" : kind === "done" ? "done" : "running",
          { session: { host: "pi", id: "already-started" }, text: "真实会话状态" });
        originalPhase = readFileSync(join(s.plan.dir, "乙.phase.json"), "utf8");
        if (kind !== "phase-only") {
          writeFileSync(join(s.plan.dir, "乙.status.json"), JSON.stringify({ stage: "乙", sessionId: "already-started", event: kind,
            readyEpoch: kind === "done" ? "ready" : undefined, seq: 1, inbox: 0, summary: "", pauseReason: kind === "paused" ? "等用户答复" : undefined }));
          originalStatus = readFileSync(join(s.plan.dir, "乙.status.json"), "utf8");
        }
      } });
      assert.equal(code, 1); assert.ok(Date.now() - started < 5000, "启动失败收尾有界");
      assert.deepEqual(launched, single ? ["甲"] : ["甲", "乙"]);
      const rows = readdirSync(join(s.root, "events")).flatMap((name) => readFileSync(join(s.root, "events", name), "utf8").trim().split("\n").map((line) => JSON.parse(line)));
      const failed = kind === "phase-first" ? ["乙"] : kind === "silent" ? ["甲", "乙"] : ["甲"];
      for (const name of failed) {
        assert.equal(JSON.parse(readFileSync(join(s.plan.dir, `${name}.status.json`), "utf8")).event, "startup-failed");
        assert.equal(JSON.parse(readFileSync(join(s.plan.dir, `${name}.phase.json`), "utf8")).phase, "failed");
        const event = rows.find((row) => row.stage === name && row.status === "failed");
        assert.ok(event); assert.match(event.reason.text, new RegExp(`${name} 没有启动`)); assert.match(event.detail.action, /处理办法/);
        assert.ok(s.notes.some((note) => note.includes(`${name} 没有启动`) && note.includes("处理办法")));
      }
      const preserved = kind === "phase-first" ? "甲" : originalPhase ? "乙" : undefined;
      if (preserved) {
        assert.equal(readFileSync(join(s.plan.dir, `${preserved}.phase.json`), "utf8"), originalPhase);
        assert.equal(existsSync(join(s.plan.dir, `${preserved}.status.json`)), originalStatus !== undefined);
        if (originalStatus) assert.equal(readFileSync(join(s.plan.dir, `${preserved}.status.json`), "utf8"), originalStatus);
        assert.equal(rows.some((row) => row.stage === preserved && row.status === "failed"), false);
        assert.equal(s.notes.some((note) => note.includes(`${preserved} 没有启动`)), false);
      }
      assert.equal(s.notes.some((note) => note.includes("第 0 条返修")), false);
      if (kind === "未执行命令" || kind === "silent") {
        const status = spawnSync(fileURLToPath(new URL("../bin/loop", import.meta.url)), ["状态", file, "--dry-run", "--json"],
          { cwd: s.plan.stages.get("甲")!.cwd, env: process.env, encoding: "utf8" });
        assert.equal(status.status, 0, status.stdout + status.stderr);
        const entries = JSON.parse(status.stdout).stages; assert.equal(entries.length, single ? 1 : 2);
        for (const entry of entries) { assert.equal(entry.event, "startup-failed"); assert.notEqual(entry.phase, "运行中"); assert.match(entry.pauseReason, /没有启动/); }
      }
    } finally {
      if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
      if (oldPA === undefined) delete process.env.LOOP_PA_CONFIG; else process.env.LOOP_PA_CONFIG = oldPA;
      s.close();
    }
  });
});

test("流水线／显式启动失败：写回startup-failed后立即非零退出", async () => {
  const root = gitRepo(tempDir());
  try {
    const start = `${process.execPath} -e 'const fs=require("node:fs"),p=require("node:path");const d=process.env.AUTOREVIEW_PIPELINE_DIR,s=process.env.AUTOREVIEW_STAGE;fs.mkdirSync(d,{recursive:true});fs.writeFileSync(p.join(d,s+".status.json"),JSON.stringify({stage:s,sessionId:"startup",summary:"",event:"startup-failed",seq:1,inbox:0,pauseReason:"权限自动执行检查未通过：bash 会询问"}));'`;
    const plan = parsePlan({ name: "启动失败", stages: { 甲: { start } }, steps: [["甲"]], dir: join(root, "pipeline") }, root, {});
    const notes: string[] = [], started = Date.now();
    const code = await runPipeline(plan, { launch: (_stage, script) => { spawnSync("/bin/sh", ["-c", `(${script}) >/dev/null 2>&1 &`]); },
      notify: (message) => notes.push(message), log: () => {}, pollMs: 20, silenceMs: 1000, preflightEnv: { playwright: () => true } });
    assert.equal(code, 1); assert.ok(Date.now() - started < 5000);
    assert.match(notes.at(-1)!, /段 甲 启动失败：权限自动执行检查未通过：bash 会询问/);
    assert.equal(readFileSync(join(plan.dir, "pipeline.finished"), "utf8").trim(), "1");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("流水线／并行段显式启动失败：收束等待但不覆盖已暂停会话", async () => {
  const root = tempDir(), out = mkdtempSync(join(tmpdir(), "autoreview-pipeline-cancel-")), launched: Promise<void>[] = [];
  try {
    const a = gitRepo(join(root, "a")), b = gitRepo(join(root, "b"));
    const status = (event: string, reason = "") => `${process.execPath} -e 'const fs=require("node:fs"),p=require("node:path");const d=process.env.AUTOREVIEW_PIPELINE_DIR,s=process.env.AUTOREVIEW_STAGE;fs.mkdirSync(d,{recursive:true});fs.writeFileSync(p.join(d,s+".status.json"),JSON.stringify({stage:s,sessionId:"s",summary:"",event:${JSON.stringify(event)},seq:1,inbox:0,pauseReason:${JSON.stringify(reason)}}));'`;
    const plan = parsePlan({ name: "并行启动失败", maxParallel: 2, stages: {
      甲: { cwd: a, start: status("startup-failed", "权限自动执行检查未通过：bash 会询问") }, 乙: { cwd: b, start: status("paused", "等用户决定") },
    }, steps: [["甲", "乙"]], dir: join(out, "pipeline") }, root, {});
    const notes: string[] = [], started = Date.now();
    const code = await runPipeline(plan, { launch: (_stage, script) => {
      const child = spawn("/bin/sh", ["-c", script], { stdio: "ignore" });
      launched.push(new Promise<void>((accept) => { child.once("exit", () => accept()); child.once("error", () => accept()); }));
    }, notify: (message) => notes.push(message), log: () => {}, pollMs: 30, silenceMs: 1000, preflightEnv: { playwright: () => true } });
    assert.equal(code, 1); assert.ok(Date.now() - started < 5000); assert.match(notes.at(-1)!, /段 甲 启动失败/);
    await Promise.all(launched);
    assert.equal(JSON.parse(readFileSync(join(plan.dir, "乙.status.json"), "utf8")).event, "paused");
  } finally { await Promise.all(launched); rmSync(root, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true }); }
});

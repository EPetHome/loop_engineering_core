/** 流水线：计划解析、归属、派发分批（纯函数）；接力、e2e、回流（假段进程 + 假验收方）。产物只写 os.tmpdir()。 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  buildRepairMessage, dispatchBatches, parseOwner, parsePlan, PlanError, routeFailures, runPipeline, stageScript,
  type PipelineIO, type Plan,
} from "../pipeline.ts";

const FAKE_STAGE = fileURLToPath(new URL("./fake-stage.mjs", import.meta.url));
const TESTER = fileURLToPath(new URL("./fake-tester.mjs", import.meta.url));
const CRITERIA = "需求：甲做接口，乙做页面\n\n## 验收标准\nA1. [甲] 操作：调接口\n    预期：返回 ok\nA2. [乙] 操作：打开页面\n    预期：显示 ok\n";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "autoreview-pipeline-"));
}

test("P1 计划解析：相对路径、默认步骤与目录、标签去掉后交给验收方", () => {
  const root = tempDir();
  try {
    writeFileSync(join(root, "e2e.md"), CRITERIA);
    mkdirSync(join(root, "front"));
    const plan = parsePlan({
      name: "V2 首批",
      stages: { 甲: { start: "bash a.sh" }, 乙: { start: "bash b.sh", cwd: "front" } },
      e2e: { workDir: ".", criteria: "e2e.md", acceptance: { reset: "sh reset.sh" } },
    }, root, {});
    assert.deepEqual(plan.steps, [["甲", "乙"]], "不写 steps 就是全部并行");
    assert.equal(plan.stages.get("甲")!.cwd, root);
    assert.equal(plan.stages.get("乙")!.cwd, join(root, "front"));
    assert.match(plan.dir, /\.pi-autoreview\/pipelines\/V2_首批$/);
    assert.deepEqual(plan.e2e!.items.map((item) => [item.id, item.text.split("\n")[0]]), [["A1", "操作：调接口"], ["A2", "操作：打开页面"]]);
    assert.deepEqual([...plan.e2e!.owners], [["A1", "甲"], ["A2", "乙"]]);
    assert.equal(plan.e2e!.maxRounds, 3);
    assert.equal(plan.e2e!.acceptance.reset, "sh reset.sh");
    const serial = parsePlan({ name: "s", stages: { 甲: { start: "a" }, 乙: { start: "b" } }, steps: ["甲", ["乙"]] }, root, {});
    assert.deepEqual(serial.steps, [["甲"], ["乙"]], "字符串和数组都能写一步");
    assert.match(stageScript(serial, serial.stages.get("乙")!), /^cd '.*' && export AUTOREVIEW_PIPELINE_DIR='.*' AUTOREVIEW_STAGE='乙' && b$/);
    assert.deepEqual(parseOwner("[乙] 操作：打开"), { owner: "乙", text: "操作：打开" });
    assert.deepEqual(parseOwner("操作：打开"), { text: "操作：打开" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("P2 计划校验：错的段名、漏排、重复、标签写错、标准缺失都直接报错", () => {
  const root = tempDir();
  try {
    writeFileSync(join(root, "e2e.md"), CRITERIA);
    writeFileSync(join(root, "bad.md"), "## 验收标准\nA1. [丙] 操作：x\n");
    writeFileSync(join(root, "none.md"), "没有标准");
    const stages = { 甲: { start: "a" }, 乙: { start: "b" } };
    const cases: [unknown, RegExp][] = [
      [{ stages }, /name/],
      [{ name: "x", stages: {} }, /至少要有一段/],
      [{ name: "x", stages, steps: [["甲", "丙"]] }, /「丙」在 stages 里没有/],
      [{ name: "x", stages, steps: [["甲"]] }, /段「乙」没有排进 steps/],
      [{ name: "x", stages, steps: [["甲"], ["甲", "乙"]] }, /不止一次/],
      [{ name: "x", stages, e2e: { workDir: ".", criteria: "bad.md" } }, /A1 标的段「丙」在 stages 里没有/],
      [{ name: "x", stages, e2e: { workDir: ".", criteria: "none.md" } }, /没有「## 验收标准」条目/],
      [{ name: "x", stages, e2e: { workDir: ".", criteria: "e2e.md", maxRounds: 0 } }, /maxRounds/],
      [{ name: "x", stages, e2e: { workDir: ".", criteria: "e2e.md", acceptance: { readyUrl: "ftp://x" } } }, /e2e\.acceptance：.*readyUrl/],
    ];
    for (const [raw, pattern] of cases) assert.throws(() => parsePlan(raw, root, {}), (error: unknown) => error instanceof PlanError && pattern.test((error as Error).message));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("P3 归属与派发：按标签分组，G1/G2 和没标的单列；同仓库逐段、不同仓库同时；返修消息", () => {
  const items = [
    { id: "A1", text: "调接口", verdict: "不通过" as const, detail: "实际：500" },
    { id: "A2", text: "打开页面", verdict: "通过" as const, detail: "" },
    { id: "A3", text: "导出", verdict: "不通过" as const, detail: "实际：空" },
    { id: "G2", text: "日志", verdict: "不通过" as const, detail: "ERROR" },
  ];
  const owners = new Map<string, string | undefined>([["A1", "甲"], ["A2", "乙"], ["A3", undefined]]);
  const { byStage, unrouted } = routeFailures({ items }, owners);
  assert.deepEqual([...byStage].map(([stage, list]) => [stage, list.map((item) => item.id)]), [["甲", ["A1"]]]);
  assert.deepEqual(unrouted.map((item) => item.id), ["A3", "G2"]);
  const repo: Record<string, string> = { 甲: "/r1", 乙: "/r1", 丙: "/r2", 丁: "/r1" };
  assert.deepEqual(dispatchBatches(["甲", "乙", "丙", "丁"], (stage) => repo[stage]), [["甲", "丙"], ["乙"], ["丁"]]);
  const { message, mustFix } = buildRepairMessage("甲", 2, [items[0]], "/run/r2");
  assert.match(message, /^【流水线 e2e 返修 · 第 2 轮】\n.*归你（甲）负责/);
  assert.match(message, /A1\. 调接口\n {4}实际：500/);
  assert.match(message, /完整材料（系统日志、证据）：\/run\/r2/);
  assert.match(message, /「A3：不归我：理由」/);
  assert.equal(mustFix, "A1. 调接口\n    实际：500");
  assert.doesNotMatch(message, /^## 验收标准/m, "返修消息不能被扩展当成新的验收标准");
});

// —— 整条流水线：真实的假段进程 + 假验收方 ——

interface Scene { root: string; plan: Plan; notes: string[]; events: (stage: string) => [number, string][]; close: () => void }

function scene(options: {
  stages: Record<string, { mode?: string; cwd?: string }>;
  steps?: unknown[];
  criteria?: string;
  env?: Record<string, string>;
  maxRounds?: number;
}): Scene {
  const root = tempDir();
  writeFileSync(join(root, "e2e.md"), options.criteria ?? CRITERIA);
  const saved: Record<string, string | undefined> = {};
  const vars = { AUTOREVIEW_ACCEPTANCE_CMD: TESTER, FAKE_STATE_DIR: join(root, "fake"), FAKE_STAGE_DELAY_MS: "80", ...options.env };
  for (const [key, value] of Object.entries(vars)) { saved[key] = process.env[key]; process.env[key] = value; }
  const stages = Object.fromEntries(Object.entries(options.stages).map(([name, value]) => {
    const cwd = value.cwd ?? join(root, `work-${name}`);
    mkdirSync(cwd, { recursive: true });
    return [name, { start: `"${process.execPath}" "${FAKE_STAGE}" ${value.mode ?? "fix"}`, cwd }];
  }));
  const plan = parsePlan({
    name: "test", dir: join(root, "pipeline"), stages, steps: options.steps,
    e2e: { workDir: root, criteria: "e2e.md", maxRounds: options.maxRounds },
  }, root, process.env);
  return {
    root, plan, notes: [],
    events: (stage) => {
      const file = join(plan.dir, `${stage}.events.log`);
      return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map((line) => {
        const [at, ...what] = line.split(" ");
        return [Number(at), what.join(" ")] as [number, string];
      }) : [];
    },
    close: () => {
      for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function io(s: Scene, silenceMs = 30_000): PipelineIO {
  return {
    launch: (_stage, script) => { spawnSync("/bin/sh", ["-c", `(${script}) >/dev/null 2>&1 &`]); },
    notify: (message) => s.notes.push(message),
    log: () => {},
    pollMs: 20,
    silenceMs,
  };
}

const at = (events: [number, string][], what: string): number => events.find(([, name]) => name === what)?.[0] ?? Number.NaN;
const accCalls = (s: Scene): number => existsSync(join(s.root, "fake", "acc-calls.log"))
  ? readFileSync(join(s.root, "fake", "acc-calls.log"), "utf8").trim().split("\n").length : 0;

test("P4 并行：甲乙都完成后才跑 e2e，全过就完成", async () => {
  const s = scene({ stages: { 甲: {}, 乙: {} } });
  try {
    const code = await runPipeline(s.plan, io(s));
    assert.equal(code, 0, s.notes.join("\n"));
    assert.ok(Number.isFinite(at(s.events("甲"), "launched")) && Number.isFinite(at(s.events("乙"), "launched")));
    assert.equal(accCalls(s), 1);
    const report = readFileSync(join(s.plan.dir, "report.md"), "utf8");
    assert.match(report, /第 1 步完成：甲、乙/);
    assert.match(report, /e2e 第 1 轮：通过/);
    assert.match(s.notes.at(-1)!, /e2e 全部通过，流水线完成/);
    assert.ok(existsSync(join(s.plan.dir, "pipeline.finished")));
  } finally { s.close(); }
});

test("P5 串行：乙等甲完成才启动", async () => {
  const s = scene({ stages: { 甲: {}, 乙: {} }, steps: [["甲"], ["乙"]] });
  try {
    assert.equal(await runPipeline(s.plan, io(s)), 0, s.notes.join("\n"));
    assert.ok(at(s.events("乙"), "launched") >= at(s.events("甲"), "done"), "乙在甲完成之后才启动");
  } finally { s.close(); }
});

test("P6 回流：A2 没过退回乙，乙修完自动重跑 e2e 通过；甲不受打扰", async () => {
  const s = scene({ stages: { 甲: {}, 乙: {} }, env: { FAKE_ACC_FAIL_ONCE: "A2" } });
  try {
    assert.equal(await runPipeline(s.plan, io(s)), 0, s.notes.join("\n"));
    assert.equal(accCalls(s), 2, "e2e 跑了两轮");
    assert.ok(existsSync(join(s.plan.dir, "乙.inbox-1.txt")));
    assert.ok(!existsSync(join(s.plan.dir, "甲.inbox-1.txt")), "甲没被退回");
    const message = readFileSync(join(s.plan.dir, "乙.inbox-1.txt"), "utf8");
    assert.match(message, /^【流水线 e2e 返修 · 第 1 轮】/);
    assert.match(message, /A2\. 操作：打开页面/);
    assert.match(readFileSync(join(s.plan.dir, "report.md"), "utf8"), /退回 乙：A2[\s\S]*e2e 第 2 轮：通过/);
  } finally { s.close(); }
});

test("P7 回流到停：认为不归自己、没标归属、超过轮数都停下告诉你", async (t) => {
  await t.test("乙没改代码、回复不归我 → 暂停（2）", async () => {
    const s = scene({ stages: { 甲: {}, 乙: { mode: "nochange" } }, env: { FAKE_ACC_FAIL: "A2" } });
    try {
      assert.equal(await runPipeline(s.plan, io(s)), 2);
      assert.match(s.notes.at(-1)!, /乙 收到 e2e 返修后没改代码，回复：A2：不归我/);
    } finally { s.close(); }
  });
  await t.test("没标归属的条目没过 → 暂停（2），不乱派", async () => {
    const s = scene({ stages: { 甲: {}, 乙: {} }, criteria: CRITERIA.replace("[乙] ", ""), env: { FAKE_ACC_FAIL: "A2" } });
    try {
      assert.equal(await runPipeline(s.plan, io(s)), 2);
      assert.match(s.notes.at(-1)!, /没法确定归谁：A2/);
      assert.ok(!existsSync(join(s.plan.dir, "乙.inbox.json")));
    } finally { s.close(); }
  });
  await t.test("一直不过 → 到轮数上限停（1），最后一轮不再派", async () => {
    const s = scene({ stages: { 甲: {}, 乙: {} }, env: { FAKE_ACC_FAIL: "A2" }, maxRounds: 2 });
    try {
      assert.equal(await runPipeline(s.plan, io(s)), 1);
      assert.match(s.notes.at(-1)!, /第 2 轮仍有 A2 没通过，已到 2 轮上限/);
      assert.ok(existsSync(join(s.plan.dir, "乙.inbox-1.txt")) && !existsSync(join(s.plan.dir, "乙.inbox-2.txt")));
    } finally { s.close(); }
  });
});

test("P8 同一仓库的两段逐个派，不同仓库同时派", async (t) => {
  await t.test("同一个 git 仓库：乙等甲修完才收到返修", async () => {
    const shared = mkdtempSync(join(tmpdir(), "autoreview-pipeline-repo-"));
    spawnSync("git", ["init", "-q"], { cwd: shared });
    const s = scene({ stages: { 甲: { cwd: shared }, 乙: { cwd: join(shared, "front") } }, env: { FAKE_ACC_FAIL_ONCE: "A1,A2", FAKE_STAGE_DELAY_MS: "150" } });
    try {
      assert.equal(await runPipeline(s.plan, io(s)), 0, s.notes.join("\n"));
      assert.ok(at(s.events("乙"), "inbox 1") >= at(s.events("甲"), "fixed 1"), "同仓库逐段派");
    } finally { s.close(); rmSync(shared, { recursive: true, force: true }); }
  });
  await t.test("不同目录（不是同一仓库）：两段同时收到返修", async () => {
    const s = scene({ stages: { 甲: {}, 乙: {} }, env: { FAKE_ACC_FAIL_ONCE: "A1,A2", FAKE_STAGE_DELAY_MS: "300" } });
    try {
      assert.equal(await runPipeline(s.plan, io(s)), 0, s.notes.join("\n"));
      assert.ok(at(s.events("乙"), "inbox 1") < at(s.events("甲"), "fixed 1"), "不同仓库同时派");
    } finally { s.close(); }
  });
});

test("P9 段暂停时提醒你并接着等；段一直不报状态时提醒检查启动命令", async (t) => {
  await t.test("甲先暂停、你处理好后完成：提醒一次，流水线照常走完", async () => {
    const s = scene({ stages: { 甲: { mode: "pause" }, 乙: {} } });
    try {
      assert.equal(await runPipeline(s.plan, io(s)), 0, s.notes.join("\n"));
      assert.equal(s.notes.filter((note) => /甲 暂停（开发方需要你决定），在它的窗口里处理/.test(note)).length, 1);
    } finally { s.close(); }
  });
  await t.test("段不报状态：提醒加载 autoreview.ts", async () => {
    const s = scene({ stages: { 甲: { mode: "silent" } }, criteria: CRITERIA.replace("[乙]", "[甲]") });
    try {
      const running = runPipeline(s.plan, io(s, 200));
      for (let i = 0; i < 100 && !s.notes.some((note) => note.includes("还没收到「甲」的状态")); i += 1) await new Promise((r) => setTimeout(r, 20));
      assert.ok(s.notes.some((note) => /还没收到「甲」的状态，确认它的启动命令加载了 autoreview\.ts/.test(note)));
      // 补一个完成状态让流水线收尾，不留挂起的等待。
      writeFileSync(join(s.plan.dir, "甲.status.json"), JSON.stringify({ stage: "甲", seq: 1, event: "done", inbox: 0, sessionId: "x", summary: "", updatedAt: "" }));
      assert.equal(await running, 0);
    } finally { s.close(); }
  });
});

test("P10 --from e2e：各段已完成时直接跑 e2e；还有没完成的就停", async () => {
  const s = scene({ stages: { 甲: {}, 乙: {} } });
  try {
    assert.equal(await runPipeline(s.plan, io(s), { fromE2e: true }), 2, "没有状态就不能从 e2e 接着跑");
    assert.match(s.notes.at(-1)!, /--from e2e 需要各段都已完成，甲、乙 还没有/);
    for (const stage of ["甲", "乙"]) {
      writeFileSync(join(s.plan.dir, `${stage}.status.json`), JSON.stringify({ stage, seq: 3, event: "done", inbox: 0, sessionId: "x", summary: "", updatedAt: "" }));
    }
    assert.equal(await runPipeline(s.plan, io(s), { fromE2e: true }), 0, s.notes.join("\n"));
    assert.ok(!existsSync(join(s.plan.dir, "甲.events.log")), "没有重新启动任何一段");
  } finally { s.close(); }
});

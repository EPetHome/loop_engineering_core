/** 流水线：计划解析、归属、派发分批（纯函数）；接力、e2e、回流（假段进程 + 假验收方）。产物只写 os.tmpdir()。 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { createServer } from "node:net";
import {
  buildRepairMessage, DEFAULT_PI, dispatchBatches, parseOwner, parsePlan, piCommand, PlanError, preflight, routeFailures,
  runPipeline, stageScript, type PipelineIO, type Plan,
} from "../pipeline.ts";

const FAKE_STAGE = fileURLToPath(new URL("./fake-stage.mjs", import.meta.url));
const TESTER = fileURLToPath(new URL("./fake-tester.mjs", import.meta.url));
const CRITERIA = "需求：甲做接口，乙做页面\n\n## 验收标准\nA1. [甲] 操作：调接口\n    预期：返回 ok\nA2. [乙] 操作：打开页面\n    预期：显示 ok\n";
const resourceRoot = mkdtempSync(join(tmpdir(), "autoreview-pipeline-resources-"));
process.env.AUTOREVIEW_RESOURCE_ROOT = resourceRoot;
after(() => rmSync(resourceRoot, { recursive: true, force: true }));

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "autoreview-pipeline-"));
}

/** 自动评审只在有提交的 git 仓库里工作：测试里的段目录都建成这样。 */
function gitRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  const git = (...args: string[]) => spawnSync("git", args, { cwd: dir, env, encoding: "utf8" });
  if (git("rev-parse", "--verify", "HEAD").status === 0) return dir;
  git("init", "-q"); git("config", "user.email", "t@example.com"); git("config", "user.name", "t");
  writeFileSync(join(dir, "README.md"), "x\n"); git("add", "README.md"); git("commit", "-qm", "init");
  return dir;
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
    assert.match(stageScript(serial, serial.stages.get("乙")!), /^cd '.*' && export AUTOREVIEW_PIPELINE_DIR='.*' AUTOREVIEW_STAGE='乙' AUTOREVIEW_PIPELINE_LAUNCH=1 AUTOREVIEW_PIPELINE_LAUNCH_TOKEN='[^']+' && b$/);
    writeFileSync(join(root, "prompt.md"), "做");
    const prompted = parsePlan({ name: "p", stages: { 甲: { prompt: "prompt.md" } }, steps: [["甲"]] }, root, {});
    assert.match(stageScript(prompted, prompted.stages.get("甲")!), /AUTOREVIEW_PIPELINE_LAUNCH_TOKEN='[^']+'/);
    assert.deepEqual(parseOwner("[乙] 操作：打开"), { owner: "乙", text: "操作：打开" });
    assert.deepEqual(parseOwner("操作：打开"), { text: "操作：打开" });
    // [人工] 条目不自动验、不退回：不当成段名，原文不动，不要求标归属。
    assert.deepEqual(parseOwner("[人工] 操作：在 WB 里点接入"), { text: "[人工] 操作：在 WB 里点接入" });
    assert.deepEqual(parseOwner("[乙] [人工] 操作：x"), { text: "[乙] [人工] 操作：x" });
    writeFileSync(join(root, "manual.md"), "## 验收标准\nA1. [甲] 操作：调接口\n   预期：ok\nA2. [人工] 操作：在 WB 里点接入\n   预期：页面显示已接入\n");
    const manual = parsePlan({ name: "m", stages: { 甲: { start: "a" } }, e2e: { workDir: ".", criteria: "manual.md" } }, root, {});
    assert.deepEqual([...manual.e2e!.owners], [["A1", "甲"], ["A2", undefined]]);
    assert.equal(manual.e2e!.items[1].text.split("\n")[0], "[人工] 操作：在 WB 里点接入");
    // [授权] 不是段名：写在段名前后都行，段名照常取，标签留在原文里。
    assert.deepEqual(parseOwner("[授权] [乙] 操作：x"), { owner: "乙", text: "[授权] 操作：x" });
    assert.deepEqual(parseOwner("[乙] [授权] 操作：x"), { owner: "乙", text: "[授权] 操作：x" });
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
    const cwd = value.cwd ?? gitRepo(join(root, `work-${name}`));
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
    preflightEnv: { playwright: () => true },
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
    const shared = gitRepo(mkdtempSync(join(tmpdir(), "autoreview-pipeline-repo-")));
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
      writeFileSync(join(s.plan.dir, "甲.status.json"), JSON.stringify({ stage: "甲", seq: 1, event: "done", readyEpoch: "fixture-ready", inbox: 0, sessionId: "x", summary: "", updatedAt: "" }));
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
      writeFileSync(join(s.plan.dir, `${stage}.status.json`), JSON.stringify({ stage, seq: 3, event: "done", readyEpoch: "fixture-ready", inbox: 0, sessionId: "x", summary: "", updatedAt: "" }));
    }
    assert.equal(await runPipeline(s.plan, io(s), { fromE2e: true }), 0, s.notes.join("\n"));
    assert.ok(!existsSync(join(s.plan.dir, "甲.events.log")), "没有重新启动任何一段");
  } finally { s.close(); }
});

test("P11 计划里写提示词：程序按日常配置生成 pi 启动命令，pi 一节和每段可以覆盖", () => {
  const root = tempDir();
  try {
    const plan = parsePlan({
      name: "V2",
      pi: { thinking: "high", args: ["--autoreview-max-repairs", "2"] },
      stages: {
        甲: { prompt: "方案二.md", cwd: "." },
        乙: { prompt: "提示词/方案三.md", model: "opencode-go/deepseek-v4.1-flash" },
        丁: { start: "bash 自己的.sh" },
      },
    }, root, {});
    const jia = plan.stages.get("甲")!;
    assert.equal(jia.prompt, join(root, "方案二.md"));
    assert.equal(jia.start, piCommand("V2", "甲", join(root, "方案二.md"), { ...DEFAULT_PI, thinking: "high", args: ["--autoreview-max-repairs", "2"] }, root));
    assert.match(jia.start, /bin\/pi-dev/);
    assert.match(jia.start, /'--model' 'openai-codex\/gpt-6\.1-sol' '--thinking' 'high'/);
    assert.match(jia.start, /'--name' 'V2·甲' .*'--' '--autoreview-max-repairs' '2'/);
    assert.match(plan.stages.get("乙")!.start, /'--model' 'opencode-go\/deepseek-v4\.1-flash' '--thinking' 'high'/, "每段可以覆盖模型，其余沿用 pi 一节");
    assert.equal(plan.stages.get("丁")!.start, "bash 自己的.sh");
    assert.equal(plan.stages.get("丁")!.prompt, undefined);
    assert.throws(() => parsePlan({ name: "x", stages: { 甲: { prompt: "a.md", start: "b" } } }, root, {}), /两个只能写一个/);
    assert.throws(() => parsePlan({ name: "x", stages: { 甲: { cwd: "." } } }, root, {}), /要写 prompt（提示词文件，推荐）或 start/);
    assert.throws(() => parsePlan({ name: "x", pi: { args: "--x" }, stages: { 甲: { prompt: "a.md" } } }, root, {}), /pi\.args 必须是字符串数组/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("P12 开跑前检查：全部满足才开跑；任何一项不过就停下，不开窗口", async (t) => {
  const root = tempDir();
  const tools = join(root, "tools");
  mkdirSync(tools);
  for (const name of ["pi", "permission.ts", "autoreview.ts"]) writeFileSync(join(tools, name), "");
  const env = { pi: join(tools, "pi"), permission: join(tools, "permission.ts"), autoreview: join(tools, "autoreview.ts"), playwright: () => true };
  const port = await new Promise<number>((resolvePort) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => { const { port: p } = server.address() as { port: number }; server.close(() => resolvePort(p)); });
  });
  writeFileSync(join(root, "e2e.md"), CRITERIA);
  writeFileSync(join(root, "甲.md"), "做接口");
  gitRepo(join(root, "jia")); gitRepo(join(root, "yi"));
  const planOf = (overrides: Record<string, unknown> = {}) => parsePlan({
    name: "check", dir: join(root, "run"),
    stages: { 甲: { prompt: "甲.md", cwd: "jia" }, 乙: { prompt: "乙.md", cwd: "yi" } },
    e2e: { workDir: ".", criteria: "e2e.md", acceptance: { start: "node s.js", readyUrl: `http://127.0.0.1:${port}/` } },
    ...overrides,
  }, root, {});
  try {
    await t.test("缺提示词、目录不是 git 仓库、同一步同目录、端口被占、缺 Playwright、缺 pi：逐项标出", async () => {
      mkdirSync(join(root, "plain"));
      const squatter = createServer().listen(port, "127.0.0.1");
      await new Promise((r) => squatter.once("listening", r));
      try {
        const plan = planOf({ stages: { 甲: { prompt: "甲.md", cwd: "jia" }, 乙: { prompt: "乙.md", cwd: "plain" }, 丙: { start: "x", cwd: "jia" } } });
        const checks = await preflight(plan, { env: { ...env, pi: join(tools, "没有的 pi"), playwright: () => false } });
        const bad = checks.filter((check) => !check.ok).map((check) => check.name);
        assert.deepEqual(bad, [
          "乙 的目录是有提交的 git 仓库", "乙 的提示词", "第 1 步里并行的段不在同一目录", "pi",
          `e2e 的地址 127.0.0.1:${port} 现在空着`, "Playwright（e2e 要操作网页）",
        ]);
        assert.match(checks.find((check) => check.name === "第 1 步里并行的段不在同一目录")!.detail, /丙 和同一步的别的段在同一个目录/);
        const notes: string[] = [];
        const launched: string[] = [];
        const code = await runPipeline(plan, {
          launch: (stage) => launched.push(stage.name), notify: (m) => notes.push(m), log: () => {}, pollMs: 20, silenceMs: 1000,
          preflightEnv: { ...env, playwright: () => false },
        });
        assert.equal(code, 2);
        assert.deepEqual(launched, [], "检查不过就不开任何窗口");
        assert.match(notes.at(-1)!, /开跑前检查没通过：乙 的目录是有提交的 git 仓库/);
        assert.match(readFileSync(join(plan.dir, "report.md"), "utf8"), /## 开跑前检查\n(- (🟢|🔴) .*\n)+/);
      } finally { squatter.close(); }
    });
    await t.test("都满足：全部 🟢；从 e2e 接着跑时只查 e2e 相关的", async () => {
      writeFileSync(join(root, "乙.md"), "做页面");
      const checks = await preflight(planOf(), { env });
      assert.deepEqual(checks.filter((check) => !check.ok), [], JSON.stringify(checks));
      assert.ok(checks.some((check) => check.name === "Playwright（e2e 要操作网页）"));
      const e2eOnly = await preflight(planOf(), { fromE2e: true, env });
      assert.ok(e2eOnly.every((check) => !check.name.startsWith("甲") && !check.name.startsWith("乙")));
      assert.ok(e2eOnly.some((check) => check.name === "pi"), "e2e 的验收方也要用 pi");
    });
    await t.test("e2e 标准里的 [授权] 条目：标准文件里没答复就不开跑，答复了才过", async () => {
      writeFileSync(join(root, "auth.md"), `${CRITERIA}A3. [甲] [授权] 操作：用正式账号同步\n    预期：多一行\n`);
      const name = "e2e 的 [授权] 条目都已答复";
      const waiting = (await preflight(planOf({ e2e: { workDir: ".", criteria: "auth.md" } }), { fromE2e: true, env })).find((check) => check.name === name)!;
      assert.equal(waiting.ok, false);
      assert.match(waiting.detail, /A3 还没答复：在 .*auth\.md 里加一行「同意授权：A3」或「不授权：A3」/);
      writeFileSync(join(root, "auth.md"), `${CRITERIA}A3. [甲] [授权] 操作：用正式账号同步\n    预期：多一行\n\n同意授权：A3\n`);
      const plan = planOf({ e2e: { workDir: ".", criteria: "auth.md" } });
      assert.equal((await preflight(plan, { fromE2e: true, env })).find((check) => check.name === name)!.ok, true);
      assert.equal(plan.e2e!.items.length, 3, "答复行不会变成标准");
      assert.equal(plan.e2e!.owners.get("A3"), "甲");
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Ponytail 只显式加载原生扩展，并记录角色模式；可按段关闭', () => {
  const root = tempDir();
  try {
    writeFileSync(join(root, '任务.md'), '任务');
    const plan = parsePlan({ name: 'pony', pi: { ponytail: { extension: 'pony/index.js', mode: 'full' } },
      stages: { 开发: { cwd: '.', prompt: '任务.md' }, 其他: { cwd: 'other', prompt: '任务.md', ponytail: false } } }, root);
    assert.match(plan.stages.get('开发')!.start, /bin\/pi-dev/);
    assert.ok(plan.stages.get('开发')!.start.includes(`'--ponytail' '${join(root, 'pony/index.js')}'`));
    assert.match(plan.stages.get('开发')!.start, /'--ponytail-mode' 'full'/);
    assert.match(plan.stages.get('其他')!.start, /'--no-ponytail'/);
    assert.ok(!plan.stages.get('其他')!.start.includes('--ponytail '));
    assert.throws(() => parsePlan({ name: 'x', maxParallel: 0, stages: { a: { start: 'true' } } }, root), /maxParallel/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('流水线先用已有项目准备方法；准备失败不启动开发会话', async () => {
  const root = tempDir();
  try {
    const repo = gitRepo(join(root, 'repo'));
    writeFileSync(join(repo, '.autoreview.json'), JSON.stringify({ preparation: { check: 'exit 75' } }));
    const plan = parsePlan({ name: 'prepared', dir: 'run', stages: { a: { cwd: 'repo', start: 'true' } } }, root);
    let launches = 0;
    const code = await runPipeline(plan, { launch: () => { launches++; }, log: () => {}, notify: () => {}, pollMs: 10, silenceMs: 100 });
    assert.equal(code, 2);
    assert.equal(launches, 0);
    assert.match(readFileSync(join(plan.dir, 'report.md'), 'utf8'), /准备未完成/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("流水线 CLI 收到退出信号先取消整合验收并等待 cleanup", async (t) => {
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) await t.test(signal, async () => {
    const root = tempDir(), dir = join(root, "run"), home = join(root, "home"), bin = join(root, "bin");
    let child: ReturnType<typeof spawn> | undefined;
    try {
      gitRepo(join(root, "repo")); mkdirSync(dir); mkdirSync(home); mkdirSync(bin);
      writeFileSync(join(bin, "osascript"), "#!/bin/sh\nexit 0\n"); chmodSync(join(bin, "osascript"), 0o755);
      writeFileSync(join(root, "e2e.md"), "## 验收标准\nA1. [a] 操作：检查\n预期：ok\n");
      const ready = join(root, "ready"), tester = join(root, "tester.mjs");
      writeFileSync(tester, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(ready)}, 'ready'); setTimeout(()=>{},30000);\n`); chmodSync(tester, 0o755);
      const plan = { name: "cancel", dir, stages: { a: { cwd: "repo", start: "true" } }, e2e: {
        workDir: "repo", criteria: "e2e.md", acceptance: { cleanup: `node -e 'setTimeout(() => require("fs").writeFileSync(process.env.AUTOREVIEW_RUN_DIR + "/released", process.env.AUTOREVIEW_RUN_ID), 100)'` },
      } };
      const file = join(root, "plan.json"); writeFileSync(file, JSON.stringify(plan));
      writeFileSync(join(dir, "a.status.json"), JSON.stringify({ event: "done", readyEpoch: "fixture-ready", seq: 1, inbox: 0 }));
      child = spawn(process.execPath, [fileURLToPath(new URL("../pipeline.ts", import.meta.url)), file, "--from", "e2e", "--launcher", "background"], {
        stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, AUTOREVIEW_ACCEPTANCE_CMD: tester },
      });
      let output = ""; child.stdout!.on("data", (v) => { output += v; }); child.stderr!.on("data", (v) => { output += v; });
      const exit = new Promise<number | null>((resolve) => child!.on("exit", resolve));
      for (let i = 0; i < 200 && !existsSync(ready) && child.exitCode === null; i++) await new Promise((r) => setTimeout(r, 50));
      assert.ok(existsSync(ready), output);
      child.kill(signal); assert.equal(await exit, 2, output);
      const run = join(dir, "e2e", "r1"), record = JSON.parse(readFileSync(join(run, "cleanup-task.json"), "utf8"));
      assert.equal(record.status, "released"); assert.equal(readFileSync(join(run, "released"), "utf8"), record.runId);
      assert.match(readFileSync(join(dir, "report.md"), "utf8"), /外部资源释放：released[\s\S]*已取消/);
      assert.equal(readFileSync(join(dir, "pipeline.finished"), "utf8").trim(), "2");
      assert.equal(JSON.parse(readFileSync(join(dir, "a.status.json"), "utf8")).event, "done", "保留开发会话交付状态");
    } finally { if (child?.exitCode === null) child.kill("SIGKILL"); rmSync(root, { recursive: true, force: true }); }
  });
});

test("流水线恢复在端口预检前回收本任务登记的孤儿", async () => {
  const s = scene({ stages: { a: {} }, criteria: "## 验收标准\nA1. [a] 操作：检查\n预期：ok\n" });
  let orphan: ReturnType<typeof spawn> | undefined;
  try {
    const { registerProc } = await import("../procs.ts");
    const { portBusy } = await import("../acceptance.ts");
    mkdirSync(s.plan.dir, { recursive: true });
    writeFileSync(join(s.plan.dir, "a.status.json"), JSON.stringify({ event: "done", readyEpoch: "fixture-ready", seq: 1, inbox: 0 }));
    const ready = join(s.root, "port");
    orphan = spawn(process.execPath, ["-e", `const s=require('http').createServer((q,r)=>r.end('old')); s.listen(0,'127.0.0.1',()=>require('fs').writeFileSync(${JSON.stringify(ready)},String(s.address().port)));`], { detached: true, stdio: "ignore" });
    for (let i = 0; i < 100 && !existsSync(ready); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(existsSync(ready));
    const url = new URL(`http://127.0.0.1:${readFileSync(ready, "utf8")}/`);
    assert.equal(await portBusy(url), true);
    const registry = join(s.plan.dir, "procs.json");
    registerProc(registry, orphan.pid!, "被测系统", "owned fixture");
    const entries = JSON.parse(readFileSync(registry, "utf8")); entries[0].ownerPid = 2147480000;
    writeFileSync(registry, JSON.stringify(entries));
    s.plan.e2e!.acceptance.readyUrl = url.href;
    assert.equal(await runPipeline(s.plan, io(s), { fromE2e: true }), 0, s.notes.join("\n"));
    assert.equal(await portBusy(url), false);
    assert.equal(existsSync(registry), false);
  } finally { if (orphan?.exitCode === null && orphan.signalCode === null) orphan.kill("SIGKILL"); s.close(); }
});


test("--from e2e 不能使用尚有未接收返修的旧 done", async () => {
  const s = scene({ stages: { a: {} }, criteria: '## 验收标准\nA1. [a] 操作：检查\n预期：ok\n' });
  try {
    mkdirSync(s.plan.dir, { recursive: true });
    writeFileSync(join(s.plan.dir, 'a.status.json'), JSON.stringify({ event: 'done', readyEpoch: 'fixture-ready', seq: 2, inbox: 0 }));
    writeFileSync(join(s.plan.dir, 'a.inbox.json'), JSON.stringify({ seq: 1, message: 'repair', mustFix: 'must fix' }));
    assert.equal(await runPipeline(s.plan, io(s), { fromE2e: true }), 2);
    assert.equal(accCalls(s), 0);
  } finally { s.close(); }
});

test('已完成段在等待其他段期间失效，不能启动整合验收', async () => {
  const s = scene({ stages: { a: {}, b: {} }, criteria: '## 验收标准\nA1. [a] 操作：检查\n预期：ok\n' });
  const timers: ReturnType<typeof setTimeout>[]=[];
  try {
    const {writeStageStatus}=await import('../pipeline-core.ts');
    const base=io(s);
    base.launch=(stage)=>{
      const link={dir:s.plan.dir,stage:stage.name};
      const emit=(event:'done'|'started')=>writeStageStatus(link,{sessionId:'fixture-'+stage.name,summary:'',event,inbox:0,...(event==='done'?{readyEpoch:'ready-'+stage.name}:{})});
      if(stage.name==='a'){emit('done');timers.push(setTimeout(()=>emit('started'),30));}
      else timers.push(setTimeout(()=>emit('done'),90));
    };
    assert.equal(await runPipeline(s.plan,base),2);
    assert.equal(accCalls(s),0);
    assert.match(readFileSync(join(s.plan.dir,'report.md'),'utf8'),/资格被撤销/);
  } finally {for(const timer of timers)clearTimeout(timer);s.close();}
});

test('整合验收期间更换资格使结果失效；同资格恢复重发可继续', async (t) => {
  for(const mode of ['during','cleanup','same']) await t.test(mode,async()=>{
    const s=scene({stages:{a:{}},criteria:'## 验收标准\nA1. [a] 操作：检查\n预期：ok\n'});
    try {
      mkdirSync(s.plan.dir,{recursive:true});
      const status=join(s.plan.dir,'a.status.json');
      const ready={stage:'a',sessionId:'fixture',summary:'',event:'done',seq:1,inbox:0,readyEpoch:'ready-before'};
      writeFileSync(status,JSON.stringify(ready));
      const replacement={...ready,seq:2,readyEpoch:mode==='same'?'ready-before':'ready-after'};
      const change=`require('fs').writeFileSync(${JSON.stringify(status)},${JSON.stringify(JSON.stringify(replacement))});`;
      const cleaner=join(s.root,'cleanup.cjs');
      writeFileSync(cleaner,(mode==='during'?'':change)+`require('fs').writeFileSync(process.env.AUTOREVIEW_RUN_DIR+'/released','yes');`);
      s.plan.e2e!.acceptance.cleanup='node cleanup.cjs';
      if(mode==='during'){
        const tester=join(s.root,'hold.cjs');writeFileSync(tester,`#!${process.execPath}\n${change}setTimeout(()=>{},30000);`);chmodSync(tester,0o755);s.plan.e2e!.acceptance.testerCmd=tester;
      }
      assert.equal(await runPipeline(s.plan,io(s),{fromE2e:true}),mode==='same'?0:2,s.notes.join('\n'));
      assert.equal(readFileSync(join(s.plan.dir,'e2e','r1','released'),'utf8'),'yes');
      assert.ok(existsSync(join(s.plan.dir,'e2e','r1','upstream.json')));
      if(mode!=='same')assert.match(readFileSync(join(s.plan.dir,'report.md'),'utf8'),/资格变化[\s\S]*结果已失效/);
    } finally {s.close();}
  });
});

test('消费旧 done 时核对真实来源文件，内容变化不失效，缺失仍中止；恢复与收尾均不依赖段巡检', async (t) => {
  const { loadContext, refreshContext } = await import('../project-context.ts');
  const oldRoot = process.env.AUTOREVIEW_PROJECTS_ROOT;
  for (const change of ['same', 'before', 'cleanup']) await t.test(change, async () => {
    const s = scene({ stages: { a: {} }, criteria: '## 验收标准\nA1. [a] 操作：检查\n预期：ok\n' });
    try {
      process.env.AUTOREVIEW_PROJECTS_ROOT = join(s.root, 'index');
      const cwd = s.plan.stages.get('a')!.cwd, source = join(cwd, 'need.md');
      writeFileSync(source, 'original requirement');
      writeFileSync(join(cwd, '.autoreview.json'), JSON.stringify({ context: { sources: [{ path: 'need.md', role: 'requirement' }] } }));
      const sourceInputs = refreshContext(loadContext(cwd)!).snapshot.inputsFingerprint;
      mkdirSync(s.plan.dir, { recursive: true });
      const status = join(s.plan.dir, 'a.status.json');
      writeFileSync(status, JSON.stringify({ event: 'done', readyEpoch: 'unchanged-ready', sourceInputs, seq: 1, inbox: 0 }));
      if (change === 'before') writeFileSync(source, 'new requirement');
      if (change === 'cleanup') {
        writeFileSync(join(s.root, 'cleanup.cjs'), `require('fs').unlinkSync(${JSON.stringify(source)}); require('fs').writeFileSync(process.env.AUTOREVIEW_RUN_DIR+'/released','yes');`);
        s.plan.e2e!.acceptance.cleanup = 'node cleanup.cjs';
      }
      assert.equal(await runPipeline(s.plan, io(s), { fromE2e: true }), change === 'cleanup' ? 2 : 0, s.notes.join('\n'));
      if (change === 'before') assert.ok(accCalls(s) > 0, '内容变化不再判段失效，e2e 照常执行');
      if (change === 'cleanup') assert.equal(readFileSync(join(s.plan.dir, 'e2e', 'r1', 'released'), 'utf8'), 'yes');
      assert.equal(JSON.parse(readFileSync(status, 'utf8')).event, 'done', '测试未模拟改写段资格，程序直接核对来源');
    } finally { s.close(); }
  });
  if (oldRoot === undefined) delete process.env.AUTOREVIEW_PROJECTS_ROOT; else process.env.AUTOREVIEW_PROJECTS_ROOT = oldRoot;
});

test("P 批次文件与 scope：启动脚本带绝对路径，scope 解析并校验字段名", () => {
  const root = tempDir();
  try {
    const batch = join(root, "批次.json");
    writeFileSync(join(root, "a.md"), "a");
    writeFileSync(batch, "{}");
    const plan = parsePlan({
      name: "环境", stages: { 甲: { prompt: "a.md", scope: { allow: ["src/"], deny: ["src/secret/"] } } }, steps: [["甲"]],
    }, root, {}, { batchFile: batch });
    assert.equal(plan.file, batch);
    assert.deepEqual(plan.stages.get("甲")!.scope, { allow: ["src"], deny: ["src/secret"] });
    assert.match(stageScript(plan, plan.stages.get("甲")!), new RegExp(`AUTOREVIEW_BATCH_FILE='${batch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'`));

    for (const [scope, pattern] of [
      [{ allow: "src/" }, /stages\.甲\.scope\.allow.*字符串数组/],
      [{ deny: [""] }, /stages\.甲\.scope\.deny\[0\].*非空字符串/],
      [{ allow: ["../outside"] }, /不能越出项目根/],
      ["src/", /stages\.甲\.scope 必须是 JSON 对象/],
    ] as const) {
      assert.throws(() => parsePlan({ name: "x", stages: { 甲: { start: "a", scope } }, steps: [["甲"]] }, root, {}),
        (error: unknown) => error instanceof PlanError && pattern.test((error as Error).message));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("P 启动入口失败：写回 startup-failed 后编排程序立即非零退出，不等待会话", async () => {
  const root = gitRepo(tempDir());
  try {
    const start = `${process.execPath} -e 'const fs=require("node:fs"),p=require("node:path");const d=process.env.AUTOREVIEW_PIPELINE_DIR,s=process.env.AUTOREVIEW_STAGE;fs.mkdirSync(d,{recursive:true});fs.writeFileSync(p.join(d,s+".status.json"),JSON.stringify({stage:s,sessionId:"startup",summary:"",event:"startup-failed",seq:1,inbox:0,pauseReason:"权限自动执行检查未通过：bash 会询问"}));'`;
    const plan = parsePlan({ name: "启动失败", stages: { 甲: { start } }, steps: [["甲"]], dir: join(root, "pipeline") }, root, {});
    const notes: string[] = [];
    const started = Date.now();
    const code = await runPipeline(plan, {
      launch: (_stage, script) => { spawnSync("/bin/sh", ["-c", `(${script}) >/dev/null 2>&1 &`]); },
      notify: (message) => notes.push(message), log: () => {}, pollMs: 20, silenceMs: 1000,
      preflightEnv: { playwright: () => true },
    });
    assert.equal(code, 1);
    assert.ok(Date.now() - started < 5_000, "没有一直等会话状态");
    assert.match(notes.at(-1)!, /段 甲 启动失败：权限自动执行检查未通过：bash 会询问/);
    assert.equal(readFileSync(join(plan.dir, "pipeline.finished"), "utf8").trim(), "1");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("P 流水线准备和段会话共用准备前确定的开工依据", async () => {
  const root = gitRepo(tempDir());
  const out = mkdtempSync(join(tmpdir(), "autoreview-pipeline-base-"));
  try {
    const prepFile = join(out, "prep-base.txt"), startFile = join(out, "start-base.txt");
    writeFileSync(join(root, ".autoreview.json"), JSON.stringify({ preparation: { check: `printf '%s' "$AUTOREVIEW_BASE_REV" > ${JSON.stringify(prepFile)}` } }));
    const script = join(root, "stage.mjs");
    writeFileSync(script, `import { mkdirSync, writeFileSync } from "node:fs";\nimport { join } from "node:path";\nwriteFileSync(${JSON.stringify(startFile)}, process.env.AUTOREVIEW_BASE_REV ?? "");\nconst dir = process.env.AUTOREVIEW_PIPELINE_DIR, stage = process.env.AUTOREVIEW_STAGE;\nmkdirSync(dir, { recursive: true });\nwriteFileSync(join(dir, stage + ".status.json"), JSON.stringify({ stage, sessionId: "s", summary: "", event: "done", readyEpoch: "e", seq: 1, inbox: 0 }));\n`);
    const plan = parsePlan({ name: "开工依据", stages: { 甲: { start: `"${process.execPath}" "${script}"` } }, steps: [["甲"]], dir: join(out, "pipeline") }, root, {});
    const code = await runPipeline(plan, {
      launch: (_stage, command) => { spawnSync("/bin/sh", ["-c", `(${command}) >/dev/null 2>&1 &`]); },
      notify: () => {}, log: () => {}, pollMs: 20, silenceMs: 1000, preflightEnv: { playwright: () => true },
    });
    assert.equal(code, 0, readFileSync(join(plan.dir, "report.md"), "utf8"));
    const prepared = readFileSync(prepFile, "utf8");
    assert.match(prepared, /^[a-f0-9]{40}$/);
    assert.equal(readFileSync(startFile, "utf8"), prepared, "启动脚本拿到准备使用的同一份开工依据");
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true }); }
});

test("P 并行段一段启动失败：收束另一段的等待，不杀已启动会话", async () => {
  const root = tempDir();
  const out = mkdtempSync(join(tmpdir(), "autoreview-pipeline-cancel-"));
  const launched: Promise<void>[] = [];
  try {
    const a = gitRepo(join(root, "a")), b = gitRepo(join(root, "b"));
    const status = (event: string, reason = "") => `${process.execPath} -e 'const fs=require("node:fs"),p=require("node:path");const d=process.env.AUTOREVIEW_PIPELINE_DIR,s=process.env.AUTOREVIEW_STAGE;fs.mkdirSync(d,{recursive:true});fs.writeFileSync(p.join(d,s+".status.json"),JSON.stringify({stage:s,sessionId:"s",summary:"",event:${JSON.stringify(event)},seq:1,inbox:0,pauseReason:${JSON.stringify(reason)}}));'`;
    const plan = parsePlan({ name: "并行启动失败", maxParallel: 2, stages: {
      甲: { cwd: a, start: status("startup-failed", "权限自动执行检查未通过：bash 会询问") },
      乙: { cwd: b, start: status("paused", "等用户决定") },
    }, steps: [["甲", "乙"]], dir: join(out, "pipeline") }, root, {});
    const notes: string[] = [];
    const started = Date.now();
    const code = await runPipeline(plan, {
      launch: (_stage, script) => {
        const child = spawn("/bin/sh", ["-c", script], { stdio: "ignore" });
        launched.push(new Promise<void>((accept) => { child.once("exit", () => accept()); child.once("error", () => accept()); }));
      },
      notify: (message) => notes.push(message), log: () => {}, pollMs: 30, silenceMs: 1000,
      preflightEnv: { playwright: () => true },
    });
    assert.equal(code, 1);
    assert.ok(Date.now() - started < 5_000, "另一段的等待已收束，进程没有一直挂着");
    assert.match(notes.at(-1)!, /段 甲 启动失败/);
    // 编排已及时返回不等于另一个替身已写完文件；按本测试创建的子进程确认退出再读/清理。
    await Promise.all(launched);
    assert.equal(JSON.parse(readFileSync(join(plan.dir, "乙.status.json"), "utf8")).event, "paused", "乙的会话状态保留");
  } finally { await Promise.all(launched); rmSync(root, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true }); }
});

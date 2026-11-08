/** 单轮执行器精确复验；首次/显式完整范围、标准/授权变化及证据来源保护。 */
import "./test-env.ts";
import "./helpers/git-runtime.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { extractCriteria, type AcceptanceRecord } from "../acceptance-core.ts";
import { runAcceptanceOnce, type AcceptanceDeps, type AcceptanceStage } from "../acceptance.ts";
import { parseAcceptanceConfig } from "../config.ts";
import { renderDeliveryReport } from "../core.ts";
import { createChildExec } from "../hosts/review-hook.ts";
const IDS = ["A1", "A2", "A3", "A4", "A5"];
const STANDARD = `## 验收标准\n${IDS.map((id) => `${id}. 操作：运行功能 ${id}\n    预期：看到了 ${id}`).join("\n")}\n`;
function fixture(results: { fail?: string[]; unknown?: string[] }[]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "loop-acceptance-recheck-"))), repo = join(root, "repo"); mkdirSync(repo);
  const saved = { ...process.env }, env = { ...process.env, AUTOREVIEW_RESOURCE_ROOT: join(root, "resources"), AUTOREVIEW_PROJECTS_ROOT: join(root, "projects"), FAKE_STATE_DIR: join(root, "fake"), FAKE_ACC_MODE: "pass", FAKE_ACC_FAIL: "", FAKE_ACC_FAIL_ONCE: "", FAKE_ACC_UNKNOWN: "", FAKE_ACC_RESULTS: JSON.stringify(results), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  Object.assign(process.env, { AUTOREVIEW_RESOURCE_ROOT: env.AUTOREVIEW_RESOURCE_ROOT, AUTOREVIEW_PROJECTS_ROOT: env.AUTOREVIEW_PROJECTS_ROOT });
  const git = (...args: string[]) => { const r = spawnSync("git", args, { cwd: repo, env, encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  git("init", "-qb", "main"); git("config", "user.email", "test@example.invalid"); git("config", "user.name", "test");
  writeFileSync(join(repo, "product.txt"), "initial\n"); git("add", "."); git("commit", "-qm", "initial");
  const config = parseAcceptanceConfig({ timeoutMin: 5, reset: "printf 'reset\\n'", cleanup: "printf 'released\\n'" }, repo, {})!;
  config.testerCmd = fileURLToPath(new URL("./fake-tester.mjs", import.meta.url));
  const procsFile = join(root, "procs.json"), exec = createChildExec(procsFile);
  const deps: AcceptanceDeps = { workDir: repo, devSessionId: "developer", round: 1, deliveryNote: "【交付完成】", state: { requirement: STANDARD, criteria: { source: "用户", items: extractCriteria(STANDARD)!, version: 1, updatedAt: "initial" } }, config, env, procsFile, reviewerModel: "fake", reviewerThinking: "off", runDir: join(root, "acceptance", "r1"), deadline: Date.now() + 300_000, now: Date.now, previousFailed: [], saveState: () => {}, exec: (cmd, args, options) => exec(cmd, args, { ...options, env: { ...env, ...options.env } }) };
  let round = 0, previous: AcceptanceRecord | undefined;
  const records: AcceptanceRecord[] = [];
  const latest = () => records.at(-1)!;
  const calls = () => existsSync(join(root, "fake", "acc-calls.log")) ? readFileSync(join(root, "fake", "acc-calls.log"), "utf8").trim().split("\n").map((line) => {
    const [, input, , runDir] = line.split("\t"), section = readFileSync(input, "utf8").split(/^## 验收标准（.*$/m)[1]?.split(/^## /m)[0] ?? "";
    return { ids: [...section.matchAll(/^(A\d+)\./gm)].map((m) => m[1]), runDir };
  }) : [];
  return { root, repo, deps, records, latest, calls, git,
    deliver: async (overrides: Partial<AcceptanceDeps> = {}): Promise<AcceptanceStage> => {
      round++; writeFileSync(join(repo, "product.txt"), `delivery ${round}\n`);
      const stage = await runAcceptanceOnce({ ...deps, previous, previousFailed: previous?.items.filter((i) => i.verdict !== "通过" && i.verdict !== "需人工").map((i) => i.id) ?? [], round, runDir: join(root, "acceptance", `r${round}`), deadline: Date.now() + 300_000, ...overrides });
      const record = stage.kind === "judged" ? stage.record : stage.attempts?.at(-1);
      if (record) { previous = record; records.push(record); }
      return stage;
    }, close: () => {
      try {
        if (existsSync(procsFile)) assert.deepEqual(JSON.parse(readFileSync(procsFile, "utf8")), []);
        if (existsSync(env.AUTOREVIEW_RESOURCE_ROOT)) for (const name of readdirSync(env.AUTOREVIEW_RESOURCE_ROOT).filter((n) => n.endsWith(".json"))) assert.equal(JSON.parse(readFileSync(join(env.AUTOREVIEW_RESOURCE_ROOT, name), "utf8")).status, "released");
      } finally { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); rmSync(root, { recursive: true, force: true }); }
    } };
}
test("定向成功不追加 full；沿用项保留原树/轮次/证据，不复制旧证据冒充本轮", async () => {
  const f = fixture([{ fail: ["A2", "A4"] }, {}]);
  try {
    assert.equal((await f.deliver()).kind, "judged"); assert.equal(f.latest().verdict, "不通过"); const first = f.latest();
    assert.deepEqual(first.scope?.tested, IDS);
    assert.equal((await f.deliver()).kind, "judged"); assert.equal(f.latest().verdict, "通过");
    assert.deepEqual(f.calls().map((c) => c.ids), [IDS, ["A2", "A4"]]);
    assert.equal(f.latest().scope?.kind, "retry"); assert.deepEqual(f.latest().scope?.reused, ["A1", "A3", "A5"]);
    for (const item of f.latest().items.filter((i) => ["A1", "A3", "A5"].includes(i.id))) { assert.equal(item.source?.round, 1); assert.equal(item.source?.runDir, first.runDir); assert.equal(existsSync(join(f.latest().runDir, "evidence", `${item.id}.txt`)), false); }
    for (const call of f.calls()) { assert.match(readFileSync(join(call.runDir, "reset.log"), "utf8"), /reset/); assert.equal(JSON.parse(readFileSync(join(call.runDir, "cleanup-task.json"), "utf8")).status, "released"); }
    assert.equal(f.git("rev-list", "--count", "HEAD"), "1");
  } finally { f.close(); }
});
test("显式完整范围仍可发现旧通过项回退；随后只重验回退项", async () => {
  const f = fixture([{ fail: ["A2"] }, { fail: ["A1"] }, {}]);
  try { await f.deliver(); await f.deliver({ fullCheck: true }); assert.equal(f.latest().items.find((i) => i.id === "A1")?.previouslyPassed, true); await f.deliver(); assert.deepEqual(f.calls().map((c) => c.ids), [IDS, IDS, ["A1"]]); } finally { f.close(); }
});
test("用户替换标准、同文改版、同编号改内容或授权变化，均不能沿用旧通过", async (t) => {
  for (const change of ["version", "content", "grant"]) await t.test(change, async () => {
    const f = fixture([{ fail: ["A2"] }, {}]);
    try {
      if (change === "grant") { f.deps.state.criteria!.items[0].text = "[授权] 操作：调用 A1\n预期：成功"; f.deps.state.grants = { version: 1, approved: ["A1"], denied: [] }; }
      await f.deliver();
      if (change === "grant") f.deps.state.grants = { version: 1, approved: [], denied: ["A1"] };
      else { f.deps.state.criteria!.version++; if (change === "content") f.deps.state.criteria!.items[0].text += "\n新预期"; }
      await f.deliver(); assert.deepEqual(f.calls().map((c) => c.ids), [IDS, change === "grant" ? IDS.slice(1) : IDS]); assert.deepEqual(f.latest().scope?.reused, []);
    } finally { f.close(); }
  });
});
test("无法验证项与失败项一起重验，连续返修保留各条原始来源", async () => {
  const f = fixture([{ fail: ["A2"], unknown: ["A4"] }, { fail: ["A2"] }, {}]);
  try { await f.deliver(); await f.deliver(); assert.equal(f.latest().items.find((i) => i.id === "A4")?.source?.round, 2); assert.equal(f.latest().items[0].source?.round, 1); await f.deliver(); assert.deepEqual(f.calls().map((c) => c.ids), [IDS, ["A2", "A4"], ["A2"]]); } finally { f.close(); }
});
test("首次自动项无法验证仍暂停；后续只重验未验证项，人工项不伪通过", async () => {
  const f = fixture([{ unknown: ["A4"] }, {}]);
  try { f.deps.state.criteria!.items[4].text = "[人工] 操作：查看布局\n预期：符合偏好"; const out = await f.deliver(); assert.equal(out.kind, "paused"); if (out.kind === "paused") assert.match(out.reason, /完整验收.*A4/); await f.deliver(); assert.deepEqual(f.calls().map((c) => c.ids), [IDS.slice(0, 4), ["A4"]]); assert.equal(f.latest().items[4].verdict, "需人工"); } finally { f.close(); }
});
test("显式完整验收出现无法验证项，保留具体原因并在后续精确重验", async () => {
  const f = fixture([{ fail: ["A2"] }, { unknown: ["A1"] }, {}]);
  try { await f.deliver(); const out = await f.deliver({ fullCheck: true }); assert.equal(out.kind, "paused"); if (out.kind === "paused") assert.match(out.notes!, /A1：.*标准写得含糊/); assert.equal(f.latest().items[0].verdict, "无法验证"); await f.deliver(); assert.deepEqual(f.calls().map((c) => c.ids), [IDS, IDS, ["A1"]]); } finally { f.close(); }
});
test("定向复验仍无法验证时暂停，不多执行任何完整验收", async () => {
  const f = fixture([{ fail: ["A2", "A4"] }, { unknown: ["A2"] }]);
  try { await f.deliver(); const out = await f.deliver(); assert.equal(out.kind, "paused"); if (out.kind === "paused") assert.match(out.reason, /定向复验.*A2/); assert.deepEqual(f.calls().map((c) => c.ids), [IDS, ["A2", "A4"]]); } finally { f.close(); }
});
test("人工与不授权项保留为需人工，精确复验成功不变成自动通过", async (t) => {
  for (const kind of ["人工", "授权"]) await t.test(kind, async () => {
    const f = fixture([{ fail: ["A2"] }, {}]);
    try { f.deps.state.criteria!.items[4].text = `[${kind}] 操作：查看布局\n预期：符合偏好`; if (kind === "授权") f.deps.state.grants = { version: 1, approved: [], denied: ["A5"] }; await f.deliver(); await f.deliver(); assert.equal(f.latest().verdict, "部分验证"); assert.equal(f.latest().items[4].verdict, "需人工"); assert.deepEqual(f.calls().map((c) => c.ids), [IDS.slice(0, 4), ["A2"]]); } finally { f.close(); }
  });
});
test("缺少历史范围身份则完整验收，不推定旧结果可复用", async () => {
  const f = fixture([{ fail: ["A2"] }, {}]);
  try { await f.deliver(); delete f.latest().scope; await f.deliver(); assert.deepEqual(f.calls().map((c) => c.ids), [IDS, IDS]); } finally { f.close(); }
});
test("定向后不为未安排的 full 预留预算；只有本次执行和收尾", async () => {
  const f = fixture([{ fail: ["A2"] }, {}]);
  try { await f.deliver(); let clock = Date.now(); const base = f.deps.exec; const out = await f.deliver({ now: () => clock, deadline: clock + 300_000, exec: async (cmd, args, options) => { const r = await base(cmd, args, options); if (options.role === "验收方") clock += 270_000; return r; } }); assert.equal(out.kind, "judged"); assert.equal(f.latest().verdict, "通过"); assert.deepEqual(f.calls().map((c) => c.ids), [IDS, ["A2"]]); } finally { f.close(); }
});
test("报告沿用项引用原证据，不将定向来源说成待补 full", async () => {
  const f = fixture([{ fail: ["A2", "A4"] }, {}]);
  try { await f.deliver(); await f.deliver(); const record = f.latest(); const report = renderDeliveryReport({ cwd: f.repo, devSessionId: "developer", reviewerSessionId: "reviewer", status: "完成", rounds: [{ round: 2, startedAt: "now", durationMs: 1, conclusion: "通过", mustFixRaw: "无", mustFix: [], minor: [], questions: [], recheck: [], acceptance: record }], repairs: 0, criteria: f.deps.state.criteria, gitStatusShort: "" }); const a1 = report.split("### A1\n")[1].split("### A2\n")[0]; assert.ok(a1.includes(`${record.items[0].source!.runDir}/evidence/A1.txt`)); assert.ok(!a1.includes(`${record.runDir}/evidence/A1.txt`)); assert.match(a1, /第 1 轮完整验收/); assert.doesNotMatch(report, /尚非最终完整验收/); } finally { f.close(); }
});

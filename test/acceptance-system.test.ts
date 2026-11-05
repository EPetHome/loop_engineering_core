/** acceptance／system：按功能独立运行，夹具与状态不跨测试进程共享。 */
/** 自动验收：纯函数（取标准、解析、判定、消息）与一轮验收流程（真起被测系统）；产物只写 os.tmpdir()。 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { grantsFromUser, renderAcceptanceLines, type AcceptanceRecord, type Criteria } from "../acceptance-core.ts";
import { runAcceptanceStage } from "../acceptance.ts";
import { parseAcceptanceConfig } from "../config.ts";
import { blockerHint } from "../onboarding.ts";
import { readProcs } from "../procs.ts";
import { harness, portOpen } from "./helpers/acceptance-fixture.ts";

test("A7 真起被测系统：就绪、带时间戳记日志、扫到 ERROR 判 G2 不通过、结束后关停并清登记", async () => {
  const h = await harness(
    { start: "node server.mjs {port}", readyUrl: "http://127.0.0.1:{port}/health" },
    { FAKE_ACC_URL: "http://127.0.0.1:{port}/boom" },
  );
  try {
    const stage = await runAcceptanceStage(h.deps());
    assert.equal(stage.kind, "judged");
    if (stage.kind !== "judged") return;
    const { record } = stage;
    assert.deepEqual(record.items.map((item) => [item.id, item.verdict]), [["A1", "通过"], ["A2", "通过"], ["G2", "不通过"]]);
    assert.equal(record.verdict, "不通过");
    assert.match(record.logErrors[0], /\[stderr\] ERROR boom at \/boom/);
    const log = readFileSync(join(record.runDir, "system.log"), "utf8");
    assert.match(log, /^\[\d{2}:\d{2}:\d{2}\.\d{3}\] Listening on/m);
    assert.match(readFileSync(join(record.runDir, "evidence", "A1.txt"), "utf8"), /^=== A1 #1 /m);
    assert.equal(h.state.criteria?.source, "用户", "需求里的标准被采用并冻结");
    assert.equal(await portOpen(h.port), false, "被测系统已关停");
    assert.deepEqual(readProcs(h.procsFile), [], "登记已清空");
    assert.deepEqual(record.extra, ["首页标题有错别字"]);
  } finally { h.close(); }
});

test("A8 端口已被占用：暂停（环境问题），不启动、不调验收方", async () => {
  const h = await harness({ start: "node server.mjs {port}", readyUrl: "http://127.0.0.1:{port}/health" });
  const { spawn } = await import("node:child_process");
  const squatter = spawn(process.execPath, [join(h.work, "server.mjs"), String(h.port)], { stdio: "ignore" });
  try {
    for (let i = 0; i < 50 && !await portOpen(h.port); i += 1) await new Promise((r) => setTimeout(r, 100));
    const stage = await runAcceptanceStage(h.deps());
    assert.equal(stage.kind, "paused");
    if (stage.kind === "paused") assert.match(stage.reason, /端口 \d+ 已被占用（环境问题/);
    assert.deepEqual(h.calls(), []);
  } finally { squatter.kill("SIGKILL"); h.close(); }
});

test("A9 系统起不来：G1 不通过，附系统输出，不调验收方", async () => {
  const h = await harness({ start: "echo 配置缺失 >&2; exit 3", readyUrl: "http://127.0.0.1:{port}/health" });
  try {
    const stage = await runAcceptanceStage(h.deps());
    assert.equal(stage.kind, "judged");
    if (stage.kind !== "judged") return;
    assert.equal(stage.record.verdict, "不通过");
    assert.equal(stage.record.items[0].id, "G1");
    assert.match(stage.record.items[0].detail, /系统启动后就退出了（退出码 3）[\s\S]*配置缺失/);
    assert.deepEqual(h.calls(), []);
  } finally { h.close(); }
});

test("A12 开发方对标准提异议：直接暂停交给用户，不跑验收；同一段旧回复不再重复暂停", async () => {
  const h = await harness({});
  try {
    const note = "A1：已修\nA2：异议：标准和需求矛盾\n【交付完成】";
    const stage = await runAcceptanceStage(h.deps({ deliveryNote: note }));
    assert.equal(stage.kind, "paused");
    if (stage.kind === "paused") assert.equal(stage.reason, "开发方对验收标准有异议（A2）");
    assert.deepEqual(h.calls(), []);
    // 用户决定后开发方没再提异议：同一条旧回复再次走到验收不重复暂停，照常验收。
    const again = await runAcceptanceStage(h.deps({ deliveryNote: note, runDir: join(h.root, "acc", "r2") }));
    assert.equal(again.kind, "judged");
    assert.ok(h.calls().length > 0);
    // 换一条新回复再提异议：还没处理过，照旧暂停。
    const next = await runAcceptanceStage(h.deps({ deliveryNote: "A1：已修\nA2：异议：另一个理由\n【交付完成】", runDir: join(h.root, "acc", "r3") }));
    assert.equal(next.kind, "paused");
  } finally { h.close(); }
});

test("A12b 方法存疑不暂停：照常验收、G2 失败照常判、理由进验收方输入和总结", async () => {
  const h = await harness(
    { start: "node server.mjs {port}", readyUrl: "http://127.0.0.1:{port}/health" },
    { FAKE_ACC_URL: "http://127.0.0.1:{port}/boom" },
  );
  try {
    const note = "A1：已修\nG2：方法存疑：日志是故意的\n【交付完成】";
    const stage = await runAcceptanceStage(h.deps({ deliveryNote: note }));
    assert.equal(stage.kind, "judged");
    if (stage.kind !== "judged") return;
    assert.equal(stage.record.verdict, "不通过", "存疑不等于通过");
    assert.equal(stage.record.items.find((item) => item.id === "G2")?.verdict, "不通过");
    assert.deepEqual(stage.record.methodDoubts, [{ id: "G2", reason: "日志是故意的" }]);
    const input = readFileSync(join(stage.record.runDir, "input.md"), "utf8");
    assert.match(input, /## 开发方对验收方法的存疑（照常实测）\n\n- G2：日志是故意的/);
    assert.match(renderAcceptanceLines(stage.record).join("\n"), /验收方法存疑（照常验收，不作为通过依据）：G2：日志是故意的/);
  } finally { h.close(); }
});

test("A20 验收方关掉被测系统：立即停掉验收方、不换强模型重验，判无法验收而不是打回开发方", async () => {
  const h = await harness(
    { start: "node server.mjs {port}", readyUrl: "http://127.0.0.1:{port}/health" },
    { FAKE_ACC_MODE: "kill" },
  );
  try {
    const stage = await runAcceptanceStage(h.deps());
    assert.equal(stage.kind, "judged");
    if (stage.kind !== "judged") return;
    const { record } = stage;
    assert.equal(record.verdict, "无法验收");
    assert.equal(record.blocker, "系统被关掉");
    assert.deepEqual(record.items.filter((item) => item.verdict === "不通过"), [], "没有任何一条算到开发方头上");
    const g1 = record.items.find((item) => item.id === "G1")!;
    assert.equal(g1.verdict, "无法验证");
    assert.match(g1.detail, /被关掉了（退出码 (143|SIGTERM)），多半是验收方/);
    assert.equal(h.calls().length, 1, "系统没了就不再重做、不换强模型");
    assert.equal(await portOpen(h.port), false);
    const hint = blockerHint(record as AcceptanceRecord, h.work, h.config);
    assert.match(hint, /不是开发方的问题/);
    assert.match(hint, /acceptance\.reset/);
  } finally { h.close(); }
});

test("A21 验收方关掉后用 setsid 重启服务占着端口：收尾时清掉，并写进记录", async () => {
  const h = await harness(
    { start: "node server.mjs {port}", readyUrl: "http://127.0.0.1:{port}/health" },
    { FAKE_ACC_MODE: "kill-restart", FAKE_ACC_URL: "http://127.0.0.1:{port}/health" },
  );
  try {
    const stage = await runAcceptanceStage(h.deps());
    assert.equal(stage.kind, "judged");
    if (stage.kind !== "judged") return;
    assert.equal(stage.record.blocker, "系统被关掉");
    const restarted = Number(readFileSync(join(stage.record.runDir, "restarted.pid"), "utf8"));
    const state = spawnSync("ps", ["-p", String(restarted), "-o", "stat="], { encoding: "utf8" });
    assert.ok(state.status !== 0 || state.stdout.trim().startsWith("Z"), "独立重启进程已被执行器提前清理，不能只检查端口");
    assert.match((stage.record.cleanup ?? []).join("\n"), /验收方调用及工具子进程已按归属确认停止（含独立进程组）/);
    assert.equal(await portOpen(h.port), false, "逃出进程组的重启进程也被清掉");
  } finally { h.close(); }
});

test("A22 系统自己崩溃（非 0 退出、日志有错误）：仍算 G1 不通过，打回开发方", async () => {
  const h = await harness(
    { start: "node server.mjs {port}", readyUrl: "http://127.0.0.1:{port}/health" },
    { FAKE_ACC_URL: "http://127.0.0.1:{port}/crash" },
  );
  try {
    const stage = await runAcceptanceStage(h.deps());
    assert.equal(stage.kind, "judged");
    if (stage.kind !== "judged") return;
    assert.equal(stage.record.verdict, "不通过");
    const g1 = stage.record.items.find((item) => item.id === "G1")!;
    assert.equal(g1.verdict, "不通过");
    assert.match(g1.detail, /系统在验收过程中退出了（退出码 1）/);
    assert.equal(stage.record.items.find((item) => item.id === "G2")?.verdict, "不通过");
  } finally { h.close(); }
});

test("A24 reset 失败：暂停（环境问题），不调验收方，被测系统照样关停", async () => {
  const h = await harness({
    start: "node server.mjs {port}", readyUrl: "http://127.0.0.1:{port}/health", reset: "echo 测试库连不上 >&2; exit 2",
  });
  try {
    const stage = await runAcceptanceStage(h.deps());
    assert.equal(stage.kind, "paused");
    if (stage.kind !== "paused") return;
    assert.match(stage.reason, /验收前重置数据失败（环境问题/);
    assert.match(stage.notes ?? "", /退出码 2：测试库连不上/);
    assert.match(stage.hint, /acceptance\.reset[\s\S]*reset\.log/);
    assert.deepEqual(h.calls(), []);
    assert.equal(await portOpen(h.port), false);
  } finally { h.close(); }
});

test("A25 没配 reset、验收方报「数据不是初始状态」：无法验收并提示配 reset；配了仍不干净就提示检查重置命令", async () => {
  const h = await harness({}, { FAKE_ACC_MODE: "dirty" });
  try {
    const stage = await runAcceptanceStage(h.deps());
    assert.equal(stage.kind, "judged");
    if (stage.kind !== "judged") return;
    assert.equal(stage.record.verdict, "无法验收");
    assert.equal(stage.record.blocker, "数据不干净");
    assert.match(readFileSync(join(stage.record.runDir, "input.md"), "utf8"), /程序没有配置数据重置[\s\S]*数据不是初始状态/);
    assert.match(blockerHint(stage.record, h.work, h.config), /没有配置 acceptance\.reset[\s\S]*可选配置：被测系统怎么启动/);
    const withReset = parseAcceptanceConfig({ reset: "true" }, h.work, process.env)!;
    assert.match(blockerHint(stage.record, h.work, withReset), /没能把数据恢复到初始状态/);
  } finally { h.close(); }
});

test("A29 一轮验收：[人工] 条目不出现在验收方输入里；标准全是 [人工] 时不启动系统、不调验收方", async () => {
  const h = await harness({ start: "node server.mjs {port}", readyUrl: "http://127.0.0.1:{port}/health" }, { FAKE_ACC_URL: "http://127.0.0.1:{port}/" });
  try {
    h.state.requirement = "做待办\n## 验收标准\n1. 操作：GET /\n   预期：返回买菜\n2. [人工] 操作：在桌面客户端里看同步状态\n   预期：显示已同步";
    const mixed = await runAcceptanceStage(h.deps());
    assert.equal(mixed.kind, "judged");
    if (mixed.kind !== "judged") return;
    assert.equal(mixed.record.verdict, "部分验证");
    assert.deepEqual(mixed.record.items.map((item) => [item.id, item.verdict]), [["A1", "通过"], ["A2", "需人工"]]);
    const input = readFileSync(join(mixed.record.runDir, "input.md"), "utf8");
    assert.ok(input.includes("A1. 操作：GET /") && !input.includes("桌面客户端"), "验收方看不到 [人工] 条目");
    assert.equal(h.calls().length, 1);

    h.state.criteria = undefined;
    h.state.requirement = "做待办\n## 验收标准\n1. 【人工】操作：在桌面客户端里看同步状态\n   预期：显示已同步";
    const manualOnly = await runAcceptanceStage(h.deps({ config: { ...h.config, start: "exit 1" }, round: 2, runDir: join(h.root, "acc", "r2") }));
    assert.equal(manualOnly.kind, "judged");
    if (manualOnly.kind !== "judged") return;
    assert.equal(manualOnly.record.verdict, "部分验证", "系统起不来也不影响：根本没启动");
    assert.deepEqual(manualOnly.record.items.map((item) => item.verdict), ["需人工"]);
    assert.equal(h.calls().length, 1, "没有调验收方");
    assert.ok(existsSync(join(manualOnly.record.runDir, "result.json")));
  } finally { h.close(); }
});

test("A31 一轮验收：[授权] 没答复先停下问你；同意了照常交给验收方；不授权留给你", async () => {
  const h = await harness({});
  try {
    h.state.requirement = "做同步\n## 验收标准\n1. 操作：本地同步\n   预期：ok\n2. [授权] 操作：用正式账号同步\n   预期：多一行";
    const waiting = await runAcceptanceStage(h.deps());
    assert.equal(waiting.kind, "paused");
    if (waiting.kind !== "paused") return;
    assert.equal(waiting.reason, "等你授权（A2）");
    assert.match(waiting.hint!, /同意就回复「同意授权：A2」/);
    assert.equal(h.calls().length, 0, "没答复前验收方不动手");

    const state = h.state as { grants?: unknown; criteria?: Criteria };
    state.grants = grantsFromUser("同意授权：A2", state.criteria);
    const approved = await runAcceptanceStage(h.deps());
    assert.equal(approved.kind, "judged");
    if (approved.kind !== "judged") return;
    assert.equal(approved.record.verdict, "通过");
    assert.match(readFileSync(join(approved.record.runDir, "input.md"), "utf8"), /A2\. \[授权\] 操作：用正式账号同步[\s\S]*## 用户授权/);

    state.grants = grantsFromUser("不授权：A2", state.criteria, state.grants as never);
    const denied = await runAcceptanceStage(h.deps({ round: 2, runDir: join(h.root, "acc", "r2") }));
    assert.equal(denied.kind, "judged");
    if (denied.kind !== "judged") return;
    assert.deepEqual(denied.record.items.map((item) => [item.id, item.verdict]), [["A1", "通过"], ["A2", "需人工"]]);
    assert.ok(!readFileSync(join(denied.record.runDir, "input.md"), "utf8").includes("正式账号"));
  } finally { h.close(); }
});

test("项目方法三个环境变量：启动、重置、验收命令都拿到同一份", async () => {
  const envLog = (name: string) => `printf '%s|%s|%s\\n' "$AUTOREVIEW_BASE_REV" "$AUTOREVIEW_BATCH_FILE" "$AUTOREVIEW_STAGE" >> "$AUTOREVIEW_RUN_DIR/../${name}"`;
  const testerLog = join(tmpdir(), `autoreview-tester-env-${process.pid}-${Date.now()}.log`);
  const h = await harness({
    start: `${envLog("start.env")}; exec node server.mjs {port}`,
    readyUrl: "http://127.0.0.1:{port}/health",
    reset: envLog("reset.env"),
  }, { FAKE_ACC_ENV_LOG: testerLog });
  try {
    const env = { AUTOREVIEW_BASE_REV: "base-rev", AUTOREVIEW_BATCH_FILE: "/tmp/批次.json", AUTOREVIEW_STAGE: "甲" };
    const stage = await runAcceptanceStage(h.deps({ env }));
    assert.equal(stage.kind, "judged", JSON.stringify(stage));
    const expected = "base-rev|/tmp/批次.json|甲";
    for (const file of ["start.env", "reset.env"]) {
      assert.equal(readFileSync(join(h.root, "acc", file), "utf8").trim(), expected, file);
    }
    assert.equal(readFileSync(testerLog, "utf8").trim(), expected, "验收命令");
  } finally {
    rmSync(testerLog, { force: true });
    h.close();
  }
});

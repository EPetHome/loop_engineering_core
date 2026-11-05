/** 单一配置入口：临时项目、只读加载；不依赖本机配置或真实模型。 */
import "./test-env.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureProjectConfigOverrides, resolveProjectConfig, projectConfigArgs, projectConfigOverridesFromArgs, loadAcceptanceConfig, loadGateConfig } from "../config.ts";
import { loadConfig } from "../hosts/review-hook.ts";
import { loadPreparation } from "../preparation.ts";
import { loadContext } from "../project-context.ts";
import { methodsComponents } from "../methods.ts";
import { planSetup } from "../setup-acceptance.ts";

const fullConfig = {
  maxRepairs: 2, reviewerModel: "file/model", reviewerThinking: "high", reviewTimeoutMin: 90, reviewerCmd: "/file/reviewer",
  gate: { cmd: "true", timeoutMin: 20 }, acceptance: { timeoutMin: 60 },
  preparation: { check: "true", timeoutMin: 3, maxRecoveries: 2, maxRepairs: 0 },
  methods: { paths: ["methods"], selfCheck: "true", probe: "true" },
  context: { sources: [{ id: "need", path: "need.md", role: "requirement" }], maxChars: 4000, intervalSec: 30 },
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "loop-config-"));
  mkdirSync(join(root, "methods"));
  writeFileSync(join(root, "need.md"), "需求\n");
  const write = (data: unknown) => writeFileSync(join(root, ".autoreview.json"), JSON.stringify(data));
  return { root, write, close: () => rmSync(root, { recursive: true, force: true }) };
}

test("统一配置：完整文件、不传参数时所有字段及兼容读取入口一致", () => {
  const f = fixture();
  try {
    f.write(fullConfig);
    const config = resolveProjectConfig(f.root, { env: {} });
    assert.equal(config.maxRepairs, 2); assert.equal(config.reviewerModel, "file/model");
    assert.equal(config.reviewerThinking, "high"); assert.equal(config.reviewerCmd, "/file/reviewer");
    assert.equal(config.reviewTimeoutMin, 90);
    assert.deepEqual(config.effectiveConfig.reviewTimeoutMin, { value: 90, source: "file" });
    assert.deepEqual(loadConfig(f.root, {}).acceptance, config.acceptance);
    assert.deepEqual(loadAcceptanceConfig(f.root, {}), config.acceptance);
    assert.deepEqual(loadGateConfig(f.root), config.gate);
    assert.deepEqual(loadPreparation(f.root), config.preparation);
    assert.deepEqual(loadContext(f.root), config.context);
    assert.deepEqual(config.methods, fullConfig.methods);
    assert.equal(methodsComponents(f.root, f.root, { dryRun: true }).files.length, 0);
    assert.equal(config.acceptance?.root, f.root);
    f.write({ ...fullConfig, reviewTimeoutMin: 100 });
    assert.equal(resolveProjectConfig(f.root, { env: {} }).reviewTimeoutMin, 100, "不缓存旧文件");
  } finally { f.close(); }
});

test("统一优先级：显式默认值也算 flag；flag > env > file > default", () => {
  const f = fixture();
  try {
    f.write({ maxRepairs: 2, reviewerModel: "file/model", reviewerThinking: "high", reviewTimeoutMin: 90, reviewerCmd: "/file" });
    const env = { AUTOREVIEW_REVIEW_TIMEOUT_MIN: "110", AUTOREVIEW_REVIEWER_CMD: "/env" };
    const config = resolveProjectConfig(f.root, { env, reviewTimeoutMin: "120", maxRepairs: "0", reviewerModel: "flag/model", reviewerThinking: "low", reviewerCmd: "/flag" });
    assert.deepEqual(config.effectiveConfig.reviewTimeoutMin, { value: 120, source: "flag" });
    assert.equal(config.maxRepairs, 0); assert.equal(config.reviewerModel, "flag/model");
    assert.equal(config.reviewerThinking, "low"); assert.equal(config.reviewerCmd, "/flag");
    assert.deepEqual(resolveProjectConfig(f.root, { env, reviewTimeoutMin: "60" }).effectiveConfig.reviewTimeoutMin, { value: 60, source: "flag" });
    assert.deepEqual(resolveProjectConfig(f.root, { env }).effectiveConfig.reviewTimeoutMin, { value: 110, source: "env" });
    assert.equal(resolveProjectConfig(f.root, { env }).reviewerCmd, "/env");
    assert.deepEqual(resolveProjectConfig(f.root, { env: {}, reviewTimeoutMin: "" }).effectiveConfig.reviewTimeoutMin, { value: 90, source: "file" });
    f.write({});
    const defaults = resolveProjectConfig(f.root, { env: {} });
    assert.deepEqual(defaults.effectiveConfig.reviewTimeoutMin, { value: 60, source: "default" });
    assert.equal(defaults.maxRepairs, 4); assert.equal(defaults.reviewerModel, "openai-codex/gpt-6-astra");
    assert.equal(defaults.reviewerThinking, "xhigh"); assert.equal(defaults.reviewerCmd, "");
  } finally { f.close(); }
});

test("启动参数提取：只认评审参数，保留空默认和等号命令，最后一个 flag 生效", () => {
  assert.deepEqual(projectConfigOverridesFromArgs(["--model", "developer/model", "--autoreview-review-timeout-min", "60", "--autoreview-review-timeout-min=120", "--autoreview-reviewer-cmd=echo a=b"]),
    { reviewTimeoutMin: "120", reviewerCmd: "echo a=b" });
  assert.throws(() => projectConfigOverridesFromArgs(["--autoreview-review-timeout-min"]), /需要一个值/);
});

test("恢复参数只重放原始 flag，不提升环境优先级，空值可覆盖启动模板的旧 flag", () => {
  const f = fixture();
  try {
    f.write({ reviewTimeoutMin: 90 });
    for (const explicit of [false, true]) {
      const captured = captureProjectConfigOverrides(explicit ? { reviewTimeoutMin: "150", maxRepairs: 0, reviewerModel: "chosen/model", reviewerThinking: "high", reviewerCmd: "/fake/reviewer's command" } : {}, { AUTOREVIEW_REVIEW_TIMEOUT_MIN: "120" });
      const restored = { ...projectConfigOverridesFromArgs(["--autoreview-review-timeout-min", "180", ...projectConfigArgs(captured)]), env: captured.env };
      assert.deepEqual(resolveProjectConfig(f.root, restored), resolveProjectConfig(f.root, captured));
    }
  } finally { f.close(); }
});

test("覆盖快照只保留配置环境；下游方法和来源读取继续校验同一份预算", () => {
  const f = fixture();
  try {
    f.write({ gate: fullConfig.gate, acceptance: fullConfig.acceptance, methods: fullConfig.methods });
    const overrides = captureProjectConfigOverrides({ reviewTimeoutMin: "120", reviewerModel: "flag/model" }, {
      AUTOREVIEW_REVIEW_TIMEOUT_MIN: "100", AUTOREVIEW_REVIEWER_CMD: "/env/reviewer", HOME: "/private", SECRET_TOKEN: "secret",
    });
    assert.deepEqual(overrides.env, { AUTOREVIEW_REVIEW_TIMEOUT_MIN: "100", AUTOREVIEW_REVIEWER_CMD: "/env/reviewer" });
    const copied = JSON.parse(JSON.stringify(overrides));
    assert.deepEqual(resolveProjectConfig(f.root, copied).effectiveConfig.reviewTimeoutMin, { value: 120, source: "flag" });
    assert.equal(methodsComponents(f.root, f.root, { dryRun: true, overrides: copied }).files.length, 0);
    assert.throws(() => methodsComponents(f.root, f.root, { dryRun: true, env: {} }), /必须小于一轮总预算/);
    assert.equal(loadContext(f.root, copied), undefined);
    assert.equal(loadGateConfig(f.root, copied)?.timeoutMin, 20);
  } finally { f.close(); }
});

test("统一校验：预算文案不变，所有配置节提前报错，显式覆盖可补足预算", () => {
  const f = fixture();
  try {
    f.write({ gate: fullConfig.gate, acceptance: fullConfig.acceptance });
    const message = ".autoreview.json 的 acceptance.timeoutMin（60）必须小于一轮总预算 reviewTimeoutMin（60）";
    assert.throws(() => resolveProjectConfig(f.root, { env: {} }), { message });
    assert.throws(() => loadConfig(f.root, {}), { message });
    assert.equal(resolveProjectConfig(f.root, { env: {}, reviewTimeoutMin: "120" }).reviewTimeoutMin, 120);
    assert.equal(loadContext(f.root, { reviewTimeoutMin: "120" }), undefined);
    for (const section of ["methods", "context", "preparation", "gate", "acceptance"]) {
      f.write({ [section]: null });
      assert.throws(() => resolveProjectConfig(f.root, { env: {} }), new RegExp(section));
    }
    f.write({ maxRepairs: -1 });
    assert.throws(() => resolveProjectConfig(f.root, { env: {} }), /maxRepairs/);
    f.write({});
    assert.throws(() => resolveProjectConfig(f.root, { reviewTimeoutMin: "invalid", env: {} }), /autoreview-review-timeout-min/);
  } finally { f.close(); }
});

test("接入：已有和待写配置都复用预算校验，保留其他字段且只做预览", async () => {
  const f = fixture();
  try {
    f.write(fullConfig);
    const plan = await planSetup(f.root);
    assert.equal(plan.config, undefined);
    f.write({ reviewTimeoutMin: 10, acceptance: { timeoutMin: 20 } });
    await assert.rejects(planSetup(f.root), /acceptance.timeoutMin（20）必须小于/);
    f.write({ gate: { cmd: "true", timeoutMin: 45 }, custom: "keep" });
    await assert.rejects(planSetup(f.root), /gate.timeoutMin（45）加 acceptance.timeoutMin（20）必须小于/);
    f.write({ reviewTimeoutMin: 90, custom: "keep" });
    const before = readFileSync(join(f.root, ".autoreview.json"), "utf8");
    const next = await planSetup(f.root);
    assert.equal(JSON.parse(next.config!).custom, "keep");
    assert.equal(readFileSync(join(f.root, ".autoreview.json"), "utf8"), before, "预览保留磁盘配置的完整原文");
    assert.equal(resolveProjectConfig(f.root).acceptance, undefined, "预览不落盘");
  } finally { f.close(); }
});

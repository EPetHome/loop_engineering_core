/** review.ts 单测：评审时间预算（首次调用加 1 次重试共用同一份 60 分钟预算）；门禁（gate）一步。 */
import "./test-env.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkRoundBudget, parseAcceptanceConfig, parseGateConfig } from "../config.ts";
import type { Exec, ExecResult } from "../git.ts";
import { loadContext, refreshContext } from "../project-context.ts";
import { newReviewState, runReviewRound, type ReviewConfig, type ReviewDeps } from "../review.ts";
import { classifyFailure } from "../failure.ts";
import preparationGuard, { mayPrepareWrite } from "../preparation-guard.ts";

const PASS = "## 结论：通过\n## 必修\n无\n## 小问题\n- 无\n## 需求疑问\n- 无\n## 上轮必修复查\n- 无\n";

test("失败归因：资源错误不因连带断言变成产品缺陷，未知不猜，脚本可明确声明", () => {
  assert.equal(classifyFailure(1, "AssertionError\nOSError: [Errno 28] No space left on device").kind, "environment");
  assert.equal(classifyFailure(1, "mc: Storage backend has reached its minimum free drive threshold").kind, "environment");
  assert.equal(classifyFailure(78, "准备脚本失效").kind, "method");
  assert.equal(classifyFailure(1, "not ok 1 - add").kind, "product");
  assert.equal(classifyFailure(1, "opaque error").kind, "unknown");
  assert.equal(classifyFailure(1, "AUTOREVIEW_FAILURE=product missing business file").kind, "product");
});

function harness() {
  const root = mkdtempSync(join(tmpdir(), "autoreview-budget-"));
  const previousResources = process.env.AUTOREVIEW_RESOURCE_ROOT;
  process.env.AUTOREVIEW_RESOURCE_ROOT = join(root, "resources");
  const previousProjects = process.env.AUTOREVIEW_PROJECTS_ROOT;
  process.env.AUTOREVIEW_PROJECTS_ROOT = join(root, "projects");
  const repo = join(root, "repo");
  mkdirSync(repo);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  const git = (...args: string[]): string => {
    const res = spawnSync("git", args, { cwd: repo, env, encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    return res.stdout.trim();
  };
  git("init", "-q"); git("config", "user.email", "budget@example.com"); git("config", "user.name", "budget");
  writeFileSync(join(repo, "file.txt"), "base\n");
  git("add", "file.txt"); git("commit", "-qm", "baseline");
  const exec: Exec = async (command, args, options): Promise<ExecResult> => {
    const res = spawnSync(command, args, { cwd: options.cwd, env: { ...env, ...(options.env ?? {}) }, encoding: "utf8" });
    return { stdout: res.stdout || "", stderr: res.stderr || "", code: res.status ?? 1, killed: Boolean(res.signal) };
  };
  const config: ReviewConfig = {
    maxRepairs: 3, reviewerModel: "m", reviewerThinking: "xhigh", reviewTimeoutMin: 60, reviewerCmd: "",
  };
  return { root, repo, git, exec, config, close: () => {
    if (previousResources === undefined) delete process.env.AUTOREVIEW_RESOURCE_ROOT;
    else process.env.AUTOREVIEW_RESOURCE_ROOT = previousResources;
    if (previousProjects === undefined) delete process.env.AUTOREVIEW_PROJECTS_ROOT;
    else process.env.AUTOREVIEW_PROJECTS_ROOT = previousProjects;
    rmSync(root, { recursive: true, force: true });
  } };
}

test("评审预算：首次用掉 59.5 分钟后不再重试，暂停原因「评审超时」", async () => {
  const h = harness();
  try {
    const calls: number[] = [];
    let now = 1_000_000;
    const outcome = await runReviewRound({
      cwd: h.repo, devSessionId: "budget-1", round: 1, deliveryNote: "x",
      state: newReviewState(), config: h.config, exec: h.exec, now: () => now,
      writeInput: (name) => join(h.root, name), saveState: () => {},
      callReviewer: async (_session, _round, timeoutMs) => {
        calls.push(timeoutMs);
        now += 59.5 * 60_000;
        return { stdout: "", stderr: "timeout", code: 1, killed: true };
      },
    });
    assert.equal(calls.length, 1, "剩余不足 1 分钟，不再重试");
    assert.equal(calls[0], 60 * 60_000);
    assert.equal(outcome.kind, "paused");
    assert.equal(outcome.reason, "评审超时");
  } finally { h.close(); }
});

test("评审预算：首次失败后重试只用剩余时间", async () => {
  const h = harness();
  try {
    const calls: number[] = [];
    let now = 1_000_000;
    const outcome = await runReviewRound({
      cwd: h.repo, devSessionId: "budget-2", round: 1, deliveryNote: "x",
      state: newReviewState(), config: h.config, exec: h.exec, now: () => now,
      writeInput: (name) => join(h.root, name), saveState: () => {},
      callReviewer: async (_session, _round, timeoutMs) => {
        calls.push(timeoutMs);
        if (calls.length === 1) {
          now += 30 * 60_000;
          return { stdout: "", stderr: "boom", code: 1, killed: false };
        }
        return { stdout: PASS, stderr: "", code: 0, killed: false };
      },
    });
    assert.deepEqual(calls, [60 * 60_000, 30 * 60_000]);
    assert.equal(outcome.kind, "done");
  } finally { h.close(); }
});

test("评审预算：首次超时但剩余充足时仍可重试成功", async () => {
  const h = harness();
  try {
    const calls: number[] = [];
    let now = 1_000_000;
    const outcome = await runReviewRound({
      cwd: h.repo, devSessionId: "budget-3", round: 1, deliveryNote: "x",
      state: newReviewState(), config: h.config, exec: h.exec, now: () => now,
      writeInput: (name) => join(h.root, name), saveState: () => {},
      callReviewer: async (_session, _round, timeoutMs) => {
        calls.push(timeoutMs);
        if (calls.length === 1) {
          now += 5 * 60_000;
          return { stdout: "", stderr: "timeout", code: 1, killed: true };
        }
        return { stdout: PASS, stderr: "", code: 0, killed: false };
      },
    });
    assert.deepEqual(calls, [60 * 60_000, 55 * 60_000]);
    assert.equal(outcome.kind, "done");
  } finally { h.close(); }
});

test("门禁配置：默认 10 分钟；非法字段报错；门禁加验收必须给评审留时间", () => {
  assert.equal(parseGateConfig(undefined), undefined);
  assert.deepEqual(parseGateConfig({ cmd: " npm test " }), { cmd: "npm test", timeoutMin: 10 });
  assert.deepEqual(parseGateConfig({ cmd: "make check", timeoutMin: 3 }), { cmd: "make check", timeoutMin: 3 });
  assert.throws(() => parseGateConfig("npm test"), /gate 必须是 JSON 对象/);
  assert.throws(() => parseGateConfig({}), /gate\.cmd 必须写/);
  assert.throws(() => parseGateConfig({ cmd: " " }), /gate\.cmd 必须是非空字符串/);
  assert.throws(() => parseGateConfig({ cmd: "x", timeoutMin: 0 }), /gate\.timeoutMin 必须大于 0/);
  assert.throws(() => parseGateConfig({ cmd: "x", timeoutMin: 1.5 }), /gate\.timeoutMin 必须是非负整数/);
  const acceptance = parseAcceptanceConfig({}, "/p", {})!;
  assert.throws(() => checkRoundBudget(10, undefined, { cmd: "x", timeoutMin: 10 }), /gate\.timeoutMin（10）必须小于一轮总预算 reviewTimeoutMin（10）/);
  assert.throws(() => checkRoundBudget(30, acceptance, { cmd: "x", timeoutMin: 10 }), /gate\.timeoutMin（10）加 acceptance\.timeoutMin（20）必须小于/);
  checkRoundBudget(60, acceptance, { cmd: "x", timeoutMin: 10 });
  checkRoundBudget(60, undefined, undefined);
});

/** 跑一轮带门禁的评审：记下门禁调用和评审输入；writeInput 真写文件。 */
async function gateRound(
  h: ReturnType<typeof harness>, cmd: string,
  options: { state?: ReturnType<typeof newReviewState>; exec?: Exec; now?: () => number; reviewer?: ReviewDeps["callReviewer"] } = {},
) {
  const state = options.state ?? newReviewState();
  const gateCalls: { args: string[]; cwd: string; timeout: number; role?: string }[] = [];
  const reviewInputs: string[] = [];
  const base = options.exec ?? h.exec;
  const exec: Exec = async (command, args, execOptions) => {
    if (command === "/bin/sh") gateCalls.push({ args, cwd: execOptions.cwd, timeout: execOptions.timeout, role: execOptions.role });
    return base(command, args, execOptions);
  };
  const outcome = await runReviewRound({
    cwd: h.repo, devSessionId: "gate", round: state.rounds.length + 1, deliveryNote: "做完了",
    state, config: { ...h.config, gate: { cmd, timeoutMin: 10 } }, exec, now: options.now,
    writeInput: (name, text) => { const file = join(h.root, name); writeFileSync(file, text); return file; },
    saveState: () => {},
    callReviewer: options.reviewer ?? (async (_session, _round, _timeout, inputPath) => {
      reviewInputs.push(readFileSync(inputPath, "utf8"));
      return { stdout: PASS, stderr: "", code: 0, killed: false };
    }),
  });
  return { outcome, state, gateCalls, reviewInputs };
}

test("门禁通过：先跑门禁再评审，评审输入写明门禁已通过，本轮记下门禁结果", async () => {
  const h = harness();
  try {
    writeFileSync(join(h.repo, "file.txt"), "base\nchange\n");
    const run = await gateRound(h, "echo GATE_OK");
    assert.equal(run.outcome.kind, "done");
    assert.equal(run.gateCalls.length, 1);
    assert.ok(run.gateCalls[0].args[1].endsWith("exec 2>&1\necho GATE_OK"));
    assert.match(run.gateCalls[0].args[1], /AUTOREVIEW_TEMP_DIR=/);
    assert.equal(run.gateCalls[0].cwd, h.repo);
    assert.equal(run.gateCalls[0].timeout, 10 * 60_000);
    assert.equal(run.gateCalls[0].role, "门禁");
    assert.equal(run.reviewInputs.length, 1);
    assert.ok(run.reviewInputs[0].includes("## 门禁\n程序已在项目目录执行门禁命令 echo GATE_OK，退出码 0（通过）。"));
    const gate = run.state.rounds[0].gate!;
    assert.equal(gate.result, "通过");
    assert.equal(gate.exitCode, 0);
    assert.match(readFileSync(gate.logPath!, "utf8"), /^\$ echo GATE_OK\n退出码：0\n\nGATE_OK/);
  } finally { h.close(); }
});

test("门禁不通过：带输出打回开发方，不评审；计入返修次数；到上限暂停", async () => {
  const h = harness();
  try {
    writeFileSync(join(h.repo, "file.txt"), "base\nchange\n");
    const cmd = "echo 'not ok 1 - add'; echo 'expected 3, got -1' >&2; exit 1";
    const first = await gateRound(h, cmd);
    assert.equal(first.outcome.kind, "repair");
    assert.match(first.outcome.message!, /^【门禁 · 第 1 次返修】\n门禁命令不通过（退出码 1）/);
    assert.ok(first.outcome.message!.includes("not ok 1 - add\nexpected 3, got -1"), "stderr 按出现顺序并进输出");
    assert.equal(first.reviewInputs.length, 0, "门禁不通过时不评审");
    assert.equal(first.state.repairs, 1);
    assert.equal(first.state.awaitingRepair, true);
    assert.equal(first.state.rounds[0].conclusion, "未评审（门禁不通过）");
    assert.ok(first.state.lastCheckedFingerprint, "记下给出结论时的指纹，返修后没改动能识别");
    assert.equal(first.state.lastSnapshot, undefined, "门禁不通过不推进评审检查点");
    assert.ok(existsSync(first.state.rounds[0].gate!.logPath!));

    first.state.repairs = h.config.maxRepairs;
    const capped = await gateRound(h, cmd, { state: first.state });
    assert.equal(capped.outcome.kind, "paused");
    assert.equal(capped.outcome.reason, "达到返修上限");
    assert.equal(capped.state.rounds.length, 2);
  } finally { h.close(); }
});

test("门禁没跑完或跑不起来：超时、命令找不到、起不来都暂停，不打回开发方", async () => {
  const h = harness();
  try {
    writeFileSync(join(h.repo, "file.txt"), "base\nchange\n");
    const missing = await gateRound(h, "no-such-gate-command-xyz");
    assert.equal(missing.outcome.kind, "paused");
    assert.equal(missing.outcome.reason, "门禁无法执行");
    assert.match(missing.outcome.notes!, /退出码 127：命令找不到或不能执行/);
    assert.match(missing.outcome.hint!, /检查 \.autoreview\.json 的 gate/);
    assert.equal(missing.state.repairs, 0);

    const timedOut = await gateRound(h, "sleep 999", {
      exec: async (command, args, options) => command === "/bin/sh"
        ? { stdout: "still running", stderr: "", code: 137, killed: true } : h.exec(command, args, options),
    });
    assert.equal(timedOut.outcome.reason, "门禁超时");
    assert.equal(timedOut.state.rounds[0].gate!.detail, "超过 10 分钟没跑完，被终止");
    assert.equal(timedOut.reviewInputs.length, 0);

    const broken = await gateRound(h, "npm test", {
      exec: async (command, args, options) => {
        if (command === "/bin/sh") throw new Error("spawn EAGAIN");
        return h.exec(command, args, options);
      },
    });
    assert.equal(broken.outcome.reason, "门禁无法执行");
    assert.match(broken.outcome.notes!, /spawn EAGAIN/);
  } finally { h.close(); }
});

test("门禁改了项目里的文件：暂停并列出文件", async () => {
  const h = harness();
  try {
    writeFileSync(join(h.repo, "file.txt"), "base\nchange\n");
    const run = await gateRound(h, "echo report > gate-report.txt");
    assert.equal(run.outcome.kind, "paused");
    assert.equal(run.outcome.reason, "门禁期间工作区变了");
    assert.deepEqual(run.outcome.changedFiles, ["gate-report.txt"]);
    assert.match(run.outcome.notes!, /\.gitignore/);
    assert.equal(run.reviewInputs.length, 0);
  } finally { h.close(); }
});

test("仓库内已登记来源变化不阻断：门禁里改来源照常评审并换用新版本", async () => {
  const h = harness();
  const previous = process.env.AUTOREVIEW_PROJECTS_ROOT;
  process.env.AUTOREVIEW_PROJECTS_ROOT = join(h.root, "context-store");
  try {
    writeFileSync(join(h.repo, "need.md"), "v1");
    writeFileSync(join(h.repo, ".autoreview.json"), JSON.stringify({ context: { sources: [{ path: "need.md", role: "requirement" }] } }));
    writeFileSync(join(h.repo, "file.txt"), "base\nchange\n");
    const run = await gateRound(h, "echo v2 >> need.md");
    assert.equal(run.outcome.kind, "done", run.outcome.kind === "paused" ? run.outcome.reason : "");
    assert.deepEqual(run.state.sourceChanges?.map((item) => item.path), ["need.md"]);
    assert.notEqual(run.state.inputsFingerprint, undefined);
  } finally {
    if (previous === undefined) delete process.env.AUTOREVIEW_PROJECTS_ROOT; else process.env.AUTOREVIEW_PROJECTS_ROOT = previous;
    h.close();
  }
});

test("仓库内已登记来源变化不阻断：评审方改了来源照常出结论，代码改动仍暂停", async () => {
  const h = harness();
  const previous = process.env.AUTOREVIEW_PROJECTS_ROOT;
  process.env.AUTOREVIEW_PROJECTS_ROOT = join(h.root, "context-store");
  try {
    writeFileSync(join(h.repo, "need.md"), "v1");
    writeFileSync(join(h.repo, ".autoreview.json"), JSON.stringify({ context: { sources: [{ path: "need.md", role: "requirement" }] } }));
    writeFileSync(join(h.repo, "file.txt"), "base\nchange\n");
    const state = newReviewState();
    const outcome = await runReviewRound({
      cwd: h.repo, devSessionId: "source-in-repo", round: 1, deliveryNote: "done", state, config: h.config, exec: h.exec,
      writeInput: (name, text) => { const file = join(h.root, name); writeFileSync(file, text); return file; }, saveState: () => {},
      callReviewer: async () => { writeFileSync(join(h.repo, "need.md"), "v2"); return { stdout: PASS, stderr: "", code: 0, killed: false }; },
    });
    assert.equal(outcome.kind, "done");
    assert.deepEqual(state.sourceChanges?.map((item) => item.path), ["need.md"]);
    // 非来源的代码改动仍要被拦下。
    const dirty = newReviewState();
    const blocked = await runReviewRound({
      cwd: h.repo, devSessionId: "code-change", round: 1, deliveryNote: "done", state: dirty, config: h.config, exec: h.exec,
      writeInput: (name, text) => { const file = join(h.root, name); writeFileSync(file, text); return file; }, saveState: () => {},
      callReviewer: async () => { writeFileSync(join(h.repo, "reviewer-note.txt"), "reviewer changed the worktree"); return { stdout: PASS, stderr: "", code: 0, killed: false }; },
    });
    assert.equal(blocked.kind, "paused");
    assert.equal(blocked.reason, "评审改动了工作区");
  } finally {
    if (previous === undefined) delete process.env.AUTOREVIEW_PROJECTS_ROOT; else process.env.AUTOREVIEW_PROJECTS_ROOT = previous;
    h.close();
  }
});

test("子目录会话：仓库内来源变化不阻断，非来源改动仍暂停", async () => {
  const h = harness();
  const previous = process.env.AUTOREVIEW_PROJECTS_ROOT;
  process.env.AUTOREVIEW_PROJECTS_ROOT = join(h.root, "context-store");
  try {
    mkdirSync(join(h.repo, "sub"));
    writeFileSync(join(h.repo, "sub", "need.md"), "v1");
    writeFileSync(join(h.repo, ".autoreview.json"), JSON.stringify({ context: { sources: [{ path: "sub/need.md", role: "requirement" }] } }));
    writeFileSync(join(h.repo, "file.txt"), "base\nchange\n");
    const workDir = join(h.repo, "sub");
    const writeInput = (name: string, text: string) => { const file = join(h.root, name); writeFileSync(file, text); return file; };
    const sourceState = newReviewState();
    const done = await runReviewRound({
      cwd: workDir, devSessionId: "sub-source", round: 1, deliveryNote: "done", state: sourceState, config: h.config, exec: h.exec,
      writeInput, saveState: () => {},
      callReviewer: async () => { writeFileSync(join(workDir, "need.md"), "v2"); return { stdout: PASS, stderr: "", code: 0, killed: false }; },
    });
    assert.equal(done.kind, "done", done.kind === "paused" ? done.reason : "");
    assert.deepEqual(sourceState.sourceChanges?.map((item) => item.path), ["sub/need.md"]);
    const codeState = newReviewState();
    const blocked = await runReviewRound({
      cwd: workDir, devSessionId: "sub-code", round: 1, deliveryNote: "done", state: codeState, config: h.config, exec: h.exec,
      writeInput, saveState: () => {},
      callReviewer: async () => { writeFileSync(join(workDir, "reviewer-note.txt"), "not a source"); return { stdout: PASS, stderr: "", code: 0, killed: false }; },
    });
    assert.equal(blocked.kind, "paused");
    assert.equal(blocked.reason, "评审改动了工作区");
    assert.deepEqual(blocked.changedFiles, ["reviewer-note.txt"]);
  } finally {
    if (previous === undefined) delete process.env.AUTOREVIEW_PROJECTS_ROOT; else process.env.AUTOREVIEW_PROJECTS_ROOT = previous;
    h.close();
  }
});

test("子目录会话：非来源文件重命名进来源目录仍暂停（重命名两端都参与范围校验）", async () => {
  const h = harness();
  const previous = process.env.AUTOREVIEW_PROJECTS_ROOT;
  process.env.AUTOREVIEW_PROJECTS_ROOT = join(h.root, "context-store");
  try {
    mkdirSync(join(h.repo, "sub", "docs"), { recursive: true });
    writeFileSync(join(h.repo, "sub", "docs", "guide.md"), "guide");
    writeFileSync(join(h.repo, "sub", "server.ts"), "export const x = 1;\n");
    h.git("add", "sub/docs/guide.md", "sub/server.ts"); h.git("commit", "-qm", "add sub files");
    writeFileSync(join(h.repo, ".autoreview.json"), JSON.stringify({ context: { sources: [{ path: "sub/docs", role: "guide" }] } }));
    writeFileSync(join(h.repo, "file.txt"), "base\nchange\n");
    const state = newReviewState();
    const outcome = await runReviewRound({
      cwd: join(h.repo, "sub"), devSessionId: "sub-rename", round: 1, deliveryNote: "done", state, config: h.config, exec: h.exec,
      writeInput: (name: string, text: string) => { const file = join(h.root, name); writeFileSync(file, text); return file; }, saveState: () => {},
      callReviewer: async () => { h.git("mv", "sub/server.ts", "sub/docs/server.ts"); return { stdout: PASS, stderr: "", code: 0, killed: false }; },
    });
    assert.equal(outcome.kind, "paused", outcome.kind === "done" ? "重命名旧路径被漏掉，误判成纯来源变化" : "");
    assert.equal(outcome.reason, "评审改动了工作区");
    assert.ok(outcome.changedFiles?.includes("server.ts"), `必须报出被移走的旧路径：${outcome.changedFiles?.join("、")}`);
    assert.ok(outcome.changedFiles?.includes("docs/server.ts"));
  } finally {
    if (previous === undefined) delete process.env.AUTOREVIEW_PROJECTS_ROOT; else process.env.AUTOREVIEW_PROJECTS_ROOT = previous;
    h.close();
  }
});

test("准备方法修复把非允许文件重命名进允许目录：范围校验拒绝", async () => {
  const h = harness();
  try {
    writeFileSync(join(h.repo, "server.ts"), "export const x = 1;\n");
    h.git("add", "server.ts"); h.git("commit", "-qm", "add server");
    mkdirSync(join(h.repo, "docs"));
    const { parsePreparation, runPreparation } = await import("../preparation.ts");
    const config = parsePreparation({ check: "true", repair: { model: "m", paths: ["docs"] } }, h.repo)!;
    const exec: Exec = async (command, args, options) => {
      if (options.role === "准备方法修复") {
        h.git("mv", "server.ts", "docs/server.ts");
        return { stdout: "", stderr: "", code: 0, killed: false };
      }
      return h.exec(command, args, options);
    };
    const result = await runPreparation({
      cwd: h.repo, config, state: {}, exec, runDir: join(h.root, "prepare-rename"), saveState: () => {}, failure: "method",
    });
    assert.equal(result.ok, false, "重命名出去的旧路径不在允许范围内，必须拒绝");
    assert.match(result.reason!, /准备动作越出修改范围/);
    assert.match(result.reason!, /server\.ts/);
  } finally { h.close(); }
});

test("子目录会话：门禁里改仓库内来源不阻断", async () => {
  const h = harness();
  const previous = process.env.AUTOREVIEW_PROJECTS_ROOT;
  process.env.AUTOREVIEW_PROJECTS_ROOT = join(h.root, "context-store");
  try {
    mkdirSync(join(h.repo, "sub"));
    writeFileSync(join(h.repo, "sub", "need.md"), "v1");
    writeFileSync(join(h.repo, ".autoreview.json"), JSON.stringify({ context: { sources: [{ path: "sub/need.md", role: "requirement" }] } }));
    writeFileSync(join(h.repo, "file.txt"), "base\nchange\n");
    const state = newReviewState();
    const outcome = await runReviewRound({
      cwd: join(h.repo, "sub"), devSessionId: "sub-gate", round: 1, deliveryNote: "done", state,
      config: { ...h.config, gate: { cmd: "echo v2 >> need.md", timeoutMin: 10 } }, exec: h.exec,
      writeInput: (name: string, text: string) => { const file = join(h.root, name); writeFileSync(file, text); return file; }, saveState: () => {},
      callReviewer: async () => ({ stdout: PASS, stderr: "", code: 0, killed: false }),
    });
    assert.equal(outcome.kind, "done", outcome.kind === "paused" ? outcome.reason : "");
    assert.deepEqual(state.sourceChanges?.map((item) => item.path), ["sub/need.md"]);
  } finally {
    if (previous === undefined) delete process.env.AUTOREVIEW_PROJECTS_ROOT; else process.env.AUTOREVIEW_PROJECTS_ROOT = previous;
    h.close();
  }
});

test("门禁用掉的时间从一轮总预算里扣，评审只拿剩余时间", async () => {
  const h = harness();
  try {
    writeFileSync(join(h.repo, "file.txt"), "base\nchange\n");
    let now = 1_000_000;
    const reviewerTimeouts: number[] = [];
    const run = await gateRound(h, "true", {
      now: () => now,
      exec: async (command, args, options) => {
        if (command === "/bin/sh") now += 5 * 60_000;
        return h.exec(command, args, options);
      },
      reviewer: async (_session, _round, timeoutMs) => {
        reviewerTimeouts.push(timeoutMs);
        return { stdout: PASS, stderr: "", code: 0, killed: false };
      },
    });
    assert.equal(run.outcome.kind, "done");
    assert.deepEqual(reviewerTimeouts, [55 * 60_000]);
    assert.equal(run.state.rounds[0].gate!.durationMs, 5 * 60_000);
  } finally { h.close(); }
});

test("环境与方法故障不消耗已使用的业务返修次数", async () => {
  const h = harness();
  try {
    const state = newReviewState(); state.repairs = 2;
    const run = await gateRound(h, "echo 'OSError: [Errno 28] No space left on device'; exit 1", { state });
    assert.equal(run.outcome.kind, "paused");
    assert.equal(run.outcome.failureKind, "environment");
    assert.equal(state.repairs, 2);
    assert.equal(run.reviewInputs.length, 0);
    const method = await gateRound(h, "exit 78", { state });
    assert.equal(method.outcome.failureKind, "method");
    assert.equal(state.repairs, 2);
  } finally { h.close(); }
});

test("静态评审有必修时不启动后置验收", async () => {
  const h = harness();
  try {
    const state = newReviewState();
    state.criteria = { source: "用户", version: 1, updatedAt: "x", items: [{ id: "A1", text: "操作：检查\n预期：通过" }] };
    const run = await runReviewRound({
      cwd: h.repo, devSessionId: "order", round: 1, deliveryNote: "完成", state,
      config: { ...h.config, acceptance: parseAcceptanceConfig({}, h.repo, {}) }, exec: h.exec,
      writeInput: (name, text) => { const p = join(h.root, name); writeFileSync(p, text); return p; },
      acceptanceDir: join(h.root, "acceptance"), saveState: () => {},
      callReviewer: async () => ({ stdout: PASS.replace("## 必修\n无", "## 必修\n1. 位置：file.txt:1 问题：不正确").replace("结论：通过", "结论：需返修"), stderr: "", code: 0, killed: false }),
    });
    assert.equal(run.kind, "repair");
    assert.equal(state.rounds.length, 1);
    assert.equal(state.rounds[0].acceptance, undefined);
    assert.equal(existsSync(join(h.root, "acceptance")), false);
  } finally { h.close(); }
});

test("已有准备方法和自动恢复沿用原候选，保留业务计数并限制环境次数", async () => {
  const h = harness();
  try {
    const { parsePreparation } = await import('../preparation.ts');
    const flag = join(h.root, 'environment-ready');
    const state = newReviewState(); state.repairs = 2;
    const config = {
      ...h.config,
      preparation: parsePreparation({ check: 'true', recover: `touch '${flag}'`, maxRecoveries: 1 }, h.repo),
      gate: { cmd: `test -f '${flag}' || exit 75`, timeoutMin: 1 },
    };
    const run = () => runReviewRound({
      cwd: h.repo, devSessionId: 'recovery', round: state.rounds.length + 1, deliveryNote: '完成', state, config, exec: h.exec,
      writeInput: (name, text) => { const path = join(h.root, name); writeFileSync(path, text); return path; },
      saveState: () => {}, callReviewer: async () => ({ stdout: PASS, stderr: '', code: 0, killed: false }),
    });
    const first = await run();
    assert.equal(first.kind, 'done', JSON.stringify(first));
    assert.equal(state.repairs, 2);
    assert.equal(state.preparationAttempts?.environment, 1);
    assert.equal(state.rounds.length, 2);
    rmSync(flag);
    assert.equal((await run()).kind, 'paused');
    assert.equal(state.repairs, 2);
    assert.equal(state.preparationAttempts?.environment, 1);
  } finally { h.close(); }
});

test("准备检查不得改稳定规则；准备模型只能修改声明路径", async () => {
  const h = harness();
  try {
    const { parsePreparation, runPreparation } = await import('../preparation.ts');
    assert.throws(() => parsePreparation({ check: 'true', repair: { model: 'm', paths: ['.'] } }, h.repo), /不能/);
    assert.throws(() => parsePreparation({ check: 'true', repair: { model: 'm', paths: ['AGENTS.md'] } }, h.repo), /不能/);
    assert.equal(mayPrepareWrite(h.repo, ['scripts'], 'scripts/check.sh'), true);
    assert.equal(mayPrepareWrite(h.repo, ['scripts'], 'AGENTS.md'), false);
    assert.equal(mayPrepareWrite(h.repo, ['scripts'], '../outside'), false);
    const result = await runPreparation({
      cwd: h.repo, config: parsePreparation({ check: 'echo changed > AGENTS.md' }, h.repo)!,
      state: {}, exec: h.exec, runDir: join(h.root, 'prepare'), saveState: () => {},
    });
    assert.equal(result.ok, false);
    assert.match(result.reason!, /稳定规则/);
  } finally { h.close(); }
});

test("仓库外权威来源变化不阻塞本轮结果，换新版本继续并记录变化", async () => {
  const h = harness();
  const previous = process.env.AUTOREVIEW_PROJECTS_ROOT;
  process.env.AUTOREVIEW_PROJECTS_ROOT = join(h.root, "context-store");
  try {
    writeFileSync(join(h.root, "requirement.md"), "original");
    writeFileSync(join(h.repo, ".autoreview.json"), JSON.stringify({ context: { root: "..", sources: [{ id: "need", path: "requirement.md", role: "requirement" }] } }));
    const state = newReviewState(); state.repairs = 2;
    let calls = 0;
    const deps: ReviewDeps = {
      cwd: h.repo, devSessionId: "frozen", round: 1, deliveryNote: "done", state, config: h.config, exec: h.exec,
      writeInput: (name, text) => { const path = join(h.root, name); writeFileSync(path, text); return path; }, saveState: () => {},
      callReviewer: async () => { calls++; writeFileSync(join(h.root, "requirement.md"), "new requirement"); return { stdout: PASS, stderr: "", code: 0, killed: false }; },
    };
    const first = await runReviewRound(deps);
    assert.equal(first.kind, "done");
    assert.equal(state.repairs, 2);
    assert.equal(state.inputsFingerprint, refreshContext(loadContext(h.repo)!).snapshot.inputsFingerprint, "版本更新到当前");
    assert.deepEqual(state.sourceChanges?.map((item) => item.path), ["requirement.md"]);
    const second = await runReviewRound({ ...deps, round: 2 });
    assert.equal(second.kind, "done"); assert.equal(calls, 2, "下一轮评审照常进行");
  } finally {
    if (previous === undefined) delete process.env.AUTOREVIEW_PROJECTS_ROOT; else process.env.AUTOREVIEW_PROJECTS_ROOT = previous;
    h.close();
  }
});


test("准备工具按实际工作目录检查路径，不跟随悬空链接", async () => {
  const h = harness();
  const oldRoot = process.env.AUTOREVIEW_PREP_ROOT, oldPaths = process.env.AUTOREVIEW_PREP_PATHS;
  try {
    const { symlinkSync } = await import("node:fs");
    mkdirSync(join(h.repo, "sub")); mkdirSync(join(h.repo, "deploy"));
    symlinkSync(join(h.root, "missing.txt"), join(h.repo, "deploy", "dangling.sh"));
    assert.equal(mayPrepareWrite(h.repo, ["deploy"], "deploy/dangling.sh"), false);
    process.env.AUTOREVIEW_PREP_ROOT = h.repo; process.env.AUTOREVIEW_PREP_PATHS = JSON.stringify(["deploy"]);
    let guard: any;
    preparationGuard({ on: (_event: string, handler: any) => { guard = handler; } } as any);
    const blocked = await guard({ toolName: "write", input: { path: "deploy/prepare.sh" } }, { cwd: join(h.repo, "sub") });
    assert.equal(blocked.block, true);
    assert.equal(await guard({ toolName: "write", input: { path: "../deploy/prepare.sh" } }, { cwd: join(h.repo, "sub") }), undefined);
  } finally {
    if (oldRoot === undefined) delete process.env.AUTOREVIEW_PREP_ROOT; else process.env.AUTOREVIEW_PREP_ROOT = oldRoot;
    if (oldPaths === undefined) delete process.env.AUTOREVIEW_PREP_PATHS; else process.env.AUTOREVIEW_PREP_PATHS = oldPaths;
    h.close();
  }
});

test("项目方法三个环境变量：准备检查和门禁都拿到本段开工依据、批次文件和段名", async () => {
  const h = harness();
  try {
    const base = h.git("rev-parse", "HEAD");
    const batch = join(h.root, "批次.json");
    writeFileSync(batch, JSON.stringify({ name: "环境变量", stages: { 甲: { start: "true" } }, steps: [["甲"]] }));
    const seen = join(h.root, "method-env.log");
    const env = { AUTOREVIEW_BATCH_FILE: batch, AUTOREVIEW_STAGE: "甲", AUTOREVIEW_BASE_REV: "stale-value" };
    const state = newReviewState();
    state.baseline = base;
    const outcome = await runReviewRound({
      cwd: h.repo, devSessionId: "method-env", round: 1, deliveryNote: "done", state, env,
      config: {
        ...h.config,
        preparation: { root: h.repo, check: `printf '%s|%s|%s\n' "$AUTOREVIEW_BASE_REV" "$AUTOREVIEW_BATCH_FILE" "$AUTOREVIEW_STAGE" >> ${JSON.stringify(seen)}`,
          timeoutMin: 1, maxRecoveries: 0, maxRepairs: 0 },
        gate: { cmd: `printf '%s|%s|%s\n' "$AUTOREVIEW_BASE_REV" "$AUTOREVIEW_BATCH_FILE" "$AUTOREVIEW_STAGE" >> ${JSON.stringify(seen)}`, timeoutMin: 1 },
      },
      exec: h.exec, writeInput: (name, text) => { const path = join(h.root, name); writeFileSync(path, text); return path; },
      saveState: () => {}, callReviewer: async () => ({ stdout: PASS, stderr: "", code: 0, killed: false }),
    });
    assert.equal(outcome.kind, "done", JSON.stringify(outcome));
    const lines = readFileSync(seen, "utf8").trim().split("\n");
    assert.deepEqual(lines, [`${base}|${batch}|甲`, `${base}|${batch}|甲`], "准备检查和门禁拿到同一份变量");
  } finally { h.close(); }
});

function scopeRound(h: ReturnType<typeof harness>, scope: unknown | undefined, change: () => void) {
  const base = h.git("rev-parse", "HEAD");
  const batch = join(h.root, `batch-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(batch, JSON.stringify({ name: "越界", stages: { 甲: { start: "true", ...(scope === undefined ? {} : { scope }) } }, steps: [["甲"]] }));
  change();
  const state = newReviewState();
  state.baseline = base;
  state.baselineUntracked = [];
  const gateLog = join(h.root, `gate-${Math.random().toString(16).slice(2)}.log`);
  let gateCalls = 0;
  const exec: Exec = async (command, args, options) => {
    if (command === "/bin/sh" && /printf/.test(args[1] ?? "")) gateCalls += 1;
    return h.exec(command, args, options);
  };
  return runReviewRound({
    cwd: h.repo, devSessionId: "scope", round: 1, deliveryNote: "done", state, exec,
    env: { AUTOREVIEW_BATCH_FILE: batch, AUTOREVIEW_STAGE: "甲" },
    config: { ...h.config, gate: { cmd: `printf gate >> ${JSON.stringify(gateLog)}`, timeoutMin: 1 } },
    writeInput: (name, text) => { const path = join(h.root, name); writeFileSync(path, text); return path; },
    saveState: () => {}, callReviewer: async () => ({ stdout: PASS, stderr: "", code: 0, killed: false }),
  }).then((outcome) => ({ outcome, state, gateCalls, gateLog }));
}

test("A3/A4 越界检查：allow 外的新文件打回、deny 命中打回，没写 scope 不检查", async () => {
  const h = harness();
  try {
    const allowed = await scopeRound(h, { allow: ["src/"] }, () => {
      mkdirSync(join(h.repo, "src"), { recursive: true });
      writeFileSync(join(h.repo, "src", "a.ts"), "ok\n");
      writeFileSync(join(h.repo, "docs-x.md"), "outside\n");
    });
    assert.equal(allowed.outcome.kind, "repair", JSON.stringify(allowed.outcome));
    assert.match(allowed.outcome.message!, /docs-x\.md/);
    assert.equal(allowed.gateCalls, 0, "越界时门禁不执行");
    assert.equal(allowed.state.repairs, 1);
    assert.equal(allowed.state.awaitingRepair, true);
    assert.equal(allowed.state.phase, "idle", "没有新增暂停");

    const denied = await scopeRound(h, { deny: ["src/secret/"] }, () => {
      mkdirSync(join(h.repo, "src", "secret"), { recursive: true });
      writeFileSync(join(h.repo, "src", "secret", "k.ts"), "secret\n");
    });
    assert.equal(denied.outcome.kind, "repair");
    assert.match(denied.outcome.message!, /src\/secret\/k\.ts/);
    assert.equal(denied.gateCalls, 0);

    const noScope = await scopeRound(h, undefined, () => {
      writeFileSync(join(h.repo, "anywhere.md"), "outside\n");
    });
    assert.equal(noScope.outcome.kind, "done", JSON.stringify(noScope.outcome));
    assert.equal(noScope.gateCalls, 1, "没写 scope 时门禁照常执行");
  } finally { h.close(); }
});

test("A3 重命名：源路径和目标路径都参与越界检查", async () => {
  const h = harness();
  try {
    mkdirSync(join(h.repo, "docs"), { recursive: true });
    writeFileSync(join(h.repo, "docs", "x.md"), "x\n");
    h.git("add", "docs/x.md"); h.git("commit", "-qm", "docs");
    const run = await scopeRound(h, { allow: ["src/"] }, () => {
      mkdirSync(join(h.repo, "src"), { recursive: true });
      h.git("mv", "docs/x.md", "src/x.md");
    });
    assert.equal(run.outcome.kind, "repair", JSON.stringify(run.outcome));
    assert.match(run.outcome.message!, /docs\/x\.md/, "被移走的源路径也要列出");
  } finally { h.close(); }
});

test("A4 开工时已有未跟踪文件：内容或模式变了仍越界，没变才豁免", async () => {
  const h = harness();
  try {
    const base = h.git("rev-parse", "HEAD");
    mkdirSync(join(h.repo, "src", "secret"), { recursive: true });
    const changed = join(h.repo, "src", "secret", "k.ts");
    const same = join(h.repo, "src", "secret", "keep.ts");
    writeFileSync(changed, "v1\n"); writeFileSync(same, "same\n");
    const details = [changed, same].map((path) => ({
      path: path.slice(h.repo.length + 1),
      hash: h.git("hash-object", "--", path.slice(h.repo.length + 1)),
      mode: "100644",
    }));
    const batch = join(h.root, "untracked-batch.json");
    writeFileSync(batch, JSON.stringify({ name: "未跟踪", stages: { 甲: { start: "true", scope: { deny: ["src/secret/"] } } }, steps: [["甲"]] }));
    const state = newReviewState();
    state.baseline = base; state.baselineUntracked = details.map((item) => item.path); state.baselineUntrackedDetails = details;
    let gateCalls = 0;
    const exec: Exec = async (command, args, options) => {
      if (command === "/bin/sh") gateCalls += 1;
      return h.exec(command, args, options);
    };
    writeFileSync(changed, "v2\n");
    const outcome = await runReviewRound({
      cwd: h.repo, devSessionId: "untracked", round: 1, deliveryNote: "done", state, exec,
      env: { AUTOREVIEW_BATCH_FILE: batch, AUTOREVIEW_STAGE: "甲" },
      config: { ...h.config, gate: { cmd: "true", timeoutMin: 1 } },
      writeInput: (name, text) => { const path = join(h.root, name); writeFileSync(path, text); return path; },
      saveState: () => {}, callReviewer: async () => ({ stdout: PASS, stderr: "", code: 0, killed: false }),
    });
    assert.equal(outcome.kind, "repair", JSON.stringify(outcome));
    assert.match(outcome.message!, /src\/secret\/k\.ts/);
    assert.doesNotMatch(outcome.message!, /src\/secret\/keep\.ts/);
    assert.equal(gateCalls, 0);
  } finally { h.close(); }
});

test("整合返修从收到返修时的快照检查，不把别的段已交付成果算成本段越界", async () => {
  const h = harness();
  try {
    const original = h.git("rev-parse", "HEAD");
    mkdirSync(join(h.repo, "src", "b"), { recursive: true });
    writeFileSync(join(h.repo, "src", "b", "other.ts"), "other\n");
    h.git("add", "src/b/other.ts"); h.git("commit", "-qm", "other stage");
    const scopeBase = h.git("rev-parse", "HEAD");
    const batch = join(h.root, "integration-batch.json");
    writeFileSync(batch, JSON.stringify({ name: "整合", stages: { 甲: { start: "true", scope: { allow: ["src/a/"] } } }, steps: [["甲"]] }));
    const state = newReviewState();
    state.baseline = original; state.scopeBaseline = scopeBase;
    state.baselineUntracked = []; state.baselineUntrackedDetails = []; state.scopeBaselineUntrackedDetails = [];
    mkdirSync(join(h.repo, "src", "a"), { recursive: true });
    writeFileSync(join(h.repo, "src", "a", "fix.ts"), "fix\n");
    let gateCalls = 0;
    const exec: Exec = async (command, args, options) => {
      if (command === "/bin/sh") gateCalls += 1;
      return h.exec(command, args, options);
    };
    const outcome = await runReviewRound({
      cwd: h.repo, devSessionId: "integration", round: 1, deliveryNote: "返修", state, exec,
      env: { AUTOREVIEW_BATCH_FILE: batch, AUTOREVIEW_STAGE: "甲" },
      config: { ...h.config, gate: { cmd: "true", timeoutMin: 1 } },
      writeInput: (name, text) => { const path = join(h.root, name); writeFileSync(path, text); return path; },
      saveState: () => {}, callReviewer: async () => ({ stdout: PASS, stderr: "", code: 0, killed: false }),
    });
    assert.equal(outcome.kind, "done", JSON.stringify(outcome));
    assert.equal(gateCalls, 1, "别的段已交付的 src/b 不算越界");
  } finally { h.close(); }
});

test("首次准备与门禁使用同一个开工依据：只取一次快照", async () => {
  const h = harness();
  try {
    writeFileSync(join(h.repo, "file.txt"), "base\ndirty before prepare\n");
    const seen = join(h.root, "baseline-env.log");
    const state = newReviewState();
    const outcome = await runReviewRound({
      cwd: h.repo, devSessionId: "baseline-order", round: 1, deliveryNote: "done", state,
      config: {
        ...h.config,
        preparation: { root: h.repo, check: `printf '%s\n' "$AUTOREVIEW_BASE_REV" >> ${JSON.stringify(seen)}`, timeoutMin: 1, maxRecoveries: 0, maxRepairs: 0 },
        gate: { cmd: `printf '%s\n' "$AUTOREVIEW_BASE_REV" >> ${JSON.stringify(seen)}`, timeoutMin: 1 },
      },
      exec: h.exec, writeInput: (name, text) => { const path = join(h.root, name); writeFileSync(path, text); return path; },
      saveState: () => {}, callReviewer: async () => ({ stdout: PASS, stderr: "", code: 0, killed: false }),
    });
    assert.equal(outcome.kind, "done", JSON.stringify(outcome));
    const lines = readFileSync(seen, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(lines[0], state.baseline, "准备拿到保存后的开工依据");
    assert.equal(lines[1], state.baseline, "门禁拿到同一份开工依据");
    assert.equal(state.baseline, h.git("rev-parse", "HEAD"), "手动 /review 以 HEAD 为基线，启动前的未提交改动仍进入评审");
  } finally { h.close(); }
});

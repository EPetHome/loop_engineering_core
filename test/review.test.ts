/** review.ts 单测：评审时间预算（首次调用加 1 次重试共用同一份 60 分钟预算）；门禁（gate）一步。 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkRoundBudget, parseAcceptanceConfig, parseGateConfig } from "../config.ts";
import type { Exec, ExecResult } from "../git.ts";
import { newReviewState, runReviewRound, type ReviewConfig, type ReviewDeps } from "../review.ts";

const PASS = "## 结论：通过\n## 必修\n无\n## 小问题\n- 无\n## 需求疑问\n- 无\n## 上轮必修复查\n- 无\n";

function harness() {
  const root = mkdtempSync(join(tmpdir(), "autoreview-budget-"));
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
    const res = spawnSync(command, args, { cwd: options.cwd, env, encoding: "utf8" });
    return { stdout: res.stdout || "", stderr: res.stderr || "", code: res.status ?? 1, killed: Boolean(res.signal) };
  };
  const config: ReviewConfig = {
    maxRepairs: 3, reviewerModel: "m", reviewerThinking: "xhigh", reviewTimeoutMin: 60, reviewerCmd: "",
  };
  return { root, repo, git, exec, config, close: () => rmSync(root, { recursive: true, force: true }) };
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
    assert.deepEqual(run.gateCalls, [{ args: ["-c", "exec 2>&1\necho GATE_OK"], cwd: h.repo, timeout: 10 * 60_000, role: "门禁" }]);
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

/** review.ts 的评审时间预算单测：首次调用加 1 次重试共用同一份 60 分钟预算。 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExecResult } from "../git.ts";
import { newReviewState, runReviewRound, type ReviewConfig } from "../review.ts";

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
  const exec = async (command: string, args: string[], options: { cwd: string; timeout: number }): Promise<ExecResult> => {
    const res = spawnSync(command, args, { cwd: options.cwd, env, encoding: "utf8" });
    return { stdout: res.stdout || "", stderr: res.stderr || "", code: res.status ?? 1, killed: Boolean(res.signal) };
  };
  const config: ReviewConfig = {
    maxRepairs: 3, reviewerModel: "m", reviewerThinking: "xhigh", reviewTimeoutMin: 60, reviewerCmd: "",
  };
  return { root, repo, exec, config, close: () => rmSync(root, { recursive: true, force: true }) };
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

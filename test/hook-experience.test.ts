/** hook／experience：按功能独立运行，夹具与状态不跨测试进程共享。 */
import "./test-env.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { conventionText } from "../core.ts";
import { projectRootHash } from "../project-context.ts";
import { fixture } from "./helpers/hook-fixture.ts";

test("经验 A1/A2 Claude 与 Codex 的开发约定、评审输入都只带三条四行正文；无文件保持原文", async (t) => {
  for (const host of ["claude", "codex"]) for (const enabled of [true, false]) await t.test(`${host}/${enabled}`, () => {
    const h = fixture();
    try {
      const checklist = [1, 2, 3].map((i) => `## P0${i} 标题${i}\n现象：现象${i}\n根因：根因${i}\n正确做法：做法${i}\n证据：PRIVATE_EVIDENCE\n失效条件：PRIVATE_CONDITION\n`).join("\n");
      h.write(".autoreview/经验.md", checklist); if (!enabled) rmSync(join(h.repo, ".autoreview", "经验.md"));
      const env = { AUTOREVIEW_HOST: host };
      const start = JSON.parse(h.run(h.event("SessionStart"), { env }).stdout).hookSpecificOutput.additionalContext;
      const prompt = JSON.parse(h.run(h.event("UserPromptSubmit", { prompt: "修好 file.txt" }), { env }).stdout).hookSpecificOutput.additionalContext;
      h.write("file.txt", "fixed\n"); h.run(h.delivered(), { env });
      assert.equal(h.readState(host).phase, "done");
      assert.equal(h.readState(host).experienceActivity.projectId, projectRootHash(h.repo), "原生记录在目录有效时捕获持久项目身份");
      const input = readFileSync(join(h.home, ".pi-autoreview", "repo", `review-input-${host}-s1-r1.md`), "utf8");
      for (const text of [start, prompt, input]) {
        if (enabled) for (const i of [1, 2, 3]) assert.match(text, new RegExp(`P0${i} 标题${i}\\n现象：现象${i}\\n根因：根因${i}\\n正确做法：做法${i}`));
        else assert.doesNotMatch(text, /对照清单|项目经验|P01/);
        assert.doesNotMatch(text, /PRIVATE_EVIDENCE|PRIVATE_CONDITION/);
      }
      if (!enabled) { assert.equal(start, conventionText()); assert.equal(prompt, conventionText()); }
    } finally { h.close(); }
  });
});

test("经验 A4/A5/A6 Hook 两个开发会话完成才在总结提示；CLI 拒绝后同类不再提；活动会话阻止批准", () => {
  const h = fixture();
  try {
    const env = { AUTOREVIEW_HOST: "claude", AUTOREVIEW_PROJECTS_ROOT: join(h.root, "projects"), FAKE_EXPERIENCE_LOG: join(h.root, "draft-calls.jsonl") };
    const cli = (action: string, value?: string) => spawnSync(process.execPath, [fileURLToPath(new URL("../loop.ts", import.meta.url)), "经验", action, h.repo, ...(value ? [value] : []), "--json"], {
      cwd: h.root, env: { ...process.env, ...env, HOME: h.home }, encoding: "utf8",
    });
    const complete = (session: string) => {
      h.run(h.event("SessionStart", {}, session), { env });
      h.run(h.event("UserPromptSubmit", { prompt: "修好 file.txt" }, session), { env });
      h.write("file.txt", `${session}-bad\n`);
      const repair = h.run(h.event("Stop", { last_assistant_message: "【交付完成】" }, session), { env, mode: "always-fix" });
      assert.equal(JSON.parse(repair.stdout).decision, "block");
      h.write("file.txt", `${session}-fixed\n`); const before = h.git("status", "--porcelain");
      h.run(h.event("Stop", { last_assistant_message: "【交付完成】" }, session), { env });
      assert.equal(h.readState("claude", session).phase, "done");
      assert.equal(h.git("status", "--porcelain"), before, "完成起草不写任何项目文件");
    };
    complete("s1"); assert.doesNotMatch(h.summary(), /待批准经验/);
    complete("s2"); assert.match(h.summary("claude", "s2"), /## 需要你做的事[\s\S]*待批准经验 C01/);
    assert.equal(existsSync(join(h.repo, ".autoreview", "经验.md")), false);
    assert.equal(JSON.parse(cli("列出").stdout).candidates.length, 1);
    h.run(h.event("SessionStart", {}, "active"), { env });
    const blocked = cli("批准", "C01"); assert.equal(blocked.status, 1); assert.match(JSON.parse(blocked.stdout).error, /进行中.*稍后再批/);
    assert.equal(cli("拒绝", "C01").status, 0);
    complete("s3"); assert.doesNotMatch(h.summary("claude", "s3"), /待批准经验/);
    assert.equal(JSON.parse(cli("列出").stdout).candidates.length, 0);
    assert.equal(readFileSync(env.FAKE_EXPERIENCE_LOG, "utf8").trim().split("\n").length, 3, "每个有必修的完成会话只独立调用一次");
  } finally { h.close(); }
});

test("经验起草失败只在完成总结提醒，Hook 不暂停", () => {
  const h = fixture();
  try {
    const env = { FAKE_EXPERIENCE_MODE: "fail" };
    h.run(h.event("SessionStart"), { env }); h.run(h.event("UserPromptSubmit", { prompt: "修好" }), { env });
    h.write("file.txt", "bad\n"); h.run(h.delivered(), { env, mode: "always-fix" });
    h.write("file.txt", "fixed\n"); h.run(h.delivered(), { env });
    assert.equal(h.readState().phase, "done"); assert.match(h.summary(), /经验候选起草失败.*不影响会话完成/);
  } finally { h.close(); }
});

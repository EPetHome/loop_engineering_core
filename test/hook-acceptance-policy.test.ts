/** hook-acceptance-policy：独立进程隔离环境，保持全部场景与断言。 */
import "./test-env.ts";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createServer } from "node:net";
import test from "node:test";
import { ACCEPTANCE_CONVENTION } from "../acceptance-core.ts";
import { CONVENTION, conventionText } from "../core.ts";
import { loadConfig } from "../hosts/review-hook.ts";
import { ACC_ENV, fixture, assertPauseOutput } from "./helpers/hook-fixture.ts";

test("H12 当前规则运行时注入，不依赖项目副本；无法验收、部分验证仍告诉你下一步", async (t) => {
  const marker = JSON.stringify({ acceptance: {} });
  const requirement = "做一个待办命令行\n## 验收标准\n1. 操作：todo add 买菜\n   预期：已添加\n2. 操作：todo list\n   预期：有买菜";
  const reviewerCalled = (h: ReturnType<typeof fixture>) => existsSync(join(h.root, "fake", "calls.log"));

  for (const host of ["claude", "codex"]) for (const legacy of [false, true]) await t.test(`${host} ${legacy ? "v6 副本字节不变" : "无副本"}：注入当前约定，完成后也不提醒同步`, () => {
    const h = fixture({ marker }), env = { ...ACC_ENV, AUTOREVIEW_HOST: host };
    try {
      const copy = join(h.repo, ".autoreview/CONVENTIONS.md");
      const old = "<!-- autoreview:acceptance v6 -->\r\nLEGACY_COPY_MUST_NOT_BE_INJECTED\r\n<!-- /autoreview:acceptance -->\r\n";
      if (legacy) h.write(".autoreview/CONVENTIONS.md", old);
      const first = JSON.parse(h.run(h.event("SessionStart"), { env }).stdout);
      assert.equal(first.systemMessage, undefined);
      assert.equal(first.hookSpecificOutput.additionalContext, `${CONVENTION}\n${ACCEPTANCE_CONVENTION}`);
      assert.doesNotMatch(first.hookSpecificOutput.additionalContext, /LEGACY_COPY_MUST_NOT_BE_INJECTED/);
      const submitted = h.run(h.event("UserPromptSubmit", { prompt: requirement }), { env });
      assert.match(submitted.stderr, /已记录验收标准第 1 版（2 条）/);
      assert.equal(JSON.parse(submitted.stdout).hookSpecificOutput.additionalContext, conventionText({ acceptance: true }));
      assert.equal(h.readState(host).criteria.source, "用户");
      h.write("file.txt", "changed\n");
      assert.equal(h.run(h.delivered(), { env }).stdout, "");
      const state = h.readState(host), summary = h.summary(host);
      assert.equal(state.phase, "done"); assert.equal(state.rounds[0].acceptance.verdict, "通过");
      const input = readFileSync(join(dirname(h.statePath(host)), `review-input-${host}-s1-r1.md`), "utf8");
      assert.doesNotMatch(input, /程序已经启动系统/);
      assert.match(readFileSync(join(state.rounds[0].acceptance.runDir, "evidence", "A2.txt"), "utf8"), /^=== A2 #1 /m);
      assert.match(summary, /## 验收标准（你写的；第 1 版）\nA1\. 操作：todo add 买菜\n {4}预期：已添加/);
      assert.match(summary, /验收：通过（耗时/);
      assert.match(summary, /## 验收额外发现（待你决定）\n- 第 1 轮：首页标题有错别字/);
      assert.doesNotMatch(summary + h.notifications(), /【块 1】|写法是旧版|CONVENTIONS|可变流程说明尚未准备/);
      if (legacy) assert.deepEqual(readFileSync(copy), Buffer.from(old));
      else assert.equal(existsSync(copy), false);
    } finally { h.close(); }
  });

  await t.test("没配启动却连不上：不打回开发方，暂停并指向 .autoreview.json 的启动配置；你发消息后恢复", () => {
    const h = fixture({ marker });
    const env = { ...ACC_ENV, FAKE_ACC_MODE: "unreachable" };
    try {
      h.run(h.event("SessionStart"), { env });
      h.run(h.event("UserPromptSubmit", { prompt: requirement }), { env });
      h.write("file.txt", "base\nTODO\n");
      const res = h.run(h.delivered(), { env });
      const out = JSON.parse(res.stdout);
      assert.equal(out.decision, undefined, "不是开发方的错，不打回");
      assert.match(out.systemMessage, /^自动评审暂停（无法验收：没有配置怎么启动被测系统（A1、A2））。/);
      assert.match(out.systemMessage, /在 .*\/repo\/\.autoreview\.json 配置 acceptance.start/);
      const state = h.readState();
      assert.equal(state.phase, "paused");
      assert.equal(state.repairs, 0);
      assert.ok(reviewerCalled(h));
      assert.match(h.summary(), /## 需要你做的事\n1\. 在 .*\.autoreview\.json 配置 acceptance.start/);
      h.run(h.event("UserPromptSubmit", { prompt: "配好了，继续" }), { env });
      assert.equal(h.readState().phase, "idle");
      assert.equal(h.readState().pauseHint, undefined);
    } finally { h.close(); }
  });

  await t.test("个别自动条目验证不了：保留部分验证报告，暂停且不写完成总表", () => {
    const h = fixture({ marker });
    const env = { ...ACC_ENV, FAKE_ACC_UNKNOWN: "A2" };
    try {
      h.run(h.event("SessionStart"), { env });
      h.run(h.event("UserPromptSubmit", { prompt: requirement }), { env });
      h.write("file.txt", "base\nTODO\n");
      const out = JSON.parse(h.run(h.delivered(), { env }).stdout);
      assert.match(out.systemMessage, /^自动评审暂停（无法验收：完整验收仍有自动条目未通过（A2））/);
      const state = h.readState();
      assert.equal(state.phase, "paused");
      assert.equal(state.repairs, 0);
      assert.equal(existsSync(h.ledger), false, "自动项未通过不得登记完成");
      assert.equal(state.rounds[0].acceptance.verdict, "部分验证");
      assert.ok(reviewerCalled(h));
      const input = readFileSync(join(h.home, ".pi-autoreview", basename(h.repo), "review-input-claude-s1-r1.md"), "utf8");
      assert.doesNotMatch(input, /其余全部通过，A2 没能自动验证/, "本轮验收在静态评审之后");
      assert.match(h.summary(), /完整验收仍有自动条目未通过（A2）/);
      assert.match(h.summary(), /A2：.*标准写得含糊/);
      assert.match(h.notifications(), /完整验收仍有自动条目未通过（A2）/);
    } finally { h.close(); }
  });
});

test("H13 自动验收被关掉或数据不干净：不打回开发方，暂停并说明下一步", async (t) => {
  const requirement = "做一个待办接口\n## 验收标准\n1. 操作：GET /\n   预期：返回 ok\n2. 操作：GET /list\n   预期：返回 ok";
  const freePort = (): Promise<number> => new Promise((resolvePort) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolvePort(port));
    });
  });
  const server = `import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
if (process.env.AUTOREVIEW_RUN_DIR) writeFileSync(join(process.env.AUTOREVIEW_RUN_DIR, "server.pid"), String(process.pid));
createServer((q, r) => r.end("ok")).listen(Number(process.argv[2]), "127.0.0.1");
`;

  await t.test("验收方关掉被测系统：G1 无法验证、不打回，已有静态评审，提示不是开发方的问题", async () => {
    const port = await freePort();
    const marker = JSON.stringify({ acceptance: { start: `node server.mjs ${port}`, readyUrl: `http://127.0.0.1:${port}/` } });
    const h = fixture({ marker, files: { "server.mjs": server } });
    const env = { ...ACC_ENV, FAKE_ACC_MODE: "kill" };
    try {
      h.run(h.event("SessionStart"), { env });
      h.run(h.event("UserPromptSubmit", { prompt: requirement }), { env });
      h.write("file.txt", "base\nTODO\n");
      const out = JSON.parse(h.run(h.delivered(), { env }).stdout);
      assert.equal(out.decision, undefined, "不是开发方的错，不打回");
      assert.match(out.systemMessage, /^自动评审暂停（无法验收：被测系统在验收途中被关掉了/);
      assert.match(out.systemMessage, /不是开发方的问题[\s\S]*acceptance\.reset/);
      const state = h.readState();
      assert.equal(state.phase, "paused");
      assert.equal(state.repairs, 0);
      assert.ok(existsSync(join(h.root, "fake", "calls.log")), "本轮已先完成静态评审");
      assert.match(h.summary(), /- G1：无法验证 —— 系统在验收途中被关掉了/);
    } finally { h.close(); }
  });

  await t.test("没配 reset、验收方报数据不是初始状态：暂停并指向 reset 配置说明", () => {
    const h = fixture({ marker: JSON.stringify({ acceptance: {} }) });
    const env = { ...ACC_ENV, FAKE_ACC_MODE: "dirty" };
    try {
      h.run(h.event("SessionStart"), { env });
      h.run(h.event("UserPromptSubmit", { prompt: requirement }), { env });
      h.write("file.txt", "base\nTODO\n");
      const out = JSON.parse(h.run(h.delivered(), { env }).stdout);
      assert.equal(out.decision, undefined);
      assert.match(out.systemMessage, /无法验收：被测系统的数据不是初始状态/);
      assert.match(out.systemMessage, /没有配置 acceptance\.reset[\s\S]*可选配置：被测系统怎么启动/);
      assert.equal(h.readState().repairs, 0);
    } finally { h.close(); }
  });
});

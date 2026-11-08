/** autoreview／sources：按功能独立运行，夹具与状态不跨测试进程共享。 */
import "./test-env.ts";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { conventionText } from "../core.ts";
import { readReviewSnapshot } from "../snapshots.ts";
import { contextDir, loadContext } from "../project-context.ts";
import { batchInfo } from "../events.ts";
import { sendWords } from "../pa.ts";
import { relayMessage } from "../pa-records.ts";
import { queryBatches } from "../query.ts";
import { type State, result, PASS, FIX, until, harness, ACCEPT, stageStatus, paFixture } from "./helpers/autoreview-fixture.ts";

test("来源索引使用 Pi 合法分段名，并保留已有提示内容", async () => {
  const h = harness();
  try {
    h.write(".autoreview.json", JSON.stringify({ context: { sources: ["file.txt"] } }));
    await h.event("session_start");
    for (const messageType of ["user", "custom"]) {
      const options = { sections: { other_context: "其它扩展内容" } as Record<string, string>, appendSystemPrompt: "已有约定" };
      await h.event("before_agent_start", { messageType, prompt: "检查来源", systemPromptOptions: options });
      assert.equal(h.state().phase, "idle");
      assert.ok(!h.apiCalls.includes("abort"));
      // Pi 的构建器只接受小写字母开头的分段名，preamble 是保留名。
      for (const name of Object.keys(options.sections)) {
        assert.match(name, /^[a-z][a-z0-9_-]*$/);
        assert.notEqual(name, "preamble");
      }
      assert.match(options.sections.autoreview_context, /当前来源与定位[\s\S]*file\.txt/);
      assert.equal(options.sections.other_context, "其它扩展内容");
      assert.equal(options.appendSystemPrompt, `已有约定\n\n${conventionText({ singleNode: true })}`);
    }
  } finally { await h.close(); }
});

test("来源内容变化保留静态资格，标准/授权变化失效；旧 /accept 一律只迁移", async (t) => {
  for (const change of ["sources", "criteria", "grants"]) await t.test(change, async () => {
    const h = harness({ flags: { ...ACCEPT, "autoreview-accept-mode": "required" } });
    try {
      writeFileSync(join(h.root, "need.md"), "old need");
      h.write(".autoreview.json", JSON.stringify({ context: { root: "..", sources: [{ path: "need.md", role: "requirement" }] } }));
      await h.event("session_start"); await h.begin(); h.write("file.txt", "base\nchange\n");
      h.acceptor = () => result("ENOSPC", 75); await h.command(); await h.terminal();
      const count = h.accepts.length;
      if (change === "sources") {
        writeFileSync(join(h.root, "need.md"), "new need");
        await h.command("review-inputs", "accept");
      } else {
        // 模拟已通过用户消息校验后的新标准/授权，候选源码不变。
        const stored = h.entries.filter((e) => e.customType === "autoreview-state").at(-1)!;
        const restored = structuredClone(stored.data);
        if (change === "criteria") restored.criteria = { source: "用户", version: 2, updatedAt: "new", items: [{ id: "A1", text: "new standard" }] };
        else restored.grants = { version: 1, approved: ["A1"], denied: [] };
        await h.event("session_shutdown");
        h.entries.push({ type: "custom", customType: "autoreview-state", data: restored });
        await h.event("session_start");
      }
      h.acceptor = () => result("pass"); await h.command("accept");
      assert.equal(h.accepts.length, count, "旧 /accept 不执行任何命令");
      if (change === "sources") { assert.equal(h.state().phase, "done"); assert.equal(h.state().acceptRun, undefined); }
      else assert.notEqual(h.state().phase, "done");
    } finally { await h.close(); }
  });
});

test("检查中修改上级配置不能把旧评审标成新配置通过", async (t) => {
  for (const accept of [true, false]) await t.test(accept ? "有必需后置命令" : "无后置命令", async () => {
    const h = harness({ flags: accept ? { ...ACCEPT, "autoreview-accept-mode": "required" } : {} });
    try {
      const marker = join(h.root, ".autoreview.json"); writeFileSync(marker, "{}");
      await h.event("session_start"); await h.begin(); h.write("file.txt", "base\nchange\n");
      h.reviewer = () => { writeFileSync(marker, JSON.stringify({ acceptance: {} })); return result(PASS); };
      await h.command(); await h.terminal();
      assert.equal(h.state().phase, "paused"); assert.match(h.state().pauseReason!, /配置已变化/);
      assert.equal(h.accepts.length, 0); assert.equal(h.state().repairs, 0);
    } finally { await h.close(); }
  });
});

test("恢复完成状态必须重新验证依据，旧状态与变化后的配置不能发布 done", async (t) => {
  for (const change of ["same", "source", "config", "candidate", "required", "failed"]) await t.test(change, async () => {
    const h = harness({ stage: "甲", flags: { ...ACCEPT, "autoreview-accept-mode": change === "required" ? "advisory" : "required" } });
    try {
      const marker = join(h.root, ".autoreview.json"), source = join(h.root, "need.md");
      const config = { context: { sources: [{ path: "need.md", role: "requirement" }] } };
      writeFileSync(source, "need"); writeFileSync(marker, JSON.stringify(config));
      await h.event("session_start"); await h.begin(); h.write("file.txt", "base\nchange\n");
      await h.command(); await h.terminal();
      assert.equal(h.state().phase, "done");
      await h.event("session_shutdown");
      if (change === "source") writeFileSync(source, "changed need");
      if (change === "config") writeFileSync(marker, JSON.stringify({ ...config, acceptance: {} }));
      if (change === "candidate") h.write("file.txt", "new unchecked candidate");
      if (change === "required") h.setFlag("autoreview-accept-mode", "required");
      if (change === "failed") {
        const restored = { ...structuredClone(h.state()), acceptRun: { result: "不通过", command: "old" } };
        h.entries.push({ type: "custom", customType: "autoreview-state", data: restored });
      }
      await h.event("session_start");
      const completed = ["same", "source", "required", "failed"].includes(change);
      assert.equal(h.state().phase, completed ? "done" : "paused");
      assert.equal(stageStatus(h, "甲")?.event, completed ? "done" : "paused");
      if (change === "source") {
        // 已完成的会话之后来源变化：保持完成，/review-inputs 只补记。
        await h.command("review-inputs");
        assert.equal(h.state().phase, "done");
        assert.equal(stageStatus(h, "甲")?.event, "done");
        assert.match(h.summary(), /## 开发期间来源变化\n- need\.md（/);
        assert.match(h.summary(), /^- 状态：完成$/m);
      }
    } finally { await h.close(); }
  });
  const h = harness({ stage: "甲", restored: { enabled: true, phase: "done", repairs: 2, rounds: [] } });
  try {
    await h.event("session_start");
    assert.equal(h.state().phase, "paused"); assert.equal(h.state().repairs, 2);
    assert.match(h.state().pauseReason!, /缺少候选或输入依据/);
    assert.equal(stageStatus(h, "甲")?.event, "paused");
  } finally { await h.close(); }
});

test("程序自动提交后恢复完成状态不被撤销；真实内容变化仍撤销", async (t) => {
  for (const mode of ["tracked-and-untracked-commit", "candidate-change"] as const) await t.test(mode, async () => {
    const h = harness({ stage: "甲" });
    try {
      await h.event("session_start"); await h.begin();
      h.write("file.txt", "base\nchange\n");
      if (mode !== "candidate-change") h.write("new.txt", "new file\n");
      await h.command(); await h.terminal();
      assert.equal(h.state().phase, "done");
      await h.event("session_shutdown");
      if (mode === "candidate-change") h.write("file.txt", "different unchecked content\n");
      else { h.git("add", "-A"); h.git("commit", "-qm", "程序自动提交"); }
      await h.event("session_start");
      if (mode === "candidate-change") {
        assert.equal(h.state().phase, "paused");
        assert.match(h.state().pauseReason!, /候选或输入版本变化/);
        assert.equal(stageStatus(h, "甲")?.event, "paused");
      } else {
        assert.equal(h.state().phase, "done", h.state().pauseReason ?? "");
        assert.equal(stageStatus(h, "甲")?.event, "done");
      }
    } finally { await h.close(); }
  });
});

test("CRLF／过滤转换文件提交后恢复：仅提交保持完成，内容、原始字节或模式变化仍撤销", async (t) => {
  for (const conversion of ["crlf", "filter"] as const) for (const change of ["commit-only", "content", "raw-only", "mode"] as const) {
    await t.test(`${conversion}/${change}`, async () => {
      const h = harness({ stage: "甲" });
      try {
        h.write(".gitattributes", conversion === "crlf" ? "*.crlf text eol=crlf\n" : "*.filtered filter=snapshot\n");
        if (conversion === "filter") {
          const clean = 'let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>process.stdout.write(s.replace(/(?:WORKSPACE|ALIAS):/g,"CANONICAL:")));';
          h.git("config", "filter.snapshot.clean", `"${process.execPath}" -e '${clean}'`);
          h.git("config", "filter.snapshot.smudge", `"${process.execPath}" -e 'process.stdin.pipe(process.stdout)'`);
        }
        h.git("add", ".gitattributes"); h.git("commit", "-qm", "conversion config");
        await h.event("session_start"); await h.begin();
        const path = conversion === "crlf" ? "value.crlf" : "value.filtered";
        const original = conversion === "crlf" ? "value=1\r\n" : "WORKSPACE:value=1\n";
        h.write(path, original); await h.command(); await h.terminal();
        assert.equal(h.state().phase, "done", h.state().pauseReason ?? "");
        const state: any = h.state(), readyEpoch = state.readyEpoch;
        const raw = state.lastSnapshotDetails.untracked.find((file: any) => file.path === path).hash;
        const stored = readReviewSnapshot(state.rounds[0].snapshot).files.find((file) => file.path === path)!;
        assert.equal(stored.hash, raw);
        await h.event("session_shutdown");
        if (change === "content") h.write(path, conversion === "crlf" ? "value=2\r\n" : "WORKSPACE:value=2\n");
        if (change === "raw-only") h.write(path, conversion === "crlf" ? "value=1\n" : "ALIAS:value=1\n");
        if (change === "mode") chmodSync(join(h.repo, path), 0o755);
        h.git("add", "-A"); h.git("commit", "-qm", "submit conversion candidate");
        if (change === "commit-only") assert.equal(readFileSync(join(h.repo, path), "utf8"), original, "正常提交不改变工作区字节");
        await h.event("session_start");
        assert.equal(h.state().phase, change === "commit-only" ? "done" : "paused", h.state().pauseReason ?? "");
        assert.equal(stageStatus(h, "甲")?.event, change === "commit-only" ? "done" : "paused");
        if (change === "commit-only") assert.equal((h.state() as any).readyEpoch, readyEpoch, "沿用原完成资格");
        else assert.match(h.state().pauseReason!, /候选或输入版本变化/);
        assert.equal(h.inputs.length, 1, "恢复只核对资格，不偷偷重新评审");
        assert.equal(readReviewSnapshot(state.rounds[0].snapshot).files.find((file) => file.path === path)!.hash, raw);
      } finally { await h.close(); }
    });
  }
});

test("子目录会话提交后资格保持，目录外候选改动仍撤销资格", async () => {
  const h = harness({ subdir: "sub" });
  try {
    await h.event("session_start"); await h.begin();
    h.write("file.txt", "outside candidate\n");
    writeFileSync(join(h.repo, "sub", "new.txt"), "new\n");
    await h.command(); await h.terminal();
    assert.equal(h.state().phase, "done");
    await h.event("session_shutdown");
    h.git("add", "-A"); h.git("commit", "-qm", "程序提交子目录候选");
    await h.event("session_start");
    assert.equal(h.state().phase, "done", h.state().pauseReason ?? "");
    await h.event("session_shutdown");
    h.write("file.txt", "outside real change\n");
    await h.event("session_start");
    assert.equal(h.state().phase, "paused");
    assert.match(h.state().pauseReason!, /候选或输入版本变化/);
  } finally { await h.close(); }
});

test("自动提交后发现可执行模式变化仍撤销资格", async () => {
  const h = harness();
  try {
    await h.event("session_start"); await h.begin();
    h.write("run.sh", "#!/bin/sh\necho ok\n");
    chmodSync(join(h.repo, "run.sh"), 0o755);
    await h.command(); await h.terminal();
    assert.equal(h.state().phase, "done");
    await h.event("session_shutdown");
    chmodSync(join(h.repo, "run.sh"), 0o644);
    h.git("add", "-A"); h.git("commit", "-qm", "程序提交不可执行版本");
    await h.event("session_start");
    assert.equal(h.state().phase, "paused");
    assert.match(h.state().pauseReason!, /候选或输入版本变化/);
  } finally { await h.close(); }
});

test("done 接受新来源保持完成并补记，标准或授权变化仍撤销接力资格", async (t) => {
  for (const change of ['source', 'criteria', 'grants']) await t.test(change, async () => {
    const h = harness({ stage: '甲' });
    try {
      writeFileSync(join(h.root, 'need.md'), 'old source');
      h.write('.autoreview.json', JSON.stringify({ acceptance: {}, context: { root: '..', sources: [{ path: 'need.md', role: 'requirement' }] } }));
      await h.event('session_start'); await h.begin('requirement\n## 验收标准\n1. [授权] 操作：外部检查\n预期：ok\n不授权：A1');
      h.write('file.txt', 'base\nchange\n'); await h.command(); await h.terminal();
      assert.equal(stageStatus(h, '甲')?.event, 'done');
      await h.event('session_shutdown'); h.entries.push({ type: 'custom', customType: 'autoreview-state', data: { ...structuredClone(h.state()), repairs: 2 } }); await h.event('session_start');
      if (change === 'source') {
        writeFileSync(join(h.root, 'need.md'), 'new source');
        await h.command('review-inputs', 'accept');
        assert.equal(h.state().phase, 'done'); assert.equal(stageStatus(h, '甲')?.event, 'done');
        assert.match(h.summary(), /## 开发期间来源变化\n- need\.md（/); assert.match(h.summary(), /^- 状态：完成$/m);
        assert.equal(h.state().repairs, 2);
        return;
      }
      if (change === 'criteria') await h.begin('## 验收标准\n1. [人工] 操作：新的标准\n预期：新目标');
      else await h.begin('同意授权：A1');
      assert.equal(h.state().phase, 'idle'); assert.equal(stageStatus(h, '甲')?.event, 'started');
      assert.match(h.summary(), /^- 状态：进行中$/m); assert.equal(h.state().repairs, 2);
      // 用受控结果确认确实重新进入评审；不在此场景发起真实外部验收。
      h.reviewer = () => result(FIX);
      const count = h.inputs.length; h.assistant('已收到'); await h.event('agent_settled');
      await until(() => h.inputs.length > count, '无代码改动仍重新评审');
      assert.match(h.inputs.at(-1)!, /当前验收标准与授权/);
      if (change === 'criteria') assert.match(h.inputs.at(-1)!, /新的标准/);
      if (change === 'grants') assert.match(h.inputs.at(-1)!, /你已同意/);
    } finally { await h.close(); }
  });
});

test("开发中 requirement 与 guide 来源变化：不暂停，下一轮评审拿新版本，总结列出两个文件", async () => {
  const h = harness();
  try {
    writeFileSync(join(h.root, "need.md"), "v1 need");
    writeFileSync(join(h.root, "guide.md"), "v1 guide");
    h.write(".autoreview.json", JSON.stringify({ context: { root: "..", sources: [{ path: "need.md", role: "requirement" }, { path: "guide.md", role: "guide" }] } }));
    await h.event("session_start");
    await h.begin("requirement");
    // 来源未变：总结不出现变化一节。
    h.write("file.txt", "base\nchange\n");
    await h.command(); await h.terminal();
    assert.equal(h.state().phase, "done");
    assert.doesNotMatch(h.summary(), /## 开发期间来源变化/);
    // 开发进行中依次改两份来源，再交付：不暂停，重评时用新版本。
    writeFileSync(join(h.root, "need.md"), "v2 need");
    writeFileSync(join(h.root, "guide.md"), "v2 guide");
    h.write("file.txt", "base\nchange 2\n");
    await h.command(); await h.terminal();
    assert.equal(h.state().phase, "done");
    assert.match(h.inputs.at(-1)!, /## 项目来源与代码定位[\s\S]*当前来源与定位（第 2 版）/);
    const section = /## 开发期间来源变化\n([\s\S]*?)\n## /.exec(h.summary())?.[1] ?? "";
    assert.match(section, /- need\.md（/); assert.match(section, /- guide\.md（/);
  } finally { await h.close(); }
});

test("来源变化／静态资格保持：仓库内外均只补记，旧命令不执行", async (t) => {
  for (const inside of [true, false]) await t.test(inside ? "仓库内" : "仓库外", async () => {
    const h = harness({ flags: { ...ACCEPT, "autoreview-accept-mode": "required" } });
    try {
      const source = join(inside ? h.repo : h.root, "need.md"); writeFileSync(source, "v1");
      h.write(".autoreview.json", JSON.stringify({ context: { ...(inside ? {} : { root: ".." }), sources: [{ path: "need.md", role: "requirement" }] } }));
      await h.event("session_start"); await h.begin("requirement"); h.write("file.txt", "base\nchange\n");
      h.reviewer = () => { writeFileSync(source, "v2"); return result(PASS); };
      await h.command(); await h.terminal();
      assert.equal(h.state().phase, "done", h.state().pauseReason ?? ""); assert.equal(h.state().acceptRun, undefined); assert.equal(h.accepts.length, 0);
      assert.match(h.summary(), /## 开发期间来源变化\n- need\.md（/);
    } finally { await h.close(); }
  });
});

test("目录型来源内部文件被删：不暂停，总结补记", async () => {
  const h = harness({ stage: "甲" });
  try {
    mkdirSync(join(h.repo, "docs"));
    writeFileSync(join(h.repo, "docs", "a.md"), "v1");
    writeFileSync(join(h.repo, "docs", "b.md"), "v1");
    h.write(".autoreview.json", JSON.stringify({ context: { sources: [{ path: "docs", role: "guide" }] } }));
    await h.event("session_start"); await h.begin("requirement");
    h.write("file.txt", "base\nchange\n");
    rmSync(join(h.repo, "docs", "a.md"));
    await h.command(); await h.terminal();
    assert.equal(h.state().phase, "done", h.state().pauseReason ?? "");
    assert.equal(stageStatus(h, "甲")?.event, "done");
    assert.match(h.summary(), /## 开发期间来源变化\n- docs\/a\.md（/);
  } finally { await h.close(); }
});

test("仓库内来源变化不作废静态评审，配置验收不执行但仍补记变化", async () => {
  const h = harness();
  const oldTester = process.env.AUTOREVIEW_ACCEPTANCE_CMD;
  process.env.AUTOREVIEW_ACCEPTANCE_CMD = fileURLToPath(new URL("./fake-tester.mjs", import.meta.url));
  process.env.FAKE_ACC_TOUCH = join(h.repo, "need.md");
  try {
    writeFileSync(join(h.repo, "need.md"), "v1");
    h.write(".autoreview.json", JSON.stringify({ acceptance: {}, context: { sources: [{ path: "need.md", role: "requirement" }] } }));
    await h.event("session_start");
    await h.begin("requirement\n## 验收标准\n1. 操作：检查\n预期：ok");
    h.write("file.txt", "base\nchange\n");
    h.reviewer = () => { writeFileSync(join(h.repo, "need.md"), "v2"); return result(PASS); };
    await h.command(); await h.terminal();
    assert.equal(h.state().phase, "done", h.state().pauseReason ?? "");
    assert.equal((h.state().rounds.at(-1) as any)?.acceptance, undefined);
    assert.match(h.summary(), /## 开发期间来源变化\n- need\.md（/);
  } finally {
    delete process.env.FAKE_ACC_TOUCH;
    await h.close();
    if (oldTester === undefined) delete process.env.AUTOREVIEW_ACCEPTANCE_CMD; else process.env.AUTOREVIEW_ACCEPTANCE_CMD = oldTester;
  }
});

test("完成检查后、发布前删除来源：暂停且不写交付", async () => {
  const h = harness({ flags: { ...ACCEPT, "autoreview-accept-mode": "required" } });
  const previousStore = process.env.AUTOREVIEW_PROJECTS_ROOT;
  process.env.AUTOREVIEW_PROJECTS_ROOT = join(h.root, "context-store");
  try {
    const source = join(h.root, "need.md");
    writeFileSync(source, "need v1");
    h.write(".autoreview.json", JSON.stringify({ context: { root: "..", sources: [{ path: "need.md", role: "requirement" }] } }));
    await h.event("session_start");
    await h.begin("requirement");
    h.write("file.txt", "base\nchange\n");
    // 静态评审返回后、完成总结前删除来源；不能用检查前的有效快照发布完成。
    let reviewed = false, removed = false;
    h.reviewer = () => { reviewed = true; return result(PASS); };
    h.inject = (plain) => {
      if (reviewed && !removed && plain[0] === "status" && plain[1] === "--short") { removed = true; rmSync(source); }
      return undefined;
    };
    await h.command(); await h.terminal();
    assert.ok(removed, "测试确实在发布前删除了来源");
    assert.equal(h.state().phase, "paused", h.state().pauseReason ?? "");
    assert.match(h.state().pauseReason!, /上游来源缺失：need\.md/);
    const deliveries = join(contextDir(loadContext(h.repo)!), "deliveries");
    assert.equal(existsSync(deliveries) ? readdirSync(deliveries).length : 0, 0, "缺失时不写交付记录");
  } finally {
    if (previousStore === undefined) delete process.env.AUTOREVIEW_PROJECTS_ROOT; else process.env.AUTOREVIEW_PROJECTS_ROOT = previousStore;
    await h.close();
  }
});

test("恢复完成态时取证窗口删除来源：暂停不发 done；内容变化保持完成", async (t) => {
  for (const mode of ["delete", "modify"]) await t.test(mode, async () => {
    const h = harness({ stage: "甲" });
    try {
      const source = join(h.root, "need.md");
      writeFileSync(source, "v1");
      h.write(".autoreview.json", JSON.stringify({ context: { root: "..", sources: [{ path: "need.md", role: "requirement" }] } }));
      await h.event("session_start"); await h.begin("requirement");
      h.write("file.txt", "base\nchange\n");
      await h.command(); await h.terminal();
      assert.equal(h.state().phase, "done");
      assert.equal(stageStatus(h, "甲")?.event, "done");
      await h.event("session_shutdown");
      // 下一次会话的完成恢复里，在 git 取证窗口（snapshot 的 ls-files 调用）动来源。
      let armed = false, touched = false;
      h.inject = (plain) => {
        if (armed && !touched && plain[0] === "ls-files") {
          touched = true;
          if (mode === "delete") rmSync(source); else writeFileSync(source, "v2");
        }
        return undefined;
      };
      armed = true;
      await h.event("session_start");
      assert.ok(touched, "测试确实在取证窗口里动了来源");
      if (mode === "delete") {
        assert.equal(h.state().phase, "paused");
        assert.match(h.state().pauseReason!, /上游来源缺失：need\.md/);
        assert.equal(stageStatus(h, "甲")?.event, "paused");
      } else {
        assert.equal(h.state().phase, "done");
        assert.equal(stageStatus(h, "甲")?.event, "done");
        assert.match(h.summary(), /## 开发期间来源变化\n- need\.md（/);
      }
    } finally { await h.close(); }
  });
});

test("准备后的静态检查：来源变化可记录，代码变化/来源缺失均不放行或执行旧命令", async (t) => {
  for (const mode of ["source", "code", "missing"]) await t.test(mode, async () => {
    const h = harness({ flags: { ...ACCEPT, "autoreview-accept-mode": "required" } });
    try {
      const source = join(h.repo, "need.md"); writeFileSync(source, "v1");
      h.write(".autoreview.json", JSON.stringify({ context: { sources: [{ path: "need.md", role: "requirement" }] }, preparation: { check: "ready", recover: "recover", maxRecoveries: 1 } }));
      h.acceptor = () => result("ready"); await h.event("session_start"); await h.begin("requirement"); h.write("file.txt", "base\nchange\n"); let calls = 0;
      h.reviewer = () => { calls++; if (mode === "source") writeFileSync(source, "v2"); if (mode === "code") writeFileSync(join(h.repo, "recovered-note.txt"), "not a source"); if (mode === "missing") rmSync(source); return result(PASS); };
      await h.command(); await h.terminal(); assert.equal(calls, 1); assert.equal(h.calls.filter((c) => c.options.role === "验收命令").length, 0); assert.equal(h.state().repairs, 0);
      if (mode === "source") { assert.equal(h.state().phase, "done"); assert.match(h.summary(), /## 开发期间来源变化\n- need\.md（/); }
      else { assert.equal(h.state().phase, "paused"); assert.match(h.summary(), mode === "code" ? /评审改动了工作区/ : /上游来源缺失：need\.md/); }
    } finally { await h.close(); }
  });
});

test('来源巡检：内容变化保持完成并补记，缺失与配置移除照旧暂停', async (t) => {
  const interval = globalThis.setInterval;
  t.mock.method(globalThis, 'setInterval', (callback: () => void, ms: number, ...args: unknown[]) =>
    interval(callback, ms === 30_000 ? 20 : ms, ...args));
  for (const change of ['modify', 'delete', 'config']) await t.test(change, async () => {
    const h = harness({ stage: '甲', restored: { enabled: true, phase: 'idle', repairs: 2, rounds: [] } });
    try {
      const source = join(h.root, 'need.md'), marker = join(h.root, '.autoreview.json');
      writeFileSync(source, 'original requirement');
      writeFileSync(marker, JSON.stringify({ context: { intervalSec: 30, sources: [{ path: 'need.md', role: 'requirement' }] } }));
      await h.event('session_start'); await h.begin(); h.write('file.txt', 'change\n');
      h.assistant('【交付完成】'); await h.event('agent_settled'); await h.terminal();
      assert.equal(h.state().phase, 'done'); assert.equal(h.state().repairs, 2);
      const before = h.state() as State & { inputsFingerprint: string; readyEpoch: string };
      assert.equal(stageStatus(h, '甲')?.sourceInputs, before.inputsFingerprint);
      if (change === 'modify') {
        writeFileSync(source, 'changed requirement');
        await until(() => h.summary().includes('## 开发期间来源变化'), '总结补记来源变化');
        const after = h.state() as State & { inputsFingerprint: string; readyEpoch?: string };
        assert.equal(after.phase, 'done'); assert.equal(stageStatus(h, '甲')?.event, 'done');
        assert.notEqual(after.inputsFingerprint, before.inputsFingerprint);
        assert.equal(after.readyEpoch, before.readyEpoch); assert.equal(after.repairs, 2);
        assert.match(h.summary(), /## 开发期间来源变化\n- need\.md（/);
        assert.match(h.summary(), /^- 状态：完成$/m);
        return;
      }
      if (change === 'delete') rmSync(source);
      if (change === 'config') rmSync(marker);
      await until(() => h.state().phase === 'paused', '缺失来源暂停完成');
      const after = h.state() as State & { inputsFingerprint: string; readyEpoch?: string };
      assert.equal(after.inputsFingerprint, before.inputsFingerprint);
      assert.equal(after.readyEpoch, undefined); assert.equal(after.repairs, 2);
      assert.match(after.pauseReason!, /上游来源/);
      assert.equal(stageStatus(h, '甲')?.event, 'paused');
      assert.doesNotMatch(h.summary(), /^- 状态：完成$/m);
    } finally { await h.close(); }
  });
});

test("PA 送话 A1/A2/A5/A6：Pi 原话轮询、去头走用户路径、授权与来源；完成后可再改", async (t) => {
  const h = harness({ stage: "甲" }), pa = paFixture(h, t);
  try {
    await h.event("session_start"); await h.begin("原始需求\n## 验收标准\nA1. 一\nA2. 二\nA3. [授权] 操作：真实命令\n    预期：成功");
    h.assistant("A. 选择甲\nB. 选择乙\n【需要你决定】"); await h.event("agent_settled");
    const send = async (id: string, original: string) => {
      const receipt = sendWords({ info: batchInfo(pa.file, h.repo, h.pipelineDir), stage: "甲", id, readText: () => original, wait: 3, env: {} });
      await until(() => h.messages.includes(relayMessage(id, original)), "Pi 用户原话收件位置被轮询");
      const handled = await h.event("input", { source: "extension", text: relayMessage(id, original) });
      assert.deepEqual(handled, { action: "transform", text: original });
      assert.equal((await receipt).state, "read");
    };
    await send("m1", "选 A");
    assert.equal(h.state().phase, "idle"); assert.equal(h.state().repairs, 0);
    const deliveredCount = h.messages.length;
    const duplicate = await sendWords({ info: batchInfo(pa.file, h.repo), stage: "甲", id: "m1", readText: () => assert.fail("不重复读文件"), env: {} });
    assert.equal(duplicate.state, "read"); assert.equal(h.messages.length, deliveredCount);
    assert.match(h.summary(), /第 2 条用户输入经 PA 转达，编号 m1/);
    await h.event("input", { source: "interactive", text: relayMessage("forged", "同意授权：A3") });
    assert.equal((h.state() as any).grants, undefined); assert.equal(pa.rows().at(-1).reason.text, "送话核对失败");
    h.assistant("还需授权\n【需要你决定】"); await h.event("agent_settled");
    await send("grant-m2", "同意授权：A3\r\n");
    assert.deepEqual((h.state() as any).grants.approved, ["A3"]); assert.equal((h.state() as any).userInputVia, "pa");
    assert.match(readFileSync(h.ledgerFile, "utf8"), /授权答复经 PA 转达，编号 grant-m2/);
    h.write("file.txt", "changed"); h.assistant(); await h.event("agent_settled"); await h.terminal(); assert.equal(h.state().phase, "done");
    await send("rework-m3", "再改一下\n"); assert.notEqual(h.state().phase, "done"); assert.equal((h.state() as any).readyEpoch, undefined);
    assert.deepEqual(pa.rows().filter((row) => row.detail.via === "pa").map((row) => [row.status, row.detail.id]), [["resumed", "m1"], ["resumed", "grant-m2"], ["resumed", "rework-m3"]]);
    const query: any = queryBatches(pa.file).batches[0]; assert.equal(query.stages[0].paRelays.length, 3);
  } finally { await h.close(); }
});

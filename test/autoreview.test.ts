/** autoreview：按功能独立运行，夹具与状态不跨测试进程共享。 */
import "./test-env.ts";
import assert from "node:assert/strict";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import { approveExperience, experienceFile, importExperience } from "../experience.ts";
import { readReviewSnapshot } from "../snapshots.ts";
import { type Result, result, PASS, FIX, until, harness } from "./helpers/autoreview-fixture.ts";

test("Pi 实际评审入口保存本机快照，并在原生状态中保留同轮引用", async () => {
  const h = harness();
  try {
    await h.event("session_start"); await h.begin(); h.write("file.txt", "reviewed bytes\n"); h.write("new.txt", "untracked bytes\n");
    h.assistant(); await h.event("agent_settled"); await h.terminal();
    assert.equal(h.state().phase, "done");
    const state: any = h.state(), path = state.rounds[0].snapshot, snapshot = readReviewSnapshot(path);
    assert.ok(path.startsWith(h.home) || path.startsWith(realpathSync(h.home)));
    assert.deepEqual(state.reviewSnapshots, [{ round: 1, path }]);
    assert.equal(snapshot.session, "unit-dev"); assert.equal(snapshot.round, 1);
    assert.equal(snapshot.files.find((file) => file.path === "new.txt")?.kind, "untracked");
    assert.equal(h.inputs.length, 1);
  } finally { await h.close(); }
});

test("Pi经验／完成后原会话继续开发，真实输入与插件触发的整个回合都阻挡批准", async () => {
  const h = harness();
  try {
    h.write(".autoreview.json", "{}");
    const source = join(h.root, "candidate.md");
    writeFileSync(source, "## P01 复核状态\n现象：旧状态继续提交\n根因：未重读\n正确做法：提交前重读\n出现次数：2\n");
    importExperience(h.repo, source);
    await h.event("session_start"); await h.begin(); h.write("file.txt", "fixed\n");
    h.assistant(); await h.event("agent_settled"); await h.terminal();
    approveExperience(h.repo, "C01", true);
    const originalRequirement = (h.state() as any).requirement;
    await h.event("input", { source: "interactive", text: "继续做后续任务" });
    assert.equal(h.state().phase, "done", "旧评审完成态无需被普通消息伪造为新检查结果");
    assert.equal((h.state() as any).requirement, originalRequirement);
    assert.throws(() => approveExperience(h.repo, "C01"), /进行中.*稍后再批/);
    await h.event("before_agent_start", { prompt: "继续做后续任务", skipInput: true, systemPromptOptions: {} });
    assert.throws(() => approveExperience(h.repo, "C01"), /进行中/);
    h.assistant("这里只需解释，无代码改动"); await h.event("agent_settled");
    approveExperience(h.repo, "C01", true);
    await h.event("before_agent_start", { messageType: "custom", message: { customType: "follow-up", content: "继续开发" }, systemPromptOptions: {} });
    assert.throws(() => approveExperience(h.repo, "C01"), /进行中/);
    h.assistant("插件回合已结束，没有改动"); await h.event("agent_settled");
    approveExperience(h.repo, "C01");
    assert.match(readFileSync(experienceFile(h.repo), "utf8"), /复核状态/);
  } finally { await h.close(); }
});

test("G1 B1 中文、引号及空白路径都参与指纹保护", async (t) => {
  for (const path of ["说明.md", 'a "b".txt', " leading\ttrailing \n.txt"]) {
    await t.test(JSON.stringify(path), async () => {
      const h = harness();
      try {
        await h.event("session_start"); await h.begin();
        h.write("说明.md", "说明 A"); h.write('a "b".txt', "引号 A"); h.write(" leading\ttrailing \n.txt", "空白 A");
        h.reviewer = () => { h.write(path, "评审修改"); return result(PASS); };
        h.assistant(); await h.command(); await h.terminal();
        assert.equal(h.state().phase, "paused");
        assert.match(h.summary(), /评审改动了工作区/);
        assert.ok(h.inputs[0].includes("说明.md") && h.inputs[0].includes('a "b".txt'));
      } finally { await h.close(); }
    });
  }
});

test("G2 B2 git 取证失败暂停；无提交仓库关闭", async (t) => {
  for (const cmd of ["stash", "hash-object", "diff", "ls-files"]) {
    await t.test(`${cmd} 失败`, async () => {
      const h = harness();
      try {
        await h.event("session_start"); await h.begin(); h.write("new.txt", "new");
        if (cmd === "stash") h.write("file.txt", "changed\n");
        h.inject = (args) => args[0] === cmd ? result("", 1, `${cmd} FAIL_SENTINEL`) : undefined;
        h.assistant(); await h.command(); await h.terminal();
        assert.equal(h.state().phase, "paused");
        assert.match(h.state().pauseReason!, /无法读取工作区状态/);
        assert.equal(h.inputs.length, 0);
        assert.ok(!h.notifications.some((text) => text.includes("：完成")));
      } finally { await h.close(); }
    });
  }
  await t.test("killed=true 即使 code=0 也失败", async () => {
    const h = harness();
    try {
      await h.event("session_start"); await h.begin();
      h.write("file.txt", "changed\n");
      h.inject = (args) => args[0] === "stash" ? result("", 0, "killed", true) : undefined;
      await h.command(); await h.terminal();
      assert.match(h.state().pauseReason!, /无法读取工作区状态/);
    } finally { await h.close(); }
  });
  await t.test("仓库没有任何提交", async () => {
    const h = harness({ empty: true });
    try {
      await h.event("session_start");
      assert.ok(h.notifications.some((text) => text.includes("仓库还没有提交，自动评审已关闭")));
      assert.equal(h.state().enabled, false);
      await h.command(); assert.equal(h.inputs.length, 0);
    } finally { await h.close(); }
  });
});

test("Pi／Git探测恢复：临时探测失败可续审，明确不支持则保持关闭", async (t) => {
  for (const killed of [false, true]) {
    await t.test(killed ? "探测被终止后恢复" : "探测非零失败后恢复", async () => {
      const h = harness();
      try {
        h.inject = (args) => args.includes("--git-dir") ? result("", killed ? 0 : 1, "PROBE_FAILURE", killed) : undefined;
        await h.event("session_start");
        assert.equal(h.state().phase, "paused");
        assert.equal(h.state().enabled, true);
        assert.match(h.state().pauseReason!, /无法读取工作区状态/);
        // 故障仍在时也必须重新探测，不能误报「不是 git 仓库」。
        const beforeRetry = h.calls.length;
        await h.command();
        assert.ok(h.calls.length > beforeRetry, "/review 没有重新执行 git");
        await h.terminal();
        assert.ok(!h.notifications.some((text) => text.includes("不是 git 仓库")));
        h.inject = undefined; h.write("file.txt", "base\nRECOVERED_PROBE\n");
        await h.command(); await until(() => h.state()?.phase === "done", "探测恢复后完成评审");
        assert.equal(h.inputs.length, 1);
        assert.ok(h.inputs[0].includes("+RECOVERED_PROBE"));
      } finally { await h.close(); }
    });
  }
  await t.test("确认不是 git 仓库时仍关闭", async () => {
    const h = harness();
    try {
      h.inject = (args) => args.includes("--git-dir") ? result("", 128, "fatal: not a git repository") : undefined;
      await h.event("session_start");
      assert.equal(h.state().enabled, false);
      const count = h.calls.length;
      await h.command();
      assert.equal(h.calls.length, count);
      assert.equal(h.inputs.length, 0);
      assert.ok(h.notifications.some((text) => text.includes("不是 git 仓库")));
    } finally { await h.close(); }
  });
});

test("G3 B4 快照固定提交 id；提交改动不漏审、不漏检", async (t) => {
  await t.test("干净基线和开发中提交", async () => {
    const h = harness();
    try {
      await h.event("session_start"); await h.begin();
      const baseline = h.state().baseline;
      h.write("file.txt", "base\nCOMMITTED_CHANGE\n"); h.git("add", "file.txt"); h.git("commit", "-qm", "development");
      h.assistant(); await h.command(); await h.terminal();
      assert.match(baseline!, /^[a-f0-9]{40}$/);
      assert.ok(h.inputs[0].includes("+COMMITTED_CHANGE"));
      assert.notEqual(baseline, h.git("rev-parse", "HEAD"));
    } finally { await h.close(); }
  });
  for (const empty of [false, true]) {
    await t.test(empty ? "评审只移动 HEAD，变化列表为空" : "评审修改并提交后工作区仍干净", async () => {
      const h = harness();
      try {
        await h.event("session_start"); await h.begin();
        h.reviewer = () => {
          if (!empty) { h.write("file.txt", "REVIEW_COMMIT\n"); h.git("add", "file.txt"); }
          h.git("commit", "--allow-empty", "-qm", "reviewer changed HEAD");
          return result(PASS);
        };
        h.assistant(); await h.command(); await h.terminal();
        assert.equal(h.git("status", "--short"), "");
        assert.equal(h.state().phase, "paused");
        if (empty) assert.match(h.state().pauseReason!, /工作区或提交发生了变化/);
      } finally { await h.close(); }
    });
  }
});

test("G4 B3 成功→两次失败→续审，保留检查点、必修和完整 diff", async () => {
  const h = harness();
  try {
    await h.event("session_start"); await h.begin(); h.write("file.txt", "base\nA\n");
    h.reviewer = () => result(FIX); h.assistant(); await h.command();
    await until(() => h.messages.length === 1, "首轮返修消息");
    const first = structuredClone(h.state());
    assert.ok(!h.messages[0].includes("MINOR_SENTINEL") && !h.messages[0].includes("QUESTION_SENTINEL"));
    h.write("file.txt", "base\nA\nB\n"); h.reviewer = () => result("", 1, "review failed");
    h.assistant("第 1 条：已修\n【交付完成】"); await h.event("agent_settled"); await h.terminal();
    const failed = structuredClone(h.state()); const failedSummary = h.summary();
    h.write("file.txt", "base\nA\nB\nC\n"); h.reviewer = () => result(PASS);
    h.assistant("第 1 条：已修（再检查）\n【交付完成】"); await h.command(); await h.terminal();
    const third = h.inputs.at(-1)!;
    assert.equal(failed.lastSnapshot, first.lastSnapshot);
    assert.equal(failed.lastFingerprint, first.lastFingerprint);
    assert.ok(failed.unresolvedMustFix?.includes("必修 X"));
    assert.ok(failedSummary.includes("## 未解决的必修") && failedSummary.includes("必修 X"));
    assert.ok(third.includes("必修 X") && third.includes("+B") && third.includes("+C"));
    assert.ok(third.includes("第 1 条：已修（再检查）"));
  } finally { await h.close(); }
});

test("G5 B3 首轮两次失败后续审，仍带需求原文和首轮完整改动", async () => {
  const h = harness();
  try {
    await h.event("session_start"); await h.begin(); h.write("file.txt", "base\nUNREVIEWED_A\n");
    h.reviewer = () => result("unparseable"); h.assistant(); await h.command(); await h.terminal();
    const failed = structuredClone(h.state());
    h.reviewer = () => result(PASS); await h.command(); await h.terminal();
    assert.equal(failed.lastSnapshot, undefined);
    assert.equal(failed.lastFingerprint, undefined);
    assert.ok(h.inputs.at(-1)!.includes("## 需求原文"));
    assert.ok(h.inputs.at(-1)!.includes("ORIGINAL_REQUIREMENT"));
    assert.ok(h.inputs.at(-1)!.includes("+UNREVIEWED_A"));
  } finally { await h.close(); }
});

test("Pi／手动评审基线：新会话直接 /review，HEAD 和未提交材料完整", async () => {
  const h = harness();
  try {
    h.write("file.txt", "base\nMANUAL_CHANGE\n"); h.write("说明.md", "manual new");
    await h.event("session_start"); const head = h.git("rev-parse", "HEAD");
    await h.command(); await h.terminal();
    assert.equal(h.state().baseline, head);
    assert.ok(h.inputs[0].includes("+MANUAL_CHANGE") && h.inputs[0].includes("说明.md"));
    assert.ok(h.inputs[0].includes("本会话没有记录需求原文（手动 /review），请按改动本身和项目文档评审"));
  } finally { await h.close(); }
});

test("G7 B6 总结不可写或 pi/UI 抛错仍通知，无未处理 rejection", async (t) => {
  for (const failure of ["summary", "appendEntry", "setStatus"]) {
    await t.test(failure, async () => {
      const h = harness(); const rejections: unknown[] = [];
      const listener = (error: unknown) => rejections.push(error);
      process.on("unhandledRejection", listener);
      try {
        await h.event("session_start"); await h.begin();
        if (failure === "summary") writeFileSync(join(h.home, ".pi-autoreview"), "不是目录");
        if (failure === "appendEntry") h.failAppend = true;
        if (failure === "setStatus") h.failStatus = true;
        await h.command();
        await until(() => h.notifications.some((text) => text.includes("暂停")), "异常后仍通知");
        assert.deepEqual(rejections, []);
        if (failure === "summary") assert.ok(h.notifications.some((text) => /总结.*失败/.test(text)));
      } finally { process.off("unhandledRejection", listener); await h.close(); }
    });
  }
});

test("G8 B7 shutdown 取消 exec、存暂停，旧任务不再调用接口；恢复中断提示", async (t) => {
  await t.test("取消并隔离旧任务", async () => {
    const h = harness(); let release!: (value: Result) => void;
    const pending = new Promise<Result>((resolve) => { release = resolve; });
    try {
      await h.event("session_start"); await h.begin();
      h.reviewer = () => pending; await h.command();
      await until(() => h.inputs.length === 1, "评审已启动");
      const call = h.calls.find((item) => item.command === "/fake-reviewer")!;
      assert.ok(call.options.signal instanceof AbortSignal);
      await h.event("session_shutdown", { reason: "reload" });
      assert.equal(call.options.signal!.aborted, true);
      assert.equal(h.state().phase, "paused");
      assert.match(h.state().pauseReason!, /评审被中断（会话关闭或重载）/);
      const count = h.apiCalls.length;
      release(result(PASS)); for (let i = 0; i < 16; i += 1) await nextTurn();
      assert.equal(h.apiCalls.length, count, "shutdown 返回之后不能再调用 pi/ctx");
    } finally { release(result(PASS)); await h.close(); }
  });
  await t.test("恢复持久化的 reviewing", async () => {
    const h = harness({ restored: { enabled: true, rounds: [], repairs: 0, phase: "reviewing" } });
    try {
      await h.event("session_start");
      assert.equal(h.state().phase, "paused");
      assert.match(h.state().pauseReason!, /评审被中断（会话关闭或重载）/);
      assert.ok(h.notifications.some((text) => text.includes("/review")));
    } finally { await h.close(); }
  });
});

test("Pi／总结关闭边界：总结准备期间关闭保存中断，已完成通知不倒退", async (t) => {
  for (const output of [FIX, PASS]) {
    await t.test(output === FIX ? "返修总结等待期间关闭" : "完成总结等待期间关闭", async () => {
      const h = harness(); let release!: (value: Result) => void; let waiting = false;
      const pending = new Promise<Result>((resolve) => { release = resolve; });
      try {
        await h.event("session_start"); await h.begin(); h.write("file.txt", "base\nA\n");
        h.reviewer = () => result(output);
        h.inject = (args, call) => {
          if (args[0] !== "status" || !call.options.signal) return undefined;
          waiting = true;
          return pending;
        };
        await h.command(); await until(() => waiting, "总结 git status 已挂起");
        const call = h.calls.find((item) => item.args.includes("status") && item.options.signal)!;
        await h.event("session_shutdown", { reason: "reload" });
        assert.equal(call.options.signal!.aborted, true);
        assert.equal(h.state().phase, "paused");
        assert.match(h.state().pauseReason!, /评审被中断（会话关闭或重载）/);
        assert.ok(h.notifications.some((text) => text.includes("评审被中断")));
        assert.equal(h.messages.length, 0);
        if (output === FIX) assert.ok(h.state().unresolvedMustFix?.includes("必修 X"));
        const count = h.apiCalls.length;
        release(result()); for (let i = 0; i < 16; i += 1) await nextTurn();
        assert.equal(h.apiCalls.length, count, "关闭后旧总结任务不能继续调用接口");
        assert.equal(h.messages.length, 0);
      } finally { release(result()); await h.close(); }
    });
  }
  await t.test("完成后仅系统通知未返回，不应倒退成中断", async () => {
    const h = harness(); let release!: (value: Result) => void;
    const pending = new Promise<Result>((resolve) => { release = resolve; });
    try {
      await h.event("session_start"); await h.begin();
      h.notifier = () => pending;
      await h.command(); await until(() => h.state()?.phase === "done", "评审完成，系统通知等待中");
      const call = h.calls.find((item) => basename(item.command) === "osascript")!;
      await h.event("session_shutdown", { reason: "quit" });
      assert.equal(call.options.signal!.aborted, true);
      assert.equal(h.state().phase, "done");
      const count = h.apiCalls.length;
      release(result()); for (let i = 0; i < 16; i += 1) await nextTurn();
      assert.equal(h.apiCalls.length, count);
    } finally { release(result()); await h.close(); }
  });
});

test("G9 无标记自动评审：有改动就评审、无改动不动作、返修无改动暂停", async (t) => {
  await t.test("无标记 + 有改动 → 自动评审", async () => {
    const h = harness();
    try {
      await h.event("session_start"); await h.begin();
      h.write("file.txt", "base\nAUTO_A\n");
      h.assistant("普通回复，不写标记");
      await h.event("agent_settled");
      await h.terminal();
      assert.equal(h.state().phase, "done");
      assert.equal(h.inputs.length, 1);
      assert.ok(h.inputs[0].includes("+AUTO_A"));
      assert.ok(!h.notifications.some((text) => text.includes("有未评审的改动")));
    } finally { await h.close(); }
  });
  await t.test("无标记 + 无改动 → 什么都不做", async () => {
    const h = harness();
    try {
      await h.event("session_start"); await h.begin();
      h.assistant("普通回复");
      await h.event("agent_settled");
      assert.equal(h.inputs.length, 0);
      assert.equal(h.notifications.length, 0);
      assert.equal(h.state().phase, "idle");
    } finally { await h.close(); }
  });
  await t.test("返修后无标记且无改动 → 暂停「返修后没有任何改动」", async () => {
    const h = harness();
    try {
      await h.event("session_start"); await h.begin(); h.write("file.txt", "base\nA\n");
      h.reviewer = () => result(FIX); await h.command();
      await until(() => h.messages.length === 1, "返修消息");
      h.assistant("第 1 条：已修（没改文件，也没写标记）");
      await h.event("agent_settled");
      assert.equal(h.state().phase, "paused");
      assert.match(h.state().pauseReason!, /返修后没有任何改动/);
      assert.equal(h.inputs.length, 1, "不应发起新一轮评审");
    } finally { await h.close(); }
  });
  await t.test("【需要你决定】→ 暂停；暂停后不自动评审", async () => {
    const h = harness();
    try {
      await h.event("session_start"); await h.begin();
      h.assistant("卡住了\n【需要你决定】");
      await h.event("agent_settled");
      assert.equal(h.state().phase, "paused");
      assert.match(h.state().pauseReason!, /开发方需要你决定/);
      const count = h.inputs.length;
      h.write("file.txt", "base\nAFTER_PAUSE\n");
      h.assistant("普通回复");
      await h.event("agent_settled");
      assert.equal(h.inputs.length, count, "暂停后不自动评审");
    } finally { await h.close(); }
  });
  await t.test("review-off 时无标记有改动不评审", async () => {
    const h = harness();
    try {
      await h.event("session_start"); await h.begin();
      await h.command("review-off");
      h.write("file.txt", "base\nOFF_A\n");
      h.assistant("普通回复");
      await h.event("agent_settled");
      assert.equal(h.inputs.length, 0);
      assert.equal(h.state().phase, "idle");
    } finally { await h.close(); }
  });
});

test("G10 暂停后你再让开发方干活：自动评审恢复，返修计数重新算", async (t) => {
  await t.test("会话在评审中异常关闭，恢复后发消息继续 → 下次停下自动评审", async () => {
    const h = harness({ restored: { enabled: true, rounds: [], repairs: 0, phase: "reviewing" } });
    try {
      await h.event("session_start");
      assert.equal(h.state().phase, "paused");
      assert.ok(h.notifications.some((text) => text.includes("给开发方发消息继续干活即恢复自动评审")));
      await h.begin("继续干活");
      assert.equal(h.state().phase, "idle");
      assert.equal(h.state().pauseReason, undefined);
      assert.ok(h.notifications.some((text) => text.includes("自动评审：已恢复（上次暂停：评审被中断")));
      h.write("file.txt", "base\nAFTER_RESUME\n");
      h.assistant("继续做完了，不写标记");
      await h.event("agent_settled"); await h.terminal();
      assert.equal(h.state().phase, "done");
      assert.equal(h.inputs.length, 1);
      assert.ok(h.inputs[0].includes("+AFTER_RESUME"));
    } finally { await h.close(); }
  });
  await t.test("【需要你决定】暂停后你回复 → 下次停下自动评审，需求原文不变", async () => {
    const h = harness();
    try {
      await h.event("session_start"); await h.begin();
      h.assistant("卡住了\n【需要你决定】");
      await h.event("agent_settled");
      assert.equal(h.state().phase, "paused");
      await h.begin("用方案 A");
      assert.equal(h.state().phase, "idle");
      h.write("file.txt", "base\nDECIDED\n");
      h.assistant("按方案 A 做完了");
      await h.event("agent_settled"); await h.terminal();
      assert.equal(h.state().phase, "done");
      assert.ok(h.inputs[0].includes("+DECIDED"));
      assert.ok(h.inputs[0].includes("ORIGINAL_REQUIREMENT"));
    } finally { await h.close(); }
  });
  await t.test("达到返修上限暂停后你接手 → 返修计数重新算，必修照常发回", async () => {
    const h = harness({ restored: { enabled: true, rounds: [], repairs: 3, phase: "paused", pauseReason: "达到返修上限" } });
    try {
      await h.event("session_start");
      await h.begin("剩下的必修你接着修");
      assert.equal(h.state().repairs, 0);
      h.write("file.txt", "base\nTAKEOVER\n");
      h.reviewer = () => result(FIX);
      h.assistant("修了\n【交付完成】");
      await h.event("agent_settled");
      await until(() => h.messages.length === 1, "返修消息");
      assert.match(h.messages[0], /第 1 次返修/);
      assert.equal(h.state().repairs, 1);
    } finally { await h.close(); }
  });
  await t.test("开会话时 git 探测异常 → 你发消息时重新探测并恢复", async () => {
    const h = harness();
    try {
      h.inject = (args) => args.includes("--git-dir") ? result("", 1, "PROBE_FAILURE") : undefined;
      await h.event("session_start");
      assert.equal(h.state().phase, "paused");
      h.inject = undefined;
      await h.begin();
      assert.equal(h.state().phase, "idle");
      h.write("file.txt", "base\nREPROBED\n");
      h.assistant("做完了");
      await h.event("agent_settled"); await h.terminal();
      assert.equal(h.state().phase, "done");
      assert.ok(h.inputs[0].includes("+REPROBED"));
    } finally { await h.close(); }
  });
  await t.test("返修消息开工不算接手：返修计数不清零", async () => {
    const h = harness();
    try {
      await h.event("session_start"); await h.begin(); h.write("file.txt", "base\nA\n");
      h.reviewer = () => result(FIX); h.assistant(); await h.command();
      await until(() => h.messages.length === 1, "返修消息");
      await h.begin(h.messages[0]);
      assert.equal(h.state().phase, "idle");
      assert.equal(h.state().repairs, 1);
    } finally { await h.close(); }
  });
});

test("扩展加载时撤掉一次性启动回报身份，自定义 start 的子进程不能再回报失败", async () => {
  const key = "AUTOREVIEW_PIPELINE_LAUNCH_TOKEN";
  const old = process.env[key];
  process.env[key] = "one-shot";
  const h = harness();
  try {
    assert.equal(process.env[key], undefined);
  } finally {
    if (old === undefined) delete process.env[key]; else process.env[key] = old;
    await h.close();
  }
});

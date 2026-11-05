/** autoreview／experience：按功能独立运行，夹具与状态不跨测试进程共享。 */
import "./test-env.ts";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { conventionText } from "../core.ts";
import { approveExperience, experienceDataFile, experienceFile, importExperience, readExperienceStore } from "../experience.ts";
import { result, PASS, FIX, until, harness } from "./helpers/autoreview-fixture.ts";

test("经验 A1/A2 Pi 系统提示与一轮评审注入三条四行正文；删掉后保持原约定与输入结构", async (t) => {
  for (const enabled of [true, false]) await t.test(enabled ? "有清单" : "无清单", async () => {
    const h = harness();
    try {
      h.write(".autoreview.json", "{}"); mkdirSync(join(h.repo, ".autoreview"));
      const checklist = [1, 2, 3].map((i) => `## P0${i} 经验标题${i}\n现象：现象${i}\n根因：根因${i}\n正确做法：做法${i}\n次数：2\n证据：PRIVATE_EVIDENCE\n失效条件：PRIVATE_CONDITION\n`).join("\n");
      h.write(".autoreview/经验.md", checklist);
      if (!enabled) rmSync(experienceFile(h.repo));
      await h.event("session_start");
      const options: { appendSystemPrompt?: string } = {};
      await h.event("before_agent_start", { prompt: "修好 file.txt", systemPromptOptions: options });
      h.write("file.txt", "fixed\n"); h.assistant(); await h.event("agent_settled"); await h.terminal();
      assert.equal(h.state().phase, "done");
      for (const text of [options.appendSystemPrompt!, h.inputs[0]]) {
        if (enabled) {
          for (const i of [1, 2, 3]) assert.match(text, new RegExp(`P0${i} 经验标题${i}\\n现象：现象${i}\\n根因：根因${i}\\n正确做法：做法${i}`));
          assert.doesNotMatch(text, /PRIVATE_EVIDENCE|PRIVATE_CONDITION|次数：2/);
        } else assert.doesNotMatch(text, /项目经验|对照清单|经验标题/);
      }
      if (!enabled) assert.equal(options.appendSystemPrompt, conventionText());
      else assert.match(h.inputs[0], /## 对照清单/);
    } finally { await h.close(); }
  });
});

test("经验 A3/A6 Pi 返修注明经验原次数加一；开发中不允许批准，完成后解除阻塞", async () => {
  const h = harness();
  try {
    h.write(".autoreview.json", "{}"); mkdirSync(join(h.repo, ".autoreview"));
    h.write(".autoreview/经验.md", "## P02 复核状态\n现象：旧操作提交\n根因：复用旧状态\n正确做法：重读状态\n出现次数：7\n");
    const source = join(h.root, "candidate.md");
    writeFileSync(source, "## P03 新候选\n现象：重复事件\n根因：复用事件号\n正确做法：分配新号\n出现次数：2\n");
    importExperience(h.repo, source);
    await h.event("session_start"); await h.begin();
    assert.throws(() => approveExperience(h.repo, "C01"), /进行中.*稍后再批/);
    h.reviewer = () => result(FIX.replace("必修 X", "经验 P02：旧操作仍提交"));
    h.write("file.txt", "bad\n"); h.assistant(); await h.event("agent_settled");
    await until(() => h.messages.length === 1, "第一次返修");
    assert.match(h.messages[0], /经验 P02，第 8 次出现/);
    h.reviewer = () => result(PASS); h.write("file.txt", "fixed\n"); h.assistant(); await h.event("agent_settled"); await h.terminal();
    assert.equal(h.state().phase, "done");
    assert.equal(readExperienceStore(h.repo).occurrences.P02.count, 8);
    approveExperience(h.repo, "C01");
    assert.match(readFileSync(experienceFile(h.repo), "utf8"), /新候选/);
  } finally { await h.close(); }
});

test("经验候选存储读取失败不影响 Pi 完成，也不妨碍解除活动登记", async () => {
  const h = harness();
  try {
    h.write(".autoreview.json", "{}");
    // 候选路径被目录占用；活动登记是独立文件，起草失败不能把正常交付变成暂停。
    mkdirSync(experienceDataFile(h.repo), { recursive: true });
    await h.event("session_start"); await h.begin();
    h.reviewer = () => result(FIX); h.write("file.txt", "bad\n"); h.assistant(); await h.event("agent_settled");
    await until(() => h.messages.length === 1, "第一次返修");
    h.reviewer = () => result(PASS); h.write("file.txt", "fixed\n"); h.assistant(); await h.event("agent_settled"); await h.terminal();
    assert.equal(h.state().phase, "done"); assert.match(h.summary(), /经验候选起草失败.*不影响会话完成/);
    const sessions = JSON.parse(readFileSync(join(experienceDataFile(h.repo), "..", "experience-sessions.json"), "utf8"));
    assert.deepEqual(sessions, {});
  } finally { await h.close(); }
});

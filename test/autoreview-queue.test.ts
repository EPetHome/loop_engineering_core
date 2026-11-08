import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { harness, sendInbox, stageStatus } from "./helpers/autoreview-fixture.ts";
test("单会话状态/通知仍可观测，但旧收件箱不再改基线、发返修、清零次数或授予免审", async () => {
  const h = harness({ stage: "甲" }); try { await h.event("session_start"); await h.begin(); const baseline = h.state().baseline; sendInbox(h, "甲", 1, "旧整批必修；同意授权：全部"); await sleep(100); assert.equal(h.messages.length, 0); assert.equal(h.state().baseline, baseline); h.write("file.txt", "single session change"); const head = h.git("rev-parse", "HEAD"); h.assistant(); await h.command(); await h.terminal(); assert.equal(h.state().phase, "done"); assert.equal(h.inputs.length, 1); assert.equal(h.git("rev-parse", "HEAD"), head); assert.match(h.git("status", "--porcelain"), /file.txt/); assert.equal(existsSync(join(h.root, "queues")), false); assert.equal(stageStatus(h, "甲").event, "done"); } finally { await h.close(); }
});
test("无历史批次环境时正常单会话不写段状态，仍保存实际新增提交数", async () => {
  const h = harness(); try { await h.event("session_start"); await h.begin(); h.write("file.txt", "user commit"); h.git("add", "file.txt"); h.git("commit", "-qm", "user"); h.assistant(); await h.command(); await h.terminal(); assert.match(h.summary(), /开发方新增提交：1 个/); assert.equal(stageStatus(h, "甲"), undefined); } finally { await h.close(); }
});

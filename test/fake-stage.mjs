#!/usr/bin/env node
/**
 * fake-stage.mjs — 流水线测试用的假段：照 pi 扩展的约定写 <段>.status.json、读 <段>.inbox.json。
 * 用法：fake-stage.mjs <行为>
 *   fix（默认）：完成后报 done；收到返修就在当前目录写 fixed-<段> 再报 done
 *   nochange：收到返修报 no-change（回复「不归我」）
 *   pause：先报暂停，过一会儿（模拟你在窗口里处理好了）再报 done
 *   silent：什么都不报（模拟启动命令没加载 autoreview.ts）
 * 环境：流水线给的 AUTOREVIEW_PIPELINE_DIR、AUTOREVIEW_STAGE；FAKE_STAGE_DELAY_MS（每步之前等多久，默认 100）。
 * 在 <流水线目录>/<段>.events.log 里记下启动、完成、收到返修、修完的时间，测试据此核对顺序。
 * 看到 <流水线目录>/pipeline.finished、流水线目录被删掉，或 60 秒后退出。
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inboxPath, readJson, writeStageStatus } from "../pipeline-core.ts";

const mode = process.argv[2] ?? "fix";
const link = { dir: process.env.AUTOREVIEW_PIPELINE_DIR, stage: process.env.AUTOREVIEW_STAGE };
const delay = Number(process.env.FAKE_STAGE_DELAY_MS ?? 100);
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const log = (what) => appendFileSync(join(link.dir, `${link.stage}.events.log`), `${Date.now()} ${what}\n`);
let inbox = 0;
const report = (event, extra = {}) => {
  if (mode !== "silent") writeStageStatus(link, { sessionId: `fake-${link.stage}`, summary: "", event, inbox, ...(event === "done" ? { readyEpoch: randomUUID() } : {}), ...extra });
};

log("launched");
report("started");
await sleep(delay);
if (mode === "pause") {
  report("paused", { pauseReason: "开发方需要你决定" });
  await sleep(delay * 3);
}
log("done");
report("done");
const until = Date.now() + 60_000;
// 流水线结束或测试清掉了目录就退出，不留进程。
while (Date.now() < until && existsSync(link.dir) && !existsSync(join(link.dir, "pipeline.finished"))) {
  const message = readJson(inboxPath(link.dir, link.stage));
  if (message && message.seq > inbox) {
    inbox = message.seq;
    log(`inbox ${message.seq}`);
    writeFileSync(join(link.dir, `${link.stage}.inbox-${message.seq}.txt`), message.message);
    await sleep(delay);
    if (mode === "nochange") {
      report("no-change", { reply: "A2：不归我：页面拿到的接口数据就是错的" });
    } else {
      writeFileSync(join(process.cwd(), `fixed-${link.stage}`), String(message.seq));
      log(`fixed ${message.seq}`);
      report("done");
    }
  }
  await sleep(20);
}

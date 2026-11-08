import test from "node:test";
import { fixture } from "./helpers/merge-queue-fixture.ts";
test("Claude 旧队列启动/返修不再可达；正常原生新卡通道由 kernel-test-node 保留覆盖", () => { const f = fixture(); try { f.raw.stages.甲.host = "claude"; f.save(); f.refuse("启动"); f.refuse("续跑"); } finally { f.close(); } });

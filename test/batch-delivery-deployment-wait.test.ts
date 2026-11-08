import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { join } from "node:path";
import test from "node:test";
import { acquireProjectExecution } from "../project-execution.ts";
import { kernelFixture } from "./helpers/kernel-fixture.ts";
test("保留项目检查/部署双向互斥：开发/暂停记录不占检查租约；只等实际登记消费者", async () => {
  const f = kernelFixture(["开发评审"]); let unlock: ((released: boolean) => void) | undefined;
  try { for (const mode of ["check", "deploy"] as const) { const first = await acquireProjectExecution(f.repo, mode, join(f.root, "first.procs.json")); let acquired = false, waiting = false; const pending = acquireProjectExecution(f.repo, mode === "check" ? "deploy" : "check", join(f.root, "second.procs.json"), undefined, undefined, () => { waiting = true; }).then((r) => { acquired = true; unlock = r; }); await sleep(150); assert.equal(waiting, true); assert.equal(acquired, false); first(true); await pending; assert.equal(acquired, true); unlock!(true); unlock = undefined; } } finally { unlock?.(true); f.cleanup(); }
});

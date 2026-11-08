import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { CONVENTION, conventionText } from "../core.ts";
import { fixture } from "./helpers/hook-fixture.ts";
for (const host of ["claude", "codex"]) for (const legacy of [false, true]) test(`${host} ${legacy ? "旧规则副本字节保护" : "无副本"}：注入单会话约定，不再暗加自动验收`, () => {
  const f = fixture({ marker: JSON.stringify({ acceptance: { start: "exit 99" } }) }), env = { AUTOREVIEW_HOST: host }, old = "<!-- autoreview:acceptance v6 -->\r\nLEGACY_COPY\r\n";
  try { if (legacy) f.write(".autoreview/CONVENTIONS.md", old); const started = JSON.parse(f.run(f.event("SessionStart"), { env }).stdout); assert.ok(started.hookSpecificOutput.additionalContext.includes(CONVENTION)); assert.ok(started.hookSpecificOutput.additionalContext.includes(conventionText({ singleNode: true }))); assert.doesNotMatch(started.hookSpecificOutput.additionalContext, /LEGACY_COPY|程序会自动验收/); f.run(f.event("UserPromptSubmit", { prompt: "做一件事" }), { env }); f.write("file.txt", "candidate"); f.run(f.delivered(), { env }); assert.equal(f.readState(host).phase, "done"); assert.equal(f.readState(host).criteria, undefined, "不自动起草验收标准"); assert.match(f.summary(host), /没验证（本次未安排）/); const copy = join(f.repo, ".autoreview/CONVENTIONS.md"); if (legacy) assert.equal(readFileSync(copy, "utf8"), old); else assert.equal(existsSync(copy), false); } finally { f.close(); }
});

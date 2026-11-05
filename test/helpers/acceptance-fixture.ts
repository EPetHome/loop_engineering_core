/** acceptance 的隔离夹具；只在调用时创建私有临时资源。 */
import "./git-runtime.ts";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AcceptanceRecord, type Criteria } from "../../acceptance-core.ts";
import { type AcceptanceDeps } from "../../acceptance.ts";
import { parseAcceptanceConfig } from "../../config.ts";
import { createChildExec } from "../../hosts/review-hook.ts";
import { renderSummary } from "../../core.ts";

export const TESTER = fileURLToPath(new URL(".././fake-tester.mjs", import.meta.url));

export const DRAFTER = fileURLToPath(new URL(".././fake-drafter.mjs", import.meta.url));

export const STALLED_TESTER = fileURLToPath(new URL(".././fake-stalled-tester.mjs", import.meta.url));

export const PARALLEL_TESTER = fileURLToPath(new URL(".././fake-parallel-tester.mjs", import.meta.url));

export const criteriaItems = [{ id: "A1", text: "操作：add\n预期：已添加" }, { id: "A2", text: "操作：list\n预期：有买菜" }];

export const evidenceOf = (map: Record<string, string>) => (id: string) => map[id];

export const block = (id: string, out: string) => `=== ${id} #1 2026-10-10T00:00:00Z\n$ todo\n退出码：0\n--- 标准输出\n${out}\n`;

export async function freePort(): Promise<number> {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolvePort(port));
    });
  });
}

export const SERVER = `
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
const port = Number(process.argv[2]);
// 假验收方的 kill 模式按这个文件找到被测系统。
if (process.env.AUTOREVIEW_RUN_DIR) writeFileSync(join(process.env.AUTOREVIEW_RUN_DIR, "server.pid"), String(process.pid));
createServer((req, res) => {
  if (req.url === "/boom") console.error("ERROR boom at " + req.url);
  if (req.url === "/crash") { console.error("ERROR crash at " + req.url); process.exit(1); }
  res.end(req.url === "/health" ? "ok" : "买菜");
}).listen(port, "127.0.0.1", () => console.log("Listening on " + port));
`;

export async function harness(acceptance: Record<string, unknown>, env: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "autoreview-acc-"));
  const work = join(root, "work");
  mkdirSync(work);
  writeFileSync(join(work, "server.mjs"), SERVER);
  const port = await freePort();
  const saved: Record<string, string | undefined> = {};
  const vars = { AUTOREVIEW_RESOURCE_ROOT: join(root, "resources"), AUTOREVIEW_ACCEPTANCE_CMD: TESTER, AUTOREVIEW_CRITERIA_CMD: DRAFTER, FAKE_STATE_DIR: join(root, "fake"), ...env };
  for (const [key, value] of Object.entries(vars)) { saved[key] = process.env[key]; process.env[key] = value.replace("{port}", String(port)); }
  const raw = JSON.parse(JSON.stringify(acceptance).replaceAll("{port}", String(port)));
  const config = parseAcceptanceConfig(raw, work, process.env)!;
  const procsFile = join(root, "procs.json");
  const state: { requirement?: string; criteria?: Criteria } = { requirement: "做待办\n## 验收标准\n1. 操作：GET /api\n   预期：返回买菜\n2. 操作：GET /boom\n   预期：返回买菜" };
  const deps = (extra: Partial<AcceptanceDeps> = {}): AcceptanceDeps => ({
    workDir: work, devSessionId: "unit", round: 1, deliveryNote: "做完了", state, config,
    reviewerModel: "m", reviewerThinking: "xhigh", exec: createChildExec(procsFile), runDir: join(root, "acc", "r1"),
    procsFile, deadline: Date.now() + 5 * 60_000, now: Date.now, previousFailed: [], saveState: () => {}, ...extra,
  });
  return {
    root, work, port, config, procsFile, state, deps,
    calls: () => existsSync(join(root, "fake", "acc-calls.log")) ? readFileSync(join(root, "fake", "acc-calls.log"), "utf8").trim().split("\n") : [],
    close: () => {
      for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export async function portOpen(port: number): Promise<boolean> {
  try { await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) }); return true; } catch { return false; }
}

export const stamped = (id: string, at: string, out: string) => `=== ${id} #1 ${at}\n$ curl\n退出码：0\n--- 标准输出\n${out}\n`;

export function acceptanceSummary(record: AcceptanceRecord): string {
  return renderSummary({ cwd: "/work", devSessionId: "dev", reviewerSessionId: "rev", status: record.verdict === "无法验收" ? "暂停" : "完成",
    pauseReason: record.reason, repairs: 0, gitStatusShort: "", rounds: [{ round: 1, startedAt: "", durationMs: record.durationMs,
      conclusion: "评审通过", mustFix: [], mustFixRaw: "无", minor: [], questions: [], recheck: [], acceptance: record }] });
}

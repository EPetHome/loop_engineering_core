/** 受管实测动作的生命周期：执行期间即留运行标记，不必等最终证据才知道工具仍在运行。 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function beginAction(runDir) {
  const call = process.env.AUTOREVIEW_ACCEPTANCE_CALL;
  // 工具仍可单独使用；受管调用必须匹配当前调用身份，过期调用不能续写活动状态。
  if (!call) return;
  if (!/^[0-9a-f-]{36}$/.test(call) || readFileSync(join(runDir, "call-id"), "utf8").trim() !== call) throw new Error("过期或无效的验收调用");
  const started = spawnSync("ps", ["-o", "lstart=", "-p", String(process.pid)], { encoding: "utf8", timeout: 5000 });
  if (started.status !== 0 || !started.stdout.trim()) throw new Error("无法确认实测工具进程身份");
  const dir = join(runDir, "active-actions", call);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${randomUUID()}.json`), temporary = `${file}.tmp`;
  writeFileSync(temporary, JSON.stringify({ call, pid: process.pid, started: started.stdout.trim() }));
  renameSync(temporary, file);
  process.once("exit", () => rmSync(file, { force: true }));
}

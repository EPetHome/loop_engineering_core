/** 暂停信息共用结构；原始现场按唯一文件保留，后续总结只能引用、不能覆盖。 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export interface PauseDetail { reason: string; error?: string; question?: string; action: string; evidence?: string }
export function developerQuestion(reply?: string): string | undefined {
  return reply && /[?？]|【需要你决定】|(?:请|需要).{0,30}(?:确认|授权|选择|决定)/s.test(reply) ? reply : undefined;
}
export function pauseAction(reason: string): string {
  if (/开发方需要你决定|对验收标准有异议/.test(reason)) return "请在原开发会话答复问题或明确决定，再继续。";
  if (/评审失败|内部错误|无法读取工作区/.test(reason)) return "请核对错误原文与材料，修复评审入口或 Loop 内部故障后，在原会话继续；不要把内部错误当作产品返修。";
  if (/返修上限/.test(reason)) return "请查看未解决项，决定是否继续返修，并在原会话明确下一步。";
  return "请按上述具体原因和材料处理阻塞，再在原开发会话继续；当前成果与业务计数保留。";
}
export function pauseText(detail: PauseDetail): string {
  return [`卡在哪：${detail.reason}`, ...(detail.error ? [`原因原文：\n${detail.error}`] : []),
    ...(detail.question ? [`开发方的问题原文：\n${detail.question}`] : []), `需要你做：${detail.action}`,
    ...(detail.evidence ? [`原始现场：${detail.evidence}`] : [])].join("\n");
}
export function preservePause(dir: string, detail: PauseDetail): string {
  const path = join(dir, "blockers", `${randomUUID()}.json`);
  mkdirSync(join(dir, "blockers"), { recursive: true });
  writeFileSync(path, JSON.stringify({ at: new Date().toISOString(), ...detail }, null, 2), { flag: "wx", mode: 0o600 });
  return path;
}

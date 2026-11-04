/** 只记录 Loop 配置改了哪些字段，不把凭证值抄到总结。 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { findProjectRoot, MARKER_FILE } from "./config.ts";

export interface ConfigMark { path: string; text: string }
export interface ConfigChange { path: string; at: string; fields: string[] }
export interface ConfigAudit { loopConfigMark?: ConfigMark; loopConfigChanges?: ConfigChange[] }
export function loopConfigMark(cwd: string): ConfigMark | undefined {
  const root = findProjectRoot(cwd);
  return root ? { path: join(root, MARKER_FILE), text: readFileSync(join(root, MARKER_FILE), "utf8") } : undefined;
}
export function auditLoopConfig(state: ConfigAudit, cwd: string): void {
  const old = state.loopConfigMark;
  const current = old ? { path: old.path, text: existsSync(old.path) ? readFileSync(old.path, "utf8") : "" } : loopConfigMark(cwd);
  if (old && current && old.text !== current.text) {
    const fields: string[] = [];
    const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
    const diff = (a: unknown, b: unknown, path: string): void => {
      if (JSON.stringify(a) === JSON.stringify(b)) return;
      if (object(a) && object(b)) for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) diff(a[key], b[key], path ? `${path}.${key}` : key);
      else fields.push(path || "（整个配置）");
    };
    try { diff(JSON.parse(old.text), JSON.parse(current.text), ""); }
    catch { fields.push(current.text ? "（JSON 无法解析）" : "（配置被删除）"); }
    if (fields.length) (state.loopConfigChanges ??= []).push({ path: old.path, fields, at: new Date().toISOString() });
  }
  state.loopConfigMark = current;
}

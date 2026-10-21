/** 准备模型只可改项目声明的准备文件；不授予 shell 或业务实现权限。 */
import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function mayPrepareWrite(root: string, paths: string[], target: string): boolean {
  const base = realpathSync(root);
  // macOS 的 /var、/tmp 自身是别名；只归一化已确认的项目根，不跟随项目内部链接。
  const requested = resolve(root, target);
  const fromRoot = relative(resolve(root), requested);
  const path = fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot) ? resolve(base, fromRoot) : requested;
  const rel = relative(base, path);
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)
    || /(^|[/\\])(AGENTS\.md|CLAUDE\.md|\.git|\.autoreview\.json)([/\\]|$)/.test(rel)) return false;
  for (let part = path; part !== base; part = dirname(part)) {
    try { if (lstatSync(part).isSymbolicLink()) return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false; }
  }
  return paths.some((allowed) => {
    const entry = resolve(base, allowed);
    return path === entry || path.startsWith(`${entry}${sep}`);
  });
}

export default function preparationGuard(pi: ExtensionAPI): void {
  const root = process.env.AUTOREVIEW_PREP_ROOT;
  let paths: string[] = [];
  try { paths = JSON.parse(process.env.AUTOREVIEW_PREP_PATHS ?? "[]"); } catch { /* block writes */ }
  pi.on("tool_call", async (event, ctx) => {
    if (["read", "grep", "find", "ls"].includes(event.toolName)) return;
    if ((event.toolName === "edit" || event.toolName === "write") && root && Array.isArray(paths)
      && paths.every((p) => typeof p === "string") && typeof event.input.path === "string"
      && mayPrepareWrite(root, paths, resolve(ctx.cwd, event.input.path))) return;
    return { block: true, reason: "准备模型只能修改本任务声明的准备文件，不能执行 shell 或修改稳定规则、业务代码和配置。" };
  });
}

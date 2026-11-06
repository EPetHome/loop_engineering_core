/** 第 1 步开发卡；全部校验都是只读，必须早于创建任何运行资源。 */
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { gitResult, gitText } from "./workspace.ts";
import { parseStageScope, type StageScope } from "./scope.ts";

export const NODE_NAMES = ["开发评审", "评审", "测试", "验收", "提交", "部署"] as const;
export type NodeName = typeof NODE_NAMES[number];
export interface DevelopmentCard {
  version: 1; name: string; nature: "开发"; base: string; target: "dev"; flow: NodeName[];
  host: "pi" | "claude" | "codex";
  tasks: [{ name: string; prompt: string; scope: StageScope }];
  limits: { 开发评审: { maxRepairs: number; timeoutMin: number } };
}
export const digest = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const object = (v: unknown, label: string): Record<string, any> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${label} 必须是对象`);
  return v as Record<string, any>;
};
const text = (v: unknown, label: string): string => {
  if (typeof v !== "string" || !v.trim() || /[\0\r\n]/.test(v)) throw new Error(`${label} 必须是非空单行字符串`);
  return v.trim();
};
export function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
}
export function readDevelopmentCard(file: string, repo: string): { card: DevelopmentCard; hash: string; content: string } {
  const content = readFileSync(file, "utf8"), raw = object(JSON.parse(content), "开发卡");
  if (["stages", "workflow", "steps", "workspaces", "recipe"].some((k) => Object.hasOwn(raw, k))) {
    throw new Error("旧批次格式已停用：请新建 version:1 开发卡；stages 改为 tasks（prompt、scope），workflow/steps 改为 flow:[开发评审,提交]，不再填写 workspaces；不回退旧引擎");
  }
  if (raw.version !== 1) throw new Error("开发卡 version 必须是 1");
  const allowed = new Set(["version", "name", "nature", "base", "target", "host", "flow", "tasks", "limits"]);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new Error(`开发卡字段尚不支持：${key}`);
  if (!Array.isArray(raw.flow) || !raw.flow.length) throw new Error("flow 必须是非空节点数组");
  const flow = raw.flow.map((v: unknown) => text(v, "flow 节点"));
  if (!flow.some((v: string) => v === "开发评审" || v === "评审")) throw new Error("底线违规：必须包含开发评审或评审；开发卡请以开发评审开始");
  if (new Set(flow).size !== flow.length) throw new Error("编排不合法：flow 节点重复");
  for (const v of flow) if (!(NODE_NAMES as readonly string[]).includes(v)) throw new Error(`未知节点：${v}；固定节点：${NODE_NAMES.join("、")}`);
  const review = flow.indexOf("开发评审");
  if (flow.some((n: string, i: number) => ["测试", "验收"].includes(n) && (review < 0 || i < review))
    || (flow.includes("提交") && (review > flow.indexOf("提交") || flow.some((n: string, i: number) => ["测试", "验收"].includes(n) && i > flow.indexOf("提交"))))
    || (flow.includes("部署") && (!flow.includes("提交") || flow.indexOf("部署") < flow.indexOf("提交")))) throw new Error("底线违规：检查必须在开发评审之后，提交在检查之后，部署在提交之后");
  if (!Array.isArray(raw.tasks) || !raw.tasks.length) throw new Error("tasks 必须是非空任务数组");
  const names = raw.tasks.map((v: unknown) => text(object(v, "任务").name, "任务名"));
  if (new Set(names).size !== names.length) throw new Error("任务重名");
  if (raw.tasks.length > 1 && !flow.includes("验收")) throw new Error("底线违规：并行批次必须带验收节点；第 3 步上线后才能运行多任务卡");
  const unavailable = flow.filter((v: string) => !["开发评审", "提交"].includes(v));
  if (unavailable.length) throw new Error(`本版本尚未支持节点：${unavailable.join("、")}；第 1 步只支持 [开发评审] 或 [开发评审,提交]`);
  if (raw.tasks.length !== 1) throw new Error("本版本尚未支持多任务（第 3 步上线）");
  if (raw.nature !== "开发") throw new Error("本版本只支持 nature:开发；测试性质与底线例外尚未上线");
  if (flow[0] !== "开发评审" || flow.length > 2) throw new Error("编排不合法：第 1 步只支持 [开发评审] 或 [开发评审,提交]");
  if (raw.target !== "dev") throw new Error("第 1 步 target 必须是 dev；禁止 main，不覆盖其他发布分支");
  const base = text(raw.base ?? raw.target, "base");
  if (/^(?:refs\/heads\/)?main$/.test(base) || gitResult(repo, ["check-ref-format", "--branch", base]).status !== 0) throw new Error(`base 分支非法或受保护：${base}`);
  gitText(repo, ["rev-parse", "--verify", "--end-of-options", `refs/heads/${base}^{commit}`]);
  gitText(repo, ["rev-parse", "--verify", "refs/heads/dev^{commit}"]);
  const task = object(raw.tasks[0], "任务");
  for (const key of Object.keys(task)) if (!["name", "prompt", "scope"].includes(key)) throw new Error(`本版本尚不支持任务字段：${key}`);
  const rawPrompt = text(task.prompt, "prompt");
  if (isAbsolute(rawPrompt)) throw new Error("prompt 必须相对卡文件目录");
  const prompt = realpathSync(resolve(dirname(file), rawPrompt));
  if (!inside(realpathSync(repo), prompt) || !statSync(prompt).isFile() || statSync(prompt).size > 200 * 1024 || readFileSync(prompt).includes(0)) throw new Error(`prompt 越出仓库或不是 <=200KB 文本：${prompt}`);
  const scope = parseStageScope(Array.isArray(task.scope) ? { allow: task.scope } : task.scope, "任务 scope");
  if (!scope?.allow?.length || scope.allow.some((v) => !v)) throw new Error("任务 scope 必须明确列出非空允许路径（数组或 {allow,deny}），不能默认提交整个工作区");
  const limits = raw.limits === undefined ? {} : object(raw.limits, "limits");
  for (const key of Object.keys(limits)) if (key !== "开发评审") throw new Error(`本版本尚不支持限额：${key}`);
  const limit = limits.开发评审 === undefined ? {} : object(limits.开发评审, "开发评审限额");
  for (const key of Object.keys(limit)) if (!["maxRepairs", "timeoutMin"].includes(key)) throw new Error(`未知限额字段：${key}`);
  const maxRepairs = limit.maxRepairs ?? 4, timeoutMin = limit.timeoutMin ?? 60;
  if (!Number.isSafeInteger(maxRepairs) || maxRepairs < 0 || !Number.isSafeInteger(timeoutMin) || timeoutMin < 1) throw new Error("开发评审 maxRepairs 须为非负整数，timeoutMin 须为正整数");
  const host = raw.host ?? "pi";
  if (!["pi", "claude", "codex"].includes(host)) throw new Error("host 必须是 pi、claude 或 codex");
  return { content, hash: digest(content), card: { version: 1, name: text(raw.name, "name"), nature: "开发", base, target: "dev", flow: flow as NodeName[], host,
    tasks: [{ name: names[0], prompt, scope }], limits: { 开发评审: { maxRepairs, timeoutMin } } } };
}

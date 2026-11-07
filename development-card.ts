/** 开发卡：全部校验只读，早于创建任何运行资源。 */
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { gitResult, gitText } from "./workspace.ts";
import { parseStageScope, type StageScope } from "./scope.ts";
import { extractCriteria, isManualCriterion, MAX_CRITERIA, type CriterionItem } from "./acceptance-core.ts";
export function inside(root: string, path: string): boolean {
  const rel = relative(root, path); return rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
}

export const NODE_NAMES = ["开发评审", "评审", "测试", "验收", "提交", "部署"] as const;
export type NodeName = typeof NODE_NAMES[number];
export interface CheckLimit { maxRepairs: number; timeoutMin: number; maxRecoveries: number }
export interface DevelopmentTask { name: string; prompt: string; scope: StageScope; test?: string; limits?: { 验收: { maxRepairs: number } } }
export interface DevelopmentCard {
  version: 1; name: string; nature: "开发"; base: string; target: "dev"; flow: NodeName[];
  host: "pi" | "claude" | "codex"; tasks: DevelopmentTask[]; acceptance?: string;
  limits: { 开发评审: { maxRepairs: number; timeoutMin: number }; 测试: CheckLimit; 验收: CheckLimit };
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
function relativeText(value: unknown, file: string, repo: string, label: string): string {
  const raw = text(value, label);
  if (isAbsolute(raw)) throw new Error(`${label} 必须相对卡文件目录`);
  const path = realpathSync(resolve(dirname(file), raw)), info = statSync(path);
  if (!inside(realpathSync(repo), path) || !info.isFile() || info.size > 200 * 1024 || readFileSync(path).includes(0)) throw new Error(`${label} 越出仓库或不是 <=200KB 文本：${path}`);
  return path;
}
/** 归属只取条目前导标签，不从操作正文猜任务。移出任务保留在 known 中供历史标准核对。 */
export function ownedCriteria(file: string, known: string[]): { items: CriterionItem[]; owners: Record<string, string>; hash: string; content: string } {
  const content = readFileSync(file, "utf8"), items = extractCriteria(content);
  if (!items?.length) throw new Error(`验收标准为空：${file}；请填写 ## 验收标准 及操作/预期条目`);
  if (items.length > MAX_CRITERIA) throw new Error(`验收标准最多 ${MAX_CRITERIA} 条`);
  const owners: Record<string, string> = {};
  for (const item of items) {
    const prefix = item.text.match(/^\s*(?:(?:\[[^\]\n]+\]|【[^】\n]+】)\s*)+/)?.[0] ?? "";
    if (!item.text.slice(prefix.length).replace(/(?:操作|预期)\s*[:：]/g, "").trim()) throw new Error(`${item.id} 验收标准为空；请补充操作和预期，不能只写标签`);
    if (isManualCriterion(item.text)) continue;
    const tags = [...prefix.matchAll(/[\[【]([^\]】]+)[\]】]/g)].map((m) => m[1].trim()).filter((s) => !["授权", "人工"].includes(s));
    if (tags.length !== 1 || !known.includes(tags[0])) throw new Error(`${item.id}「${item.text.split("\n")[0]}」归属${tags.length === 0 ? "缺失" : tags.length > 1 ? "多义" : "未知"}；请仅标一个已存在任务 [${known.join(" / ")}]，跨任务条目也指定一个责任任务`);
    owners[item.id] = tags[0];
  }
  return { items, owners, hash: digest(content), content };
}
function checkLimit(raw: unknown, label: string): CheckLimit {
  const v = raw === undefined ? {} : object(raw, `${label}限额`);
  for (const key of Object.keys(v)) if (!["maxRepairs", "timeoutMin", "maxRecoveries"].includes(key)) throw new Error(`未知${label}限额字段：${key}`);
  const limit = { maxRepairs: v.maxRepairs ?? 3, timeoutMin: v.timeoutMin ?? 20, maxRecoveries: v.maxRecoveries ?? 1 };
  if (!Number.isSafeInteger(limit.maxRepairs) || limit.maxRepairs < 0 || !Number.isSafeInteger(limit.maxRecoveries) || limit.maxRecoveries < 0 || !Number.isSafeInteger(limit.timeoutMin) || limit.timeoutMin < 1) throw new Error(`${label} maxRepairs/maxRecoveries 须为非负整数，timeoutMin 须为正整数`);
  return limit;
}
export function readDevelopmentCard(file: string, repo: string) { return parseDevelopmentCard(readFileSync(file, "utf8"), file, repo); }
export function parseDevelopmentCard(content: string, file: string, repo: string, retired: string[] = []): { card: DevelopmentCard; hash: string; content: string } {
  const raw = object(JSON.parse(content), "开发卡");
  if (["stages", "workflow", "steps", "workspaces", "recipe"].some((k) => Object.hasOwn(raw, k))) throw new Error("旧批次格式已停用：请新建 version:1 开发卡；stages 改为 tasks（prompt、scope），workflow/steps 改为 flow:[开发评审,提交]，不再填写 workspaces；不回退旧引擎");
  if (raw.version !== 1) throw new Error("开发卡 version 必须是 1");
  for (const key of Object.keys(raw)) if (!["version", "name", "nature", "base", "target", "host", "flow", "tasks", "limits", "acceptance"].includes(key)) throw new Error(`开发卡字段尚不支持：${key}`);
  if (!Array.isArray(raw.flow) || !raw.flow.length) throw new Error("flow 必须是非空节点数组");
  const flow = raw.flow.map((v: unknown) => text(v, "flow 节点")) as NodeName[];
  if (!flow.some((v) => v === "开发评审" || v === "评审")) throw new Error("底线违规：必须包含开发评审或评审；开发卡请以开发评审开始");
  if (new Set(flow).size !== flow.length) throw new Error("编排不合法：flow 节点重复");
  for (const v of flow) if (!(NODE_NAMES as readonly string[]).includes(v)) throw new Error(`未知节点：${v}；固定节点：${NODE_NAMES.join("、")}`);
  const order = ["开发评审", "测试", "验收", "提交"];
  const unavailable = flow.filter((v) => !order.includes(v));
  if (unavailable.length) throw new Error(`本版本尚未支持节点：${unavailable.join("、")}`);
  if (flow[0] !== "开发评审" || flow.some((v, i) => i > 0 && order.indexOf(v) < order.indexOf(flow[i - 1]))) throw new Error("底线违规：必须开发评审 → 可选测试 → 可选验收 → 可选提交，检查必须在开发评审之后，不能逆序");
  if (!Array.isArray(raw.tasks) || !raw.tasks.length) throw new Error("tasks 必须是非空任务数组");
  const names: string[] = raw.tasks.map((v: unknown) => text(object(v, "任务").name, "任务名"));
  if (new Set(names).size !== names.length) throw new Error("任务重名");
  if (raw.tasks.length > 1 && !flow.includes("验收")) throw new Error("底线违规：并行批次必须带验收节点；请添加验收及逐条任务归属");
  if (raw.nature !== "开发") throw new Error("本版本只支持 nature:开发；测试性质与底线例外尚未上线");
  if (raw.target !== "dev") throw new Error("target 必须是 dev；禁止 main，不覆盖其他发布分支");
  const base = text(raw.base ?? raw.target, "base");
  if (/^(?:refs\/heads\/)?main$/.test(base) || gitResult(repo, ["check-ref-format", "--branch", base]).status !== 0) throw new Error(`base 分支非法或受保护：${base}`);
  gitText(repo, ["rev-parse", "--verify", "--end-of-options", `refs/heads/${base}^{commit}`]);
  gitText(repo, ["rev-parse", "--verify", "refs/heads/dev^{commit}"]);
  const tasks: DevelopmentTask[] = raw.tasks.map((v: unknown, i: number) => {
    const task = object(v, "任务");
    for (const key of Object.keys(task)) if (!["name", "prompt", "scope", "test", "limits"].includes(key)) throw new Error(`本版本尚不支持任务字段：${key}`);
    const prompt = relativeText(task.prompt, file, repo, "prompt");
    const scope = parseStageScope(Array.isArray(task.scope) ? { allow: task.scope } : task.scope, `任务 ${names[i]} scope`);
    if (!scope?.allow?.length || scope.allow.some((v) => !v)) throw new Error("任务 scope 必须明确列出非空允许路径（数组或 {allow,deny}），不能默认提交整个工作区");
    if (task.test !== undefined) text(task.test, `任务 ${names[i]} test 测试命令`);
    const test = task.test === undefined ? undefined : /^无\s*[:：]/.test(task.test.trim()) ? task.test.trim() : task.test;
    if (flow.includes("测试") && !test) throw new Error(`测试节点必须填写任务 ${names[i]} test 测试命令或「无：原因」`);
    if (test && /^无\s*[:：]/.test(test) && !/^无[:：]\s*\S/.test(test)) throw new Error("无测试必须填写「无：非空原因」");
    let limits: DevelopmentTask["limits"];
    if (task.limits !== undefined) {
      const l = object(task.limits, "任务限额"), a = object(l.验收, "任务验收限额");
      if (Object.keys(l).some((k) => k !== "验收") || Object.keys(a).some((k) => k !== "maxRepairs") || !Number.isSafeInteger(a.maxRepairs) || a.maxRepairs < 0) throw new Error("任务仅支持 limits.验收.maxRepairs 非负整数覆盖");
      limits = { 验收: { maxRepairs: a.maxRepairs } };
    }
    return { name: names[i], prompt, scope, ...(test ? { test } : {}), ...(limits ? { limits } : {}) };
  });
  const acceptance = raw.acceptance === undefined ? undefined : relativeText(raw.acceptance, file, repo, "acceptance");
  if (flow.includes("验收") && !acceptance) throw new Error("验收节点必须填写 acceptance 相对标准文件路径，包含 ## 验收标准 及 [任务名] 归属");
  if (acceptance) ownedCriteria(acceptance, [...new Set([...names, ...retired])]);
  const limits = raw.limits === undefined ? {} : object(raw.limits, "limits");
  for (const key of Object.keys(limits)) if (!["开发评审", "测试", "验收"].includes(key)) throw new Error(`本版本尚不支持限额：${key}`);
  const review = limits.开发评审 === undefined ? {} : object(limits.开发评审, "开发评审限额");
  for (const key of Object.keys(review)) if (!["maxRepairs", "timeoutMin"].includes(key)) throw new Error(`未知限额字段：${key}`);
  const maxRepairs = review.maxRepairs ?? 4, timeoutMin = review.timeoutMin ?? 60;
  if (!Number.isSafeInteger(maxRepairs) || maxRepairs < 0 || !Number.isSafeInteger(timeoutMin) || timeoutMin < 1) throw new Error("开发评审 maxRepairs 须为非负整数，timeoutMin 须为正整数");
  const host = raw.host ?? "pi";
  if (!["pi", "claude", "codex"].includes(host)) throw new Error("host 必须是 pi、claude 或 codex");
  return { content, hash: digest(content), card: { version: 1, name: text(raw.name, "name"), nature: "开发", base, target: "dev", flow, host, tasks, ...(acceptance ? { acceptance } : {}),
    limits: { 开发评审: { maxRepairs, timeoutMin }, 测试: checkLimit(limits.测试, "测试"), 验收: checkLimit(limits.验收, "验收") } } };
}

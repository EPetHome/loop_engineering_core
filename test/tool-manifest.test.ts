/** 现用入口/新卡字段/配置双向一致；源码增删字段而未改文档必须失败。 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
const ROOT = fileURLToPath(new URL("..", import.meta.url)), read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const quoted = (s: string): string[] => [...s.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
function section(md: string, heading: string): string {
  const start = md.indexOf(heading + "\n"); assert.ok(start >= 0, `缺标题 ${heading}`); const rest = md.slice(start + heading.length + 1), level = /^#+/.exec(heading)![0].length; const lines = rest.split("\n"), end = lines.findIndex((l) => { const m = /^(#+) /.exec(l); return m && m[1].length <= level; }); return lines.slice(0, end < 0 ? undefined : end).join("\n");
}
function table(md: string): Set<string> {
  return new Set(md.split("\n").filter((l) => /^\|/.test(l)).map((l) => l.split("|")[1].replace(/`/g, "").trim()).filter((k) => k && !["字段", "配置"].includes(k) && !/^:?-+:?$/.test(k)));
}
function compare(code: Set<string>, doc: Set<string>): void { assert.deepEqual([...code].filter((k) => !doc.has(k)).sort(), [], "文档缺少源码字段"); assert.deepEqual([...doc].filter((k) => !code.has(k)).sort(), [], "文档多出已不解析字段"); }
function body(source: string, signature: string): string {
  const start = source.indexOf(signature); assert.ok(start >= 0, `缺函数 ${signature}`); let at = source.indexOf("(", start), depth = 0, quote = "", escaped = false;
  for (; at < source.length; at++) { const c = source[at]; if (quote) { if (escaped) escaped = false; else if (c === "\\") escaped = true; else if (c === quote) quote = ""; continue; } if ('"\'`'.includes(c)) quote = c; else if (c === "(") depth++; else if (c === ")" && --depth === 0) break; }
  const open = source.indexOf("{", at); depth = 0; quote = ""; escaped = false;
  for (at = open; at < source.length; at++) { const c = source[at]; if (quote) { if (escaped) escaped = false; else if (c === "\\") escaped = true; else if (c === quote) quote = ""; continue; } if ('"\'`'.includes(c)) quote = c; else if (c === "{") depth++; else if (c === "}" && --depth === 0) return source.slice(open, at + 1); }
  throw new Error("函数体未闭合");
}
function keys(text: string, variable: string): Set<string> {
  const result = new Set([...text.matchAll(new RegExp(`\\b${variable}\\.([A-Za-z_$][\\w$]*)`, "g"))].map((m) => m[1]));
  for (const m of text.matchAll(new RegExp(`\\b(?:nonNegativeInt|nonEmptyString|optionalString|stringList|positiveInt|number|string|object|text)\\(\\s*${variable}\\s*,\\s*"([^"]+)"`, "g"))) result.add(m[1]);
  return result;
}
function configFields(source = read("config.ts")): Set<string> {
  const fields = keys(body(source, "export function parseProjectLayout"), "raw"), review = keys(body(source, "export function resolveProjectConfig"), "data"); for (const k of review) fields.add(k); fields.add("gate");
  for (const [name, signature] of [["methods", "export function parseMethodsConfig"], ["acceptance", "export function parseAcceptanceConfig"], ["deployment", "export function parseDeploymentConfig"], ["preparation", "export function parsePreparation"], ["context", "export function parseContext"]]) {
    const b = body(source, signature); for (const k of keys(b, "data")) fields.add(`${name}.${k}`);
    if (name === "methods") for (const m of b.matchAll(/command\("([^"]+)"\)/g)) fields.add(`methods.${m[1]}`);
    if (name === "deployment") for (const k of quoted(/for \(const key of \[([^\]]+)\] as const\)/.exec(b)?.[1] ?? "")) fields.add(`deployment.${k}`);
    if (name === "preparation") for (const k of keys(b, "r")) fields.add(`preparation.repair.${k}`);
    if (name === "context") { fields.add("context.sources[]"); for (const k of keys(b, "source")) fields.add(`context.sources[].${k}`); }
  }
  return fields;
}
test("当前工具入口与真实 CLI 双向一致；旧入口仅诊断，不列成执行命令", () => {
  const source = read("loop.ts"), code = new Set([...source.matchAll(/args\.command === "([^"]+)"/g)].map((m) => m[1]));
  for (const m of read("bin/loop").matchAll(/\$\{1:-\}" == "([^"]+)"/g)) code.add(m[1]);
  for (const k of quoted(/!\[([^\]]+)\]\.includes\(command\)/.exec(read("kernel-cli.ts"))![1])) code.add(k);
  const rows = section(read("工具清单.md"), "### 子命令").split("\n").filter((l) => /^\| [\u4e00-\u9fff]/.test(l)).map((l) => l.split("|")[1].trim()).filter((k) => k !== "子命令"); compare(code, new Set(rows));
});
test("开发卡与任务字段来自真正解析白名单，不再抽取已删除 parsePlan", () => {
  const source = read("development-card.ts"), doc = read("工具清单.md");
  for (const [variable, heading] of [["raw", "## 开发卡字段（第4步）"], ["task", "### tasks[]"]]) { const match = new RegExp(`Object\\.keys\\(${variable}\\)\\) if \\(!\\[([^\\]]+)\\]\\.includes\\(key\\)`).exec(source); assert.ok(match); compare(new Set(quoted(match[1])), table(section(doc, heading).split("###")[0])); }
  for (const name of ["开发评审", "评审", "测试", "验收", "提交", "部署"]) assert.ok(doc.includes(name));
});
test("配置字段（含 helper/嵌套模型和来源）与现用表双向一致，废弃字段另作迁移说明", () => {
  const doc = table(section(read("工具清单.md"), "## .autoreview.json 字段")); compare(configFields(), doc);
  const added = configFields(read("config.ts").replace('reviewTimeoutMin = nonNegativeInt(data, "reviewTimeoutMin", DEFAULT_TIMEOUT_MIN);', 'reviewTimeoutMin = nonNegativeInt(data, "newBudget", DEFAULT_TIMEOUT_MIN);')); assert.throws(() => compare(added, doc), /文档缺少|文档多出/);
  const deleted = new Set(configFields()); deleted.delete("acceptance.timeoutMin"); assert.throws(() => compare(deleted, doc), /文档多出/);
});
test("帮助与现用说明指向新卡/单会话；不得推荐旧 workflow 或 accept-cmd 执行", () => {
  for (const p of ["README.md", "工具清单.md", "项目文档/运行与维护.md", "项目模板/README.md"]) { const text = read(p); assert.match(text, /bin\/loop 开发/); assert.match(text, /bin\/loop 接入/); assert.match(text, /已停用|已删除/); assert.doesNotMatch(text, /验收预算必须小于|定向复验通过后立即补做|旧批次引擎内部保留|accept-cmd 默认 required/); }
});

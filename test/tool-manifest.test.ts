/**
 * 工具清单一致性：子命令和字段从代码的解析定义里取，与 工具清单.md 对照。
 * 任一边新增或删除而另一边没跟上，测试失败并列出缺项/多项。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");
const KEY = "[A-Za-z_$][\\w$]*";

/** 取函数体（从声明后的第一个 { 到匹配的 }）；忽略字符串内的花括号。 */
function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `源码里找不到 ${signature}`);
  const paren = source.indexOf("(", start);
  assert.ok(paren >= 0, `${signature} 没有参数列表`);
  let parenDepth = 0;
  let quote = "";
  let escaped = false;
  let bodyStart = -1;
  for (let index = paren; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") { quote = char; continue; }
    if (char === "(") parenDepth += 1;
    else if (char === ")") {
      parenDepth -= 1;
      if (parenDepth === 0) { bodyStart = index + 1; break; }
    }
  }
  assert.ok(bodyStart >= 0, `${signature} 的参数列表没有闭合`);
  const open = source.indexOf("{", bodyStart);
  assert.ok(open >= 0, `${signature} 后面没有函数体`);
  let depth = 0;
  quote = "";
  escaped = false;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") { quote = char; continue; }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  throw new Error(`${signature} 的函数体没有闭合`);
}

function directKeys(body: string, variables: string[]): Set<string> {
  const keys = new Set<string>();
  for (const variable of variables) {
    for (const match of body.matchAll(new RegExp(`\\b${variable}\\.(${KEY})`, "g"))) keys.add(match[1]);
  }
  return keys;
}

function helperKeys(body: string, variables: string[]): Set<string> {
  const keys = new Set<string>();
  const helpers = "nonNegativeInt|nonEmptyString|optionalString|stringList|positiveInt|number|string|object|text";
  for (const variable of variables) {
    for (const match of body.matchAll(new RegExp(`\\b(?:${helpers})\\(\\s*${variable}\\s*,\\s*"([^"]+)"`, "g"))) keys.add(match[1]);
  }
  return keys;
}

function headingLevel(line: string): number {
  const match = /^(#{1,6})\s/.exec(line);
  return match ? match[1].length : 0;
}

/** 取某个标题下、下一个同级或更高级标题之前的内容。 */
function section(markdown: string, heading: string): string {
  const lines = markdown.split(/\r?\n/);
  const level = headingLevel(heading);
  const start = lines.findIndex((line) => line.trim() === heading);
  assert.ok(start >= 0, `工具清单里缺少标题：${heading}`);
  let end = start + 1;
  while (end < lines.length) {
    const next = headingLevel(lines[end]);
    if (next > 0 && next <= level) break;
    end += 1;
  }
  return lines.slice(start + 1, end).join("\n");
}

/** 取 markdown 表格的第一列；只用于清单里的字段/子命令表。 */
function tableFirstColumn(text: string): Set<string> {
  const keys = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    const cells = trimmed.replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
    const key = (cells[0] ?? "").replace(/`/g, "").trim();
    if (!key || ["字段", "子命令", "选项", "变量", "退出码", "标记/退出码"].includes(key)) continue;
    if (/^:?-+:?$/.test(key)) continue;
    keys.add(key);
  }
  return keys;
}

function differences(code: Set<string>, doc: Set<string>): { missing: string[]; extra: string[] } {
  return {
    missing: [...code].filter((item) => !doc.has(item)).sort(),
    extra: [...doc].filter((item) => !code.has(item)).sort(),
  };
}

function compare(label: string, code: Set<string>, doc: Set<string>): void {
  const { missing, extra } = differences(code, doc);
  assert.deepEqual(missing, [], `${label}：工具清单缺少 ${missing.join("、")}`);
  assert.deepEqual(extra, [], `${label}：工具清单多出 ${extra.join("、")}（代码里没有解析定义）`);
}

type Sources = Record<string, string>;

function realSources(): Sources {
  return {
    "pipeline.ts": read("pipeline.ts"),
    "scope.ts": read("scope.ts"),
    "config.ts": read("config.ts"),
    "preparation.ts": read("preparation.ts"),
    "project-context.ts": read("project-context.ts"),
    "hosts/hook.ts": read("hosts/hook.ts"),
  };
}

function batchFields(sources: Sources = realSources()): Set<string> {
  const pipeline = sources["pipeline.ts"];
  const parsePlan = functionBody(pipeline, "export function parsePlan");
  const piOptions = functionBody(pipeline, "function piOptions");
  const scope = functionBody(sources["scope.ts"], "export function parseStageScope");

  const fields = new Set<string>();
  for (const key of directKeys(parsePlan, ["raw"])) fields.add(key);
  for (const match of parsePlan.matchAll(new RegExp(`\\braw\\.e2e\\.(${KEY})`, "g"))) fields.add(`e2e.${match[1]}`);

  const stage = directKeys(parsePlan, ["value"]);
  const pi = directKeys(piOptions, ["value"]);
  for (const key of helperKeys(piOptions, ["value"])) pi.add(key);
  for (const match of piOptions.matchAll(/\bpick\("([^"]+)"\)/g)) pi.add(match[1]);
  for (const key of pi) {
    fields.add(`pi.${key}`);
    fields.add(`stages.<段>.${key}`);
  }
  for (const match of piOptions.matchAll(new RegExp(`\\bvalue\\.ponytail\\.(${KEY})`, "g"))) {
    fields.add(`pi.ponytail.${match[1]}`);
    fields.add(`stages.<段>.ponytail.${match[1]}`);
  }
  fields.add("stages.<段>");
  for (const key of stage) fields.add(`stages.<段>.${key}`);
  for (const key of directKeys(scope, ["raw"])) fields.add(`stages.<段>.scope.${key}`);
  return fields;
}

function autoreviewFields(sources: Sources = realSources()): Set<string> {
  const config = sources["config.ts"];
  const layout = functionBody(config, "export function parseProjectLayout");
  const methods = functionBody(config, "export function parseMethodsConfig");
  const acceptance = functionBody(config, "export function parseAcceptanceConfig");
  const gate = functionBody(config, "export function parseGateConfig");
  const preparation = functionBody(sources["preparation.ts"], "export function parsePreparation");
  const repair = functionBody(preparation, "if (data.repair !== undefined)");
  const context = functionBody(sources["project-context.ts"], "export function parseContext");
  const review = functionBody(sources["hosts/hook.ts"], "export function loadConfig");

  const fields = new Set<string>();
  for (const key of new Set([...directKeys(layout, ["raw"]), ...helperKeys(layout, ["raw"])])) fields.add(key);
  for (const key of helperKeys(review, ["data"])) fields.add(key);
  for (const key of directKeys(review, ["data"])) fields.add(key);
  fields.add("context");

  for (const key of new Set([...directKeys(methods, ["data"]), ...helperKeys(methods, ["data"]), ...[...methods.matchAll(/command\("([^"]+)"\)/g)].map((match) => match[1])])) {
    fields.add(`methods.${key}`);
  }
  for (const key of new Set([...directKeys(acceptance, ["data"]), ...helperKeys(acceptance, ["data"])])) {
    fields.add(`acceptance.${key}`);
  }
  for (const key of new Set([...directKeys(gate, ["data"]), ...helperKeys(gate, ["data"])])) {
    fields.add(`gate.${key}`);
  }
  for (const key of new Set([...directKeys(preparation, ["data"]), ...helperKeys(preparation, ["data"])])) {
    fields.add(`preparation.${key}`);
  }
  for (const key of new Set([...directKeys(repair, ["r"]), ...helperKeys(repair, ["r"])])) {
    fields.add(`preparation.repair.${key}`);
  }
  for (const key of directKeys(context, ["data"])) fields.add(`context.${key}`);
  fields.add("context.sources[]");
  for (const key of directKeys(context, ["source"])) fields.add(`context.sources[].${key}`);
  return fields;
}

test("工具清单覆盖所有工具入口", () => {
  const doc = read("工具清单.md");
  for (const heading of [
    "## bin/loop",
    "## bin/pi-dev",
    "## pipeline.ts（流水线）",
    "## setup-acceptance.ts（接入命令）",
    "## project-context.ts（来源索引）",
    "## 项目方法的环境变量",
    "## 批次.json 字段",
    "## .autoreview.json 字段",
    "## 失败分类与退出码",
  ]) {
    assert.ok(doc.includes(heading), `工具清单缺少一节：${heading}`);
  }
});

test("工具清单与代码一致：bin/loop 子命令", () => {
  const source = read("loop.ts");
  const code = new Set([...source.matchAll(/args\.command === "([^"]+)"/g)].map((match) => match[1]));
  const doc = tableFirstColumn(section(read("工具清单.md"), "### 子命令"));
  compare("bin/loop 子命令", code, doc);
});

test("工具清单与代码一致：批次.json 字段", () => {
  const code = batchFields();
  const doc = tableFirstColumn(section(read("工具清单.md"), "## 批次.json 字段"));
  compare("批次.json 字段", code, doc);
});

test("工具清单与代码一致：.autoreview.json 字段", () => {
  const code = autoreviewFields();
  const doc = tableFirstColumn(section(read("工具清单.md"), "## .autoreview.json 字段"));
  compare(".autoreview.json 字段", code, doc);
});

test("一致性检查覆盖 helper 字段读取方式：新增报缺项，删除报多项", () => {
  const doc = tableFirstColumn(section(read("工具清单.md"), "## .autoreview.json 字段"));
  const sources = realSources();
  const needle = 'const release = raw.release === undefined ? "main" : nonEmptyString(raw, "release", "main");';
  assert.ok(sources["config.ts"].includes(needle), "项目布局的 release 解析写法变了，更新负向测试");

  const addedSource = sources["config.ts"].replace(needle,
    `${needle}\n  const toolManifestProbe = nonEmptyString(raw, "toolManifestProbe", "默认值");`);
  const added = autoreviewFields({ ...sources, "config.ts": addedSource });
  assert.ok(added.has("toolManifestProbe"), "helper 形式的新字段应进入比较集合");
  assert.ok(differences(added, doc).missing.includes("toolManifestProbe"), "新增字段应报为清单缺项");

  const removed = autoreviewFields({ ...sources, "config.ts": sources["config.ts"].replace(`${needle}\n`, "") });
  assert.ok(!removed.has("release"), "helper 和属性访问都删除后，字段应离开比较集合");
  assert.ok(differences(removed, doc).extra.includes("release"), "删除字段应报为清单多项");
});

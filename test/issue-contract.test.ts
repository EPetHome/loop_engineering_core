/** 问题单唯一写法、字段解析及搬运路径契约；不改验收标准解析和判定规则。 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { remapBatchReferences } from "../batch-refs.ts";
import { parsePlan } from "../pipeline.ts";
import { parseIssuePaths } from "../issue-writeback.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");

test("A1/A2/A9 问题单方法只有一个正文来源，模板只指向它，批次字段文档完整", () => {
  const source = read("README-验收标准.md").split("## 问题单\n")[1].split("\n## 可选配置：")[0];
  for (const text of ["`issues/`", "issues/【history】/", "未完成单子", "自动归档", "状态、排期、关联单", "待修复", "修复中·<批次名>", "已合入待验·<批次名>", "已解决", "完成／重复／不做", "因果链", "分层归因", "待排查", "待补充", "同一根因合为一单", "一批修一个根因", "立即修", "互相链接", "重复", "程序不自动关单", "不改文件名", "批次文档", "交付总表", "撤回"]) assert.ok(source.includes(text), text);
  const template = /```markdown\n([\s\S]*?)```/.exec(source)![1];
  for (const text of ["【bug】<简单描述>.md", "【req】<简单描述>.md", "一级标题与文件名", "【xxx】", "只是类型占位示例"]) assert.ok(source.includes(text), text);
  assert.match(template, /^# 【bug】<简单描述>$/m);
  assert.deepEqual([...template.matchAll(/^## (.+)$/gm)].map((match) => match[1]), ["问题描述", "复现步骤", "预期结果", "环境与证据", "本次任务", "范围与限制", "验收标准", "完成后需要提供"]);
  const rules = read("项目模板/项目根/AGENTS.md");
  assert.deepEqual(rules.split("\n").filter((line) => /问题单|issues\//.test(line)), ["- 问题单放 `issues/`，写法见 Loop `README-验收标准.md`「问题单」一节。"]);
  assert.doesNotMatch(rules, /已合入待验|因果链|关闭原因/);
  assert.doesNotMatch(read("项目模板/README.md"), /iusses|模板没放.*问题清单/);
  assert.ok(existsSync(join(root, "项目模板/项目根/issues")));
  assert.deepEqual(readdirSync(join(root, "项目模板/项目根/issues")).sort(), [".gitkeep", "【history】"], "不复制第二份写法或正文模板");
  assert.deepEqual(readdirSync(join(root, "项目模板/项目根/issues/【history】")), [".gitkeep"]);
  const fields = read("工具清单.md").split("## 批次.json 字段\n")[1];
  const issue = fields.split("\n").find((line) => line.startsWith("| `issues` |"))!;
  for (const text of ["string[]", "批次文件所在目录", "绝对路径", "仓库内", "开工", "仓库外", "合入成功后", "不阻断开工", "不退回", "不阻止合入"]) assert.ok(issue.includes(text), text);
});

test("issues 字段解析：可省略，按批次目录解析并去重，路径不存在不做阻断检查", () => {
  const dir = resolve("/project/repo/docs/batches/demo");
  const value = ["../../../issues/【bug】登录失败.md", "/elsewhere/issues/【req】新增导出.md", "../../../issues/【bug】登录失败.md"];
  assert.deepEqual(parseIssuePaths(undefined, dir), []);
  assert.deepEqual(parseIssuePaths(value, dir), [resolve("/project/repo/issues/【bug】登录失败.md"), resolve("/elsewhere/issues/【req】新增导出.md")]);
  for (const invalid of ["issues/【bug】登录失败.md", null, [null], [""], ["line\nbreak"]]) assert.throws(() => parseIssuePaths(invalid, dir), /issues.*数组/);
  const raw = { name: "问题单批次", issues: value, stages: { 甲: { cwd: root, start: "true" } } };
  assert.deepEqual(parsePlan(raw, dir).issues, parseIssuePaths(value, dir));
  assert.throws(() => parsePlan({ ...raw, issues: {} }, dir), /issues.*数组/);
});

test("问题单路径搬运：仓库内绝对路径跟随非同级 worktree，仓库外相对路径固定，重复搬运不漂移", () => {
  const main = resolve("/project/repo"), workspace = resolve("/project/workspaces/dev");
  const batch = join(main, "docs/batches/demo/批次.json"), dir = dirname(batch);
  const internal = join(main, "issues/单.md"), external = resolve("/project/other/issues/单.md");
  const raw = { issues: [internal, relative(dir, internal), external, relative(dir, external)] };
  const moved = remapBatchReferences(raw, main, workspace, batch);
  assert.deepEqual(moved.issues, [join(workspace, "issues/单.md"), relative(dir, internal), external, external]);
  assert.deepEqual(remapBatchReferences(moved, main, workspace, join(workspace, relative(main, batch))), moved);
  assert.deepEqual(raw.issues, [internal, relative(dir, internal), external, relative(dir, external)]);
});

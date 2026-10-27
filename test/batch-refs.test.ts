/** 批次搬运的路径重定位；纯函数测试，不创建文件。 */
import assert from "node:assert/strict";
import { dirname, relative, resolve } from "node:path";
import test from "node:test";
import { remapBatchReferences } from "../batch-refs.ts";

const main = resolve("/project/repo");
const workspace = resolve("/project/workspaces/dev");
const batch = resolve(main, "docs/batches/demo/批次.json");
const dir = dirname(batch);
const external = resolve("/project/resources");
const fromBatch = (path: string): string => relative(dir, path);

test("搬运路径：目录、日志和未搬运依赖保留原目标，文档引用跟随 worktree", () => {
  const raw = {
    dir: "./state",
    pi: { ponytail: { extension: resolve(main, "extensions/pony.js"), mode: "full" } },
    stages: {
      甲: { cwd: fromBatch(workspace), prompt: "../../prompt/任务.md",
        ponytail: { extension: fromBatch(resolve(external, "pony.js")) } },
      乙: { cwd: "../../..", prompt: resolve(main, "prompt.md") },
      丙: { cwd: workspace, start: "sh ./start.sh", args: ["./unchanged"] },
    },
    prepare: "sh ./prepare.sh",
    e2e: { workDir: "../../..", criteria: "./验收.md", acceptance: {
      logs: ["./logs/system.log", resolve(external, "system.log")],
      guide: resolve(main, "guide.md"), actions: "./actions", start: "sh ./start.sh",
    } },
  };
  const before = structuredClone(raw);
  const moved = remapBatchReferences(raw, main, workspace, batch);
  assert.deepEqual(moved, {
    ...raw,
    dir: resolve(dir, "state"),
    pi: raw.pi,
    stages: {
      甲: { ...raw.stages.甲, cwd: workspace, ponytail: { extension: resolve(external, "pony.js") } },
      乙: { cwd: main, prompt: resolve(workspace, "prompt.md") },
      丙: raw.stages.丙,
    },
    e2e: { ...raw.e2e, workDir: main, acceptance: {
      ...raw.e2e.acceptance,
      logs: [resolve(dir, "logs/system.log"), resolve(external, "system.log")],
      guide: raw.e2e.acceptance.guide,
    } },
  });
  assert.deepEqual(raw, before, "不修改原批次对象");
  const movedBatch = resolve(workspace, relative(main, batch));
  assert.deepEqual(remapBatchReferences(moved, main, workspace, movedBatch), moved, "重复重定位不漂移");
});

test("搬运路径：只有实际搬运的 Ponytail 和验收说明重定位到开发空间", () => {
  const globalExtension = resolve(dir, "resources/global.js");
  const stageExtension = resolve(dir, "resources/stage.js");
  const guide = resolve(dir, "resources/guide.md");
  const raw = {
    pi: { ponytail: { extension: globalExtension } },
    stages: { 甲: { ponytail: { extension: fromBatch(stageExtension) } } },
    e2e: { acceptance: { guide: fromBatch(guide) } },
  };
  const files = new Set([globalExtension, stageExtension, guide].map((file) => relative(main, file)));
  const moved = remapBatchReferences(raw, main, workspace, batch, files);
  assert.deepEqual(moved, {
    pi: { ponytail: { extension: resolve(workspace, relative(main, globalExtension)) } },
    stages: { 甲: { ponytail: { extension: resolve(workspace, relative(main, stageExtension)) } } },
    e2e: { acceptance: { guide: resolve(workspace, relative(main, guide)) } },
  });
  assert.deepEqual(remapBatchReferences(moved, main, workspace, resolve(workspace, relative(main, batch)), files), moved);
  assert.deepEqual(remapBatchReferences(raw, main, workspace, batch), {
    ...raw,
    stages: { 甲: { ponytail: { extension: stageExtension } } },
    e2e: { acceptance: { guide } },
  }, "位于批次目录内也不能在未搬运时假定目标有副本");
});

test("搬运路径：其他仓库外相对资源固定原目标，绝对目录不变", () => {
  const prompt = resolve(external, "prompt.md");
  const criteria = resolve(external, "criteria.md");
  const guide = resolve(external, "guide.md");
  const ponytail = resolve(external, "pony.js");
  const state = resolve(external, "state");
  const raw = {
    dir: state,
    pi: { ponytail: { extension: fromBatch(ponytail) } },
    stages: { 甲: { cwd: external, prompt: fromBatch(prompt) } },
    e2e: { workDir: external, criteria: fromBatch(criteria), acceptance: { guide: fromBatch(guide) } },
  };
  assert.deepEqual(remapBatchReferences(raw, main, workspace, batch), {
    ...raw,
    pi: { ponytail: { extension: ponytail } },
    stages: { 甲: { cwd: external, prompt } },
    e2e: { workDir: external, criteria, acceptance: { guide } },
  });
  assert.deepEqual(remapBatchReferences(raw, main, main, batch), raw, "同一工作区不重写相对路径");
});

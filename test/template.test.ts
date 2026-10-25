/** A3：按项目模板接入临时 git 项目，占位符不替换时 loop 开工应报方法错误。 */
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { inScope, parseStageScope } from "../scope.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TEMPLATE = join(ROOT, "项目模板", "项目根");
const LOOP = join(ROOT, "bin", "loop");
const BATCH = "docs/batches/示例批次-20261012/批次.json";

test("A3 模板占位符未替换时 loop 开工报方法错误，不空跑通过", () => {
  const root = mkdtempSync(join(tmpdir(), "autoreview-template-"));
  const repo = join(root, "仓库");
  try {
    cpSync(TEMPLATE, repo, { recursive: true });
    // 接入：示例配置复制成实际配置，但故意不替换 <占位符>。
    writeFileSync(join(repo, ".autoreview.json"), readFileSync(join(repo, ".autoreview.json.示例")));
    const git = (...args: string[]) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    const init = git("init", "-q", "-b", "main");
    assert.equal(init.status, 0, init.stderr);
    // 接入项目把本机忽略规则放进 .git/info/exclude；模板骨架本身仍随仓库交付。
    writeFileSync(join(repo, ".git", "info", "exclude"), readFileSync(join(repo, ".gitignore.示例")));
    const add = git("add", "-A");
    assert.equal(add.status, 0, add.stderr);
    const commit = git("-c", "user.name=模板测试", "-c", "user.email=template@example.com", "commit", "-qm", "模板骨架");
    assert.equal(commit.status, 0, commit.stderr);

    const env = {
      ...process.env,
      HOME: join(root, "home"),
      AUTOREVIEW_PROJECTS_ROOT: join(root, "projects"),
      AUTOREVIEW_RESOURCE_ROOT: join(root, "resources"),
    };
    const run = spawnSync("bash", [LOOP, "开工", BATCH], { cwd: repo, encoding: "utf8", env });
    const output = `${run.stdout}\n${run.stderr}`;
    assert.notEqual(run.status, 0, `占位符未替换时不应成功：\n${output}`);
    assert.match(output, /方法自测未通过|AUTOREVIEW_FAILURE=method/, output);
    assert.match(output, /未替换的占位符|<[^>\n]+>/, output);
    assert.match(output, /<仓库目录名>|<模块>|<项目>|<测试库连接串>/, output);
    assert.equal(readFileSync(join(repo, ".autoreview.json"), "utf8"), readFileSync(join(repo, ".autoreview.json.示例"), "utf8"), "开工不修改配置");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("模板骨架随仓库交付：验收环境文件没有被忽略", () => {
  const files = [
    "deploy/acceptance/start.sh",
    "deploy/acceptance/reset-data.sh",
    "deploy/acceptance/release.sh",
    "deploy/acceptance/GUIDE.md",
    ".gitignore.示例",
  ];
  for (const file of files) {
    const absolute = join(TEMPLATE, file);
    assert.ok(existsSync(absolute), `模板缺少文件：${file}`);
    const ignored = spawnSync("git", ["-C", ROOT, "check-ignore", "-q", "--", relative(ROOT, absolute)], { encoding: "utf8" });
    assert.notEqual(ignored.status, 0, `模板文件被忽略，不会随仓库交付：${file}`);
  }
});

test("示例批次 scope 允许业务文件和结果，拒绝其他批次文件", () => {
  const batch = JSON.parse(readFileSync(join(TEMPLATE, BATCH), "utf8"));
  const scope = parseStageScope(batch.stages["实现"].scope, "示例批次 scope");
  assert.ok(scope, "示例批次应写 scope");
  assert.equal(inScope("线上/说明.md", scope), true);
  assert.equal(inScope("docs/batches/示例批次-20261012/结果.md", scope), true);
  assert.equal(inScope("docs/batches/示例批次-20261012/批次.json", scope), false);
  assert.equal(inScope(".autoreview/methods/gate.sh", scope), false);
});

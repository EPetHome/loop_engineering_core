import "./test-env.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { archiveResolvedIssues, ISSUE_HISTORY } from "../issue-archive.ts";
import { productionAction } from "../production-loop.ts";
import { harness } from "./helpers/autoreview-fixture.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const name = "【bug】按钮无响应.md", pending = "【req】新增导出.md";
const issue = (state: string) => `# ${name.slice(0, -3)}\n\n状态：${state}\n排期：原排期\n关联单：[待验单](${pending})\n\n## 原始证据\n[结果](../docs/结果.md)\n状态：已解决（关闭原因：完成）\n`;
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "loop-issue-archive-")));
  const write = (path: string, text: string) => { const file = join(root, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
  write(".autoreview.json", JSON.stringify({ context: { sources: [{ path: `issues/${name}` }] } }));
  write(`issues/${name}`, issue("已解决（关闭原因：完成）"));
  write(`issues/${pending}`, issue("已合入待验·批次"));
  write("docs/结果.md", `[单子](../issues/${name})\n`);
  write("docs/batches/历史/结果.md", `[当时的单子](../../../issues/${name})\n`);
  write("wiki/raw/原文.md", `[原文引用](../../issues/${name})\n`);
  return { root, write, read: (path: string) => readFileSync(join(root, path), "utf8"), close: () => rmSync(root, { recursive: true, force: true }) };
}

test("关单归档：只预览不写；关闭原因、当前引用、归档内相对链接及历史证据均保留", () => {
  const f = fixture();
  try {
    const before = f.read(`issues/${name}`), historical = f.read("docs/batches/历史/结果.md");
    assert.equal(archiveResolvedIssues(f.root, true).archived.length, 1);
    assert.equal(existsSync(join(f.root, "issues", ISSUE_HISTORY)), false);
    const result = archiveResolvedIssues(f.root);
    assert.equal(result.ok, true, result.lines.join("\n")); assert.equal(result.archived.length, 1);
    assert.equal(existsSync(join(f.root, "issues", name)), false);
    assert.equal(f.read(`issues/${ISSUE_HISTORY}/${name}`), before.replace(`](${pending})`, `](../${pending})`).replace("](../docs/结果.md)", "](../../docs/结果.md)"));
    assert.equal(f.read("docs/结果.md"), `[单子](../issues/${ISSUE_HISTORY}/${name})\n`);
    assert.equal(JSON.parse(f.read(".autoreview.json")).context.sources[0].path, `issues/${ISSUE_HISTORY}/${name}`);
    assert.match(f.read(`issues/${pending}`), /状态：已合入待验/);
    assert.equal(f.read("docs/batches/历史/结果.md"), historical);
    assert.equal(f.read("wiki/raw/原文.md"), `[原文引用](../../issues/${name})\n`, "原始材料只读");
    assert.deepEqual(archiveResolvedIssues(f.root).archived, [], "重复事件不能重复移动");
    assert.equal(existsSync(join(f.root, "issues", ".archive.lock")), false);
  } finally { f.close(); }
});

test("待验、仅正文写已解决、没有关闭原因或有重复单头均不归档", () => {
  const f = fixture();
  try {
    for (const state of ["待修复", "已合入待验·批次", "已解决", "已解决（关闭原因：完成）\n状态：待修复"]) {
      f.write(`issues/${name}`, issue(state));
      assert.deepEqual(archiveResolvedIssues(f.root).archived, [], state);
      assert.equal(f.read(`issues/${name}`), issue(state));
    }
  } finally { f.close(); }
});

test("同名、只读引用和链接目录失败时保留原单及已有归档，不把失败伪装成完成", () => {
  for (const kind of ["collision", "readonly", "symlink"] as const) {
    const f = fixture();
    try {
      if (kind === "collision") f.write(`issues/${ISSUE_HISTORY}/${name}`, "原有归档\n");
      if (kind === "readonly") chmodSync(join(f.root, "docs/结果.md"), 0o444);
      if (kind === "symlink") { mkdirSync(join(f.root, "outside")); symlinkSync(join(f.root, "outside"), join(f.root, "issues", ISSUE_HISTORY)); }
      const before = f.read(`issues/${name}`), result = archiveResolvedIssues(f.root);
      assert.equal(result.ok, false, kind); assert.equal(result.archived.length, 0);
      assert.equal(f.read(`issues/${name}`), before);
      if (kind === "collision") assert.equal(f.read(`issues/${ISSUE_HISTORY}/${name}`), "原有归档\n");
      if (kind === "symlink") assert.deepEqual(readdirSync(join(f.root, "outside")), []);
    } finally { f.close(); }
  }
});

test("Claude/Codex 实际 Hook：编辑后自动归档；只读与未知脚本不触发，工具结果包含新位置", () => {
  for (const host of ["claude", "codex"]) {
    const f = fixture();
    try {
      f.write("issues/【bug】另一张已解决单.md", issue("已解决（关闭原因：完成）"));
      const input = { hook_event_name: "PostToolUse", cwd: f.root, session_id: "archive", transcript_path: `/${host}/session`,
        ...(host === "codex" ? { turn_id: "turn" } : {}),
        tool_name: host === "claude" ? "Edit" : "apply_patch",
        tool_input: host === "claude" ? { file_path: join(f.root, "issues", name) } : { command: `*** Begin Patch\n*** Update File: issues/${name}\n@@\n-old\n+new\n*** End Patch` } };
      const run = (event: object) => spawnSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", join(ROOT, "hosts/hook.ts")], { cwd: f.root, input: JSON.stringify(event), encoding: "utf8" });
      assert.equal(productionAction({ paths: [], command: `cat 'issues/${name}'` }, f.root), undefined);
      assert.equal(run({ ...input, tool_name: "Bash", tool_input: { command: `cat 'issues/${name}'` } }).stdout, "");
      assert.equal(existsSync(join(f.root, "issues", name)), true);
      const result = run(input); assert.equal(result.status, 0, result.stderr);
      assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /问题单已归档/);
      assert.equal(existsSync(join(f.root, "issues", ISSUE_HISTORY, name)), true);
      assert.equal(existsSync(join(f.root, "issues/【bug】另一张已解决单.md")), true, "自动事件只归档明确编辑的单子");
      assert.equal(run(input).stdout, "");
    } finally { f.close(); }
  }
});

test("Pi 工具完成事件实际调用同一归档器；失败工具与 read 不触发", async () => {
  const h = harness();
  try {
    h.write(".autoreview.json", "{}"); mkdirSync(join(h.repo, "issues"));
    h.write(`issues/${name}`, issue("已解决（关闭原因：重复）"));
    const event = { toolName: "write", input: { path: join(realpathSync(h.repo), "issues", name) }, isError: false, content: [{ type: "text", text: "written" }] };
    await h.event("tool_result", { ...event, isError: true }); await h.event("tool_result", { ...event, toolName: "read" });
    assert.equal(existsSync(join(h.repo, "issues", name)), true);
    const result = await h.event("tool_result", event);
    assert.match(result.content.at(-1).text, /问题单已归档/);
    assert.equal(existsSync(join(h.repo, "issues", ISSUE_HISTORY, name)), true);
  } finally { await h.close(); }
});

test("文档项目可直接编辑归档；不猜脚本相对路径，维护 CLI 预览与执行一致", () => {
  const f = fixture();
  try {
    rmSync(join(f.root, ".autoreview.json")); f.write("AGENTS.md", "[问题单](../loop/README-验收标准.md#问题单)\n");
    const action = productionAction({ paths: [], command: `python3 - <<'PY'\nfrom pathlib import Path\nPath('issues/${name}').write_text('已核销')\nPY` }, f.root);
    assert.equal(action, undefined, "命令字符串不能触发移动");
    assert.equal(productionAction({ paths: [], command: `p = some_directory; Path(p / 'issues/${name}').write_text('已核销')` }, f.root), undefined);
    assert.equal(productionAction({ paths: [`issues/${name}`] }, f.root)?.files[0].kind, "issue");
    const run = (preview: boolean) => spawnSync(process.execPath, [join(ROOT, "loop.ts"), "归档问题单", f.root, "--json", ...(preview ? ["--dry-run"] : [])], { cwd: f.root, encoding: "utf8" });
    const preview = run(true); assert.equal(preview.status, 0, preview.stderr); assert.equal(JSON.parse(preview.stdout).archived.length, 1);
    assert.equal(existsSync(join(f.root, "issues", name)), true);
    const result = run(false); assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).archived.length, 1);
  } finally { f.close(); }
});

/** 接入：接入手册的复制块、目标文件、写法段状态、下一步提示、接入命令；产物只写 os.tmpdir()。 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { extractCriteria, type AcceptanceRecord } from "../acceptance-core.ts";
import { parseAcceptanceConfig } from "../config.ts";
import {
  acceptanceTodos, blockerHint, blockVersion, conventionNotice, conventionStatus, conventionTarget, extractBlock,
  GUIDE_DOC, manualHint, readBlock, SETUP_SCRIPT,
} from "../onboarding.ts";
import { detectProject, planSetup, upsertBlock } from "../setup-acceptance.ts";

const SETUP = fileURLToPath(new URL("../setup-acceptance.ts", import.meta.url));
const tempDir = (): string => mkdtempSync(join(tmpdir(), "autoreview-onboard-"));
const write = (root: string, path: string, text: string): void => {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), text);
};

test("O1 接入手册里的三块都在，内容能被程序直接用", () => {
  const doc = readFileSync(GUIDE_DOC, "utf8");
  const block1 = extractBlock(doc, 1)!;
  assert.equal(blockVersion(block1), 1);
  assert.match(block1.split("\n")[0], /^<!-- autoreview:acceptance v1/);
  assert.equal(block1.split("\n").at(-1), "<!-- /autoreview:acceptance -->");
  assert.deepEqual(extractCriteria(block1)?.map((item) => item.id), ["A1", "A2"], "块 1 里的示例格式能被程序取到");
  const block2 = JSON.parse(extractBlock(doc, 2)!);
  const config = parseAcceptanceConfig(block2.acceptance, "/p", {})!;
  assert.ok(config.start && config.readyUrl, "块 2 是一份能直接用的启动配置");
  assert.match(extractBlock(doc, 3)!, /playwright install chromium/);
  assert.equal(readBlock(1), block1);
  assert.equal(blockVersion("## 起草需求时写验收标准（自动验收）\n"), 0, "没有标记的旧版算第 0 版");
  assert.equal(blockVersion("什么都没有"), undefined);
});

test("O2 目标文件：Codex/pi 读 AGENTS.md；Claude Code 读 CLAUDE.md，除非它 @AGENTS.md", () => {
  const root = tempDir();
  try {
    assert.equal(conventionTarget(root, "codex"), join(root, "AGENTS.md"));
    assert.equal(conventionTarget(root, "pi"), join(root, "AGENTS.md"));
    assert.equal(conventionTarget(root, "claude"), join(root, "CLAUDE.md"));
    write(root, "CLAUDE.md", "# 说明\n@AGENTS.md\n");
    assert.equal(conventionTarget(root, "claude"), join(root, "AGENTS.md"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("O3 写法段状态与提醒：缺失 → 旧版 → 最新；提醒里写明手册、块号、完整路径和接入命令", () => {
  const root = tempDir();
  try {
    assert.equal(conventionStatus(root, "codex").status, "缺失");
    const missing = conventionNotice(root, "codex")!;
    for (const part of [GUIDE_DOC, "【块 1】", join(root, "AGENTS.md"), SETUP_SCRIPT]) assert.ok(missing.includes(part), `缺少：${part}`);
    write(root, "AGENTS.md", "## 起草需求时写验收标准（自动验收）\n旧的\n");
    assert.equal(conventionStatus(root, "codex").status, "旧版");
    assert.match(conventionNotice(root, "codex")!, /旧版（v0，最新 v1）/);
    write(root, "AGENTS.md", `# 我的规则\n\n${readBlock(1)}\n`);
    assert.equal(conventionStatus(root, "codex").status, "最新");
    assert.equal(conventionNotice(root, "codex"), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const record = (overrides: Partial<AcceptanceRecord>): AcceptanceRecord => ({
  verdict: "无法验收", items: [], logErrors: [], extra: [], runDir: "/run", durationMs: 0, ...overrides,
});

test("O4 下一步提示：按卡住的原因指到具体的块和文件；部分验证列出要人工验收的条目", () => {
  const acceptance = parseAcceptanceConfig({}, "/proj", {})!;
  const service = blockerHint(record({ blocker: "没配启动" }), "/proj/sub", acceptance);
  assert.ok(service.includes(`${GUIDE_DOC} 的【块 2】复制到 /proj/.autoreview.json`));
  assert.match(service, /再给开发方发一条消息继续/);
  const tool = blockerHint(record({ blocker: "缺工具" }), "/proj/sub", acceptance);
  assert.ok(tool.startsWith(`在 /proj/sub 里执行 ${GUIDE_DOC} 的【块 3】`));
  assert.match(blockerHint(record({ blocker: "验收方", escalated: true }), "/proj", acceptance), /已换强模型重验，仍然不行/);
  assert.match(blockerHint(record({ blocker: "其他" }), "/proj", acceptance), /环境问题/);
  const partial = record({
    verdict: "部分验证",
    items: [
      { id: "A1", text: "操作：a", verdict: "通过", detail: "" },
      { id: "A2", text: "操作：b\n预期：c", verdict: "无法验证", detail: "原因：标准含糊", cause: "其他" },
    ],
  });
  assert.equal(manualHint(partial), "A2 没能自动验证，需要你人工验收（原因见总结「需要你做的事」）");
  assert.equal(manualHint(record({ verdict: "通过" })), undefined);
});

test("O5 总结「需要你做的事」：暂停的下一步、人工验收、自动起草的标准、写法段缺失", () => {
  const root = tempDir();
  try {
    const acceptance = parseAcceptanceConfig({}, root, {})!;
    const partial = record({
      verdict: "部分验证",
      items: [{ id: "A2", text: "操作：b", verdict: "无法验证", detail: "原因：标准含糊", cause: "其他" }],
    });
    const todos = acceptanceTodos({
      acceptance, host: "codex", phase: "paused", pauseHint: "先做这个",
      criteria: { source: "自动起草", items: [], version: 1, updatedAt: "" }, lastAcceptance: partial,
    });
    assert.equal(todos[0], "先做这个");
    assert.match(todos[1], /^人工验收 A2（操作：b）：程序没能自动验证，原因：标准含糊/);
    assert.match(todos[2], /自动起草/);
    assert.ok(todos[3].includes("【块 1】") && todos[3].includes(join(root, "AGENTS.md")));
    assert.deepEqual(acceptanceTodos({ host: "codex", phase: "paused", pauseHint: "只剩这个" }), ["只剩这个"]);
    assert.deepEqual(acceptanceTodos({ host: "codex", phase: "done", pauseHint: "暂停已解除" }), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("O6 接入命令的探测：常见项目推断启动命令和端口，推不出来的写明要补什么", () => {
  const cases: { files: Record<string, string>; kind: string; start?: RegExp; env?: Record<string, string>; note?: RegExp; browser?: boolean }[] = [
    { files: { "package.json": JSON.stringify({ scripts: { dev: "next dev" }, dependencies: { next: "14" } }) }, kind: "网页或接口", start: /^npm run dev$/, env: { PORT: "40001" }, browser: true },
    { files: { "package.json": JSON.stringify({ scripts: { dev: "vite" }, devDependencies: { vite: "5", playwright: "1" } }), "yarn.lock": "" }, kind: "网页或接口", start: /^yarn dev --port 40001 --strictPort$/ },
    { files: { "package.json": JSON.stringify({ scripts: { dev: "vite" }, devDependencies: { vite: "5" } }) }, kind: "网页或接口", start: /^npm run dev -- --port 40001 --strictPort$/ },
    { files: { "package.json": JSON.stringify({ scripts: { start: "node server.js" }, dependencies: { express: "4" } }), "logs/app.log": "" }, kind: "网页或接口", start: /^npm run start$/, browser: false },
    { files: { "package.json": JSON.stringify({ bin: { todo: "bin/todo.js" } }) }, kind: "命令行" },
    { files: { "manage.py": "" }, kind: "网页或接口", start: /^python3 manage\.py runserver 127\.0\.0\.1:40001$/ },
    { files: { "requirements.txt": "fastapi\nuvicorn\n" }, kind: "网页或接口", note: /补上 start/ },
    { files: { "README.md": "hi" }, kind: "看不出来", note: /【块 2】/ },
  ];
  for (const item of cases) {
    const root = tempDir();
    try {
      for (const [path, text] of Object.entries(item.files)) write(root, path, text);
      const detected = detectProject(root, 40001);
      assert.equal(detected.kind, item.kind, JSON.stringify(item.files));
      if (item.start) assert.match(String(detected.acceptance.start), item.start);
      else assert.equal(detected.acceptance.start, undefined);
      if (item.env) assert.deepEqual(detected.acceptance.env, item.env);
      if (item.note) assert.ok(detected.notes.some((note) => item.note!.test(note)), detected.notes.join("\n"));
      if (item.browser !== undefined) assert.equal(detected.needsBrowser, item.browser);
      if (item.files["logs/app.log"] !== undefined) assert.deepEqual(detected.acceptance.logs, ["logs/app.log"]);
      parseAcceptanceConfig(detected.acceptance, root, {});
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("O7 插入或更新【块 1】：追加、按标记替换、已是最新、旧版整段替换、标记残缺不动", () => {
  const block = readBlock(1);
  const appended = upsertBlock("# 我的规则\n保留\n", block);
  assert.equal(appended.action, "追加");
  assert.equal(appended.text, `# 我的规则\n保留\n\n${block}\n`);
  assert.equal(upsertBlock(appended.text, block).action, "已是最新");
  const older = appended.text.replace("autoreview:acceptance v1", "autoreview:acceptance v0").replace("旧内容不存在", "");
  const updated = upsertBlock(`${older}\n## 之后的规则\n也保留\n`, block);
  assert.equal(updated.action, "更新");
  assert.ok(updated.text.includes("# 我的规则\n保留") && updated.text.includes("## 之后的规则\n也保留"));
  assert.equal(updated.text.match(/autoreview:acceptance v/g)?.length, 1);
  const legacy = "# 顶部\n\n## 起草需求时写验收标准（自动验收）\n旧规则\n\n开发时不要补写或修改验收标准；验收标准只认用户发来的消息。\n\n## 我的规则\n保留我\n";
  const replaced = upsertBlock(legacy, block);
  assert.equal(replaced.action, "更新");
  assert.ok(!replaced.text.includes("旧规则") && replaced.text.includes("## 我的规则\n保留我") && replaced.text.includes(block));
  const broken = upsertBlock("<!-- autoreview:acceptance v0：残缺 -->\n只有开头", block);
  assert.equal(broken.action, "已是最新");
  assert.match(broken.warning!, /没有结束标记/);
});

test("O8 接入命令：先给计划不写盘；--yes 写入且保留已有字段；再跑一次不重复；已有 acceptance 不覆盖", async () => {
  const root = tempDir();
  try {
    write(root, "package.json", JSON.stringify({ scripts: { dev: "next dev" }, dependencies: { next: "14" } }));
    write(root, ".autoreview.json", JSON.stringify({ maxRepairs: 2 }));
    write(root, "CLAUDE.md", "# 说明\n");
    const dry = spawnSync(process.execPath, [SETUP, root], { encoding: "utf8", input: "" });
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /没有写入：确认无误后加 --yes 再跑一次/);
    assert.deepEqual(JSON.parse(readFileSync(join(root, ".autoreview.json"), "utf8")), { maxRepairs: 2 });
    const run = spawnSync(process.execPath, [SETUP, root, "--yes"], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const config = JSON.parse(readFileSync(join(root, ".autoreview.json"), "utf8"));
    assert.equal(config.maxRepairs, 2);
    assert.equal(config.acceptance.start, "npm run dev");
    assert.match(readFileSync(join(root, "AGENTS.md"), "utf8"), /autoreview:acceptance v1/);
    assert.match(readFileSync(join(root, "CLAUDE.md"), "utf8"), /autoreview:acceptance v1/, "CLAUDE.md 没引入 AGENTS.md 时也写一份");
    const again = await planSetup(root);
    assert.equal(again.config, undefined);
    assert.match(again.configAction, /已有 acceptance，保留你的配置/);
    assert.ok(again.files.every((entry) => entry.action === "已是最新"));
    const rerun = spawnSync(process.execPath, [SETUP, root, "--yes"], { encoding: "utf8" });
    assert.match(rerun.stdout, /没有要改的/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

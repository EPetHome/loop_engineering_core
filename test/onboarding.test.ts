/** 接入只处理配置；项目、HOME 与全部产物均在本测试创建的系统临时仓库中。 */
import "./helpers/git-runtime.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { extractCriteria, isAuthorizationCriterion, isManualCriterion, type AcceptanceRecord } from "../acceptance-core.ts";
import { parseAcceptanceConfig } from "../config.ts";
import { acceptanceTodos, blockerHint, BROWSER_SECTION, CONFIG_SECTION, GUIDE_DOC, manualHint } from "../onboarding.ts";
import { detectProject, planSetup, renderPlan, RESET_NOTE } from "../setup-acceptance.ts";

const SETUP = fileURLToPath(new URL("../setup-acceptance.ts", import.meta.url));
const LOOP = fileURLToPath(new URL("../bin/loop", import.meta.url));
const tempDir = (): string => mkdtempSync(join(tmpdir(), "autoreview-onboard-"));
const write = (root: string, path: string, text: string): void => {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), text);
};
const ruleFiles = ["AGENTS.md", "CLAUDE.md", ".autoreview/CONVENTIONS.md"];
const oldCopy = "# 项目原文\r\n<!-- autoreview:acceptance v6 -->\r\n旧写法\r\n<!-- /autoreview:acceptance -->\r\n保留尾部\r\n";

function fixture() {
  const temp = tempDir(), root = join(temp, "项目 with space"), home = join(temp, "home");
  mkdirSync(root); mkdirSync(home);
  const env = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  const git = (...args: string[]): string => {
    const run = spawnSync("git", args, { cwd: root, env, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr); return run.stdout;
  };
  git("init", "-q", "-b", "main"); git("config", "user.email", "onboard@example.test"); git("config", "user.name", "onboard");
  write(root, "README.md", "临时项目\n"); git("add", "."); git("commit", "-qm", "fixture");
  const run = (args: string[], direct = false) => spawnSync(direct ? process.execPath : LOOP,
    direct ? [SETUP, root, ...args] : ["接入", root, ...args], { cwd: temp, env, encoding: "utf8", input: "", timeout: 15_000 });
  return { temp, root, git, run, close: () => rmSync(temp, { recursive: true, force: true }) };
}

test("O1 Loop 仓库保留唯一起草写法与可用示例，不再提供项目复制块或回写要求", () => {
  const doc = readFileSync(GUIDE_DOC, "utf8");
  assert.match(doc, /## 起草需求时写验收标准（自动验收 v7）/);
  assert.match(doc, /## 起草任务提示词（自动评审 v2）[\s\S]*以下四节/);
  assert.match(doc, /不重复全仓阅读或手工抄写/);
  assert.match(doc, /不要写联调或端到端测试的步骤/);
  assert.match(doc, /最后跑整批验收（流水线）/);
  assert.match(doc, /「A3\. \[乙\] 操作：/);
  assert.match(doc, /按权限划分，不按难易[\s\S]*「\[授权\]」[\s\S]*不要替用户写「同意授权」[\s\S]*「\[人工\]」：要用户拍板[\s\S]*难做不算：图形界面操作/);
  assert.match(doc, /批次参数写进 `批次\.json`，不要在批次目录里写门禁或启动脚本/);
  assert.doesNotMatch(doc, /autoreview:acceptance|【块 [123]】|复制到项目|收尾回写|已回写原单/);
  const example = /```markdown\n([\s\S]*?)\n```/.exec(doc)![1];
  const examples = extractCriteria(example)!;
  assert.deepEqual(examples.map((item) => item.id), ["A1", "A2", "A3", "A4"]);
  assert.deepEqual(examples.map((item) => [isAuthorizationCriterion(item.text), isManualCriterion(item.text)]),
    [[false, false], [false, false], [true, false], [false, true]]);
  const configs = [...doc.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => JSON.parse(match[1]));
  const config = parseAcceptanceConfig(configs[0].acceptance, "/p", {})!;
  assert.ok(config.start && config.readyUrl);
  assert.equal(parseAcceptanceConfig(configs[1].acceptance, "/p", {})!.reset, "sh deploy/acceptance/reset-data.sh");
  assert.match(doc, /只重置数据，\*\*不要重启或关闭服务\*\*/);
  assert.match(doc, /playwright install chromium/);
  for (const heading of [CONFIG_SECTION, BROWSER_SECTION]) assert.ok(doc.includes(`## ${heading}`));
});

const record = (overrides: Partial<AcceptanceRecord>): AcceptanceRecord => ({
  verdict: "无法验收", items: [], logErrors: [], extra: [], runDir: "/run", durationMs: 0, ...overrides,
});

test("O4 下一步指向配置与 Loop 手册；部分验证仍列出人工验收", () => {
  const acceptance = parseAcceptanceConfig({}, "/proj", {})!;
  const service = blockerHint(record({ blocker: "没配启动" }), "/proj/sub", acceptance);
  for (const part of [GUIDE_DOC, CONFIG_SECTION, "/proj/.autoreview.json", "bin/loop", " 接入 ", "再给开发方发一条消息继续"]) assert.ok(service.includes(part), part);
  assert.doesNotMatch(service, /【块|复制|setup-acceptance/);
  const tool = blockerHint(record({ blocker: "缺工具" }), "/proj/sub", acceptance);
  assert.ok(tool.startsWith(`在 /proj/sub 里按 ${GUIDE_DOC}「${BROWSER_SECTION}」`));
  assert.match(blockerHint(record({ blocker: "验收方", escalated: true }), "/proj", acceptance), /已换强模型重验，仍然不行/);
  const unknown = blockerHint(record({ blocker: "其他", items: [{ id: "A1", text: "操作：a", verdict: "无法验证", detail: "原始原因：缺少离线样本" }] }), "/proj", acceptance);
  assert.match(unknown, /A1：原始原因：缺少离线样本/);
  assert.doesNotMatch(unknown, /多半是环境问题|数据库、测试账号/);
  const partial = record({ verdict: "部分验证", items: [
    { id: "A1", text: "操作：a", verdict: "通过", detail: "" },
    { id: "A2", text: "操作：b\n预期：c", verdict: "无法验证", detail: "原因：标准含糊", cause: "其他" },
  ] });
  assert.equal(manualHint(partial), "A2 没能自动验证，需要你人工验收（原因见总结「需要你做的事」）");
  assert.equal(manualHint(record({ verdict: "通过" })), undefined);
  assert.equal(manualHint(record({ verdict: "部分验证", items: [
    { id: "A1", text: "操作：a", verdict: "无法验证", detail: "原因：标准含糊", cause: "其他" },
    { id: "A3", text: "[人工] 操作：c", verdict: "需人工", detail: "标了 [人工]" },
  ] })), "A1 没能自动验证，A3 标了 [人工]，需要你人工验收（原因见总结「需要你做的事」）");
});

test("O5 总结只保留实际待办，不因缺少或旧版项目副本产生提醒", () => {
  const root = tempDir();
  try {
    const acceptance = parseAcceptanceConfig({}, root, {})!;
    const input = { acceptance, host: "codex", phase: "paused", pauseHint: "先做这个",
      criteria: { source: "自动起草" as const, items: [], version: 1, updatedAt: "" },
      lastAcceptance: record({ verdict: "部分验证", items: [
        { id: "A2", text: "操作：b", verdict: "无法验证", detail: "原因：标准含糊", cause: "其他" },
        { id: "A3", text: "[人工] 操作：c\n预期：d", verdict: "需人工", detail: "标了 [人工]" },
      ] }) };
    const todos = acceptanceTodos(input);
    assert.equal(todos.length, 4);
    assert.equal(todos[0], "先做这个");
    assert.match(todos[1], /^人工验收 A2（操作：b）：程序没能自动验证，原因：标准含糊/);
    assert.equal(todos[2], "人工验收 A3（[人工] 操作：c）：标了 [人工]，程序不自动验");
    assert.match(todos[3], /自动起草/);
    write(root, ".autoreview/CONVENTIONS.md", oldCopy);
    assert.deepEqual(acceptanceTodos(input), todos);
    assert.deepEqual(readFileSync(join(root, ".autoreview/CONVENTIONS.md")), Buffer.from(oldCopy));
    assert.deepEqual(acceptanceTodos({ host: "codex", phase: "paused", pauseHint: "只剩这个" }), ["只剩这个"]);
    assert.deepEqual(acceptanceTodos({ host: "codex", phase: "done", pauseHint: "暂停已解除" }), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("O6 探测沿用常见项目的命令、端口、日志和 reset 提醒", () => {
  const cases: { files: Record<string, string>; kind: string; start?: RegExp; env?: Record<string, string>; note?: RegExp; browser?: boolean }[] = [
    { files: { "package.json": JSON.stringify({ scripts: { dev: "next dev" }, dependencies: { next: "14" } }) }, kind: "网页或接口", start: /^npm run dev$/, env: { PORT: "40001" }, browser: true },
    { files: { "package.json": JSON.stringify({ scripts: { dev: "vite" }, devDependencies: { vite: "5", playwright: "1" } }), "yarn.lock": "" }, kind: "网页或接口", start: /^yarn dev --port 40001 --strictPort$/ },
    { files: { "package.json": JSON.stringify({ scripts: { dev: "vite" }, devDependencies: { vite: "5" } }) }, kind: "网页或接口", start: /^npm run dev -- --port 40001 --strictPort$/ },
    { files: { "package.json": JSON.stringify({ scripts: { start: "node server.js" }, dependencies: { express: "4" } }), "logs/app.log": "" }, kind: "网页或接口", start: /^npm run start$/, browser: false },
    { files: { "package.json": JSON.stringify({ bin: { todo: "bin/todo.js" } }) }, kind: "命令行" },
    { files: { "manage.py": "" }, kind: "网页或接口", start: /^python3 manage\.py runserver 127\.0\.0\.1:40001$/ },
    { files: { "requirements.txt": "fastapi\nuvicorn\n" }, kind: "网页或接口", note: /补上 start/ },
    { files: { "README.md": "hi" }, kind: "看不出来", note: /可选配置：被测系统怎么启动/ },
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
      assert.equal(detected.notes.includes(RESET_NOTE), item.kind === "网页或接口");
      parseAcceptanceConfig(detected.acceptance, root, {});
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("A3 接入临时仓库：预览不写、确认只生成配置，不创建三种规则文件", () => {
  const f = fixture();
  try {
    const before = f.git("status", "--porcelain");
    for (const args of [[], ["--dry-run", "--yes"]]) {
      const preview = f.run(args); assert.equal(preview.status, 0, preview.stderr);
      assert.equal(f.git("status", "--porcelain"), before);
      assert.equal(existsSync(join(f.root, ".autoreview.json")), false);
    }
    const run = f.run(["--yes"]); assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(f.root, ".autoreview.json"), "utf8")), { acceptance: {} });
    for (const file of ruleFiles) assert.equal(existsSync(join(f.root, file)), false, file);
    assert.equal(f.git("status", "--porcelain"), "?? .autoreview.json\n");
  } finally { f.close(); }
});

test("接入与直接脚本行为相同：补全配置不碰已有 v6/稳定规则，重跑不覆盖 acceptance", async () => {
  for (const direct of [false, true]) {
    const f = fixture();
    try {
      write(f.root, "package.json", JSON.stringify({ scripts: { dev: "next dev" }, dependencies: { next: "14" } }));
      write(f.root, ".autoreview.json", JSON.stringify({ maxRepairs: 2, reviewTimeoutMin: 90, custom: "保留" }));
      for (const file of ruleFiles) write(f.root, file, file.endsWith("CONVENTIONS.md") ? oldCopy : `# ${file}\r\n稳定规则\r\n`);
      const bytes = ruleFiles.map((file) => readFileSync(join(f.root, file)));
      const run = f.run(["--yes", "--host", "claude"], direct);
      assert.equal(run.status, 0, run.stderr);
      assert.doesNotMatch(run.stdout, /CONVENTIONS|【块|旧版|v6 →|其他工作区/);
      const configBytes = readFileSync(join(f.root, ".autoreview.json"));
      const config = JSON.parse(configBytes.toString());
      assert.equal(config.maxRepairs, 2); assert.equal(config.custom, "保留"); assert.equal(config.acceptance.start, "npm run dev");
      ruleFiles.forEach((file, index) => assert.deepEqual(readFileSync(join(f.root, file)), bytes[index], file));
      const plan = await planSetup(f.root); assert.equal(plan.config, undefined);
      assert.match(plan.configAction, /已有 acceptance，保留你的配置/);
      assert.doesNotMatch(renderPlan(plan), /CONVENTIONS|旧版|替换/);
      const again = f.run(["--yes"], direct); assert.equal(again.status, 0, again.stderr); assert.match(again.stdout, /没有要改的/);
      assert.deepEqual(readFileSync(join(f.root, ".autoreview.json")), configBytes);
    } finally { f.close(); }
  }
});

test("接入不扫描同仓库其他工作区的旧副本，不检查副本是不是文件", async () => {
  const f = fixture();
  try {
    const other = join(f.temp, "other"); f.git("worktree", "add", "-qb", "other", other);
    write(other, ".autoreview/CONVENTIONS.md", oldCopy);
    mkdirSync(join(f.root, ".autoreview/CONVENTIONS.md"), { recursive: true }); // 不是可读的规则文件也不应检查它。
    const plan = await planSetup(f.root);
    assert.ok(!renderPlan(plan).includes(other));
    const run = f.run(["--yes"]); assert.equal(run.status, 0, run.stderr);
    assert.doesNotMatch(run.stdout, /其他工作区|旧版|CONVENTIONS/);
    assert.deepEqual(readFileSync(join(other, ".autoreview/CONVENTIONS.md")), Buffer.from(oldCopy));
  } finally { f.close(); }
});

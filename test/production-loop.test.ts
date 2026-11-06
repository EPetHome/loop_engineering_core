/** 官方 Hook 字段夹具：Claude https://code.claude.com/docs/en/hooks；Codex https://learn.chatgpt.com/docs/hooks。
 * PostToolUse 使用 tool_input.command（不是 Codex 调用工具时的 cmd）；真实抓样本留给 A9。
 * 全部仓库、HOME、采样和加载探针都在本测试创建的系统临时目录，结束释放。
 */
import "./helpers/git-runtime.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { productionAction, PRODUCTION_RULES } from "../production-loop.ts";
import { touchedBy } from "../hosts/hook.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url)), HOOK = join(ROOT, "hosts", "hook.ts");
type Host = "claude" | "codex";
const hosts: Host[] = ["claude", "codex"];
const batchFile = "docs/batches/x/批次.json", promptFile = "docs/prompt/提示词-x.md";

function fixture(marker: Record<string, unknown> | null = { acceptance: {} }) {
  const temp = mkdtempSync(join(tmpdir(), "loop-production-")), repo = join(temp, "repo"), home = join(temp, "home");
  mkdirSync(repo); mkdirSync(home);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", AUTOREVIEW_DEV_ROOT: "" };
  for (const key of ["AUTOREVIEW_HOST", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "PLUGIN_ROOT", "AUTOREVIEW_DEBUG_EVENT", "AUTOREVIEW_DEBUG_ENV", "AUTOREVIEW_PRODUCTION_SAMPLES"]) delete env[key];
  const git = (...args: string[]): string => {
    const result = spawnSync("git", args, { cwd: repo, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  git("init", "-q", "-b", "main"); git("config", "user.email", "production@example.test"); git("config", "user.name", "production");
  const write = (path: string, text: string): void => { const file = join(repo, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
  write("business.ts", "export const value = 1;\n");
  if (marker) write(".autoreview.json", JSON.stringify(marker));
  git("add", "."); git("commit", "-qm", "fixture");
  const forbidden = join(temp, "forbidden-loads"), guard = join(temp, "guard.mjs");
  writeFileSync(guard, `import {registerHooks} from 'node:module'; import {appendFileSync} from 'node:fs';
registerHooks({resolve(specifier,context,next){const result=next(specifier,context); if (/(?:^|\\/)(?:config|loop|pipeline|review-hook|production-loop-validation)\\.ts$/.test(result.url)) {appendFileSync(${JSON.stringify(forbidden)}, result.url+'\\n');} return result;}});`);
  const event = (host: Host, tool: string, input: Record<string, unknown>, session = "one") => ({
    hook_event_name: "PostToolUse", session_id: session, cwd: repo,
    transcript_path: join(home, host === "claude" ? ".claude/projects/p/session.jsonl" : ".codex/sessions/session.jsonl"),
    ...(host === "codex" ? { turn_id: "turn-1" } : {}), permission_mode: "auto", tool_use_id: "tool-use-1", tool_name: tool, tool_input: input,
    tool_response: host === "claude" ? { success: true } : { output: "Success" },
  });
  const editEvent = (host: Host, path: string, session = "one", tool = "Edit") => host === "claude"
    ? event(host, tool, { file_path: join(repo, path), old_string: "old", new_string: "new" }, session)
    : event(host, "apply_patch", { command: tool === "Write" ? `*** Begin Patch\n*** Add File: ${path}\n+new\n*** End Patch` : `*** Begin Patch\n*** Update File: ${path}\n@@\n-old\n+new\n*** End Patch` }, session);
  const run = (input: object | string, extra: NodeJS.ProcessEnv = {}, probe = false, warning?: RegExp) => {
    const start = performance.now();
    const result = spawnSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", ...(probe ? ["--import", guard] : []), HOOK], {
      cwd: repo, env: { ...env, ...extra }, input: typeof input === "string" ? input : JSON.stringify(input), encoding: "utf8", timeout: 15_000,
    });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    if (warning) assert.match(result.stderr, warning);
    else assert.equal(result.stderr, "", result.stderr);
    return { stdout: result.stdout, ms: performance.now() - start };
  };
  const context = (stdout: string): string => {
    const parsed = JSON.parse(stdout);
    assert.deepEqual(Object.keys(parsed), ["hookSpecificOutput"]);
    assert.deepEqual(Object.keys(parsed.hookSpecificOutput), ["hookEventName", "additionalContext"]);
    assert.equal(parsed.hookSpecificOutput.hookEventName, "PostToolUse");
    return parsed.hookSpecificOutput.additionalContext;
  };
  const valid = () => JSON.stringify({ name: "x", branch: "feat/x", stages: { 甲: { prompt: "../../prompt/提示词-x.md" } } });
  return { temp, repo, home, env, git, write, event, editEvent, run, context, valid, forbidden, close: () => rmSync(temp, { recursive: true, force: true }) };
}

function assertCard(text: string): void {
  assert.ok(text.split("\n").length <= 6, text);
  for (const rule of PRODUCTION_RULES) assert.ok(text.includes(join(ROOT, rule.file)), rule.file);
  assert.match(text, /完成后由程序提交并记录，推不推由用户决定/);
  assert.match(text, /合入只由用户执行 bin\/loop 合入（合入队列），不要在会话里手动 git 合并/);
  assert.doesNotMatch(text, /merge\.auto|由程序自动合入|复制到项目|\.autoreview\/CONVENTIONS\.md|收尾回写/);
}

test("A1 两宿主范围外三类动作各 20 次，零输出且未加载校验/评审模块；记录进程耗时中位数", (t) => {
  const h = fixture();
  try {
    for (const host of hosts) {
      const samples = [
        ["读文件", h.event(host, host === "claude" ? "Read" : "read_file", { file_path: join(h.repo, batchFile) })],
        ["普通 Bash", h.event(host, "Bash", { command: "printf hello" })],
        ["编辑业务代码", h.editEvent(host, "business.ts")],
      ] as const;
      for (const [label, event] of samples) {
        const times: number[] = [];
        for (let i = 0; i < 20; i++) { const result = h.run(event, {}, true); assert.equal(result.stdout, ""); times.push(result.ms); }
        times.sort((a, b) => a - b);
        t.diagnostic(`${host} ${label}，20 次中位数 ${((times[9] + times[10]) / 2).toFixed(2)} ms（含 Node 启动与模块加载探针）`);
      }
    }
    assert.equal(existsSync(h.forbidden), false, "范围外不应加载任何校验或评审模块");
  } finally { h.close(); }
});

test("A2/A7 首次写提示词才给卡，正确批次无输出；开发会话相同；指南动作也不加载校验器", () => {
  for (const host of hosts) for (const dev of [false, true]) {
    const h = fixture();
    try {
      const env = dev ? { AUTOREVIEW_DEV_ROOT: h.repo } : {};
      h.write(promptFile, "# 任务\n");
      assertCard(h.context(h.run(h.editEvent(host, promptFile, "one", "Write"), env, true).stdout));
      assert.equal(existsSync(h.forbidden), false);
      h.write(batchFile, h.valid());
      const before = h.git("status", "--porcelain");
      assert.equal(h.run(h.editEvent(host, batchFile), env).stdout, "");
      assert.equal(h.git("status", "--porcelain"), before, "校验不能改工作区或索引");
      assert.equal(existsSync(join(h.home, ".pi-autoreview", "repo", `${host}-one.state.json`)), false, "PostToolUse 不创建评审状态");
    } finally { h.close(); }
  }
});

test("A3/A7 编辑与 Bash 重定向都复用开工报错、同会话去重，改对后静默", () => {
  for (const host of hosts) for (const dev of [false, true]) for (const bash of [false, true]) {
    const h = fixture();
    try {
      h.write(batchFile, JSON.stringify({ name: "x" }));
      const cli = spawnSync(process.execPath, [join(ROOT, "loop.ts"), "开工", join(h.repo, batchFile), "--dry-run", "--json"], { cwd: h.repo, env: h.env, encoding: "utf8" });
      assert.equal(cli.status, 1, cli.stdout + cli.stderr);
      const error = JSON.parse(cli.stdout).error;
      assert.equal(error, "批次文件的 stages 必须是对象");
      const event = bash ? h.event(host, "Bash", { command: `printf '%s' '{"name":"x"}' > '${batchFile}'` }) : h.editEvent(host, batchFile);
      const env = dev ? { AUTOREVIEW_DEV_ROOT: h.repo } : {};
      const text = h.context(h.run(event, env).stdout);
      assert.ok(text.includes(error), text); assert.ok(text.includes(join(ROOT, "README.md"))); assert.match(text, /「流水线与批次/);
      assert.equal((text.match(/Loop 规则按需读/g) ?? []).length, 1);
      assert.equal(h.run(event, env).stdout, "");
      h.write(promptFile, "# 提示词\n"); h.write(batchFile, h.valid());
      assert.equal(h.run(event, env).stdout, "");
      h.write(batchFile, '{"name":"x"}'); assert.equal(h.run(event, env).stdout, "", "同会话旧报错不重发");
    } finally { h.close(); }
  }
});

test("生产指路／两宿主 heredoc 写入即时校验；只读脚本静默、报错去重、改正后静默", () => {
  for (const host of hosts) {
    const h = fixture();
    try {
      h.write(batchFile, '{"name":"x"}'); h.write(promptFile, "# 提示词\n");
      const script = (body: string): string => `python3 - <<'PY'\nfrom pathlib import Path\n${body}\nPY\n`;
      const event = (command: string) => h.event(host, "Bash", { command });
      const read = script(`print(Path("${batchFile}").read_text())`);
      assert.equal(h.run(event(read), {}, true).stdout, "", "首次只读不能消耗指路卡或加载校验器");
      assert.equal(existsSync(h.forbidden), false);
      const write = script(`Path("${batchFile}").write_text('{"name":"x"}')`);
      // 在临时仓库真实执行评审给出的命令，再将宿主的 PostToolUse 输入送入 Hook。
      const result = spawnSync("/bin/sh", ["-c", write], { cwd: h.repo, env: h.env, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      const text = h.context(h.run(event(write)).stdout);
      assertCard(text.split("\n\n")[0]);
      assert.match(text, /批次文件的 stages 必须是对象/); assert.ok(text.includes(join(ROOT, "README.md")));
      assert.equal(h.run(event(write)).stdout, "", "同文件同报错去重");
      const correct = script(`Path("${batchFile}").write_text(${JSON.stringify(h.valid())})`);
      const corrected = spawnSync("/bin/sh", ["-c", correct], { cwd: h.repo, env: h.env, encoding: "utf8" });
      assert.equal(corrected.status, 0, corrected.stderr);
      assert.equal(h.run(event(correct)).stdout, "", "改正后不能重复指路或报错");
      assert.equal(h.run(event(write)).stdout, "", "Hook 不重执行脚本：应校验磁盘上的正确配置，而非命令中的旧内容");
      assert.equal(readFileSync(join(h.repo, batchFile), "utf8"), h.valid());
      assert.equal(h.run(event(read)).stdout, "", "只读仍保持静默");
    } finally { h.close(); }
  }
});

test("生产指路／heredoc 保留引号和命令归属，支持分隔符变体、cd、多文档及 shell 只读正文", () => {
  const h = fixture();
  try {
    const body = `from pathlib import Path\nPath("${batchFile}").write_text('{"name":"x"}')`;
    const commands = [
      `python3 - <<PY\n${body}\nPY`,
      `python3 - <<"PY"\n${body}\nPY\n`,
      `python3 - <<'P Y'\n${body}\nP Y\n`,
      `# 说明中的 <<'NOT_A_DOCUMENT' 不能吞掉后续命令\npython3 - <<'PY' # 写配置\n${body}\nPY\n`,
      `bash -c ${JSON.stringify("printf '%s' '{\"name\":\"x\"}'")} > '${batchFile}'`,
      `bash <<'SH' > '${batchFile}'\nprintf '%s' '{"name":"x"}'\nSH\n`,
      `python3 - <<-PY\n${body.split("\n").map((line) => `\t${line}`).join("\n")}\n\tPY\n`,
      `python3 - <<'PY'; printf done\n${body}\nPY\n`,
      `cd docs/batches/x && python3 - <<'PY'\nfrom pathlib import Path\nPath("批次.json").write_text('{}')\nPY\n`,
      `cat <<'TEXT'; python3 - <<'PY'\nPath("docs/batches/not-written/批次.json").write_text('{}')\nTEXT\n${body}\nPY\n`,
      `node <<'JS'\nrequire('node:fs').writeFileSync("${batchFile}", '{"name":"x"}');\nJS\n`,
    ];
    for (const command of commands) {
      assert.deepEqual(productionAction({ paths: [], command }, h.repo)?.files.map((file) => file.path), [join(h.repo, batchFile)], command);
    }
    for (const command of [
      `python3 - <<'PY'\nfrom pathlib import Path\nprint(Path("${batchFile}").read_text())\nPY\n`,
      `python3 - <<'PY'\nprint("${batchFile}")\nPY\n`,
      `node <<'JS'\nconsole.log(require('node:fs').readFileSync("${batchFile}", 'utf8'));\nJS\n`,
      `cat <<'TEXT'\n${body}\nTEXT\n`,
      `bash <<'SH'\ncat '${batchFile}'\nSH\n`,
      `cat <<< '${batchFile}'`,
      `echo hi # <<'NOT_A_DOCUMENT' ${batchFile}\n`,
    ]) assert.equal(productionAction({ paths: [], command }, h.repo), undefined, command);
  } finally { h.close(); }
});

test("A4 提示词/验收标准尚未写出只提示尚未找到，不当错误", () => {
  for (const host of hosts) {
    const h = fixture();
    try {
      h.run(h.editEvent(host, promptFile)); h.write(batchFile, h.valid());
      const missing = h.context(h.run(h.editEvent(host, batchFile)).stdout);
      assert.match(missing, /尚未找到：.*提示词-x\.md/); assert.doesNotMatch(missing, /错误|不存在/);
      h.write(promptFile, "# 已写出\n"); assert.equal(h.run(h.editEvent(host, batchFile)).stdout, "");
      for (const key of ["acceptance", "e2e"]) { // 兼容旧批次字段的缺文件提示。
        const raw = JSON.parse(h.valid()); raw[key] = { workDir: ".", criteria: "验收标准.md" };
        h.write(batchFile, JSON.stringify(raw));
        const context = h.context(h.run(h.editEvent(host, batchFile, key)).stdout);
        assert.match(context, /尚未找到：.*验收标准\.md/);
        if (key === "acceptance") assert.doesNotMatch(context, /旧写法|建议改成/);
        else assert.match(context, /旧写法，建议改成 acceptance/);
      }
    } finally { h.close(); }
  }
});

test("A5 项目状态只看原始字段或批次文件；启动只指路，不拦截", () => {
  for (const host of hosts) for (const state of ["old", "release", "workspaces", "methods", "batch"]) {
    const h = fixture();
    try {
      if (["release", "workspaces", "methods"].includes(state)) h.write(".autoreview.json", JSON.stringify({ [state]: state === "release" ? "main" : {} }));
      if (state === "batch") h.write(batchFile, "{}");
      const card = h.context(h.run(h.event(host, "Bash", { command: "/opt/loop/bin/pi-dev --cwd . docs/prompt/提示词-x.md" })).stdout);
      assertCard(card); assert.equal(card.includes("本项目未接入批次流程"), state === "old");
      if (state === "old") assert.match(card, /迁移见「迁移与检查」/);
    } finally { h.close(); }
  }
});

test("A6 compact 后重给卡，保留报错去重；宿主/session_id 隔离", () => {
  const h = fixture();
  try {
    h.write(batchFile, '{"name":"x"}');
    for (const host of hosts) {
      h.run(h.editEvent(host, batchFile));
      const session = { ...h.event(host, "", {}), hook_event_name: "SessionStart", source: "compact" };
      assert.equal(h.run(session).stdout, "");
      const card = h.context(h.run(h.editEvent(host, batchFile)).stdout);
      assertCard(card); assert.doesNotMatch(card, /stages 必须/);
      assert.equal(h.run(h.editEvent(host, promptFile)).stdout, "");
      assertCard(h.context(h.run(h.editEvent(host, promptFile, "two")).stdout));
    }
  } finally { h.close(); }
});

test("项目配置复用布局/acceptance/gate/评审解析；程序报错原文并指向运行维护", () => {
  const cases = [
    ['{"methods":{"paths":[]}}', ".autoreview.json 的 methods.paths 必须是非空字符串数组"],
    ['{"acceptance":{"readyUrl":"bad"}}', ".autoreview.json 的 acceptance.readyUrl 不是合法网址"],
    ['{"maxRepairs":-1}', ".autoreview.json 的 maxRepairs 必须是非负整数"],
    ["[]", ".autoreview.json 必须是 JSON 对象"],
  ];
  for (const host of hosts) {
    const h = fixture(null);
    try {
      for (const [raw, expected] of cases) {
        h.write(".autoreview.json", raw);
        const text = h.context(h.run(h.editEvent(host, ".autoreview.json")).stdout);
        assert.ok(text.includes(expected), text); assert.ok(text.includes(join(ROOT, "项目文档/运行与维护.md")));
        assert.equal(h.run(h.editEvent(host, ".autoreview.json")).stdout, "");
      }
      h.write(".autoreview.json", '{"gate":{}}');
      const ignored = h.run(h.editEvent(host, ".autoreview.json"), {}, false, /gate 已停用并忽略/);
      assert.equal(ignored.stdout, "");
      h.write(".autoreview.json", "{}"); assert.equal(h.run(h.editEvent(host, ".autoreview.json")).stdout, "");
    } finally { h.close(); }
  }
});

test("动作边界、MultiEdit、patch 移动、多文件 Bash、cd/空格/脚本及只读命令", () => {
  const h = fixture();
  try {
    h.write(batchFile, '{"name":"x"}');
    for (const command of [`cat '${batchFile}'`, `rg stages '${batchFile}'`, `git diff -- '${batchFile}'`, "echo bin/loop", "cat bin/pi-dev", `printf '%s' '${batchFile}'`, `jq . .autoreview.json`, `cat '${batchFile}' > unrelated.txt`, `node -e 'require("fs").readFileSync(".autoreview.json")'`, `bash -lc 'cat ${batchFile}'`]) {
      assert.equal(h.run(h.event("claude", "Bash", { command })).stdout, "", command);
    }
    const multi = h.context(h.run(h.event("claude", "MultiEdit", { file_path: join(h.repo, promptFile), edits: [] })).stdout); assertCard(multi);
    h.write("docs/batches/with space/批次.json", '{"name":"x"}');
    const text = h.context(h.run(h.event("claude", "Bash", { command: `cd 'docs/batches/with space' && python -c 'from pathlib import Path; Path("批次.json").write_text("{}")' '${join(h.repo, "docs/batches/with space/批次.json")}'` })).stdout);
    assert.match(text, /stages 必须是对象/);
    const patch = h.event("codex", "apply_patch", { command: `*** Begin Patch\n*** Update File: old.txt\n*** Move to: ${batchFile}\n@@\n-a\n+b\n*** Add File: ${promptFile}\n+x\n*** End Patch` });
    assert.deepEqual(touchedBy(patch).paths, ["old.txt", batchFile, promptFile]);
    assert.match(h.context(h.run(patch).stdout), /stages 必须是对象/);
    assert.equal(h.run(patch).stdout, "");
    const other = "docs/batches/y/批次.json"; h.write(other, '{"name":"x"}');
    const both = h.context(h.run(h.event("claude", "Bash", { command: `tee '${other}' '${batchFile}' <<'EOF'\n{}\nEOF` })).stdout);
    assert.ok(both.includes(other)); assert.ok(both.includes(batchFile));
    assert.equal((both.match(/stages 必须是对象/g) ?? []).length, 2, "同报错按文件去重");
    assertCard(h.context(h.run(h.event("claude", "Bash", { command: "bash /opt/loop/bin/loop 状态" }, "command-only")).stdout));
    assertCard(h.context(h.run(h.event("codex", "exec_command", { command: "bin/pi-dev task.md" }, "exec-alias")).stdout));
    const launcher = h.context(h.run(h.event("claude", "Bash", { command: `bin/loop 状态 '${batchFile}'` }, "launcher")).stdout);
    assertCard(launcher); assert.doesNotMatch(launcher, /stages 必须/);
    assertCard(h.context(h.run(h.editEvent("codex", ".autoreview/methods/gate.sh", "methods")).stdout));
  } finally { h.close(); }
  const unconfigured = fixture(null);
  try {
    for (const host of hosts) for (const event of [unconfigured.editEvent(host, batchFile), unconfigured.editEvent(host, promptFile), unconfigured.event(host, "Bash", { command: "bin/pi-dev task.md" })]) assert.equal(unconfigured.run(event, {}, true).stdout, "");
    assert.equal(existsSync(unconfigured.forbidden), false);
  } finally { unconfigured.close(); }
});

test("采样默认关闭、开启后原样存字节，失败/非法输入静默放行", () => {
  const h = fixture();
  try {
    const sample = join(h.temp, "samples"), event = h.event("codex", "Bash", { command: "pwd" });
    h.run(event); assert.equal(existsSync(sample), false);
    const raw = ` \n${JSON.stringify(event, null, 2)}\n\n`;
    assert.equal(h.run(raw, { AUTOREVIEW_PRODUCTION_SAMPLES: sample }).stdout, "");
    const files = readdirSync(sample); assert.equal(files.length, 1); assert.equal(readFileSync(join(sample, files[0]), "utf8"), raw);
    assert.equal(statSync(join(sample, files[0])).mode & 0o777, 0o600);
    assert.equal(h.run(event, { AUTOREVIEW_PRODUCTION_SAMPLES: join(h.repo, "business.ts") }).stdout, "");
    for (const invalid of ["", "{bad", "null", "[]"]) assert.equal(h.run(invalid).stdout, "");
    assert.equal(h.run(h.editEvent("codex", promptFile), { HOME: join(h.repo, "business.ts") }).stdout, "", "状态写入故障不能污染宿主输出");
  } finally { h.close(); }
});

test("A10 指路卡每个文件和完整标题都存在；hooks.json 只按工具名匹配且无 if", () => {
  for (const rule of PRODUCTION_RULES) {
    const file = join(ROOT, rule.file); assert.equal(existsSync(file), true);
    const headings = readFileSync(file, "utf8").split(/\r?\n/).filter((line) => /^#{1,6} /.test(line)).map((line) => line.replace(/^#{1,6} /, ""));
    for (const section of rule.sections) assert.ok(headings.includes(section), `${rule.file} 缺少标题 ${section}`);
  }
  const config = JSON.parse(readFileSync(join(ROOT, "plugins/autoreview/hooks/hooks.json"), "utf8"));
  assert.equal(config.hooks.PostToolUse.length, 1);
  assert.equal(config.hooks.PostToolUse[0].matcher, "Write|Edit|MultiEdit|Bash|apply_patch");
  assert.doesNotMatch(JSON.stringify(config), /"if"/);
});

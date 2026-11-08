#!/usr/bin/env node
/** 仅准备供协调方手动启动的隔离窗口示例；不启动宿主/模型/验收，不修改真实配置。 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const loop = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), "bin/loop");
const root = realpathSync(mkdtempSync(join(tmpdir(), "loop-window-example-")));
const quote = (s) => `'${s.replace(/'/g, "'\\''")}'`;
function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
}
const samples = [];
for (const [name, tasks] of [["single", ["甲"]], ["batch", ["甲", "乙"]]]) {
  const base = join(root, name), repo = join(base, "repo"), state = join(base, "state"), origin = join(base, "origin.git");
  mkdirSync(repo, { recursive: true }); mkdirSync(state); mkdirSync(join(repo, "src")); mkdirSync(join(repo, "prompts"));
  git(repo, "init", "-q", "-b", "dev"); git(repo, "config", "user.name", "Loop window example"); git(repo, "config", "user.email", "loop-window@example.invalid");
  git(base, "init", "--bare", "-q", origin); git(repo, "remote", "add", "origin", origin);
  writeFileSync(join(repo, ".gitignore"), ".autoreview.json\ndist/\n__pycache__/\n");
  writeFileSync(join(repo, ".autoreview.json"), JSON.stringify({ release: "dev", gate: { obsolete: "保留此旧字段，验证不刷屏" }, ...(tasks.length > 1 ? { acceptance: { reset: "printf 'example reset\\n'", cleanup: "printf 'example cleanup\\n'" } } : {}) }));
  for (const task of tasks) {
    writeFileSync(join(repo, "src", `${task}.cjs`), "module.exports = 0;\n");
    writeFileSync(join(repo, "prompts", `${task}.md`), `# 独立窗口流程示例 ${task}\n只把 src/${task}.cjs 的导出值改为 42，其他任务文件不动。可以在此窗口输入补充要求。不要自行 git add/commit/merge/push。做必要定向自检；交付时在回复第一行独立写【交付完成】，后面说明改动；需要用户决定则写【需要你决定】。\n`);
  }
  const file = join(repo, "开发卡.json"), card = { version: 1, name: `窗口示例-${name}`, nature: "开发", target: "dev", host: "pi",
    flow: ["开发评审", "测试", ...(tasks.length > 1 ? ["验收"] : [])],
    tasks: tasks.map((task) => ({ name: task, prompt: `prompts/${task}.md`, scope: [`src/${task}.cjs`],
      test: `node -e "const f=require('fs');f.mkdirSync('dist',{recursive:true});f.writeFileSync('dist/${task}.cjs',f.readFileSync('src/${task}.cjs'));if(require('./dist/${task}.cjs')!==42)throw Error('AssertionError: expected 42')"` })),
    ...(tasks.length > 1 ? { acceptance: "标准.md" } : {}) };
  if (tasks.length > 1) writeFileSync(join(repo, "标准.md"), `## 验收标准\n${tasks.map((task, i) => `A${i + 1}. [${task}] 操作：执行 node -e "if(require('./src/${task}.cjs')!==42)throw Error('expected 42')"\n    预期：退出码为 0，保留原始命令输出。`).join("\n")}\nA3. [人工] 操作：观察两个 Pi 窗口并输入补充要求\n    预期：任务/批次进度与停点易懂；此项由用户判断。\n`);
  writeFileSync(file, JSON.stringify(card, null, 2)); git(repo, "add", "."); git(repo, "commit", "-qm", "isolate window example");
  const pa = join(state, "pa.json"); writeFileSync(pa, JSON.stringify({ pa: { localNotify: false } }));
  const wrapper = join(base, "run-loop.sh"), env = { AUTOREVIEW_KERNEL_ROOT: join(state, "kernel"), AUTOREVIEW_LOCAL_QUEUE_ROOT: join(state, "queue"), AUTOREVIEW_RESOURCE_ROOT: join(state, "resources"), AUTOREVIEW_PROJECTS_ROOT: join(state, "projects"), LOOP_PA_CONFIG: pa };
  writeFileSync(wrapper, `#!/bin/sh\ncd ${quote(repo)} || exit 1\nunset AUTOREVIEW_KERNEL_LEDGER AUTOREVIEW_KERNEL_RUN AUTOREVIEW_KERNEL_TASK AUTOREVIEW_KERNEL_REPAIR AUTOREVIEW_KERNEL_LAUNCH AUTOREVIEW_DEV_ROOT AUTOREVIEW_BASE_REV AUTOREVIEW_BATCH_FILE AUTOREVIEW_STAGE\nexec env ${Object.entries(env).map(([k, v]) => `${k}=${quote(v)}`).join(" ")} ${quote(loop)} "$@"\n`, { mode: 0o700 });
  const cmd = (action, tail = "") => `${quote(wrapper)} ${action} ${quote(file)}${tail}`;
  samples.push({ name, repo, origin, file, wrapper, state, started: false, commands: { dryRun: cmd("启动", " --dry-run --json"), launch: cmd("启动"), query: cmd("查询", " --json"), stop: cmd("停止", " --json"), resume: cmd("续跑"), resumeTask: cmd("续跑", " --task 甲"), backgroundAfterStop: cmd("续跑", " --launcher background --json"), abandon: cmd("放弃", " --json") } });
}
const manifest = join(root, "examples.json");
writeFileSync(manifest, JSON.stringify({ root, source: loop, preparedOnly: true, samples, cleanup: "先用各自 wrapper 停止/放弃；确认该卡及 testWorkspaces 释放后按本清单精确归属收尾。未提交成果或未知资源保留，不猜删。" }, null, 2));
console.log(JSON.stringify({ root, manifest, samples }, null, 2));

/**
 * setup-acceptance.ts — 一条命令给项目接入自动验收：探测项目怎么启动，写好 .autoreview.json 的 acceptance，
 * 在 AGENTS.md（和 Claude Code 读的 CLAUDE.md）里插入或更新接入手册的【块 1】。
 * 先打印要改什么，你确认了才写；可以重复跑：已有的 acceptance 保留不动，【块 1】只替换标记之间的那一段。
 *
 * 用法：node /Users/Admin/Desktop/loop/setup-acceptance.ts <项目目录> [--yes] [--host claude|codex|pi]
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { checkAcceptanceBudget, MARKER_FILE, parseAcceptanceConfig } from "./config.ts";
import { BLOCK_END, BLOCK_START, blockVersion, conventionTarget, copyNotice, GUIDE_DOC, readBlock } from "./onboarding.ts";
import { DEFAULT_TIMEOUT_MIN } from "./review.ts";

export interface Detection {
  kind: "命令行" | "网页或接口" | "看不出来";
  /** 推断出的 acceptance 一节。 */
  acceptance: Record<string, unknown>;
  /** 推断依据和需要你核对的地方。 */
  notes: string[];
  /** 验收大概要操作网页。 */
  needsBrowser: boolean;
  hasPlaywright: boolean;
}

const FRONTEND = ["next", "vite", "react-scripts", "nuxt", "@sveltejs/kit", "astro", "@angular/core"];
const BACKEND = ["express", "koa", "fastify", "@nestjs/core", "hono", "@hapi/hapi"];
const readJson = (file: string): Record<string, any> | undefined => {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return undefined; }
};
const readText = (file: string): string => {
  try { return readFileSync(file, "utf8"); } catch { return ""; }
};

/** 找一个当前空闲的端口给被测系统用。 */
export function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolvePort(port));
    });
  });
}

/** 项目里的日志文件和操作说明，只看最常见的位置。 */
function extras(root: string): { logs: string[]; guide?: string } {
  const logs: string[] = [];
  for (const dir of ["logs", "log"]) {
    try {
      for (const name of readdirSync(join(root, dir))) if (name.endsWith(".log") && logs.length < 5) logs.push(`${dir}/${name}`);
    } catch { /* 没有这个目录 */ }
  }
  let guide: string | undefined;
  for (const dir of [".", "docs"]) {
    try {
      const found = readdirSync(join(root, dir)).find((name) => /\.md$/i.test(name) && /usage|how-?to|使用|操作|说明/i.test(name));
      if (found) { guide = dir === "." ? found : `${dir}/${found}`; break; }
    } catch { /* 没有这个目录 */ }
  }
  return { logs, guide };
}

/** 按项目文件推断类型、启动命令和端口；推不出来的写进 notes 让你补。 */
export function detectProject(root: string, port: number): Detection {
  const notes: string[] = [];
  const url = `http://localhost:${port}/`;
  const { logs, guide } = extras(root);
  const optional: Record<string, unknown> = {};
  if (logs.length > 0) { optional.logs = logs; notes.push(`收集日志：${logs.join("、")}`); }
  if (guide) { optional.guide = guide; notes.push(`操作说明：${guide}（原文交给验收方）`); }

  const pkg = readJson(join(root, "package.json"));
  if (pkg) {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies } as Record<string, string>;
    const has = (name: string) => Object.prototype.hasOwnProperty.call(deps, name);
    const hasPlaywright = has("playwright") || has("@playwright/test");
    const runner = existsSync(join(root, "pnpm-lock.yaml")) ? "pnpm" : existsSync(join(root, "yarn.lock")) ? "yarn" : "npm";
    const run = (script: string, args = ""): string => {
      const base = runner === "yarn" ? `yarn ${script}` : `${runner} run ${script}`;
      return args ? `${base}${runner === "npm" ? " --" : ""} ${args}` : base;
    };
    const scripts = (pkg.scripts ?? {}) as Record<string, string>;
    const frontend = FRONTEND.find(has);
    const backend = BACKEND.find(has);
    if (frontend || backend) {
      const script = frontend && scripts.dev ? "dev" : scripts.start ? "start" : scripts.dev ? "dev" : undefined;
      if (!script) {
        notes.push(`看起来是网页或接口项目（${frontend ?? backend}），但 package.json 里没有 start 或 dev 脚本：请按【块 2】补上 start`);
        return { kind: "网页或接口", acceptance: { ...optional }, notes, needsBrowser: Boolean(frontend), hasPlaywright };
      }
      // vite 不认 PORT 环境变量，端口只能写进命令；其他常见框架都认 PORT。
      const start = frontend === "vite" ? run(script, `--port ${port} --strictPort`) : run(script);
      const env: Record<string, string> = { PORT: String(port) };
      if (frontend === "react-scripts") env.BROWSER = "none";
      notes.push(`启动命令：${start}（package.json 的 ${script} 脚本，${frontend ?? backend}）`);
      notes.push(`端口：${port}（${frontend === "vite" ? "写进启动命令" : "通过 PORT 环境变量传给服务；服务不认 PORT 的话把端口写进 start"}）`);
      return {
        kind: "网页或接口", acceptance: { start, readyUrl: url, env, ...optional }, notes, needsBrowser: Boolean(frontend), hasPlaywright,
      };
    }
    if (pkg.bin) {
      notes.push("命令行项目（package.json 有 bin）：验收方直接调用命令，不用启动服务");
      return { kind: "命令行", acceptance: { ...optional }, notes, needsBrowser: false, hasPlaywright };
    }
  }

  if (existsSync(join(root, "manage.py"))) {
    const start = `python3 manage.py runserver 127.0.0.1:${port}`;
    notes.push(`启动命令：${start}（Django，manage.py）`);
    return { kind: "网页或接口", acceptance: { start, readyUrl: `http://127.0.0.1:${port}/`, ...optional }, notes, needsBrowser: true, hasPlaywright: false };
  }
  const python = `${readText(join(root, "pyproject.toml"))}\n${readText(join(root, "requirements.txt"))}`;
  if (/fastapi|uvicorn|flask/i.test(python)) {
    notes.push(`看起来是 Python 接口项目，启动命令推断不出来：请按【块 2】补上 start（例如 uvicorn main:app --port ${port}）和 readyUrl（${url}）`);
    return { kind: "网页或接口", acceptance: { ...optional }, notes, needsBrowser: false, hasPlaywright: false };
  }
  if (/\[project\.scripts\]|console_scripts/.test(python)) {
    notes.push("命令行项目（Python 入口脚本）：验收方直接调用命令，不用启动服务");
    return { kind: "命令行", acceptance: { ...optional }, notes, needsBrowser: false, hasPlaywright: false };
  }
  if (existsSync(join(root, "docker-compose.yml")) || existsSync(join(root, "compose.yaml"))) {
    notes.push("有 docker compose 配置：如果服务靠它启动，按【块 2】把 start 写成 docker compose up，readyUrl 写服务地址");
  }
  notes.push("看不出项目类型：命令行项目保持 {} 即可；要先启动服务的项目按【块 2】补上 start 和 readyUrl");
  return { kind: "看不出来", acceptance: { ...optional }, notes, needsBrowser: false, hasPlaywright: false };
}

/** 在文件内容里插入或更新【块 1】：有标记就替换标记之间，旧版标题就整段换掉，都没有就追加到末尾。 */
export function upsertBlock(content: string, block: string): { text: string; action: "追加" | "更新" | "已是最新"; warning?: string } {
  const latest = blockVersion(block) ?? 0;
  const lines = content.split("\n");
  const start = lines.findIndex((line) => BLOCK_START.test(line));
  if (start >= 0) {
    const end = lines.findIndex((line, index) => index > start && line.trim() === BLOCK_END);
    if (end < 0) return { text: content, action: "已是最新", warning: `找到了开始标记却没有结束标记「${BLOCK_END}」，没有改动，请手动整理` };
    if ((blockVersion(lines[start]) ?? 0) >= latest) return { text: content, action: "已是最新" };
    return { text: [...lines.slice(0, start), block, ...lines.slice(end + 1)].join("\n"), action: "更新" };
  }
  const legacy = lines.findIndex((line) => /^##\s*起草需求时写验收标准（自动验收）\s*$/.test(line.trim()));
  if (legacy >= 0) {
    const close = lines.findIndex((line, index) => index > legacy && line.trim() === "开发时不要补写或修改验收标准；验收标准只认用户发来的消息。");
    if (close >= 0) return { text: [...lines.slice(0, legacy), block, ...lines.slice(close + 1)].join("\n"), action: "更新" };
  }
  const base = content.replace(/\s*$/, "");
  return { text: `${base ? `${base}\n\n` : ""}${block}\n`, action: "追加" };
}

export interface Plan {
  root: string;
  detection: Detection;
  /** 要写的 .autoreview.json 全文；undefined 表示不动。 */
  config?: string;
  configAction: string;
  files: { file: string; text: string; action: string; warning?: string }[];
  tips: string[];
}

/** 算出要改什么，不写盘。 */
export async function planSetup(root: string, host?: string): Promise<Plan> {
  if (!statSync(root).isDirectory()) throw new Error(`不是目录：${root}`);
  const detection = detectProject(root, await freePort());
  const configPath = join(root, MARKER_FILE);
  let data: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    const parsed = readJson(configPath);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${configPath} 不是合法的 JSON 对象，先修好再跑`);
    data = parsed;
  }
  let config: string | undefined;
  let configAction: string;
  if (data.acceptance !== undefined) {
    configAction = "已有 acceptance，保留你的配置（要重新探测就先删掉 acceptance 一节再跑）";
  } else {
    const next = { ...data, acceptance: detection.acceptance };
    // 写之前按程序的规则校验一遍，保证写进去的配置一定能用。
    const timeout = typeof data.reviewTimeoutMin === "number" ? data.reviewTimeoutMin : DEFAULT_TIMEOUT_MIN;
    checkAcceptanceBudget(timeout, parseAcceptanceConfig(next.acceptance, root, {}));
    config = `${JSON.stringify(next, null, 2)}\n`;
    configAction = existsSync(configPath) ? "加上 acceptance 一节（其他字段保留）" : "新建";
  }

  const block = readBlock(1);
  const tips: string[] = [];
  const targets = new Set<string>();
  if (host) targets.add(conventionTarget(root, host));
  else {
    targets.add(conventionTarget(root, "codex"));
    const claude = conventionTarget(root, "claude");
    if (existsSync(claude) || claude === join(root, "AGENTS.md")) targets.add(claude);
    else tips.push("用 Claude Code 头脑风暴的话：Claude Code 不读 AGENTS.md，在项目里建 CLAUDE.md 写一行 @AGENTS.md（或用 --host claude 重跑）");
  }
  const files = [...targets].map((file) => ({ file, ...upsertBlock(readText(file), block) }));
  if (detection.needsBrowser && !detection.hasPlaywright) tips.push(copyNotice(3, root));
  return { root, detection, config, configAction, files, tips };
}

export function renderPlan(plan: Plan): string {
  const lines = [`项目：${plan.root}（看起来是：${plan.detection.kind}）`, "", `1. ${join(plan.root, MARKER_FILE)}：${plan.configAction}`];
  if (plan.config) lines.push(...plan.config.trimEnd().split("\n").map((line) => `     ${line}`));
  lines.push(...plan.detection.notes.map((note) => `   - ${note}`));
  plan.files.forEach((entry, index) => {
    lines.push(`${index + 2}. ${entry.file}：${entry.action === "已是最新" ? "【块 1】已是最新，不用改" : `${entry.action}【块 1】（来自 ${GUIDE_DOC}）`}`);
    if (entry.warning) lines.push(`   - ${entry.warning}`);
  });
  if (plan.tips.length > 0) lines.push("", "还需要你做：", ...plan.tips.map((tip) => `- ${tip}`));
  return lines.join("\n");
}

/** 按计划写盘；返回实际写了的文件。 */
export function applyPlan(plan: Plan): string[] {
  const written: string[] = [];
  if (plan.config) {
    writeFileSync(join(plan.root, MARKER_FILE), plan.config);
    written.push(join(plan.root, MARKER_FILE));
  }
  for (const entry of plan.files) {
    if (entry.action === "已是最新") continue;
    writeFileSync(entry.file, entry.text);
    written.push(entry.file);
  }
  return written;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const yes = argv.includes("--yes");
  const hostIndex = argv.indexOf("--host");
  const host = hostIndex >= 0 ? argv[hostIndex + 1] : undefined;
  const target = argv.find((arg, index) => !arg.startsWith("--") && (hostIndex < 0 || index !== hostIndex + 1));
  if (!target) {
    process.stderr.write("用法：node setup-acceptance.ts <项目目录> [--yes] [--host claude|codex|pi]\n");
    return 1;
  }
  const plan = await planSetup(resolve(target), host);
  process.stdout.write(`${renderPlan(plan)}\n\n`);
  const changes = Boolean(plan.config) || plan.files.some((entry) => entry.action !== "已是最新");
  if (!changes) {
    process.stdout.write("没有要改的。\n");
    return 0;
  }
  if (!yes) {
    if (!process.stdin.isTTY) {
      process.stdout.write("没有写入：确认无误后加 --yes 再跑一次。\n");
      return 0;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question("按上面写入吗？[y/N] ")).trim().toLowerCase();
    rl.close();
    if (answer !== "y" && answer !== "yes") {
      process.stdout.write("没有写入。\n");
      return 0;
    }
  }
  for (const file of applyPlan(plan)) process.stdout.write(`已写入：${file}\n`);
  process.stdout.write("这些文件在你的项目里，提交与否由你决定。\n");
  return 0;
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (error: unknown) => {
    process.stderr.write(`接入失败：${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

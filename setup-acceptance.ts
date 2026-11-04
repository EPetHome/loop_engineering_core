/**
 * setup-acceptance.ts — 一条命令给项目接入自动验收：探测项目怎么启动，写好 .autoreview.json 的 acceptance，
 * 先打印要改什么，你确认了才写；已有的 acceptance 保留不动，不读写项目的规则文件。
 *
 * 用法：bin/loop 接入 <项目目录> [--yes] [--dry-run]；本文件保留直接调用兼容。
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { MARKER_FILE, resolveProjectConfig } from "./config.ts";
import { browserHint, CONFIG_SECTION, GUIDE_DOC } from "./onboarding.ts";

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

/** 有常驻服务的项目都提醒一次：验收会写数据时要配 reset，否则从第 2 轮起数据不干净。 */
export const RESET_NOTE = `验收会写数据库或文件的话，按 ${GUIDE_DOC}「${CONFIG_SECTION}」补上 reset（只重置数据、不重启服务）；不配的话从第 2 次验收起数据不干净，依赖初始状态的标准会验不了`;

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
        notes.push(`看起来是网页或接口项目（${frontend ?? backend}），但 package.json 里没有 start 或 dev 脚本：请按「${CONFIG_SECTION}」补上 start`);
        notes.push(RESET_NOTE);
        return { kind: "网页或接口", acceptance: { ...optional }, notes, needsBrowser: Boolean(frontend), hasPlaywright };
      }
      // vite 不认 PORT 环境变量，端口只能写进命令；其他常见框架都认 PORT。
      const start = frontend === "vite" ? run(script, `--port ${port} --strictPort`) : run(script);
      const env: Record<string, string> = { PORT: String(port) };
      if (frontend === "react-scripts") env.BROWSER = "none";
      notes.push(`启动命令：${start}（package.json 的 ${script} 脚本，${frontend ?? backend}）`);
      notes.push(`端口：${port}（${frontend === "vite" ? "写进启动命令" : "通过 PORT 环境变量传给服务；服务不认 PORT 的话把端口写进 start"}）`);
      notes.push(RESET_NOTE);
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
    notes.push(RESET_NOTE);
    return { kind: "网页或接口", acceptance: { start, readyUrl: `http://127.0.0.1:${port}/`, ...optional }, notes, needsBrowser: true, hasPlaywright: false };
  }
  const python = `${readText(join(root, "pyproject.toml"))}\n${readText(join(root, "requirements.txt"))}`;
  if (/fastapi|uvicorn|flask/i.test(python)) {
    notes.push(`看起来是 Python 接口项目，启动命令推断不出来：请按「${CONFIG_SECTION}」补上 start（例如 uvicorn main:app --port ${port}）和 readyUrl（${url}）`);
    notes.push(RESET_NOTE);
    return { kind: "网页或接口", acceptance: { ...optional }, notes, needsBrowser: false, hasPlaywright: false };
  }
  if (/\[project\.scripts\]|console_scripts/.test(python)) {
    notes.push("命令行项目（Python 入口脚本）：验收方直接调用命令，不用启动服务");
    return { kind: "命令行", acceptance: { ...optional }, notes, needsBrowser: false, hasPlaywright: false };
  }
  if (existsSync(join(root, "docker-compose.yml")) || existsSync(join(root, "compose.yaml"))) {
    notes.push(`有 docker compose 配置：如果服务靠它启动，按「${CONFIG_SECTION}」把 start 写成 docker compose up，readyUrl 写服务地址`);
  }
  notes.push(`看不出项目类型：命令行项目保持 {} 即可；要先启动服务的项目按「${CONFIG_SECTION}」补上 start 和 readyUrl`);
  return { kind: "看不出来", acceptance: { ...optional }, notes, needsBrowser: false, hasPlaywright: false };
}

export interface Plan {
  root: string;
  detection: Detection;
  /** 要写的 .autoreview.json 全文；undefined 表示不动。 */
  config?: string;
  configAction: string;
  tips: string[];
}

/** 算出要改什么，不写盘。 */
export async function planSetup(root: string): Promise<Plan> {
  if (!statSync(root).isDirectory()) throw new Error(`不是目录：${root}`);
  const detection = detectProject(root, await freePort());
  const configPath = join(root, MARKER_FILE);
  const data = resolveProjectConfig(existsSync(configPath) ? root : undefined).raw;
  let config: string | undefined;
  let configAction: string;
  if (data.acceptance !== undefined) {
    configAction = "已有 acceptance，保留你的配置（要重新探测就先删掉 acceptance 一节再跑）";
  } else {
    const next = { ...data, acceptance: detection.acceptance };
    // 写之前按程序的规则校验一遍，保证写进去的配置一定能用。
    resolveProjectConfig(root, { marker: next });
    config = `${JSON.stringify(next, null, 2)}\n`;
    configAction = existsSync(configPath) ? "加上 acceptance 一节（其他字段保留）" : "新建";
  }

  const tips = [`配置说明：${GUIDE_DOC}「${CONFIG_SECTION}」。规则由 Loop 运行时注入或按需指路，无需同步项目副本。`];
  if (detection.needsBrowser && !detection.hasPlaywright) tips.push(browserHint(root));
  return { root, detection, config, configAction, tips };
}

export function renderPlan(plan: Plan): string {
  const lines = [`项目：${plan.root}（看起来是：${plan.detection.kind}）`, "", `1. ${join(plan.root, MARKER_FILE)}：${plan.configAction}`];
  if (plan.config) lines.push(...plan.config.trimEnd().split("\n").map((line) => `     ${line}`));
  lines.push(...plan.detection.notes.map((note) => `   - ${note}`));
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
  return written;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let yes = false, dryRun = false, target: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--yes") yes = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--host" && ["claude", "codex", "pi"].includes(argv[index + 1])) index++; // 旧参数兼容，不影响行为。
    else if (!arg.startsWith("-") && !target) target = arg;
    else throw new Error(`未知或不完整的参数：${arg}`);
  }
  if (!target) {
    process.stderr.write("用法：bin/loop 接入 <项目目录> [--yes] [--dry-run]\n");
    return 1;
  }
  const plan = await planSetup(resolve(target));
  process.stdout.write(`${renderPlan(plan)}\n\n`);
  if (dryRun) {
    process.stdout.write("仅预览，没有写入。\n");
    return 0;
  }
  const changes = Boolean(plan.config);
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
  process.stdout.write("配置在你的项目里，提交与否由你决定。\n");
  return 0;
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (error: unknown) => {
    process.stderr.write(`接入失败：${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

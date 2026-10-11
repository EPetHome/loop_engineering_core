#!/usr/bin/env node
/**
 * browser.mjs — 验收方操作网页并留证据：按步骤文件驱动无头 Chromium，把每一步的结果、读到的文字、
 * 页面报错和截图路径追加到 <运行目录>/evidence/<条目>.txt，截图存成 evidence/<条目>-<名字>.png。
 *
 * 运行目录里的 ./browser 包装脚本会补上前两个参数（运行目录、项目目录），验收方这样用：
 *   ./browser A3 steps.json
 * 步骤文件是 JSON 数组，每步一个对象：
 *   {"goto": "http://localhost:3000"}        打开网址
 *   {"click": "text=保存"}                   点击（选择器写法同 Playwright：css、text=、role= 等）
 *   {"fill": "#name", "value": "张三"}        输入
 *   {"press": "#name", "key": "Enter"}       按键
 *   {"text": ".message"}                     读出元素文字（全部匹配的元素）
 *   {"waitFor": "text=已保存"}               等元素出现
 *   {"screenshot": "保存后"}                 截图
 *   {"wait": 500}                            等若干毫秒
 * Playwright 依次从 AUTOREVIEW_PLAYWRIGHT、项目依赖、全局 npm 里找；找不到时退出码 2，并在证据里写明。
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const STEP_TIMEOUT = 15_000;
const [runDir, workDir, id, stepsArg] = process.argv.slice(2);
if (!runDir || !id || !/^[AG]\d+$/.test(id) || !stepsArg) {
  process.stderr.write("用法：./browser <条目，如 A3> <步骤文件.json>\n");
  process.exit(2);
}

const evidenceDir = join(runDir, "evidence");
mkdirSync(evidenceDir, { recursive: true });
const file = join(evidenceDir, `${id}.txt`);
const count = existsSync(file) ? (readFileSync(file, "utf8").match(new RegExp(`^=== ${id} #`, "gm")) ?? []).length : 0;
const lines = [`=== ${id} #${count + 1} ${new Date().toISOString()}`, `$ browser ${stepsArg}`];
const finish = (code) => {
  appendFileSync(file, `${lines.join("\n")}\n\n`);
  process.stdout.write(`${lines.slice(1).join("\n")}\n[browser] 已记录到 evidence/${id}.txt\n`);
  process.exit(code);
};

function resolveFrom(base, name) {
  try { return createRequire(join(base, "noop.js")).resolve(name); } catch { return undefined; }
}

async function loadPlaywright() {
  const candidates = [];
  const forced = process.env.AUTOREVIEW_PLAYWRIGHT?.trim();
  if (forced) candidates.push(resolveFrom(forced, forced) ?? resolveFrom(forced, "playwright"));
  if (workDir) for (const name of ["playwright", "@playwright/test"]) candidates.push(resolveFrom(workDir, name));
  const globalRoot = spawnSync("npm", ["root", "-g"], { encoding: "utf8", timeout: 10_000 }).stdout?.trim();
  if (globalRoot) for (const name of ["playwright", "@playwright/test"]) candidates.push(resolveFrom(globalRoot, `./${name}`) ?? resolveFrom(globalRoot, name));
  for (const path of candidates.filter(Boolean)) {
    try {
      const mod = await import(pathToFileURL(path).href);
      const chromium = mod.chromium ?? mod.default?.chromium;
      if (chromium) return chromium;
    } catch { /* 试下一个 */ }
  }
  return undefined;
}

let steps;
try {
  steps = JSON.parse(readFileSync(resolve(runDir, stepsArg), "utf8"));
  if (!Array.isArray(steps) || steps.length === 0) throw new Error("步骤文件必须是非空 JSON 数组");
} catch (error) {
  lines.push(`步骤文件有问题：${error.message}`);
  finish(2);
}

const chromium = await loadPlaywright();
if (!chromium) {
  lines.push("缺少 Playwright：在项目里安装 playwright 并执行 npx playwright install chromium，或设置 AUTOREVIEW_PLAYWRIGHT 指向 playwright 模块目录。这一条请报「无法验证」。");
  finish(2);
}

const safeName = (name) => String(name).replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(0, 60) || "shot";
let browser;
let code = 0;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(STEP_TIMEOUT);
  page.on("console", (message) => { if (message.type() === "error") lines.push(`页面控制台报错：${message.text()}`); });
  page.on("pageerror", (error) => lines.push(`页面脚本报错：${error.message}`));
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i] ?? {};
    const n = `${i + 1}.`;
    try {
      if (step.goto !== undefined) {
        const res = await page.goto(String(step.goto), { timeout: STEP_TIMEOUT });
        lines.push(`${n} goto ${step.goto} → ${res ? res.status() : "无响应"}`);
      } else if (step.click !== undefined) {
        await page.locator(String(step.click)).first().click();
        lines.push(`${n} click ${step.click}`);
      } else if (step.fill !== undefined) {
        await page.locator(String(step.fill)).first().fill(String(step.value ?? ""));
        lines.push(`${n} fill ${step.fill} = ${step.value ?? ""}`);
      } else if (step.press !== undefined) {
        await page.locator(String(step.press)).first().press(String(step.key ?? "Enter"));
        lines.push(`${n} press ${step.press} ${step.key ?? "Enter"}`);
      } else if (step.text !== undefined) {
        const texts = await page.locator(String(step.text)).allInnerTexts();
        lines.push(`${n} text ${step.text} → ${texts.length ? texts.map((text) => text.trim()).join(" | ") : "（没有匹配的元素）"}`);
      } else if (step.waitFor !== undefined) {
        await page.locator(String(step.waitFor)).first().waitFor({ state: "visible" });
        lines.push(`${n} waitFor ${step.waitFor} → 已出现`);
      } else if (step.screenshot !== undefined) {
        const shot = join(evidenceDir, `${id}-${safeName(step.screenshot)}.png`);
        await page.screenshot({ path: shot, fullPage: true });
        lines.push(`${n} screenshot → ${shot}`);
      } else if (step.wait !== undefined) {
        await page.waitForTimeout(Number(step.wait) || 0);
        lines.push(`${n} wait ${step.wait}ms`);
      } else {
        throw new Error(`不认识的步骤：${JSON.stringify(step)}`);
      }
    } catch (error) {
      lines.push(`${n} 失败：${String(error.message ?? error).split("\n")[0]}`);
      code = 1;
      break;
    }
  }
  lines.push(`最后网址：${page.url()}`);
  lines.push(code === 0 ? "结果：全部步骤完成" : "结果：有步骤失败，后面的步骤没有执行");
} catch (error) {
  lines.push(`浏览器无法启动：${String(error.message ?? error).split("\n")[0]}`);
  code = 2;
} finally {
  await browser?.close().catch(() => {});
}
finish(code);

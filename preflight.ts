/** 批次写后核对与开发前空跑。只核对声明的事实，不替项目改范围或标准。 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { probeAcceptanceReset } from "./acceptance.ts";
import { isCriteriaHeading } from "./acceptance-core.ts";
import { MARKER_FILE, findProjectRoot, resolveProjectConfig, workflowSteps } from "./config.ts";
import { parseReview } from "./core.ts";
import { createGitEvidence } from "./git.ts";
import { createChildExec } from "./hosts/review-hook.ts";
import { methodEnv } from "./method-env.ts";
import type { Check, Plan } from "./pipeline.ts";
import { defaultCallReviewer, newReviewState } from "./review.ts";
import { changedSince, missingSyncScope, outOfScope } from "./scope.ts";

/** 流程和配置必须一致；只读检查，早于任何开发空间或会话副作用。 */
export function checkStageWorkflow(stage: import("./pipeline.ts").StagePlan, config: ReturnType<typeof resolveProjectConfig>): Check[] {
  const workflow = stage.workflow ?? "with-acceptance";
  const basis = stage.workflowExplicit ? `批次 stages.${stage.name}.workflow 明确指定 ${workflow}` : `批次 stages.${stage.name}.workflow 未写，默认带验收`;
  const checks: Check[] = [{ name: `${stage.name} 的流程`, ok: true, detail: `${workflowSteps(workflow)}；依据：${basis}` }];
  if (!config.gate) checks.push({ name: `${stage.name} 的门禁配置`, ok: false,
    detail: `缺少项目门禁。请在项目 .autoreview.json 配置 gate，例如 {"gate":{"cmd":"项目实际测试命令","timeoutMin":10}}；两条流程都必须执行测试。` });
  if (workflow === "with-acceptance" && !config.acceptance) checks.push({ name: `${stage.name} 的验收配置`, ok: false,
    detail: `带验收流程缺少验收配置。请在项目 .autoreview.json 配置 acceptance（命令行项目可用 {}），或在 stages.${stage.name}.acceptance 配置本段验收；如果任务确实不带验收，由协作者明确设置 workflow:"without-acceptance"。` });
  if (workflow === "without-acceptance" && stage.prompt) {
    try {
      const prompt = readFileSync(stage.prompt, "utf8");
      if (prompt.split(/\r?\n/).some(isCriteriaHeading)) checks.push({ name: `${stage.name} 的流程与验收标准`, ok: false,
        detail: `流程和验收标准对不上：workflow:"without-acceptance"，但提示词 ${stage.prompt} 写了「## 验收标准」。请由协作者改为带验收流程并补齐配置，或确认任务不带验收后修正提示词。` });
    } catch (error) { checks.push({ name: `${stage.name} 的提示词`, ok: false, detail: `无法核对流程：${String(error)}；请补齐提示词。` }); }
  }
  return checks;
}

/** 写完配置即可调用；不建目录、不运行命令或模型。 */
export function checkBatchConfiguration(plan: Plan, fallbackRoot: string, options: { localFileCopies?: readonly { source: string; target: string }[] } = {}): Check[] {
  const checks: Check[] = [];
  const guideDetail = (guide: string): string => {
    try { readFileSync(guide, "utf8"); return guide; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      for (const copy of options.localFileCopies ?? []) {
        // copyLocalFiles 只复制尚不存在的目标；已有目录缺子文件时不能假称稍后会补齐。
        if (existsSync(copy.target)) continue;
        const rel = relative(copy.target, guide);
        if (isAbsolute(rel) || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\")) continue;
        const source = resolve(copy.source, rel);
        try { readFileSync(source, "utf8"); }
        catch (sourceError) { throw new Error(`待复制的验收说明来源不可读 ${source}：${String(sourceError)}`); }
        return `${guide}（开工将从 ${source} 复制，复制后再实际加载校验）`;
      }
      throw error;
    }
  };
  for (const stage of plan.stages.values()) {
    const pendingMarker = options.localFileCopies?.some((copy) => {
      const rel = relative(resolve(copy.target, ".."), stage.cwd);
      return copy.target.endsWith(`/${MARKER_FILE}`) && !existsSync(copy.target) && !isAbsolute(rel) && rel !== ".." && !rel.startsWith("../");
    });
    // 只有尚未建立的工作区或已计划复制配置的本仓库 worktree 可借运行版核对。
    // 已存在的外部项目不能借用运行版门禁冒充自己已有配置。
    const root = findProjectRoot(stage.cwd) ?? (!existsSync(stage.cwd) || pendingMarker ? findProjectRoot(fallbackRoot) : undefined);
    const config = resolveProjectConfig(root, stage.configOverrides);
    checks.push(...checkStageWorkflow(stage, config));
    const missing = stage.scope ? missingSyncScope(root ?? stage.cwd, stage.scope) : [];
    checks.push({ name: `${stage.name} 的同步范围核对`, ok: !missing.length,
      detail: missing.length ? missing.map((item) => `${item.source} 声明「${item.rule}」；范围缺少：${item.missing.join("、")}。请把这些具体文件或覆盖它们的目录加入 stages.${stage.name}.scope.allow，并移除相应 deny。`).join("\n")
        : stage.scope ? "已声明的同步文件均在本段范围内" : "跳过：未配置 scope" });
    if (config.acceptance?.guide) {
      try {
        checks.push({ name: `${stage.name} 的验收说明引用`, ok: true, detail: guideDetail(config.acceptance.guide) });
      } catch (error) {
        checks.push({ name: `${stage.name} 的验收说明引用`, ok: false, detail: `无法加载 ${config.acceptance.guide}：${String(error)}；修正本段 acceptance.guide 或补齐该文件。` });
      }
    }
  }
  if (plan.acceptance?.acceptance.guide) {
    const guide = plan.acceptance.acceptance.guide;
    try { checks.push({ name: "整批的验收说明引用", ok: true, detail: guideDetail(guide) }); }
    catch (error) { checks.push({ name: "整批的验收说明引用", ok: false, detail: `无法加载 ${guide}：${String(error)}；修正 acceptance.guide 或补齐文件。` }); }
  }
  return checks;
}

/** 每段四项都给结论；dry-run 绝不调用模型/脚本，也不把未执行写成通过。 */
export async function rehearseBatch(plan: Plan, options: { dryRun?: boolean } = {}): Promise<Check[]> {
  const checks: Check[] = [];
  const runRoot = join(plan.dir, "preflight", randomUUID());
  for (const stage of plan.stages.values()) {
    if (options.dryRun) {
      for (const name of ["越界检查", "评审能否启动", "验收前重置", "加载验收说明"]) checks.push({ name: `${stage.name} · ${name}`, ok: true, detail: "未执行：dry-run 只核对，实际开工时空跑" });
      continue;
    }
    const runDir = join(runRoot, randomUUID());
    mkdirSync(runDir, { recursive: true });
    const exec = createChildExec(join(runDir, "procs.json"));
    const config = resolveProjectConfig(findProjectRoot(stage.cwd), stage.configOverrides);
    const git = createGitEvidence(exec, stage.cwd);
    const state = newReviewState();
    const before = await git.snapshot();
    // 只覆盖 Loop 方法身份；普通宿主环境由执行器继承，acceptance.env 必须保持更高优先级。
    const env = methodEnv(before.ref, { batchFile: plan.file, stage: stage.name });
    const check = async (name: string, action: () => Promise<string> | string): Promise<void> => {
      try { checks.push({ name: `${stage.name} · ${name}`, ok: true, detail: await action() }); }
      catch (error) { checks.push({ name: `${stage.name} · ${name}`, ok: false, detail: String(error) }); }
    };
    await check("越界检查", async () => {
      if (!stage.scope) return "跳过：未配置 scope";
      const root = findProjectRoot(stage.cwd) ?? stage.cwd;
      const baselineUntracked = before.untracked.map((item) => ({ ...item, path: relative(root, resolve(stage.cwd, item.path)).replace(/\\/g, "/") }));
      const files = await changedSince(exec, root, before.ref, { baselineUntracked });
      const outside = outOfScope(files.filter((path) => resolve(root, path) !== join(root, ".autoreview.json")), stage.scope);
      if (outside.length) throw new Error(`越界：${outside.join("、")}；修正 scope 后重新开工`);
      return "通过：真实越界检查已执行，空跑无业务改动";
    });
    await check("评审能否启动", async () => {
      const input = join(runDir, "review-input.md");
      writeFileSync(input, "# 开工前空跑\n开发方尚未派发，没有本批产品改动。请按既有静态评审规则输出；只确认评审调用可以完成，不运行测试、服务或修改文件。\n");
      const result = await defaultCallReviewer({ cwd: stage.cwd, config, exec, env: { ...env, PI_BIN: process.env.PI_BIN }, state, devSessionId: randomUUID(), round: 0,
        deliveryNote: "", writeInput: () => input, saveState: () => {} })(randomUUID(), 0, Math.max(60_000, Math.min(120_000, config.reviewTimeoutMin * 60_000)), input);
      const log = join(runDir, "review.log");
      writeFileSync(log, `${result.stdout}\n${result.stderr}`);
      const after = await git.snapshot();
      if (after.fingerprint !== before.fingerprint) throw new Error(`空跑评审改动了工作区；检查只读权限，日志：${log}`);
      if (result.code || result.killed || !parseReview(result.stdout).ok) throw new Error(`评审无法正常启动/返回（退出码 ${result.code}）：${result.stdout}\n${result.stderr}\n检查评审命令、模型与权限；日志：${log}`);
      return `通过：独立评审已启动并返回可解析结果；不计业务评审。日志：${log}`;
    });
    await check("验收前重置", async () => {
      if (!config.acceptance?.reset) return "跳过：未配置 acceptance.reset";
      const result = await probeAcceptanceReset({ workDir: stage.cwd, config: config.acceptance, exec, env,
        devSessionId: `preflight-${stage.name}`, round: 0, deliveryNote: "", state: {}, reviewerModel: config.reviewerModel,
        reviewerThinking: config.reviewerThinking, runDir: join(runDir, "acceptance"), procsFile: join(runDir, "procs.json"),
        deadline: Date.now() + config.acceptance.timeoutMin * 60_000, now: Date.now, previousFailed: [], saveState: () => {} });
      if (!result.ok) throw new Error(`验收前重置失败：${result.detail}`);
      const after = await git.snapshot();
      if (after.fingerprint !== before.fingerprint) throw new Error(`重置空跑期间工作区变了；请把运行产物写到 AUTOREVIEW_RUN_DIR 或配置忽略规则，检查 reset/cleanup；日志：${runDir}`);
      return `通过：${result.detail}`;
    });
    await check("加载验收说明", () => {
      if (!config.acceptance) return "跳过：未配置自动验收";
      if (!config.acceptance.guide) return "跳过：未配置 acceptance.guide";
      const guide = readFileSync(config.acceptance.guide, "utf8");
      writeFileSync(join(runDir, "guide.md"), guide);
      return `通过：已加载本段说明 ${config.acceptance.guide}（${Buffer.byteLength(guide)} 字节）`;
    });
  }
  if (plan.acceptance) {
    const { acceptance: config, workDir } = plan.acceptance;
    if (options.dryRun) checks.push({ name: "整批 · 验收前重置", ok: true, detail: "未执行：dry-run 只核对" });
    else {
      const runDir = join(runRoot, "batch-acceptance"), exec = createChildExec(join(runDir, "procs.json"));
      try {
        const result = await probeAcceptanceReset({ workDir, config, exec, devSessionId: `preflight-${plan.name}`, round: 0, deliveryNote: "", state: {},
          reviewerModel: "", reviewerThinking: "", runDir, procsFile: join(runDir, "procs.json"),
          env: methodEnv(undefined, { batchFile: plan.file }), deadline: Date.now() + config.timeoutMin * 60_000, now: Date.now, previousFailed: [], saveState: () => {} });
        checks.push({ name: "整批 · 验收前重置", ok: result.ok, detail: result.detail });
      } catch (error) { checks.push({ name: "整批 · 验收前重置", ok: false, detail: String(error) }); }
    }
  }
  return checks;
}

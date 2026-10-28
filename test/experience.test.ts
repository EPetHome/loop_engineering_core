/** 项目经验验收：所有项目、本机数据与模型替身都在系统临时目录。 */
import "./test-env.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  approveExperience, candidateCount, experienceDataFile, experienceFile, experienceInjection, experienceSession, experienceTodos,
  hookExperienceDir, hookExperienceStates, importExperience, markExperienceRecurrence, parseExperience, readExperience, readExperienceStore, rejectExperience,
} from "../experience.ts";
import { finishExperience } from "../experience-draft.ts";
import { newReviewState, type ReviewConfig } from "../review.ts";
import { endHostExperienceSessions } from "../hosts/hook.ts";
import { projectRootHash } from "../project-context.ts";
import type { Exec, ExecResult } from "../git.ts";

const entry = (id = "P01", count = 2, title = "等待后复核权限") => `## ${id} ${title}\n现象：旧操作继续提交。\n根因：复用等待前状态。\n正确做法：提交前重读当前权限。\n出现次数：${count} 个不同开发会话。\n证据：SECRET_EVIDENCE\n失效条件：专项检查覆盖。\n`;
const config: ReviewConfig = { maxRepairs: 4, reviewerModel: "review-model", reviewerThinking: "high", reviewTimeoutMin: 60, reviewerCmd: "" };
const result = (stdout: string): ExecResult => ({ stdout, stderr: "", code: 0, killed: false });
const fresh = () => ({ index: 1, kind: "new", entry: { title: "等待后复核权限", phenomenon: "旧操作继续提交。", cause: "复用等待前状态。", practice: "提交前重读当前权限。", invalidWhen: "专项检查覆盖。" } });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "loop-experience-")), project = join(root, "project");
  mkdirSync(project); writeFileSync(join(project, ".autoreview.json"), "{}");
  const keys = ["HOME", "AUTOREVIEW_PROJECTS_ROOT"] as const, old = keys.map((key) => process.env[key]);
  process.env.HOME = join(root, "home"); process.env.AUTOREVIEW_PROJECTS_ROOT = join(root, "local");
  const source = join(root, "draft.md");
  const write = (content = entry()) => { mkdirSync(join(project, ".autoreview"), { recursive: true }); writeFileSync(experienceFile(project), content); };
  const issueState = () => {
    const state = newReviewState();
    state.rounds.push({ round: 1, startedAt: "now", durationMs: 1, conclusion: "需返修", mustFixRaw: "1. 旧权限继续提交", mustFix: ["旧权限继续提交"], minor: [], questions: [], recheck: [] });
    return state;
  };
  return { root, project, source, write, issueState,
    import: (content = entry()) => { writeFileSync(source, content); return importExperience(project, source); },
    close: () => { keys.forEach((key, index) => { if (old[index] === undefined) delete process.env[key]; else process.env[key] = old[index]; }); rmSync(root, { recursive: true, force: true }); } };
}

test("A1/A2 经验注入只有标题和三行；无文件完全为空，支持从项目子目录查找", () => {
  const f = fixture();
  try {
    assert.equal(experienceInjection(f.project), "");
    f.write([entry("P01"), entry("P02"), entry("P03")].join("\n"));
    mkdirSync(join(f.project, "src"));
    for (const reviewer of [false, true]) {
      const text = experienceInjection(join(f.project, "src"), reviewer);
      assert.equal((text.match(/### P\d+/g) ?? []).length, 3);
      for (const field of ["现象", "根因", "正确做法"]) assert.equal((text.match(new RegExp(`${field}：`, "g")) ?? []).length, 3);
      assert.doesNotMatch(text, /SECRET_EVIDENCE|出现次数|失效条件/);
    }
    rmSync(experienceFile(f.project)); assert.equal(experienceInjection(f.project, true), "");
  } finally { f.close(); }
});
test("格式：缺字段、重复编号不吞错；草稿的前置次数写入时会移到三行后", () => {
  const f = fixture();
  try {
    assert.throws(() => parseExperience(entry().replace("根因：复用等待前状态。\n", "")), /根因/);
    assert.throws(() => parseExperience(entry() + entry()), /重复/);
    f.import(entry().replace("现象：", "出现次数：7 个不同开发会话。\n现象：").replace("出现次数：2 个不同开发会话。\n", ""));
    approveExperience(f.project, "全部");
    assert.match(readFileSync(experienceFile(f.project), "utf8"), /## P01 .*\n现象：.*\n根因：.*\n正确做法：.*\n出现次数：7/);
  } finally { f.close(); }
});
test("A3 复发计数从原次数加一、按开发会话去重，项目文件不改", () => {
  const f = fixture();
  try {
    f.write(entry("P02", 7)); const before = readFileSync(experienceFile(f.project), "utf8");
    const raw = "1. 位置：file.ts:1，经验 P02\n   问题：旧操作仍提交\n2. 位置：x:1，没有命中";
    assert.match(markExperienceRecurrence(f.project, "dev1", raw), /经验 P02，第 8 次出现/);
    assert.match(markExperienceRecurrence(f.project, "dev1", raw), /第 8 次出现/);
    assert.match(markExperienceRecurrence(f.project, "dev2", raw), /第 9 次出现/);
    const indented = "1. 普通必修\n  2. 经验 P02：另一条必修";
    assert.match(markExperienceRecurrence(f.project, "dev3", indented), /2\. 经验 P02：另一条必修\n   （经验 P02，第 10 次出现）/);
    assert.equal(readFileSync(experienceFile(f.project), "utf8"), before);
  } finally { f.close(); }
});
test("A4/A5 两会话同类候选才提示；拒绝后同类不再提示，也不改项目", async () => {
  const f = fixture();
  try {
    const run = (session: string, judgment: unknown, state = f.issueState()) => finishExperience({ cwd: f.project, session, state, config, summary: join(f.root, `${session}.md`), env: {}, exec: async () => result(JSON.stringify({ items: [judgment] })) });
    await run("dev1", fresh());
    assert.deepEqual(experienceTodos(f.project), []);
    await run("dev1", { index: 1, kind: "candidate", id: "C01" });
    assert.equal(candidateCount(readExperienceStore(f.project).candidates[0]), 1);
    await run("dev2", { index: 1, kind: "candidate", id: "C01" });
    assert.match(experienceTodos(f.project).join("\n"), /待批准经验 C01/);
    assert.equal(existsSync(experienceFile(f.project)), false);
    rejectExperience(f.project, "C01");
    await run("dev3", { index: 1, kind: "candidate", id: "C01" });
    await run("dev4", fresh()); // 相同标题/根因即使误分 new，也不绕过拒绝。
    assert.deepEqual(experienceTodos(f.project), []);
    assert.equal(readExperienceStore(f.project).candidates.length, 1);
    assert.equal(existsSync(experienceFile(f.project)), false);
  } finally { f.close(); }
});
test("完成起草命中已有经验或已批准候选不再新建，且与返修计数不重复", async () => {
  const f = fixture();
  try {
    f.write(entry("P01", 2)); markExperienceRecurrence(f.project, "dev1", "1. 经验 P01");
    const state = f.issueState();
    await finishExperience({ cwd: f.project, session: "dev1", state, config, summary: "summary.md", env: {}, exec: async () => result('{"items":[{"index":1,"kind":"experience","id":"P01"}]}') });
    assert.equal(readExperienceStore(f.project).occurrences.P01.count, 3);
    assert.equal(readExperienceStore(f.project).candidates.length, 0);
  } finally { f.close(); }
});
test("A6 批准与活动会话互斥；拒绝与 dry-run 不写项目，成功批准保留旧正文", () => {
  const f = fixture();
  try {
    f.import(entry("P02", 4)); experienceSession(f.project, "claude-dev", true);
    assert.throws(() => approveExperience(f.project, "C01"), /进行中.*稍后再批/);
    assert.equal(existsSync(experienceFile(f.project)), false);
    experienceSession(f.project, "claude-dev", false);
    const before = readFileSync(experienceDataFile(f.project), "utf8");
    approveExperience(f.project, "C01", true);
    assert.equal(readFileSync(experienceDataFile(f.project), "utf8"), before);
    assert.equal(existsSync(experienceFile(f.project)), false);
    f.write(entry("P09", 1, "已有经验"));
    approveExperience(f.project, "C01");
    assert.deepEqual(readExperience(f.project).map((item) => item.id), ["P09", "P10"]);
    assert.equal(readExperienceStore(f.project).candidates[0].status, "approved");
  } finally { f.close(); }
});
test("返修 2.1：同名旧项目完成并删除后，新项目仍可批准及按启动身份退出收尾，历史原样保留", async (t) => {
  for (const persistentId of [false, true]) await t.test(persistentId ? "持久身份记录" : "旧版无身份记录", () => {
    const f = fixture();
    try {
      f.import();
      const previous = join(f.root, "old", "project"); mkdirSync(previous, { recursive: true });
      const dir = hookExperienceDir(f.project); mkdirSync(dir, { recursive: true });
      const historyFile = join(dir, "claude-history.state.json");
      const history = JSON.stringify({ ...newReviewState(), phase: "done", experienceActivity: {
        root: previous, host: "claude", session: "history", turn: "past", active: false,
        ...(persistentId ? { projectId: projectRootHash(previous) } : {}),
      } });
      writeFileSync(historyFile, history); rmSync(previous, { recursive: true });
      const approve = (dryRun = false) => spawnSync(process.execPath,
        [LOOP, "经验", "批准", f.project, "C01", "--json", ...(dryRun ? ["--dry-run"] : [])],
        { cwd: f.root, env: process.env, encoding: "utf8" });
      const preview = approve(true); assert.equal(preview.status, 0, preview.stdout || preview.stderr);
      assert.equal(existsSync(experienceFile(f.project)), false);
      const currentFile = join(dir, "claude-current.state.json");
      const current = { ...newReviewState(), phase: "done", experienceActivity: {
        root: f.project, projectId: projectRootHash(f.project), host: "claude", session: "current", turn: "current-turn", runId: "current-run", active: true,
      } };
      writeFileSync(currentFile, JSON.stringify(current));
      assert.throws(() => approveExperience(f.project, "C01"), /进行中的开发会话/, "目标项目的原生活动事实仍阻挡批准");
      experienceSession(f.project, "claude-current", true);
      endHostExperienceSessions(f.project, "claude", "current-run");
      assert.equal(JSON.parse(readFileSync(currentFile, "utf8")).experienceActivity.active, false);
      const approved = approve(); assert.equal(approved.status, 0, approved.stdout || approved.stderr);
      assert.equal(readExperience(f.project).length, 1);
      assert.equal(readFileSync(historyFile, "utf8"), history, "不删除、不迁移、不重写无关历史记录");
    } finally { f.close(); }
  });
});

test("返修 2.1：项目身份不依赖已删除的别名；目标身份和旧活动无法确认时仍拒绝批准", () => {
  const f = fixture();
  try {
    f.import();
    const alias = join(f.root, "alias", "project"); mkdirSync(join(f.root, "alias")); symlinkSync(f.project, alias);
    const activity: Record<string, unknown> = { root: alias, projectId: projectRootHash(alias), host: "claude", session: "alias", turn: "alias-turn", active: true };
    const dir = hookExperienceDir(f.project); mkdirSync(dir, { recursive: true });
    const file = join(dir, "claude-alias.state.json");
    writeFileSync(file, JSON.stringify({ experienceActivity: activity })); rmSync(alias);
    assert.throws(() => approveExperience(f.project, "C01"), /进行中的开发会话/, "失效别名不能丢失目标项目的真实活动");
    activity.projectId = "unconfirmed"; writeFileSync(file, JSON.stringify({ experienceActivity: activity }));
    assert.throws(() => approveExperience(f.project, "C01"), /身份|无法核对/);
    delete activity.projectId; activity.root = f.project; writeFileSync(file, JSON.stringify({ experienceActivity: activity }));
    assert.throws(() => approveExperience(f.project, "C01"), /进行中的开发会话/, "旧版目标活动仍按原生状态阻挡");
    activity.root = alias; writeFileSync(file, JSON.stringify({ experienceActivity: activity }));
    assert.throws(() => hookExperienceStates(f.project), /身份|无法核对/, "旧版未结束且归属不明的记录不能按已结束跳过");
    assert.equal(existsSync(experienceFile(f.project)), false);
  } finally { f.close(); }
});

test("Pi 精确续接完成后释放已死旧实例登记，但不释放仍活着的同会话实例", () => {
  const f = fixture();
  try {
    f.import();
    const ended = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" }); assert.equal(ended.status, 0);
    const old = `pi:resumed:${ended.pid}:old`, current = `pi:resumed:${process.pid}:current`, sibling = `pi:resumed:${process.pid}:sibling`;
    for (const key of [old, current, sibling]) experienceSession(f.project, key, true);
    experienceSession(f.project, current, false);
    assert.throws(() => approveExperience(f.project, "C01"), /进行中/);
    experienceSession(f.project, sibling, false);
    approveExperience(f.project, "C01");
    assert.equal(readExperience(f.project).length, 1);
  } finally { f.close(); }
});

test("超过 30 条仍全量注入，并在需要用户做的事中提醒", () => {
  const f = fixture();
  try {
    f.write(Array.from({ length: 31 }, (_, i) => entry(`P${String(i + 1).padStart(2, "0")}`)).join("\n"));
    assert.equal((experienceInjection(f.project).match(/### P\d+/g) ?? []).length, 31);
    assert.match(experienceTodos(f.project).join("\n"), /超过 30 条.*合并或退役/);
  } finally { f.close(); }
});
test("独立只读起草复用评审模型但不用评审会话；失败、漏项只记软失败", async () => {
  const f = fixture();
  try {
    let calls = 0;
    const state = f.issueState();
    const exec: Exec = async (_cmd, args, options) => {
      calls += 1;
      assert.equal(args[args.indexOf("--model") + 1], config.reviewerModel);
      assert.equal(args[args.indexOf("--thinking") + 1], config.reviewerThinking);
      assert.match(args[args.indexOf("--session-id") + 1], /^experience-/);
      assert.equal(args[args.indexOf("--tools") + 1], "read,grep,find,ls");
      assert.ok(args.includes("--no-extensions") && args.includes("--no-context-files"));
      assert.equal(options.role, "经验候选起草");
      return result('{"items":[]}');
    };
    await finishExperience({ cwd: f.project, session: "dev1", state, config, exec, env: {}, summary: "summary.md" });
    assert.match(state.experienceDraft?.error ?? "", /覆盖必修/);
    assert.equal(state.phase, "idle");
    assert.match(experienceTodos(f.project, state.experienceDraft?.error).join("\n"), /起草失败.*不影响会话完成/);
    await finishExperience({ cwd: f.project, session: "dev1", state, config, exec, env: {}, summary: "summary.md" });
    assert.equal(calls, 1);
  } finally { f.close(); }
});

const LOOP = fileURLToPath(new URL("../loop.ts", import.meta.url));
test("A5 CLI 列出、批准、拒绝、预览，且不要求项目是 Git 仓库", () => {
  const f = fixture();
  try {
    const cli = (...args: string[]) => {
      const res = spawnSync(process.execPath, [LOOP, "经验", ...args, "--json"], { cwd: f.root, env: process.env, encoding: "utf8" });
      assert.equal(res.status, 0, res.stderr || res.stdout); return JSON.parse(res.stdout);
    };
    writeFileSync(f.source, entry() + entry("P02", 3, "第二类"));
    cli("导入", f.project, f.source, "--dry-run"); assert.equal(existsSync(experienceDataFile(f.project)), false);
    cli("导入", f.project, f.source);
    assert.equal(cli("列出", f.project).candidates.length, 2);
    cli("批准", f.project, "C01"); cli("拒绝", f.project, "C02");
    assert.equal(readExperience(f.project).length, 1); assert.equal(cli("列出", f.project).candidates.length, 0);
  } finally { f.close(); }
});

test("A7 首批现成草稿只读导入，临时项目全部批准后正好 20 条", (t) => {
  const source = process.env.AUTOREVIEW_EXPERIENCE_SEED;
  if (!source) { t.skip("显式设置 AUTOREVIEW_EXPERIENCE_SEED 才读取机外首批草稿"); return; }
  const f = fixture();
  try {
    const original = readFileSync(source, "utf8");
    for (const args of [["导入", f.project, source], ["批准", f.project, "全部"]]) {
      const res = spawnSync(process.execPath, [LOOP, "经验", ...args, "--json"], { cwd: f.root, env: process.env, encoding: "utf8" });
      assert.equal(res.status, 0, res.stdout || res.stderr);
    }
    const approved = readExperience(f.project);
    assert.equal(approved.length, 20);
    assert.deepEqual(approved.map((item) => item.id), Array.from({ length: 20 }, (_, i) => `P${String(i + 1).padStart(2, "0")}`));
    for (const item of approved) assert.ok(item.title && item.phenomenon && item.cause && item.practice && item.count >= 2);
    assert.equal(readFileSync(source, "utf8"), original);
  } finally { f.close(); }
});

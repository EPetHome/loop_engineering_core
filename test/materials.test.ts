/** 运行材料释放；所有身份、会话和磁盘数据均在系统临时目录。 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs, { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { renderSummary } from "../core.ts";
import { cleanupMaterialHistory, materialSession, recordMaterialSession, registerAcceptanceMaterials, slimCompletedSession } from "../materials.ts";
import { createRunResource, newMaterialCleanup, releaseRunResource, slimMaterialDirectory } from "../resources.ts";

const LOOP = fileURLToPath(new URL("../bin/loop", import.meta.url));
const SMALL = 256 * 1024;
const big = Buffer.alloc(SMALL + 1, "x");
const put = (path: string, content: string | Buffer = big): string => {
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); return path;
};

function fixture(t: test.TestContext, phase = "done", id = "s1") {
  const root = mkdtempSync(join(tmpdir(), "autoreview-materials-"));
  const home = join(root, "home"), data = join(home, ".pi-autoreview"), work = join(root, "repo");
  mkdirSync(work, { recursive: true });
  const previous = process.env.AUTOREVIEW_RESOURCE_ROOT;
  process.env.AUTOREVIEW_RESOURCE_ROOT = join(data, "resources");
  t.after(() => {
    if (previous === undefined) delete process.env.AUTOREVIEW_RESOURCE_ROOT; else process.env.AUTOREVIEW_RESOURCE_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const summary = join(data, "repo", `${id}.md`), run = join(data, "repo", "acceptance", id, "r1");
  const session = materialSession(id, work, summary, phase, [run]);
  const native = join(home, ".pi", "agent", "sessions", "project", `old_${id}.jsonl`);
  const nativeEntry = (phase: string, extra: Record<string, unknown> = {}) => ({ type: "custom", customType: "autoreview-state",
    data: { phase, rounds: session.runDirs.map((runDir) => ({ acceptance: { runDir } })), ...extra } });
  const saveNative = (phase: string, extra: Record<string, unknown> = {}) => put(native,
    [JSON.stringify({ type: "session", id, cwd: work }), JSON.stringify(nativeEntry(phase, extra))].join("\n") + "\n");
  const save = () => {
    saveNative(session.phase);
    put(summary, renderSummary({ cwd: work, devSessionId: id, reviewerSessionId: `review-${id}`, rounds: [], repairs: 0,
      status: session.phase === "done" ? "完成" : session.phase === "paused" ? "暂停" : "进行中", gitStatusShort: "" }));
    recordMaterialSession(session);
  };
  save();
  mkdirSync(run, { recursive: true }); registerAcceptanceMaterials(id, work, run, session.procsFile);
  const history = (apply = false) => cleanupMaterialHistory({ dataRoot: data, resourcesRoot: process.env.AUTOREVIEW_RESOURCE_ROOT,
    piSessionsRoot: join(home, ".pi", "agent", "sessions"), apply });
  const cli = (...args: string[]) => spawnSync(LOOP, ["清理", ...args], { cwd: root, env: { ...process.env, HOME: home }, encoding: "utf8" });
  return { root, home, data, work, run, session, summary, native, nativeEntry, saveNative, save, history, cli };
}

/** 不包含 atime（读取文件本身的系统访问时间不属于材料改写）。 */
function snapshot(root: string): unknown[] {
  if (!existsSync(root)) return [];
  const stat = lstatSync(root);
  return [[root, stat.ino, stat.mtimeMs, stat.size, stat.isFile() ? readFileSync(root).toString("base64") : ""],
    ...(stat.isDirectory() ? readdirSync(root).sort().flatMap((name) => snapshot(join(root, name))) : [])];
}

test("完成后瘦身所有登记轮次及 TMPDIR 材料，留小证据/脚本，删大数据和依赖", (t) => {
  const h = fixture(t);
  const r2 = join(h.session.acceptanceDir, "r2-retry");
  mkdirSync(r2); registerAcceptanceMaterials(h.session.sessionId, h.work, r2, h.session.procsFile);
  const deleted = [put(join(h.run, "mysql", "data.ibd")), put(join(h.run, "libs", "package.bin")),
    put(join(h.run, "oversize.sh")), put(join(h.run, "node_modules", "tiny.js"), "tiny"), put(join(r2, "data.bin"))];
  const kept = [put(join(h.run, "input.md")), put(join(h.run, "result-strong.json")), put(join(h.run, "system.log")),
    put(join(h.run, "logs", "raw.bin")), put(join(h.run, "evidence", "raw.data")), put(join(h.run, "checkpoints", "state.bin")),
    put(join(h.run, "screens", "screen.png")), put(join(h.run, "photo.jpg")), put(join(h.run, "actions", "test.sh"), Buffer.alloc(SMALL, "s")),
    put(join(h.run, "plain-no-extension"), "small text")];
  mkdirSync(join(h.run, "empty"));
  const resource = createRunResource("gate:s1:r1", 0, h.session.procsFile);
  const evidenceData = put(join(resource.evidenceDir, "database", "huge"));
  const evidenceLog = put(join(resource.evidenceDir, "log.log"));
  const evidenceScript = put(join(resource.evidenceDir, "reuse.py"), "print('ok')");
  releaseRunResource(resource, true);
  const cacheData = put(join(resource.dir, "large-cache"));
  const unrelated = put(join(h.work, "node_modules", "business.db"));
  mkdirSync(join(h.run, "node_modules", ".bin")); symlinkSync(unrelated, join(h.run, "node_modules", ".bin", "tool"));
  const line = slimCompletedSession(h.session);
  assert.match(line, /运行材料瘦身：删除 8 个文件，释放约 .* MiB；保留/);
  for (const path of [...deleted, evidenceData, cacheData]) assert.equal(existsSync(path), false, path);
  for (const path of [...kept, evidenceLog, evidenceScript, unrelated]) assert.ok(existsSync(path), path);
  for (const path of ["mysql", "libs", "empty", "node_modules"]) assert.equal(existsSync(join(h.run, path)), false, path);
});

test("暂停、开发中、评审中、必需验收中均不改变任何材料", async (t) => {
  for (const phase of ["paused", "idle", "reviewing", "accepting"]) await t.test(phase, (t) => {
    const h = fixture(t, phase), file = put(join(h.run, "node_modules", "big.data"));
    const resource = createRunResource("gate:s1:r1", 0, h.session.procsFile);
    put(join(resource.evidenceDir, "huge.data")); releaseRunResource(resource);
    const before = snapshot(h.data);
    assert.match(slimCompletedSession(h.session), /删除 0 个文件/);
    assert.equal(h.history(true).files, 0);
    assert.deepEqual(snapshot(h.data), before);
    assert.ok(existsSync(file));
  });
});

test("无登记/错登记/链接只列归属不明；不按名字认领，也不跟随链接目标", (t) => {
  const h = fixture(t);
  const unregistered = put(join(h.session.acceptanceDir, "r99", "big.bin"));
  const mismatched = join(h.session.acceptanceDir, "r2");
  mkdirSync(mismatched); registerAcceptanceMaterials("other-session", h.work, mismatched, h.session.procsFile);
  const wrongData = put(join(mismatched, "big.bin"));
  const brokenMarker = join(h.session.acceptanceDir, "r3");
  mkdirSync(brokenMarker); symlinkSync(join(h.root, "missing-marker"), join(brokenMarker, ".loop-run.json"));
  const brokenData = put(join(brokenMarker, "big.bin"));
  put(join(brokenMarker, "result.json"), JSON.stringify({ runDir: brokenMarker }));
  h.session.runDirs.push(brokenMarker); h.save();
  const outside = put(join(h.root, "outside", "business.data"));
  symlinkSync(dirname(outside), join(h.run, "node_modules"));
  symlinkSync(outside, join(h.run, "linked.data"));
  const resource = createRunResource("gate:s1:r1", 0, h.session.procsFile);
  releaseRunResource(resource);
  const badData = put(join(resource.evidenceDir, "huge.bin"));
  resource.evidenceDir = dirname(outside);
  put(join(resource.root, `${resource.id}.json`), JSON.stringify(resource));
  const orphan = put(join(resource.root, "evidence", "unregistered", "big.bin"));
  const fakeCache = put(join(resource.root, "looks-like-owned", "big.bin"));
  const result = h.history(true);
  assert.equal(result.files, 0);
  for (const path of [unregistered, wrongData, brokenData, outside, badData, orphan, fakeCache]) assert.ok(existsSync(path), path);
  for (const path of [dirname(unregistered), mismatched, brokenMarker, join(h.run, "node_modules"), join(h.run, "linked.data"),
    join(resource.root, `${resource.id}.json`), join(resource.root, "evidence", "unregistered"), dirname(fakeCache)]) {
    assert.ok(result.unknown.some((item) => item.path === path), `未列归属不明：${path}`);
  }
});

test("默认 CLI 只读预览，--apply 才删，JSON 路径和空间与执行对应", (t) => {
  const h = fixture(t), file = put(join(h.run, "data.bin"));
  const before = snapshot(h.data), preview = h.cli("--json");
  assert.equal(preview.status, 0, preview.stderr);
  const plan = JSON.parse(preview.stdout);
  assert.equal(plan.apply, false); assert.equal(plan.dryRun, true); assert.equal(plan.files, 1);
  assert.ok(plan.bytes > 0); assert.ok(plan.paths.includes(file));
  assert.deepEqual(snapshot(h.data), before, "预览不能写状态、总结、目录或登记");
  const apply = h.cli("--apply", "--json"); assert.equal(apply.status, 0, apply.stderr);
  const actual = JSON.parse(apply.stdout);
  assert.deepEqual(actual.paths, plan.paths); assert.equal(actual.bytes, plan.bytes);
  assert.equal(existsSync(file), false);
  assert.equal(JSON.parse(readFileSync(h.summary.replace(/\.md$/, ".materials.json"), "utf8")).phase, "done");
  assert.equal(h.cli("--apply", "--dry-run").status, 2);
  assert.equal(h.cli("batch.json").status, 2);
});

test("历史 Hook 轮次必须由状态引用与 result 实际位置交叉核对", (t) => {
  const h = fixture(t), file = put(join(h.run, "big.bin"));
  rmSync(h.summary.replace(/\.md$/, ".materials.json")); rmSync(join(h.run, ".loop-run.json"));
  put(h.summary.replace(/\.md$/, ".state.json"), JSON.stringify({ phase: "done", rounds: [{ acceptance: { runDir: h.run } }] }));
  put(join(h.run, "result.json"), JSON.stringify({ runDir: h.run }));
  assert.equal(h.history().files, 1);
  put(join(h.run, "result.json"), JSON.stringify({ runDir: join(h.root, "somewhere-else") }));
  const mismatch = h.history(true);
  assert.equal(mismatch.files, 0); assert.ok(mismatch.unknown.some((item) => item.path === h.run)); assert.ok(existsSync(file));
  put(join(h.run, "result.json"), JSON.stringify({ runDir: h.run }));
  assert.equal(h.history(true).files, 1); assert.equal(existsSync(file), false);
});

test("历史 Pi 只认原生头部身份和最新状态，不信过期完成总结或相似文件名", (t) => {
  const h = fixture(t), file = put(join(h.run, "big.bin"));
  rmSync(h.summary.replace(/\.md$/, ".materials.json"));
  const native = join(h.home, ".pi", "agent", "sessions", "project", `old_${h.session.sessionId}.jsonl`);
  const head = { type: "session", id: h.session.sessionId, cwd: h.work };
  const state = (phase: string) => ({ type: "custom", customType: "autoreview-state", data: { phase, rounds: [] } });
  put(native, [head, state("done"), { type: "message", content: "填充".repeat(40_000) }, state("paused")].map((x) => JSON.stringify(x)).join("\n"));
  assert.equal(h.history(true).files, 0); assert.ok(existsSync(file));
  put(native, [head, state("done"), { type: "message", content: "填充".repeat(40_000) }].map((x) => JSON.stringify(x)).join("\n"));
  assert.equal(h.history().files, 1, "跨块读取最新持久状态");
  put(native, [JSON.stringify({ ...head, cwd: h.root }), JSON.stringify(state("done"))].join("\n"));
  assert.ok(h.history().unknown.some((item) => item.reason.includes("原生会话状态")));
  assert.ok(existsSync(file));
});

test("旧 done 材料登记和总结仍在时，Pi 原生暂停/进行中状态阻止预览与实际清理", async (t) => {
  for (const phase of ["paused", "idle", "reviewing", "accepting", "done"]) await t.test(phase === "done" ? "附加验收仍在运行" : phase, (t) => {
    const h = fixture(t), file = put(join(h.run, "big.bin"));
    const resource = createRunResource("gate:s1:r1", 0, h.session.procsFile);
    const evidence = put(join(resource.evidenceDir, "big.bin"));
    releaseRunResource(resource, true);
    const cache = put(join(resource.dir, "big.bin"));
    h.saveNative(phase, phase === "done" ? { acceptRun: { result: "进行中" } } : {});
    const before = snapshot(h.data);
    for (const apply of [false, true]) {
      const result = h.history(apply);
      assert.equal(result.files, 0, "不能用旧 done 材料登记替代当前原生状态");
      assert.deepEqual(result.paths, []);
      assert.ok(result.unknown.some((item) => item.reason.includes("原生会话状态")));
    }
    const cli = h.cli("--apply", "--json");
    assert.equal(cli.status, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).files, 0);
    assert.deepEqual(snapshot(h.data), before, "保留旧 done 登记、总结和所有验收/资源现场");
    for (const path of [file, evidence, cache]) assert.ok(existsSync(path), path);
    assert.equal(JSON.parse(readFileSync(h.summary.replace(/\.md$/, ".materials.json"), "utf8")).phase, "done");
    assert.match(readFileSync(h.summary, "utf8"), /^- 状态：完成$/m);
  });
});

test("旧 done 材料登记不能在 Pi 原生状态缺失、损坏、身份不符或不唯一时授权删除", async (t) => {
  for (const mode of ["missing", "corrupt", "truncated", "invalid-state", "wrong-identity", "ambiguous"]) await t.test(mode, (t) => {
    const h = fixture(t), file = put(join(h.run, "big.bin"));
    if (mode === "missing") rmSync(h.native);
    if (mode === "corrupt") appendFileSync(h.native, '{"customType":"autoreview-state","data":broken}\n');
    if (mode === "truncated") appendFileSync(h.native, '{"type":"custom","id":');
    if (mode === "invalid-state") appendFileSync(h.native, JSON.stringify({ type: "custom", customType: "autoreview-state", data: {} }) + "\n");
    if (mode === "wrong-identity") put(h.native, [JSON.stringify({ type: "session", id: h.session.sessionId, cwd: h.root }), JSON.stringify(h.nativeEntry("done"))].join("\n"));
    if (mode === "ambiguous") put(join(dirname(h.native), `duplicate_${h.session.sessionId}.jsonl`), readFileSync(h.native));
    const before = snapshot(h.data), result = h.history(true);
    assert.equal(result.files, 0); assert.deepEqual(result.paths, []); assert.ok(existsSync(file));
    assert.ok(result.unknown.some((item) => item.path === h.summary));
    assert.deepEqual(snapshot(h.data), before);
  });
});

test("Pi 原生状态在清理期间变更时，即使 done 材料登记和总结未变也停止后续删除", (t) => {
  const h = fixture(t), first = put(join(h.run, "first.bin")), second = put(join(h.run, "second.bin"));
  const marker = h.summary.replace(/\.md$/, ".materials.json"), beforeMarker = readFileSync(marker), beforeSummary = readFileSync(h.summary);
  const unlink = fs.unlinkSync;
  t.mock.method(fs, "unlinkSync", (path: Parameters<typeof unlink>[0]) => {
    unlink(path);
    if (path === first) appendFileSync(h.native, JSON.stringify(h.nativeEntry("paused")) + "\n");
  });
  syncBuiltinESMExports();
  try {
    const result = h.history(true);
    assert.equal(result.files, 1); assert.equal(existsSync(first), false); assert.ok(existsSync(second));
    assert.match(result.failures[0].reason, /会话状态.*变化/);
    assert.deepEqual(readFileSync(marker), beforeMarker); assert.deepEqual(readFileSync(h.summary), beforeSummary);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test("扫描后阶段变化或文件被替换为链接时，停止删除并保留链接目标", (t) => {
  const h = fixture(t), first = put(join(h.run, "first.bin")), second = put(join(h.run, "second.bin"));
  const result = newMaterialCleanup(true);
  let checks = 0;
  slimMaterialDirectory(h.data, h.run, result, () => ++checks === 1);
  assert.equal(result.files, 1); assert.equal(existsSync(first), false); assert.ok(existsSync(second));
  assert.match(result.failures[0].reason, /会话状态.*变化/);
  const target = put(join(h.root, "outside.bin"));
  const replaced = newMaterialCleanup(true);
  slimMaterialDirectory(h.data, h.run, replaced, () => {
    if (!lstatSync(second).isSymbolicLink()) { rmSync(second); symlinkSync(target, second); }
    return true;
  });
  assert.equal(replaced.files, 0); assert.ok(existsSync(target)); assert.ok(lstatSync(second).isSymbolicLink());
  assert.ok(replaced.failures.some((item) => item.path === second));
});

test("未确认消费者、损坏进程登记和资源未释放不进入删除", (t) => {
  const h = fixture(t), data = put(join(h.run, "big.bin"));
  put(h.session.procsFile, "broken json");
  assert.equal(h.history(true).files, 0); assert.ok(existsSync(data));
  put(h.session.procsFile, JSON.stringify([{ pgid: 123, runId: "not-guessed" }]));
  assert.equal(h.history(true).files, 0); assert.ok(existsSync(data));
  rmSync(h.session.procsFile);
  const resource = createRunResource("gate:s1:r1", 0, h.session.procsFile), evidence = put(join(resource.evidenceDir, "big.bin"));
  const result = h.history(true);
  assert.equal(result.files, 1); assert.ok(existsSync(evidence));
  assert.ok(result.unknown.some((item) => item.path === resource.evidenceDir));
});

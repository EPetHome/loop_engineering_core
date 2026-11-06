/** batch-delivery 的隔离夹具；只在调用时创建私有临时资源。 */
import "../test-env.ts";
import "./git-runtime.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { workingTree } from "../../commit-batch.ts";
import { queueAcceptance, readJson, statusPath, writeJsonAtomic, type StageStatus } from "../../pipeline-core.ts";
import { type DeploymentConfig } from "../../config.ts";
import { beginQueuePipeline, queueDir, queueStageEvent, readMergeQueue, registerQueueBatch } from "../../merge-queue.ts";
import { batchInfo, phasePath } from "../../events.ts";
import { processStartTime, readProcs } from "../../procs.ts";

export function fixture(options: { release?: string; deployment?: Partial<DeploymentConfig>; count?: number } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "loop-delivery-"))), repo = join(root, "repo"), remote = join(root, "remote.git");
  const release = options.release ?? "release", count = options.count ?? 1;
  const values = { HOME: join(root, "home"), PATH: `${join(root, "bin")}:${process.env.PATH}`, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    AUTOREVIEW_MERGE_QUEUE_ROOT: join(root, "queues"), AUTOREVIEW_RESOURCE_ROOT: join(root, "resources"), AUTOREVIEW_PROJECTS_ROOT: join(root, "projects"),
    LOOP_PA_CONFIG: join(root, "pa.json"), AUTOREVIEW_MERGE_QUEUE_LAUNCHER: "background", AUTOREVIEW_PIPELINE_POLL_MS: "25" };
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]])); Object.assign(process.env, values);
  for (const dir of [repo, values.HOME, join(root, "bin")]) mkdirSync(dir);
  writeFileSync(join(root, "bin", "osascript"), "#!/bin/sh\nexit 0\n"); chmodSync(join(root, "bin", "osascript"), 0o755);
  writeFileSync(values.LOOP_PA_CONFIG, JSON.stringify({ pa: { localNotify: false } }));
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr || result.stdout}`); return result.stdout.trim();
  };
  git(repo, "init", "-qb", release); git(repo, "config", "user.name", "delivery"); git(repo, "config", "user.email", "delivery@example.com");
  writeFileSync(join(repo, "code.txt"), "base\n"); writeFileSync(join(repo, "unrelated.txt"), "base\n");
  const gates = join(root, "gates.jsonl"), deployments = join(root, "deployments.jsonl");
  writeFileSync(join(repo, "gate.mjs"), `import fs from 'node:fs'; import cp from 'node:child_process';
const root=${JSON.stringify(root)}, queued=process.cwd().startsWith(root+'/queues/');
const mode=queued&&fs.existsSync(root+'/mode')?fs.readFileSync(root+'/mode','utf8'):'pass';
fs.appendFileSync(root+'/gates.jsonl',JSON.stringify({cwd:process.cwd(),queued,head:cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),base:process.env.AUTOREVIEW_BASE_REV})+'\\n');
console.log('TEST_OUTPUT code.txt');
if(mode==='timeout') while(true) await new Promise(r=>setTimeout(r,1000));
if(mode==='hold') while(!fs.existsSync(root+'/release')) await new Promise(r=>setTimeout(r,20));
if(mode==='fail') { console.log('assertion failed code.txt'); process.exit(1); }
`);
  writeFileSync(join(repo, "deploy.mjs"), `import fs from 'node:fs'; import cp from 'node:child_process';
fs.appendFileSync(${JSON.stringify(deployments)},JSON.stringify({action:'deploy',head:cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()})+'\\n');
if(fs.existsSync(${JSON.stringify(join(root, "hold-deploy"))})) while(!fs.existsSync(${JSON.stringify(join(root, "release-deploy"))})) await new Promise(r=>setTimeout(r,20));
`);
  writeFileSync(join(repo, "check.mjs"), `import fs from 'node:fs'; import cp from 'node:child_process';
fs.appendFileSync(${JSON.stringify(deployments)},JSON.stringify({action:'check',head:cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()})+'\\n');
if(fs.existsSync(${JSON.stringify(join(root, "hold-check"))})) while(!fs.existsSync(${JSON.stringify(join(root, "release-check"))})) await new Promise(r=>setTimeout(r,20));
if(fs.existsSync(${JSON.stringify(join(root, "fail-check"))})) { console.log('HEALTH_CHECK_FAILED'); process.exit(1); }
`);
  const config = { release, gate: { cmd: "node gate.mjs", timeoutMin: 1 }, deployment: { cmd: "node deploy.mjs", check: "node check.mjs", ...options.deployment } };
  writeFileSync(join(repo, ".autoreview.json"), JSON.stringify(config)); git(repo, "add", "."); git(repo, "commit", "-qm", "baseline");
  const base = git(repo, "rev-parse", "HEAD"); git(root, "init", "--bare", "-q", remote); git(repo, "remote", "add", "origin", remote); git(repo, "push", "-q", "origin", release);
  const batches = Array.from({ length: count }, (_, index) => {
    const cwd = join(root, `dev-${index}`), file = join(root, `batch-${index}.json`), dir = join(root, `pipeline-${index}`), branch = `feat/delivery-${index}`;
    git(repo, "worktree", "add", "-qb", branch, cwd, release);
    writeFileSync(file, JSON.stringify({ name: `delivery-${index}`, branch, dir, stages: { dev: { cwd, start: "true", workflow: "without-acceptance" } }, steps: [["dev"]] }));
    registerQueueBatch(repo, { name: `delivery-${index}`, file, dir, project: repo, release, stages: [{ name: "dev", cwd, branch, start: "true" }], steps: [["dev"]] });
    return { cwd, file, dir, branch };
  });
  const directory = queueDir(repo), queueFile = join(directory, "queue.json");
  let observing = false;
  // 轮询不重复Git取证；完成后的断言照常调用真实readMergeQueue核对身份。
  const queue = () => observing ? readJson<NonNullable<ReturnType<typeof readMergeQueue>>>(queueFile)! : readMergeQueue(repo)!;
  const rows = (file: string): any[] => existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const until = async (predicate: () => boolean, timeout = 30_000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      let ready: boolean;
      observing = true;
      try { ready = predicate(); } finally { observing = false; }
      if (ready) return;
      await sleep(50);
    }
    assert.fail(`等待超时\n${JSON.stringify(queue(), null, 2)}\n${existsSync(join(directory, "worker.log")) ? readFileSync(join(directory, "worker.log"), "utf8") : ""}`);
  };
  const idle = () => until(() => !readdirSync(directory).some((file) => {
    if (!/^executor-[0-9a-f-]+\.json$/.test(file)) return false;
    const owner = readJson<{ pid: number; started: string }>(join(directory, file));
    return Boolean(owner && (!owner.pid || processStartTime(owner.pid) === owner.started));
  }));
  const complete = (index = 0, testEvidence = true) => {
    const batch = batches[index];
    const candidate = workingTree(batch.cwd, root).tree;
    queueStageEvent({ cwd: batch.cwd, file: batch.file, stage: "dev", status: { sessionId: `session-${index}`, host: "pi", pid: process.pid, processStarted: processStartTime(process.pid),
      event: "done", batchFile: batch.file, readyEpoch: randomUUID(), summary: join(root, `summary-${index}.md`), candidate, acceptance: queueAcceptance(), inbox: 0,
      checks: { test: "Loop 未运行测试", review: "通过", acceptance: "未配置" },
      ...(testEvidence ? { test: { result: "通过", candidate, command: config.gate.cmd, round: 2, startedAt: new Date().toISOString() } } : {}) } });
  };
  const notice = (index = 0) => readFileSync(join(queueDir(repo), `${queue().entries[index].id}.notification.txt`), "utf8");
  const advance = () => { writeFileSync(join(repo, "unrelated.txt"), randomUUID()); git(repo, "add", "unrelated.txt"); git(repo, "commit", "-qm", "target advance"); return git(repo, "rev-parse", "HEAD"); };
  return { root, repo, remote, release, base, batches, git, queue, until, idle, complete, notice, advance, config,
    stop(index = 0, dryRun = false) {
      // 开发会话已退出，只剩已登记部署；停止入口必须支持这种正常完成场景。
      const path = statusPath(batches[index].dir, "dev"), status = readJson<StageStatus>(path)!;
      delete status.pid; delete status.processStarted; writeJsonAtomic(path, status);
      const result = spawnSync(process.execPath, [fileURLToPath(new URL("../../loop.ts", import.meta.url)), "停止", batches[index].file, "--json", ...(dryRun ? ["--dry-run"] : [])], { cwd: repo, encoding: "utf8", timeout: 20_000 });
      assert.ok(result.stdout.trim(), result.stderr); return { code: result.status, ...JSON.parse(result.stdout) };
    },
    gates: () => rows(gates), deployments: () => rows(deployments),
    async close() {
      writeFileSync(join(root, "release"), "release");
      writeFileSync(join(root, "release-deploy"), "release"); writeFileSync(join(root, "release-check"), "release");
      for (const batch of batches) { const path = phasePath(batch.dir, "dev"), phase = readJson<any>(path); if (phase?.phase === "reviewing") writeJsonAtomic(path, { ...phase, phase: "done" }); }
      await idle();
      for (const file of readdirSync(queueDir(repo)).filter((name) => name.endsWith(".procs.json"))) assert.equal(readProcs(join(queueDir(repo), file)).length, 0, `本次资源未释放：${file}`);
      for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      rmSync(root, { recursive: true, force: true });
    } };
}

export function backgroundPipeline(f: ReturnType<typeof fixture>, acceptance = false) {
  const source = f.batches[1], file = join(f.root, "background.json"), dir = join(f.root, "background");
  const stages = Object.fromEntries(["dev", "tail"].map((name) => [name, { cwd: source.cwd, start: "true", workflow: "without-acceptance" }]));
  writeFileSync(file, JSON.stringify({ name: "background", dir, stages, steps: [["dev"], ["tail"]], ...(acceptance ? { acceptance: {} } : {}) }));
  registerQueueBatch(f.repo, { name: "background", file, dir, project: f.repo, release: f.release, steps: [["dev"], ["tail"]],
    stages: Object.keys(stages).map((name) => ({ name, cwd: source.cwd, branch: source.branch, start: "true" })) });
  const run = beginQueuePipeline(f.repo, file, acceptance)!; assert.ok(run);
  return { file, dir, run, info: batchInfo(file, f.repo, dir) };
}

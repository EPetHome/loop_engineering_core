import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:net";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { fakeKernelLauncher, kernelFixture, reviewer } from "./helpers/kernel-fixture.ts";
import { attachSession, completeManagedDelivery, consumeManagedRepair, mergeManaged, recordManagedUserInput } from "../kernel-session.ts";
import { checkInputs, independentRecoveryCommand } from "../kernel-workspace.ts";
import { readRun, updateRun } from "../node-ledger.ts";
import { executeNode, queryKernel } from "../kernel.ts";
import { runTestNode } from "../test-node.ts";
import { createChildExec, handleReviewEvent } from "../hosts/review-hook.ts";
import { fileURLToPath } from "node:url";
import { abandonKernel, deliverManagedRepair, releaseKernelWorkspace, resumeManaged, stopKernel } from "../kernel-runtime.ts";
import { processStartTime, readProcs, registerProc, releaseProc } from "../procs.ts";
import { readLocalQueue } from "../local-node-queue.ts";
import { releaseTestWorkspace } from "../test-workspace.ts";

test("A2 产品测试失败回同一会话，修复后先评审再测试；各自计数/精确命令", async () => {
  const command = `node -e "if(require('fs').readFileSync('file.txt','utf8').trim()!=='fixed'){console.error('AssertionError: expected fixed');process.exit(1)}"`;
  const f = kernelFixture(["开发评审", "测试"], command);
  try {
    const path = f.start(), run = readRun(path); attachSession(path, "pi", "original-session", join(run.dir, "session.jsonl"));
    writeFileSync(join(run.worktree, "file.txt"), "broken"); let reviews = 0;
    const options = { exec: f.exec, callReviewer: async () => { reviews++; return reviewer(); } };
    const first = await completeManagedDelivery(path, "【交付完成】", options);
    assert.equal(first.status, "不通过", first.reason ?? ""); assert.match(first.message!, /AssertionError: expected fixed/);
    assert.equal(readRun(path).session!.id, "original-session"); assert.equal(readRun(path).repairs, 0); assert.equal(readRun(path).counters!.测试!.repairs, 1);
    assert.equal(readLocalQueue().items.length, 0); assert.equal(reviews, 1);
    writeFileSync(join(run.worktree, "file.txt"), "fixed");
    const second = await completeManagedDelivery(path, "【交付完成】", options); assert.equal(second.status, "通过", second.reason ?? "");
    assert.equal(reviews, 2); assert.deepEqual(readRun(path).results.map((r) => r.node), ["开发评审", "测试", "开发评审", "测试"]);
    assert.equal(queryKernel(path).status, "可合入");
    const results = readRun(path).results.filter((r) => r.node === "测试");
    for (const r of results) { const report = JSON.parse(readFileSync(r.evidence.find((p) => p.endsWith("test.json"))!, "utf8")); assert.equal(report.command, command); assert.equal(report.calls.length, 1); assert.equal(report.calls[0].command, command); }
  } finally { f.cleanup(); }
});
function preparationFixture(command: string, recover?: string, check = `node -e "require('core')"`) {
  const f = kernelFixture(["开发评审", "测试"], command);
  writeFileSync(join(f.repo, ".gitignore"), `${readFileSync(join(f.repo, ".gitignore"), "utf8")}node_modules/\ndist/\n`);
  f.git(f.repo, "add", ".gitignore"); f.git(f.repo, "commit", "-qm", "dependency recovery fixture");
  const raw = JSON.parse(readFileSync(join(f.repo, ".autoreview.json"), "utf8"));
  writeFileSync(join(f.repo, ".autoreview.json"), JSON.stringify({ ...raw, preparation: { check, recover, maxRecoveries: 1 } }));
  return f;
}
const installCore = "mkdir -p node_modules/core node_modules/.bin; printf 'module.exports=1' > node_modules/core/index.js; ln -s ../core/index.js node_modules/.bin/core";
function conditionalCacheFixture(local = false) {
  const f = preparationFixture("placeholder"), ready = join(f.root, "ready"), installed = join(f.root, "installed");
  f.card.tasks[0].scope = local ? ["file.txt", "lib"] : ["file.txt"];
  f.card.tasks[0].test = `node -e "const assert=require('assert');assert.equal(require('core'),1);assert.equal(require('fs').readFileSync('file.txt','utf8'),'fixed')"`;
  f.card.limits = { 测试: { maxRecoveries: 2 } }; writeFileSync(f.file, JSON.stringify(f.card));
  if (local) { mkdirSync(join(f.repo, "lib")); writeFileSync(join(f.repo, "lib/index.js"), "module.exports=1"); f.git(f.repo, "add", "lib"); f.git(f.repo, "commit", "-qm", "conditional local install"); }
  const script = `const fs=require('fs');fs.mkdirSync('node_modules/core',{recursive:true});if(!fs.existsSync(${JSON.stringify(installed)})){fs.writeFileSync('node_modules/core/index.js',${local ? "fs.readFileSync('lib/index.js')" : "'module.exports=1'"});fs.writeFileSync(${JSON.stringify(installed)},'installed')}else{require('assert').ok(fs.existsSync('node_modules/core/index.js'),'cached dependency must survive recovery')}fs.writeFileSync(${JSON.stringify(ready)},'ready')`;
  const check = `const fs=require('fs');require('core');if(!fs.existsSync(${JSON.stringify(ready)})){console.error('core runtime condition unavailable');process.exit(1)}`;
  const marker = join(f.repo, ".autoreview.json"), raw = JSON.parse(readFileSync(marker, "utf8"));
  writeFileSync(marker, JSON.stringify({ ...raw, preparation: { recover: `node -e ${JSON.stringify(script)}`, check: `node -e ${JSON.stringify(check)}`, maxRecoveries: 2 } }));
  return { ...f, ready };
}

test("返修2：补装沿原 repo 解析外部 context 来源，并保护恢复期间的来源变化", async () => {
  for (const mutate of [false, true]) {
    const f = preparationFixture(`node -e "require('core')"`, installCore);
    try {
      const source = join(f.root, "need.md"), marker = join(f.repo, ".autoreview.json"), raw = JSON.parse(readFileSync(marker, "utf8"));
      writeFileSync(source, "external requirement");
      writeFileSync(marker, JSON.stringify({ ...raw, context: { root: "..", sources: [{ path: "need.md", role: "requirement" }] } }));
      const path = f.start(), run = readRun(path); writeFileSync(join(run.worktree, "file.txt"), "candidate");
      assert.ok(Object.values(checkInputs(run, "测试").paths).includes(source));
      let recoveries = 0;
      const output = await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: reviewer, testExec: async (cmd, args, options) => {
        const result = await f.exec(cmd, args, options);
        if (options.role === "测试环境恢复") { recoveries++; if (mutate) writeFileSync(source, "changed external requirement"); }
        return result;
      } });
      assert.equal(recoveries, 1, "正确配置的外部来源不得阻止执行 recover");
      if (mutate) { assert.notEqual(output.status, "通过"); assert.notEqual(output.failure, "product"); assert.match(output.reason!, /输入.*变化|补装改动候选、输入/); }
      else { assert.equal(output.status, "通过", output.reason); assert.equal(readFileSync(source, "utf8"), "external requirement"); }
      assert.equal(readRun(path).counters!.测试!.recoveries, 1); assert.equal(readRun(path).counters!.测试!.repairs, 0);
      assert.equal(existsSync(join(run.worktree, "node_modules")), false); assert.equal(readLocalQueue().items.length, 0);
    } finally { f.cleanup(); }
  }
});

test("补装 A6：Cannot find module 先恢复和复查再重跑，依赖及内部链接只装进隔离副本", async () => {
  const command = `node -e "require('core')"`, f = preparationFixture(command, installCore);
  try {
    const path = f.start(), run = readRun(path); writeFileSync(join(run.worktree, "file.txt"), "candidate");
    const output = await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: reviewer });
    assert.equal(output.status, "通过", output.reason); assert.equal(existsSync(join(run.worktree, "node_modules")), false);
    assert.deepEqual(readRun(path).counters!.测试, { repairs: 0, recoveries: 1 });
    const result = readRun(path).results.find((r) => r.node === "测试")!;
    const report = JSON.parse(readFileSync(result.evidence.find((p) => p.endsWith("test.json"))!, "utf8"));
    assert.deepEqual(report.calls.map((c: any) => c.role), ["任务测试", "测试环境恢复", "测试只读条件复查", "任务测试恢复重试"]);
    assert.deepEqual(report.calls.map((c: any) => c.code), [1, 0, 0, 0]); assert.equal(report.calls[3].command, command);
    assert.ok(readRun(path).testWorkspaces!.every((e) => e.state === "released")); assert.equal(readLocalQueue().items.length, 0);
  } finally { f.cleanup(); }
});

test("补装 A6：已有依赖也可在恢复副本重建，原候选和既有依赖保持不变", async () => {
  const f = preparationFixture(`node -e "if(require('core')!==1)throw Error('Cannot find module usable core')"`, `rm -rf node_modules; ${installCore}`);
  try {
    const path = f.start(), run = readRun(path); mkdirSync(join(run.worktree, "node_modules/core"), { recursive: true });
    writeFileSync(join(run.worktree, "node_modules/core/index.js"), "module.exports=0");
    writeFileSync(join(run.worktree, "file.txt"), "candidate");
    const output = await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: reviewer });
    assert.equal(output.status, "通过", output.reason);
    assert.equal(readFileSync(join(run.worktree, "node_modules/core/index.js"), "utf8"), "module.exports=0");
    assert.ok(readRun(path).testWorkspaces!.every((e) => e.state === "released"));
  } finally { f.cleanup(); }
});

test("补装 A7：补装复查通过后测试仍失败，按产品失败回原会话并扣测试返修次数", async () => {
  for (const tail of ["require('./missing-product-module')", "process.exit(1)", "throw Error('AssertionError: expected fixed')"]) {
    const f = preparationFixture(`node -e "require('core'); ${tail}"`, installCore);
    try {
      const path = f.start(), run = readRun(path); attachSession(path, "pi", "original-recovery", join(run.dir, "session.jsonl"));
      writeFileSync(join(run.worktree, "file.txt"), "candidate");
      const output = await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: reviewer });
      assert.equal(output.status, "不通过", output.reason); assert.equal(output.failure, "product"); assert.match(output.message!, /Loop 测试返修/);
      const current = readRun(path); assert.notEqual(current.stopped, true); assert.equal(current.session!.id, "original-recovery");
      assert.equal(current.repair!.session, "original-recovery"); assert.equal(current.repairs, 0);
      assert.deepEqual(current.counters!.测试, { repairs: 1, recoveries: 1 }); assert.equal(current.blockedNode, "开发评审");
      assert.equal(queryKernel(path).status, "返修中"); assert.equal(readLocalQueue().items.length, 0);
    } finally { f.cleanup(); }
  }
});

test("补装返修状态：初次产品断言也先补装；同树重测通过后旧返修信封不再显示返修中", async () => {
  const f = kernelFixture();
  try {
    const flag = join(f.root, "fixed"), command = `node -e "require('core'); if(!require('fs').existsSync('${flag}')){console.error('AssertionError: flag missing'); process.exit(1)}"`;
    f.card.tasks[0].test = command; writeFileSync(f.file, JSON.stringify(f.card));
    writeFileSync(join(f.repo, ".gitignore"), `${readFileSync(join(f.repo, ".gitignore"), "utf8")}node_modules/\n`);
    f.git(f.repo, "add", ".gitignore"); f.git(f.repo, "commit", "-qm", "ignored dependency");
    const marker = join(f.repo, ".autoreview.json"), raw = JSON.parse(readFileSync(marker, "utf8"));
    writeFileSync(marker, JSON.stringify({ ...raw, preparation: { check: `node -e "require('core')"`, recover: `rm -rf node_modules; ${installCore}`, maxRecoveries: 1 } }));
    const path = f.start(), run = readRun(path); attachSession(path, "pi", "same-tree", join(run.dir, "session.jsonl"));
    mkdirSync(join(run.worktree, "node_modules/core"), { recursive: true }); writeFileSync(join(run.worktree, "node_modules/core/index.js"), "module.exports=1");
    writeFileSync(join(run.worktree, "file.txt"), "candidate");
    const failed = await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: reviewer });
    assert.equal(failed.failure, "product"); assert.equal(queryKernel(path).status, "返修中");
    const counters = readRun(path).counters, candidate = readRun(path).candidate;
    writeFileSync(flag, "fixed"); await resumeManaged(path, false, "测试");
    assert.equal(queryKernel(path).status, "可合入"); assert.deepEqual(readRun(path).candidate, candidate); assert.deepEqual(readRun(path).counters, counters);
  } finally { f.cleanup(); }
});

test("返修3：补装后产品失败，原会话只修产品即可复用依赖再次测试通过，次数不清零", async () => {
  const command = `node -e "require('core'); const fs=require('fs'); if(fs.readFileSync('file.txt','utf8')!=='fixed'){console.error('AssertionError: expected fixed'); process.exit(1)} require('assert').equal(fs.readFileSync('dist/output.js','utf8'),'current build')"`;
  const f = preparationFixture(command, `${installCore}; mkdir -p dist; printf 'old build' > dist/output.js`);
  try {
    const marker = join(f.repo, ".autoreview.json"), raw = JSON.parse(readFileSync(marker, "utf8"));
    writeFileSync(join(f.root, "need.md"), "external requirement");
    writeFileSync(marker, JSON.stringify({ ...raw, context: { root: "..", sources: [{ path: "need.md", role: "requirement" }] } }));
    const path = f.start(), run = readRun(path); attachSession(path, "pi", "original-cached-repair", join(run.dir, "session.jsonl"));
    let recoveries = 0, reviews = 0;
    const options = { exec: f.exec, callReviewer: async () => { reviews++; return reviewer(); }, testExec: async (cmd: string, args: string[], options: any) => {
      if (options.role === "测试环境恢复") recoveries++;
      // 此场景带 dist 输入，会启用 Node I/O 观测；使用真实执行器提供 fd 3 控制通道及释放回执。
      return createChildExec(join(run.dir, "attempts", readRun(path).activity!.id, "test.procs.json"))(cmd, args, options);
    } };
    writeFileSync(join(run.worktree, "file.txt"), "broken");
    const first = await completeManagedDelivery(path, "【交付完成】", options);
    assert.equal(first.failure, "product", first.reason); assert.equal(first.status, "不通过"); assert.match(first.message!, /Loop 测试返修/);
    const failed = readRun(path), cached = failed.testEnvironments![0]; assert.equal(cached.state, "ready");
    assert.equal(cached.resource.status, "retained"); assert.deepEqual(cached.roots, ["node_modules"]);
    assert.equal(existsSync(join(cached.resource.dir, "node_modules/core/index.js")), true);
    assert.equal(existsSync(join(cached.resource.dir, "file.txt")), false); assert.equal(existsSync(join(cached.resource.dir, "dist")), false);
    assert.equal(existsSync(join(run.worktree, "node_modules")), false);
    assert.equal(consumeManagedRepair(path, first.message!), true); writeFileSync(join(run.worktree, "file.txt"), "fixed");
    mkdirSync(join(run.worktree, "dist")); writeFileSync(join(run.worktree, "dist/output.js"), "current build");
    const second = await completeManagedDelivery(path, "【交付完成】", options);
    assert.equal(second.status, "通过", second.reason); const current = readRun(path);
    assert.equal(recoveries, 1); assert.equal(reviews, 2); assert.deepEqual(current.counters!.测试, { repairs: 1, recoveries: 1 });
    assert.equal(current.session!.id, "original-cached-repair"); assert.equal(current.userVersion, failed.userVersion);
    assert.equal(queryKernel(path).status, "可合入"); assert.equal(existsSync(join(run.worktree, "node_modules")), false);
    const result = current.results.filter((r) => r.node === "测试").at(-1)!;
    const report = JSON.parse(readFileSync(result.evidence.find((p) => p.endsWith("test.json"))!, "utf8"));
    assert.equal(report.environment.id, cached.id); assert.deepEqual(report.calls.map((c: any) => c.role), ["测试复用环境条件复查", "任务测试"]);
    assert.equal(report.calls[1].command, command); assert.ok(current.testWorkspaces!.every((e) => e.state === "released")); assert.equal(readLocalQueue().items.length, 0);
  } finally { f.cleanup(); }
});

test("返修3：快照损坏或依赖声明变化不能复用旧补装，也不能清零次数制造通过", async () => {
  for (const mode of ["tampered", "descriptor"]) {
    const command = `node -e "require('core'); if(require('fs').readFileSync('file.txt','utf8')!=='fixed'){console.error('AssertionError: expected fixed'); process.exit(1)}"`;
    const f = preparationFixture(command, installCore);
    try {
      f.card.tasks[0].scope = ["file.txt", "package.json"]; writeFileSync(f.file, JSON.stringify(f.card));
      writeFileSync(join(f.repo, "package.json"), JSON.stringify({ private: true, dependencies: { core: "1" } }));
      f.git(f.repo, "add", "package.json"); f.git(f.repo, "commit", "-qm", "dependency declaration");
      const path = f.start(), run = readRun(path); writeFileSync(join(run.worktree, "file.txt"), "broken");
      const first = await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: reviewer }); assert.equal(first.failure, "product", first.reason);
      const cached = readRun(path).testEnvironments![0], file = join(cached.resource.dir, "node_modules/core/index.js");
      if (mode === "tampered") writeFileSync(file, "unknown cache edit");
      else writeFileSync(join(run.worktree, "package.json"), JSON.stringify({ private: true, dependencies: { core: "2" } }));
      writeFileSync(join(run.worktree, "file.txt"), "fixed");
      const second = await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: reviewer });
      assert.notEqual(second.status, "通过"); assert.notEqual(second.failure, "product");
      assert.deepEqual(readRun(path).counters!.测试, { repairs: 1, recoveries: 1 }); assert.equal(existsSync(join(run.worktree, "node_modules")), false);
      if (mode === "tampered") {
        assert.match(second.reason!, /依赖快照内容变化/);
        await abandonKernel(path, "test:tampered-cache");
        assert.equal(readFileSync(file, "utf8"), "unknown cache edit"); assert.equal(readRun(path).release.status, "未确认");
        assert.match(readRun(path).release.details.join("；"), /补装依赖缓存保留/);
        await releaseKernelWorkspace(path); assert.equal(readFileSync(file, "utf8"), "unknown cache edit", "重复释放也不能洗白未知快照变化");
      }
      assert.equal(readLocalQueue().items.length, 0);
    } finally { f.cleanup(); }
  }
});

test("二返1：字面量补装证明拒绝展开、未知工具和 printf 赋值", () => {
  assert.equal(independentRecoveryCommand(installCore), true);
  assert.equal(independentRecoveryCommand(`rm -rf node_modules; ${installCore}`), true);
  assert.equal(independentRecoveryCommand("printf '%s' '[12]' > node_modules/core.js"), true);
  assert.equal(independentRecoveryCommand('printf "%s" "[[:digit:]]" > node_modules/core.js'), true);
  for (const command of ["cp lib/index.js node_modules/core/index.js", "printf '%s' \"$(cat lib/index.js)\" > node_modules/core/index.js",
    "printf '%s' \"$SOURCE\" > node_modules/core/index.js", "printf '%n' PATH; mkdir -p node_modules", "printf -v PATH x; mkdir -p node_modules",
    "mkdir -p node_modules && printf x > node_modules/core.js", "printf x >> node_modules/core.js",
    "printf 'module.exports=%s' [12] > node_modules/core.js", "printf '%s' [!x] > node_modules/core.js", "printf '%s' [[:digit:]] > node_modules/core.js"]) assert.equal(independentRecoveryCommand(command), false, command);
});

test("二返1：本地依赖消费的 scope 源码、存在性及不透明复制变化不得借旧实现通过", async () => {
  for (const mode of ["copy", "read", "child", "exists", "missing-read", "missing-module", "opaque"]) {
    const check = `node -e "require('local-core')"`, command = `node -e "const assert=require('assert');assert.equal(require('local-core'),1);assert.equal(require('fs').readFileSync('file.txt','utf8'),'fixed')"`;
    const child = "const fs=require('fs');fs.mkdirSync('node_modules/local-core',{recursive:true});fs.writeFileSync('node_modules/local-core/index.js',fs.readFileSync('lib/index.js'))";
    const recover = mode === "copy" ? "mkdir -p node_modules/local-core; cp lib/index.js node_modules/local-core/index.js"
      : mode === "child" ? `node -e ${JSON.stringify(`require('child_process').execFile(process.execPath,['-e',${JSON.stringify(child)}],error=>{if(error)throw error})`)}`
      : mode === "opaque" ? `node -e "const fs=require('fs');fs.mkdirSync('node_modules/local-core',{recursive:true});require('child_process').execFileSync('cp',['lib/index.js','node_modules/local-core/index.js'])"`
      : `node -e "const fs=require('fs');fs.mkdirSync('node_modules/local-core',{recursive:true});fs.writeFileSync('node_modules/local-core/index.js',${mode === "read" ? "fs.readFileSync('lib/index.js')" : mode === "missing-read" ? "(()=>{try{return fs.readFileSync('lib/new-feature')}catch{return 'module.exports=1'}})()" : mode === "missing-module" ? "'module.exports='+(()=>{try{return require('./lib/new-feature')}catch{return 1}})()" : "'module.exports='+(fs.existsSync('lib/new-feature')?2:1)"})"`;
    const f = preparationFixture(command, recover, check);
    try {
      f.card.tasks[0].scope = ["file.txt", "lib"]; f.card.limits = { 测试: { maxRecoveries: 2 } }; writeFileSync(f.file, JSON.stringify(f.card));
      mkdirSync(join(f.repo, "lib")); writeFileSync(join(f.repo, "lib/index.js"), "module.exports=1");
      f.git(f.repo, "add", "lib"); f.git(f.repo, "commit", "-qm", "local dependency source");
      const path = f.start(), run = readRun(path); attachSession(path, "pi", "original-local-dependency", join(run.dir, "session.jsonl"));
      writeFileSync(join(run.worktree, "file.txt"), "broken");
      const first = await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: reviewer });
      assert.equal(first.failure, "product", `${mode}: ${first.reason}`);
      const old = readRun(path).testEnvironments![0];
      assert.equal(old.installation!.kind, ["read", "child"].includes(mode) ? "observed" : "candidate");
      if (["read", "child"].includes(mode)) assert.ok(old.installation!.files["lib/index.js"], "实际安装输入必须包含 scope 内本地源码");
      assert.equal(consumeManagedRepair(path, first.message!), true);
      writeFileSync(join(run.worktree, "file.txt"), "fixed");
      if (["exists", "missing-read", "missing-module"].includes(mode)) writeFileSync(join(run.worktree, "lib/new-feature"), mode === "exists" ? "new source input" : "module.exports=2");
      else writeFileSync(join(run.worktree, "lib/index.js"), "module.exports=2");
      const second = await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: reviewer });
      assert.equal(second.status, "不通过", `${mode}: 不能用旧 local-core=1 授予新候选通过；${second.reason}`);
      assert.equal(second.failure, "product"); assert.match(second.message!, /Loop 测试返修/);
      const current = readRun(path); assert.deepEqual(current.counters!.测试, { repairs: 2, recoveries: 2 });
      assert.equal(current.testEnvironments!.length, 2); assert.notEqual(current.testEnvironments![1].id, old.id);
      const attempt = current.results.filter((r) => r.node === "测试").at(-1)!;
      const report = JSON.parse(readFileSync(attempt.evidence.find((p) => p.endsWith("test.json"))!, "utf8"));
      assert.equal(report.calls.some((c: any) => c.role === "测试复用环境条件复查"), false);
      assert.match(report.calls.find((c: any) => c.role === "任务测试恢复重试").stderr, /2.*1|actual|AssertionError/s);
      assert.equal(existsSync(join(run.worktree, "node_modules")), false); assert.equal(readLocalQueue().items.length, 0);
    } finally { f.cleanup(); }
  }
});

test("三返1：只改内部文件或目录链接指向不能复用旧实现，普通直接读取仍可复用", async () => {
  for (const mode of ["file", "directory", "require", "plain"]) {
    const source = mode === "directory" ? "lib/current/index.js" : mode === "plain" ? "lib/plain.js" : "lib/current.js";
    const script = `const fs=require('fs');fs.mkdirSync('node_modules/core',{recursive:true});fs.writeFileSync('node_modules/core/index.js',${mode === "require" ? `'module.exports='+require('./${source}')` : `fs.readFileSync('${source}')`})`;
    const command = `node -e "const assert=require('assert');assert.equal(require('core'),1);assert.equal(require('fs').readFileSync('file.txt','utf8'),'fixed')"`;
    const f = preparationFixture(command, `node -e ${JSON.stringify(script)}`);
    try {
      f.card.tasks[0].scope = mode === "require" ? ["file.txt", "lib/current.js"] : ["file.txt", "lib"];
      f.card.limits = { 测试: { maxRecoveries: 2 } }; writeFileSync(f.file, JSON.stringify(f.card));
      const targetRoot = mode === "require" ? "data" : "lib";
      mkdirSync(join(f.repo, targetRoot), { recursive: true }); mkdirSync(join(f.repo, "lib"), { recursive: true });
      for (const n of [1, 2]) {
        const target = mode === "directory" ? join(f.repo, "lib", `v${n}`, "index.js") : join(f.repo, targetRoot, `v${n}.js`);
        mkdirSync(join(target, ".."), { recursive: true }); writeFileSync(target, `module.exports=${n}`);
      }
      const link = mode === "directory" ? "lib/current" : "lib/current.js";
      const linkTarget = (n: number): string => mode === "directory" ? `v${n}` : mode === "require" ? `../data/v${n}.js` : `v${n}.js`;
      if (mode === "plain") writeFileSync(join(f.repo, source), "module.exports=1");
      else symlinkSync(linkTarget(1), join(f.repo, link));
      f.git(f.repo, "add", "lib", ...(mode === "require" ? ["data"] : [])); f.git(f.repo, "commit", "-qm", "installation input aliases");
      const path = f.start(), run = readRun(path); attachSession(path, "pi", "original-link-input", join(run.dir, "session.jsonl"));
      writeFileSync(join(run.worktree, "file.txt"), "broken");
      const first = await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: reviewer }); assert.equal(first.failure, "product", `${mode}: ${first.reason}`);
      const old = readRun(path).testEnvironments![0];
      if (mode === "plain") { assert.equal(old.installation!.kind, "observed"); assert.ok(old.installation!.files[source]); }
      else if (old.installation!.kind === "observed") assert.ok(old.installation!.links![link], "即使模块解析已丢失别名，也必须绑定链接本身");
      else assert.equal(old.installation!.kind, "candidate", "无法证明解析链时只允许同候选复用");
      assert.equal(consumeManagedRepair(path, first.message!), true); writeFileSync(join(run.worktree, "file.txt"), "fixed");
      if (mode !== "plain") { rmSync(join(run.worktree, link)); symlinkSync(linkTarget(2), join(run.worktree, link)); }
      const second = await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: reviewer });
      const current = readRun(path), attempt = current.results.filter((r) => r.node === "测试").at(-1)!;
      const report = JSON.parse(readFileSync(attempt.evidence.find((p) => p.endsWith("test.json"))!, "utf8"));
      if (mode === "plain") {
        assert.equal(second.status, "通过", second.reason); assert.equal(report.environment.id, old.id);
        assert.deepEqual(current.counters!.测试, { repairs: 1, recoveries: 1 });
        assert.deepEqual(report.calls.map((c: any) => c.role), ["测试复用环境条件复查", "任务测试"]);
      } else {
        assert.equal(second.status, "不通过", `${mode}: 只改链接不能让旧 core=1 掩盖新目标 core=2；${second.reason}`);
        assert.equal(second.failure, "product"); assert.deepEqual(current.counters!.测试, { repairs: 2, recoveries: 2 });
        assert.notEqual(report.environment.id, old.id); assert.equal(report.calls.some((c: any) => c.role === "测试复用环境条件复查"), false);
        assert.match(report.calls.find((c: any) => c.role === "任务测试恢复重试").stderr, /2.*1|actual|AssertionError/s);
      }
      for (const n of [1, 2]) {
        const target = mode === "directory" ? join(run.worktree, "lib", `v${n}`, "index.js") : join(run.worktree, targetRoot, `v${n}.js`);
        assert.equal(readFileSync(target, "utf8"), `module.exports=${n}`, "两个目标内容始终不变");
      }
      assert.equal(existsSync(join(run.worktree, "node_modules")), false); assert.equal(readLocalQueue().items.length, 0);
    } finally { f.cleanup(); }
  }
});

test("三返2：字符组通配按新候选重新补装，不能用旧 literal 依赖掩盖回归", async () => {
  const recover = "mkdir -p node_modules/core; printf 'module.exports=%s' [12] > node_modules/core/index.js";
  const command = `node -e "const assert=require('assert');assert.equal(require('core'),1);assert.equal(require('fs').readFileSync('file.txt','utf8'),'fixed')"`;
  const f = preparationFixture(command, recover);
  try {
    f.card.tasks[0].scope = ["file.txt", "1", "2"]; f.card.limits = { 测试: { maxRecoveries: 2 } }; writeFileSync(f.file, JSON.stringify(f.card));
    writeFileSync(join(f.repo, "1"), "one"); f.git(f.repo, "add", "1"); f.git(f.repo, "commit", "-qm", "shell expansion input");
    const path = f.start(), run = readRun(path); attachSession(path, "pi", "original-glob-input", join(run.dir, "session.jsonl"));
    writeFileSync(join(run.worktree, "file.txt"), "broken");
    const first = await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: reviewer }); assert.equal(first.failure, "product", first.reason);
    const old = readRun(path).testEnvironments![0]; assert.equal(old.installation!.kind, "candidate");
    assert.equal(consumeManagedRepair(path, first.message!), true); writeFileSync(join(run.worktree, "file.txt"), "fixed");
    rmSync(join(run.worktree, "1")); writeFileSync(join(run.worktree, "2"), "two");
    const second = await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: reviewer });
    assert.equal(second.status, "不通过", second.reason); assert.equal(second.failure, "product");
    const current = readRun(path); assert.deepEqual(current.counters!.测试, { repairs: 2, recoveries: 2 });
    const attempt = current.results.filter((r) => r.node === "测试").at(-1)!;
    const report = JSON.parse(readFileSync(attempt.evidence.find((p) => p.endsWith("test.json"))!, "utf8"));
    assert.notEqual(report.environment.id, old.id); assert.equal(report.calls.some((c: any) => c.role === "测试复用环境条件复查"), false);
    assert.match(report.calls.find((c: any) => c.role === "任务测试恢复重试").stderr, /2.*1|actual|AssertionError/s);
    assert.equal(readLocalQueue().items.length, 0);
  } finally { f.cleanup(); }
});

test("二返2：缓存复查普通失败仍按剩余额度恢复、复查和测试，保留依赖与原会话次数", async () => {
  const f = conditionalCacheFixture();
  try {
    const path = f.start(), run = readRun(path); attachSession(path, "pi", "original-cache-conditions", join(run.dir, "session.jsonl"));
    writeFileSync(join(run.worktree, "file.txt"), "broken");
    const first = await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: reviewer }); assert.equal(first.failure, "product", first.reason);
    const old = readRun(path).testEnvironments![0]; assert.equal(old.installation!.kind, "observed");
    assert.equal(consumeManagedRepair(path, first.message!), true); writeFileSync(join(run.worktree, "file.txt"), "fixed"); rmSync(f.ready);
    const second = await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: reviewer });
    assert.equal(second.status, "通过", second.reason); const current = readRun(path);
    assert.deepEqual(current.counters!.测试, { repairs: 1, recoveries: 2 }); assert.notEqual(current.stopped, true);
    assert.equal(current.session!.id, "original-cache-conditions"); assert.equal(queryKernel(path).status, "可合入");
    assert.equal(current.testEnvironments!.at(-1)!.installation!.inherited, old.id);
    const attempt = current.results.filter((r) => r.node === "测试").at(-1)!;
    const report = JSON.parse(readFileSync(attempt.evidence.find((p) => p.endsWith("test.json"))!, "utf8"));
    assert.deepEqual(report.calls.map((c: any) => [c.role, c.code]), [["测试复用环境条件复查", 1], ["测试环境恢复", 0], ["测试只读条件复查", 0], ["任务测试恢复重试", 0]]);
    assert.equal(existsSync(join(run.worktree, "node_modules")), false); assert.equal(readLocalQueue().items.length, 0);
  } finally { f.cleanup(); }
});

test("二返2：再次恢复沿用依赖时不得丢失原有本地源码安装输入", async () => {
  const f = conditionalCacheFixture(true);
  try {
    const path = f.start(), run = readRun(path); attachSession(path, "pi", "original-inherited-install", join(run.dir, "session.jsonl"));
    writeFileSync(join(run.worktree, "file.txt"), "broken");
    const first = await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: reviewer }); assert.equal(first.failure, "product", first.reason);
    const old = readRun(path).testEnvironments![0]; assert.ok(old.installation!.files["lib/index.js"]);
    assert.equal(consumeManagedRepair(path, first.message!), true); writeFileSync(join(run.worktree, "file.txt"), "fixed"); rmSync(f.ready);
    const second = await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: reviewer }); assert.equal(second.status, "通过", second.reason);
    const latest = readRun(path).testEnvironments!.at(-1)!;
    assert.equal(latest.installation!.inherited, old.id); assert.equal(latest.installation!.files["lib/index.js"], old.installation!.files["lib/index.js"]);
    writeFileSync(join(run.worktree, "lib/index.js"), "module.exports=2");
    const third = await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: reviewer });
    assert.notEqual(third.status, "通过", "后续恢复未重建 core，也不能洗掉最初的 lib 安装输入而复用旧实现");
    assert.deepEqual(readRun(path).counters!.测试, { repairs: 1, recoveries: 2 }); assert.equal(readLocalQueue().items.length, 0);
  } finally { f.cleanup(); }
});

test("二返2：缓存复查的项目方法声明、中断、写候选及释放未知仍禁止恢复", async () => {
  for (const mode of ["method", "interrupted", "write", "release"]) {
    const f = conditionalCacheFixture(); let path: string | undefined;
    try {
      path = f.start(); const run = readRun(path); attachSession(path, "pi", "original-protected-check", join(run.dir, "session.jsonl"));
      writeFileSync(join(run.worktree, "file.txt"), "broken");
      const first = await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: reviewer }); assert.equal(first.failure, "product", first.reason);
      assert.equal(consumeManagedRepair(path, first.message!), true); writeFileSync(join(run.worktree, "file.txt"), "fixed");
      let recoveries = 0;
      const second = await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: reviewer, testExec: async (cmd, args, options) => {
        if (options.role === "测试复用环境条件复查") {
          if (mode === "write") writeFileSync(join(options.cwd, "file.txt"), "illegal preparation write");
          return { code: mode === "method" ? 78 : mode === "write" ? 0 : 1, stdout: "", stderr: mode === "method" ? "AUTOREVIEW_FAILURE=method broken check" : mode,
            killed: mode === "interrupted", processesReleased: mode !== "release" };
        }
        if (options.role === "测试环境恢复") recoveries++;
        return createChildExec(join(run.dir, "attempts", readRun(path!).activity!.id, "test.procs.json"))(cmd, args, options);
      } });
      assert.notEqual(second.status, "通过"); assert.notEqual(second.failure, "product"); assert.equal(recoveries, 0);
      assert.deepEqual(readRun(path).counters!.测试, { repairs: 1, recoveries: 1 }); assert.equal(readFileSync(join(run.worktree, "file.txt"), "utf8"), "fixed");
      if (mode === "method") assert.match(second.reason!, /项目声明方法错误，未补装/);
      if (mode === "write") assert.match(second.reason!, /改动候选、输入或稳定规则/);
      if (mode === "release") {
        const entry = readRun(path).testWorkspaces!.at(-1)!; assert.equal(entry.state, "retained"); assert.equal(readRun(path).release.status, "未确认");
        assert.equal(releaseTestWorkspace(path, entry, true), undefined, "仅本用例纯内存替身没有启动消费者，清理夹具检出；不改程序的未知结论");
      } else assert.equal(readLocalQueue().items.length, 0);
    } finally { if (path) await stopKernel(path); f.cleanup(); }
  }
});

test("返修3：终态按登记释放补装缓存，保留清单与原测试结论", async () => {
  for (const terminal of ["merged", "abandoned"]) {
    const f = preparationFixture(`node -e "require('core')"`, installCore);
    try {
      const path = f.start(), run = readRun(path); writeFileSync(join(run.worktree, "file.txt"), "candidate");
      const output = await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: reviewer }); assert.equal(output.status, "通过", output.reason);
      const cached = readRun(path).testEnvironments![0]; assert.equal(existsSync(cached.resource.dir), true);
      if (terminal === "merged") { assert.equal((await mergeManaged(path, { localOnly: true })).status, "通过"); await releaseKernelWorkspace(path); }
      else await abandonKernel(path, "test:cached-environment");
      const current = readRun(path); assert.equal(current.release.status, "已释放", current.release.details.join("；"));
      assert.equal(current.testEnvironments![0].state, "released"); assert.equal(current.testEnvironments![0].resource.status, "released");
      assert.equal(existsSync(cached.resource.dir), false); assert.equal(existsSync(cached.evidence), true);
      assert.equal(current.results.filter((r) => r.node === "测试").at(-1)!.status, "通过"); assert.equal(current.counters!.测试!.recoveries, 1);
      assert.equal(readLocalQueue().items.length, 0);
    } finally { f.cleanup(); }
  }
});

test("补装保护：明确方法错误不补装；恢复或复查失败、重跑中断仍不扣产品次数", async () => {
  for (const mode of ["marker", "exit78", "recovery-failed", "check-failed", "interrupted", "write-candidate"]) {
    const command = mode === "marker" ? "echo 'AUTOREVIEW_FAILURE=method unavailable'; exit 1" : mode === "exit78" ? "exit 78" : `node -e "require('core')"`;
    const recover = mode === "recovery-failed" ? "echo 'install failed'; exit 1" : mode === "write-candidate" ? "printf illegal > file.txt; exit 1" : installCore;
    const f = preparationFixture(command, recover, mode === "check-failed" ? "echo 'check failed'; exit 1" : undefined);
    try {
      const path = f.start(), run = readRun(path); attachSession(path, "pi", "same-session", join(run.dir, "session.jsonl"));
      writeFileSync(join(run.worktree, "file.txt"), "candidate");
      const output = await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: reviewer,
        testExec: async (cmd, args, options) => mode === "interrupted" && options.role === "任务测试恢复重试" ? { code: 143, stdout: "", stderr: "interrupted", killed: true, processesReleased: true } : f.exec(cmd, args, options) });
      assert.notEqual(output.failure, "product", output.reason); assert.notEqual(output.status, "通过"); assert.equal(output.message, undefined);
      const current = readRun(path); assert.equal(current.counters?.测试?.repairs ?? 0, 0); assert.equal(current.session!.id, "same-session");
      assert.equal(current.counters?.测试?.recoveries ?? 0, ["marker", "exit78"].includes(mode) ? 0 : 1);
      if (["marker", "exit78"].includes(mode)) assert.match(output.reason!, /项目声明方法错误，未补装/);
      if (mode === "write-candidate") assert.match(output.reason!, /补装改动候选/);
      assert.equal(readFileSync(join(run.worktree, "file.txt"), "utf8"), "candidate");
      assert.equal(readLocalQueue().items.length, 0);
    } finally { f.cleanup(); }
  }
});

test("真实 bin/loop → Pi 生命周期替身 → 测试返修原会话 → 自动 dev 发布/释放", async () => {
  const f = kernelFixture(["开发评审", "测试", "提交"], `node -e "if(!require('fs').readFileSync('file.txt','utf8').includes('3')){console.error('AssertionError: need round 3');process.exit(1)}"`);
  let path: string | undefined;
  try {
    fakeKernelLauncher(f);
    const cli = spawnSync(fileURLToPath(new URL("../bin/loop", import.meta.url)), ["启动", f.file, "--launcher", "background", "--json"], { cwd: f.repo, env: process.env, encoding: "utf8", timeout: 20_000 });
    assert.equal(cli.status, 0, cli.stdout + cli.stderr); path = JSON.parse(cli.stdout).ledger;
    const end = Date.now() + 30_000;
    while (readRun(path!).release.status !== "已释放" && Date.now() < end) await sleep(50);
    const run = readRun(path!); assert.equal(run.release.status, "已释放", JSON.stringify(queryKernel(path!)));
    assert.equal(run.session!.id, "fake-original-session"); assert.equal(run.repairs, 0); assert.equal(run.counters!.测试!.repairs, 2);
    assert.equal(run.publication!.push, "成功"); assert.equal(existsSync(run.worktree), false); assert.equal(readLocalQueue().items.length, 0);
    assert.equal(f.git(f.origin, "for-each-ref", "--format=%(refname)"), "refs/heads/dev"); assert.match(readFileSync(join(run.dir, "repair-1.json"), "utf8"), /Loop 测试返修/);
  } finally { if (path) await stopKernel(path); f.cleanup(); }
});
test("同次尝试首次 75、自动重试 0 保留失败证据并继续提交，不被旧 failure 覆盖", async () => {
  const f = kernelFixture(["开发评审", "测试", "提交"]);
  try {
    const flag = join(f.root, "first-failure");
    const command = `if [ -f '${flag}' ]; then echo recovered; else touch '${flag}'; echo 'AUTOREVIEW_FAILURE=environment temporary blockage' >&2; exit 75; fi`;
    f.card.tasks[0].test = command; writeFileSync(f.file, JSON.stringify(f.card));
    const path = f.start(); writeFileSync(join(readRun(path).worktree, "file.txt"), "done");
    const output = await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: reviewer });
    assert.equal(output.status, "通过", output.reason ?? ""); const run = readRun(path);
    assert.equal(run.publication!.push, "成功"); assert.equal(run.repairs, 0); assert.deepEqual(run.counters!.测试, { repairs: 0, recoveries: 1 });
    assert.deepEqual(run.results.map((r) => [r.node, r.status]), [["开发评审", "通过"], ["测试", "通过"], ["提交", "通过"]]);
    const result = run.results.find((r) => r.node === "测试")!;
    const report = JSON.parse(readFileSync(result.evidence.find((p) => p.endsWith("test.json"))!, "utf8"));
    assert.deepEqual(report.calls.map((call: any) => call.code), [75, 0]); assert.ok(report.calls.every((call: any) => call.command === command));
    assert.match(report.calls[0].stderr, /temporary blockage/); assert.match(report.calls[1].stdout, /recovered/);
    assert.equal(report.result, "通过"); assert.equal(report.failure, undefined); assert.equal(readLocalQueue().items.length, 0);
  } finally { f.cleanup(); }
});

test("A3 环境有限恢复不扣产品次数，三条命令可见；只重跑测试不重新评审", async () => {
  const f = kernelFixture();
  try {
    const flag = join(f.root, "fixed-env"); f.card.tasks[0].test = `if [ -f '${flag}' ]; then echo ok; else echo EADDRINUSE >&2; exit 75; fi`; writeFileSync(f.file, JSON.stringify(f.card));
    const path = f.start(), run = readRun(path); writeFileSync(join(run.worktree, "file.txt"), "done"); let reviews = 0;
    const output = await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: async () => { reviews++; return reviewer(); } });
    assert.equal(output.failure, "environment"); assert.equal(readRun(path).counters!.测试!.repairs, 0); assert.equal(readRun(path).counters!.测试!.recoveries, 1);
    assert.equal(queryKernel(path).status, "等你决定"); assert.equal(queryKernel(path).node, "测试");
    const lines = queryKernel(path).lines.join("\n"); for (const action of ["重跑", "改卡", "放弃"]) assert.ok(lines.includes(action));
    await assert.rejects(() => mergeManaged(path), /普通合入被拒绝/);
    const proof = readRun(path).results[0], inputs = checkInputs(readRun(path), "开发评审").hash;
    writeFileSync(flag, "fixed"); await resumeManaged(path, false, "测试");
    assert.equal(reviews, 1); assert.equal(readRun(path).results[0].id, proof.id); assert.equal(checkInputs(readRun(path), "开发评审").hash, inputs);
    assert.equal(queryKernel(path).status, "可合入"); assert.equal(readLocalQueue().items.length, 0);
  } finally { f.cleanup(); }
});
test("无测试原因不是通过、不占槽；无测试 flow 不执行命令/旧验收", async () => {
  for (const flow of [["开发评审", "测试"], ["开发评审"]]) {
    const f = kernelFixture(flow, flow.includes("测试") ? "无：纯文档" : "exit 93");
    try {
      const path = f.start(); writeFileSync(join(readRun(path).worktree, "file.txt"), "done");
      const output = await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: reviewer });
      assert.equal(output.status, flow.includes("测试") ? "没验证" : "通过"); assert.equal(readLocalQueue().items.length, 0);
      assert.equal(existsSync(join(f.root, "local-queue", "queue.json")), false);
      if (flow.includes("测试")) await assert.rejects(() => mergeManaged(path), /普通合入被拒绝/);
    } finally { f.cleanup(); }
  }
});
test("ENOSPC 共享归因实际接入节点：通过名不吞产品返修，真实错误/冲突/未知不扣产品次数", async () => {
  for (const [failure, lines] of [
    ["product", ["ok 1 - ENOSPC 故障时保留证据", "AssertionError: actual product regression"]],
    ["environment", ["Error: ENOSPC: no space left on device, write '/tmp/report'", "AssertionError: evidence file missing", "AUTOREVIEW_FAILURE=product 衍生断言"]],
    ["environment", ["mc: Storage backend has reached its minimum free drive threshold", "AssertionError: upload failed"]],
    ["unknown", ["AUTOREVIEW_FAILURE=product 业务失败", "ModuleNotFoundError: runner unavailable"]],
    ["unknown", ["ok 1 - ENOSPC 故障时保留证据", "opaque failure"]],
  ] as const) {
    const command = `printf '%s\\n' ${lines.map((line) => `'${line.replace(/'/g, "'\\''")}'`).join(" ")} >&2; exit 1`;
    const f = kernelFixture(["开发评审", "测试"], command);
    try {
      const maxRecoveries = lines[0].startsWith("mc:") ? 1 : 0;
      f.card.limits = { 测试: { maxRecoveries } }; writeFileSync(f.file, JSON.stringify(f.card));
      const path = f.start(), run = readRun(path); attachSession(path, "pi", "original-enospc", join(run.dir, "session.jsonl"));
      writeFileSync(join(run.worktree, "file.txt"), "candidate");
      const output = await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: reviewer });
      assert.equal(output.failure, failure, output.reason ?? ""); assert.equal(output.released, true);
      const current = readRun(path); assert.equal(current.repairs, 0); assert.equal(current.counters!.测试!.repairs, failure === "product" ? 1 : 0);
      assert.equal(current.counters!.测试!.recoveries, maxRecoveries, "mc 水位错误应进入有限环境恢复，而非产品返修");
      assert.equal(current.session!.id, "original-enospc"); assert.equal(current.results[0].status, "通过");
      assert.equal(queryKernel(path).missing.some((s: string) => s.includes("/ 开发评审 /")), false, "当前开发评审仍有效");
      assert.equal(Boolean(output.message), failure === "product", "只有产品失败回同一会话返修");
      if (failure === "product") assert.match(output.message!, /AssertionError: actual product regression/);
      else { assert.equal(queryKernel(path).status, "等你决定"); assert.equal(queryKernel(path).node, "测试"); }
      assert.equal(readLocalQueue().items.length, 0);
    } finally { f.cleanup(); }
  }
});

test("A7/A9 已检查树合入不复跑，用户例外保留测试失败且只推 dev", async () => {
  for (const failure of [false, true]) {
    const f = kernelFixture(["开发评审", "测试"], failure ? "echo 'AssertionError: broken' >&2; exit 1" : "echo passed");
    try {
      const path = f.start(); writeFileSync(join(readRun(path).worktree, "file.txt"), "done"); let reviews = 0;
      const options = { exec: f.exec, callReviewer: async () => { reviews++; return reviewer(); } };
      await completeManagedDelivery(path, "【交付完成】", options);
      if (failure) {
        await assert.rejects(() => mergeManaged(path), /普通合入被拒绝/);
        assert.equal(recordManagedUserInput(path, '<file name="x">合入本批</file>', "pi:interactive"), undefined);
        const decision = recordManagedUserInput(path, "合入本批", "pi:interactive")!;
        assert.ok(decision.missing.some((s) => s.includes("测试")));
        const output = await mergeManaged(path, { accept: true, decision }); assert.equal(output.status, "通过", output.reason ?? "");
        assert.equal(readRun(path).results.some((r) => r.node === "测试" && r.status === "通过"), false);
        assert.equal(readRun(path).publication!.decision, decision.id);
      } else {
        const count = readRun(path).results.length; await completeManagedDelivery(path, "【交付完成】", options); assert.equal(readRun(path).results.length, count);
        const output = await mergeManaged(path); assert.equal(output.status, "通过", output.reason ?? "");
      }
      assert.equal(reviews, 1); assert.equal(f.git(f.origin, "for-each-ref", "--format=%(refname)"), "refs/heads/dev");
      const before = readRun(path), checks = queryKernel(path).checks, missing = queryKernel(path).missing;
      assert.ok(before.publication!.nodeChecks!.开发评审!.result);
      assert.equal(Boolean(before.publication!.nodeChecks!.测试!.result), !failure);
      await releaseKernelWorkspace(path);
      const after = readRun(path); assert.equal(after.release.status, "已释放"); assert.equal(existsSync(after.worktree), false);
      assert.deepEqual(queryKernel(path).checks, checks, "合法清理不使已发布的检查结论失效");
      assert.deepEqual(queryKernel(path).missing, missing, "例外合入的欠项仍原样保留");
      assert.deepEqual(after.results, before.results); assert.deepEqual(after.counters, before.counters); assert.equal(after.repairs, before.repairs);
      assert.deepEqual(after.decisions, before.decisions); assert.equal(checks.includes("测试：通过"), !failure);
      const summary = readFileSync(join(after.dir, "summary.md"), "utf8"); assert.ok(checks.every((line: string) => summary.includes(line)));
    } finally { f.cleanup(); }
  }
});
test("真实命令超时、无释放证明、写产品源码都不算测试通过或产品返修", async () => {
  for (const mode of ["timeout", "release", "write"]) {
    const f = kernelFixture(["开发评审", "测试"], mode === "timeout" ? "node -e 'setInterval(()=>{},1000)'" : mode === "write" ? "printf bad > file.txt" : "echo ok");
    let path: string | undefined;
    try {
      path = f.start(); f.candidate(path);
      await executeNode(path, "开发评审", async (i) => ({ status: "通过", evidence: [i.evidenceDir], operations: [], released: true }));
      const output = await executeNode(path, "测试", (i) => runTestNode({ ...i, deadline: mode === "timeout" ? Date.now() + 100 : i.deadline },
        mode === "release" ? async () => ({ code: 0, stdout: "ok", stderr: "", killed: false }) : createChildExec(i.procsFile)), { localSlot: true });
      assert.notEqual(output.status, "通过"); assert.notEqual(output.failure, "product"); assert.equal(readRun(path).counters?.测试?.repairs ?? 0, 0);
      await assert.rejects(() => mergeManaged(path!), /未确认|活动|普通合入|身份核对/);
      if (mode === "release") {
        const entry = readRun(path).testWorkspaces!.at(-1)!;
        assert.equal(releaseTestWorkspace(path, entry, true), undefined, "纯内存替身未启动消费者，仅释放本夹具检出；不改产品的未知结论");
      }
    } finally { if (path) await stopKernel(path); f.cleanup(); }
  }
});
test("Claude/Codex 真实 Hook 测试产品失败 block 原会话，返修不更新用户版本", async () => {
  for (const host of ["claude", "codex"]) {
    const f = kernelFixture(["开发评审", "测试"], "echo 'AssertionError: repair' >&2; exit 1");
    try {
      const path = f.start(), run = readRun(path);
      Object.assign(process.env, { AUTOREVIEW_KERNEL_LEDGER: path, AUTOREVIEW_KERNEL_RUN: run.id, AUTOREVIEW_DEV_ROOT: run.worktree, AUTOREVIEW_HOST: host,
        AUTOREVIEW_REVIEWER_CMD: fileURLToPath(new URL("./fake-reviewer.mjs", import.meta.url)), FAKE_MODE: "pass", FAKE_STATE_DIR: join(f.root, "fake") });
      const event = { cwd: run.worktree, session_id: "same-original" };
      await handleReviewEvent({ ...event, hook_event_name: "SessionStart" });
      await handleReviewEvent({ ...event, hook_event_name: "UserPromptSubmit", prompt: "按原任务修改" });
      const version = readRun(path).userVersion; writeFileSync(join(run.worktree, "file.txt"), "done");
      const output = JSON.parse((await handleReviewEvent({ ...event, hook_event_name: "Stop", last_assistant_message: "【交付完成】" }))!);
      assert.equal(output.decision, "block"); assert.match(output.reason, /AssertionError: repair/); assert.equal(readRun(path).userVersion, version);
      assert.equal(readRun(path).session!.id, "same-original"); assert.equal(readRun(path).repair!.state, "read"); assert.equal(readRun(path).repairs, 0);
    } finally { f.cleanup(); }
  }
});
test("新卡 Claude/Codex 实际启动/原生通道，独立测试返修仍回原 session 且不改用户版本", async () => {
  for (const host of ["claude", "codex"]) {
    const f = kernelFixture(["开发评审", "测试"], "echo 'AssertionError: native repair' >&2; exit 1"); let path: string | undefined;
    try {
      const root = fileURLToPath(new URL("..", import.meta.url)), plugin = join(f.root, "plugin"); mkdirSync(join(plugin, "hooks"), { recursive: true });
      const hooks = JSON.parse(readFileSync(join(root, "plugins/autoreview/hooks/hooks.json"), "utf8"));
      for (const groups of Object.values(hooks.hooks) as any[]) for (const group of groups) for (const hook of group.hooks) hook.command = hook.command.replace(/\S*\/hosts\/hook\.ts/, join(root, "hosts/hook.ts"));
      writeFileSync(join(plugin, "hooks/hooks.json"), JSON.stringify(hooks));
      const config = join(f.root, "fake-host.json"); writeFileSync(config, JSON.stringify({ root: f.root, plugin, host, session: `original-${host}`, hook: join(root, "hosts/hook.ts"), apiSocket: join(f.root, "api.sock") }));
      const hostCommand = join(f.root, "native-host.mjs");
      writeFileSync(hostCommand, `#!${process.execPath}\nimport ${JSON.stringify(new URL("./fake-live-hook.mjs", import.meta.url).href)};\n`, { mode: 0o755 });
      Object.assign(process.env, { LOOP_FAKE_HOST_CONFIG: config, AUTOREVIEW_HOST: host, CLAUDE_BIN: hostCommand, CODEX_BIN: hostCommand, CODEX_HOME: join(f.root, "codex"),
        AUTOREVIEW_REVIEWER_CMD: join(root, "test/fake-reviewer.mjs"), FAKE_MODE: "pass", FAKE_STATE_DIR: join(f.root, "reviewer") });
      f.card.host = host; f.card.tasks[0].scope = ["src/a.txt"]; writeFileSync(f.file, JSON.stringify(f.card));
      const cli = spawnSync(join(root, "bin/loop"), ["启动", f.file, "--launcher", "background", "--json"], { cwd: f.repo, env: process.env, encoding: "utf8", timeout: 20_000 });
      assert.equal(cli.status, 0, cli.stdout + cli.stderr); path = JSON.parse(cli.stdout).ledger;
      const wait = async (check: () => boolean, label: string) => { const end = Date.now() + 20_000; while (!check() && Date.now() < end) await sleep(50); assert.ok(check(), `${host}: ${label}; ${readRun(path!).stopReason}; ${readFileSync(join(readRun(path!).dir, "launch.log"), "utf8").slice(-4000)}`); };
      await wait(() => existsSync(join(f.root, "before-stop-1")), "原宿主实际启动"); writeFileSync(join(f.root, "run-stop-1"), "go");
      await wait(() => existsSync(join(f.root, "host-idle-1.json")), "首轮测试失败 block 已返回");
      const version = readRun(path!).userVersion; assert.equal(readRun(path!).repair!.state, "read");
      updateRun(path!, (r) => { r.activity = undefined; }); // 替身不执行 block 后的模型回合，明确转 idle 后模拟用户只重测。
      await resumeManaged(path!, true, "测试");
      await wait(() => existsSync(join(f.root, "host-receipt.jsonl")), "独立测试失败通过原生通道送回");
      assert.equal(readRun(path!).session!.id, `original-${host}`); assert.equal(readRun(path!).userVersion, version); assert.equal(readRun(path!).repair!.state, "read");
      assert.equal(readRun(path!).repairs, 0); assert.equal(readRun(path!).counters!.测试!.repairs, 2);
      const receipt = readFileSync(join(f.root, "host-receipt.jsonl"), "utf8"); assert.match(receipt, /Loop 测试返修/); assert.equal(readLocalQueue().items.length, 0);
    } finally { if (path) await stopKernel(path); f.cleanup(); }
  }
});
test("loop-kernel 原生拒收/异常应答保留待处理信封并通知，不记 sent 或清零计数", async () => {
  for (const host of ["claude", "codex"] as const) for (const reply of ['{"ok":false,"error":"denied"}', '{broken-json']) {
    const f = kernelFixture(["开发评审", "测试"], "echo 'AssertionError: needs repair' >&2; exit 1");
    let server: Server | undefined, ownedPid: number | undefined; const registry = join(f.root, "native-fixture.procs.json");
    try {
      const token = randomUUID();
      const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore", env: { ...process.env, AUTOREVIEW_PROCESS_OWNER: token } });
      await new Promise<void>((ok, no) => { child.once("spawn", ok); child.once("error", no); }); ownedPid = child.pid!;
      registerProc(registry, ownedPid, "native-rejection-fixture", process.execPath, token);
      const started = processStartTime(ownedPid), path = f.start();
      process.env.AUTOREVIEW_KERNEL_LAUNCH = token;
      updateRun(path, (r) => { r.launch = { pid: ownedPid!, processStarted: started, token }; });
      attachSession(path, host, "original-rejected", join(readRun(path).dir, "session.jsonl"));
      const command = join(f.root, "native-reply.cjs"); writeFileSync(command, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(reply)});\n`, { mode: 0o755 });
      const socket = join(f.root, "reject.sock"), binding = join(f.root, "binding.json");
      if (host === "claude") {
        server = createServer({ allowHalfOpen: true }, (connection) => {
          connection.on("data", () => {}); connection.on("end", () => connection.end(`${reply}\n`));
        });
        await new Promise<void>((ok, no) => { server!.once("error", no); server!.listen(socket, ok); });
      }
      writeFileSync(binding, JSON.stringify({ launch: token, session: "original-rejected", childPid: ownedPid, childStarted: started,
        ...(host === "claude" ? { channel: { socket, token: "private-fixture-token" } } : {}) }), { mode: 0o600 });
      updateRun(path, (r) => { r.native = { launch: token, command, childPid: ownedPid!, childStarted: started, binding }; });
      writeFileSync(join(readRun(path).worktree, "file.txt"), "candidate");
      await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: reviewer });
      const before = readRun(path); assert.equal(before.repair!.state, "pending");
      await deliverManagedRepair(path);
      const after = readRun(path); assert.equal(after.repair!.state, "unknown"); assert.equal(after.repair!.id, before.repair!.id);
      assert.equal(after.repair!.message, before.repair!.message); assert.deepEqual(after.results, before.results); assert.deepEqual(after.counters, before.counters);
      assert.equal(after.userVersion, before.userVersion); assert.equal(after.repairs, before.repairs);
      assert.match(queryKernel(path).reason, /返修投递未确认/); assert.ok(queryKernel(path).reason.includes("续跑"));
      assert.match(readFileSync(join(after.dir, "summary.md"), "utf8"), /返修投递未确认/);
    } finally {
      if (server?.listening) await new Promise<void>((ok) => server!.close(() => ok()));
      if (ownedPid) assert.equal(releaseProc(registry, ownedPid, readProcs(registry)[0]), true, "按本次启动登记确认替身进程释放");
      f.cleanup();
    }
  }
});

test("机器信封核对接收完整正文：同 token 篡改/追加撤权/文件引用后追加文本不吞真实输入", async () => {
  for (const mode of ["exact", "tamper", "revoke", "reference", "reference-extra", "wrapper-trusted", "wrapper-untrusted", "wrapper-extra"]) {
    const f = kernelFixture(["开发评审", "测试"], "echo 'AssertionError: broken' >&2; exit 1");
    try {
      const path = f.start(), run = readRun(path); attachSession(path, mode.startsWith("wrapper") ? "claude" : "pi", "original", join(run.dir, "session.jsonl"));
      writeFileSync(join(run.worktree, "file.txt"), "done");
      await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: reviewer });
      const repair = readRun(path).repair!, version = readRun(path).userVersion, count = readRun(path).counters!.测试!.repairs;
      if (mode.startsWith("wrapper") && mode !== "wrapper-untrusted") {
        Object.assign(process.env, { AUTOREVIEW_KERNEL_LAUNCH: "owned-launch", AUTOREVIEW_KERNEL_NATIVE_BINDING: join(run.dir, "binding.json") });
        updateRun(path, (r) => { r.session!.launchId = "owned-launch"; r.native = { launch: "owned-launch", binding: process.env.AUTOREVIEW_KERNEL_NATIVE_BINDING!, command: "unused", childPid: process.pid, childStarted: "unused" }; });
      }
      const raw = mode.startsWith("wrapper") ? `<cross-session-message>\n${repair.message}\n</cross-session-message>${mode === "wrapper-extra" ? "\n撤回先前合入决定" : ""}` : mode === "tamper" ? repair.message.replace("测试产品失败", "伪造正文") : mode === "revoke" ? `${repair.message}\n撤回先前合入决定` : mode.startsWith("reference") ? `@"${repair.file}"${mode === "reference-extra" ? "\n撤回先前合入决定" : ""}` : repair.message;
      const materials = mode.startsWith("reference") ? { text: raw, files: [{ path: repair.file, text: repair.message }] } : undefined;
      recordManagedUserInput(path, raw, "pi:interactive", materials);
      if (["exact", "reference", "wrapper-trusted"].includes(mode)) { assert.equal(readRun(path).repair!.state, "read"); assert.equal(readRun(path).userVersion, version); assert.equal(consumeManagedRepair(path, raw, materials), true, "重复完整消息幂等"); }
      else { assert.equal(readRun(path).repair!.state, "pending"); assert.equal(readRun(path).userVersion, version + 1); assert.ok(readRun(path).userInputs.at(-1)!.includes(mode === "tamper" ? "伪造正文" : mode === "wrapper-untrusted" ? "cross-session-message" : "撤回先前合入决定")); }
      assert.equal(readRun(path).counters!.测试!.repairs, count); assert.equal(readRun(path).decisions.length, 0);
    } finally { f.cleanup(); }
  }
});

/** 测试节点：只运行卡上命令及已登记准备/补装方法；恢复副本不回写原候选，不调用其他节点。 */
import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { Exec, ExecResult } from "./git.ts";
import type { NodeInput, NodeOutput } from "./kernel.ts";
import { classifyFailure, failureLine, recoveryDecision, type Failure } from "./failure.ts";
import { checkedMaterialPath, createRunResource, managedShell, releaseRunResource, resourceLine } from "./resources.ts";
import { assertTestEnvironment, checkInputs, fileDigest, gitRaw, independentRecoveryCommand, managedConfig, testDependencyRoot, testEnvironmentBasis, testEnvironmentFiles, testEnvironmentLinks, testEnvironmentSources, workspaceGuard } from "./kernel-workspace.ts";
import { gitResult, gitText } from "./workspace.ts";
import { confirmedConsumerRelease, readTaskRun, updateTaskRun, taskDefinition, type TestEnvironment } from "./node-ledger.ts";
import { digest, inside } from "./development-card.ts";
import { createTestWorkspace } from "./test-workspace.ts";
import { nodeOutputProof, type NodeOutputReport } from "./node-output-proof.ts";

export async function runTestNode(input: NodeInput, exec: Exec): Promise<NodeOutput> {
  const command = taskDefinition(input.run).test!, log = join(input.evidenceDir, "test.log"), report = join(input.evidenceDir, "test.json");
  const operations: string[] = [], calls: unknown[] = [], evidence = [log, report];
  writeFileSync(log, "", { mode: 0o600 });
  if (/^无[:：]/.test(command)) {
    writeFileSync(report, JSON.stringify({ command, result: "没验证", reason: command }));
    return { status: "没验证", reason: command, evidence, operations: [command], released: true };
  }
  const deadline = input.deadline ?? Date.now() + input.run.card.limits.测试.timeoutMin * 60_000;
  const resource = createRunResource(`kernel-test:${input.run.id}:${input.attempt}`, 0, input.procsFile);
  // 专用、首次为空的运行时输出通道；不靠忽略规则猜测既有 .pyc 是否可写，也不改卡上命令。
  const runtimeCache = { variable: "PYTHONPYCACHEPREFIX", path: join(resource.dir, "python-cache"), resource: resource.id,
    artifacts: [] as { path: string; relative: string; hash: string; size: number }[], capturedAt: "", release: "未确认" };
  const captureCache = (path: string): void => {
    const info = lstatSync(path, { throwIfNoEntry: false });
    if (!info) return;
    checkedMaterialPath(resource.dir, path);
    if (info.isDirectory()) for (const name of readdirSync(path)) captureCache(join(path, name));
    else {
      if (!info.isFile() || info.nlink !== 1 || !path.endsWith(".pyc")) throw new Error(`运行时缓存通道出现未知产物/链接：${path}`);
      runtimeCache.artifacts.push({ path, relative: relative(runtimeCache.path, path), hash: fileDigest(path), size: info.size });
    }
  };
  let output: NodeOutput = { status: "没验证", reason: "测试未完成", evidence, operations, released: false };
  let consumersReleased = true;
  let checkout: ReturnType<typeof createTestWorkspace> | undefined;
  const guard = workspaceGuard(input.run);
  const live = (): void => {
    input.signal?.throwIfAborted();
    const r = readTaskRun(input.ledger, input.taskId);
    if (r.stopped || r.abandoned || r.activity?.id !== input.attempt || r.userVersion !== input.run.userVersion || (r.epoch ?? 0) !== (input.run.epoch ?? 0)) throw new Error("测试已取消或输入版本变化");
    if (workspaceGuard(r) !== guard) throw new Error("测试/恢复期间原候选工作区或索引变化，当前结果无效");
    checkout?.assertUnchanged();
  };
  let basis = "", declared: string[] = [];
  const protectedInput = (p: string): boolean => input.run.localFiles.includes(p) || declared.some((path) => p === path || p.startsWith(`${path}/`));
  let sourceIndex = 0, environment: TestEnvironment | undefined, installation: TestEnvironment["installation"];
  const copyInto = (from: string, root: string, rel: string): void => {
    const target = join(root, rel);
    if (!inside(root, target) || lstatSync(target, { throwIfNoEntry: false })) throw new Error(`补装依赖复制路径冲突：${rel}`);
    for (let parent = dirname(target); parent !== root; parent = dirname(parent)) {
      if (lstatSync(parent, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`补装依赖复制父路径含链接：${rel}`);
    }
    mkdirSync(dirname(target), { recursive: true }); cpSync(join(from, rel), target, { dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false });
  };
  const sourceWorkspace = (cached?: TestEnvironment): string => {
    const files = cached ? assertTestEnvironment(cached, input.run) : {};
    const cwd = join(realpathSync(resource.dir), `recovery-${++sourceIndex}`);
    gitText(input.run.repo, ["-c", "core.hooksPath=/dev/null", "clone", "--shared", "--no-checkout", "--quiet", input.run.worktree, cwd]);
    gitText(cwd, ["-c", "core.hooksPath=/dev/null", "checkout", "-qb", "loop-test-recovery", input.candidate.commit]);
    const exclude = join(input.run.common, "info/exclude");
    if (existsSync(exclude)) cpSync(exclude, join(cwd, ".git/info/exclude"));
    const original = new Set([...gitRaw(input.run.worktree, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]).split("\0").filter(Boolean), ...input.run.localFiles]);
    for (const rel of original) if (!cached?.roots.some((root) => rel.startsWith(`${root}/`)) || protectedInput(rel)) copyInto(input.run.worktree, cwd, rel);
    for (const rel of Object.keys(files)) {
      if (protectedInput(rel) || !testDependencyRoot(rel) || gitResult(cwd, ["check-ignore", "-q", "--", rel]).status !== 0) throw new Error(`补装依赖与当前候选/登记输入冲突：${rel}`);
      copyInto(cached!.resource.dir, cwd, rel);
    }
    if (cached) assertTestEnvironment(cached, input.run); // 复制期间快照也必须保持原样。
    return cwd;
  };
  const sourceGuard = (cwd: string, all: boolean): string => JSON.stringify([
    workspaceGuard({ ...input.run, repo: cwd, worktree: cwd, branch: "loop-test-recovery", common: realpathSync(join(cwd, ".git")) }, undefined, all),
    // Git 身份属于恢复副本，来源配置仍从原登记 repo 解析。
    checkInputs({ ...input.run, worktree: cwd }, "开发评审").files,
  ]);
  const openCheckout = (cwd: string, suffix: string): ReturnType<typeof createTestWorkspace> => {
    const attempt = `${input.attempt}-${suffix}`, evidenceDir = join(input.evidenceDir, suffix); mkdirSync(evidenceDir);
    const opened = createTestWorkspace({ ...input, attempt, evidenceDir, run: { ...input.run, worktree: cwd } });
    updateTaskRun(input.ledger, input.taskId, (r) => { r.testWorkspaces!.find((e) => e.attempt === attempt)!.consumerAttempt = input.attempt; });
    return opened;
  };
  const installationObserver = (command: string, cwd: string): ReturnType<typeof nodeOutputProof> | undefined => {
    installation = { kind: "candidate", inputs: input.inputs, files: {} };
    if (independentRecoveryCommand(command)) { installation.kind = "literal"; return undefined; }
    const sources = testEnvironmentSources(input.run);
    const paths = [...new Set([...sources.files, ...gitRaw(cwd, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]).split("\0").filter((p) => p && !testDependencyRoot(p))])];
    const hashes = Object.fromEntries(paths.map((p) => [p, fileDigest(join(cwd, p))]));
    const marker = join(input.evidenceDir, `installation-structure-${sourceIndex}`), markerPath = relative(cwd, marker);
    writeFileSync(marker, "", { flag: "wx", mode: 0o600 });
    const observer = nodeOutputProof(command, cwd, [...paths, markerPath], input.evidenceDir);
    if (observer.env.NODE_OPTIONS) {
      // 原 Node I/O 证明负责签名、完整进程树和不透明消费者；额外覆盖其未记录的元数据/目录读取。
      // 这类读取若涉及未绑定产品输入，就保守绑定整个候选，绝不猜测它与安装产物无关。
      const addon = join(input.evidenceDir, `installation-inputs-${sourceIndex}.cjs`);
      const bound = [...new Set([...sources.bound, ...paths.filter(protectedInput)])];
      writeFileSync(addon, `const fs=require('node:fs'),path=require('node:path'),url=require('node:url'),mod=require('node:module');
const root=${JSON.stringify(cwd)}, aliases=${JSON.stringify([input.run.worktree, input.run.repo])}, marker=${JSON.stringify(marker)}, bound=new Set(${JSON.stringify(bound)}.map(p=>path.resolve(root,p))), known=new Set(${JSON.stringify(paths)}.map(p=>path.resolve(root,p)));
const read=fs.readFileSync, real=fs.realpathSync; let busy=false;
function touch(value,data=false){if(busy)return;busy=true;try{
 if(typeof value==='number'){read(marker);return;}
 if(value instanceof URL)value=url.fileURLToPath(value);if(Buffer.isBuffer(value))value=value.toString();
 if(typeof value!=='string'){read(marker);return;}
 const lexical=path.resolve(process.cwd(),value),within=(base,p)=>{const rel=path.relative(base,p);return rel!=='..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel);};
 const related=(p)=>within(root,p)||aliases.some(base=>within(base,p));
 let absolute=lexical,unresolved=false;try{absolute=real(lexical);}catch{unresolved=true;}
 // realpath 会丢掉别名链；未证明的候选读取保守回退，普通依赖输出的新路径不算候选输入。
 const dependency=(p)=>within(root,p)&&path.relative(root,p).split(path.sep).some(part=>['node_modules','.venv','venv'].includes(part));
 if(value.split(path.sep).includes('..')||(unresolved&&!dependency(lexical)||absolute!==lexical)&&(related(lexical)||related(absolute)))read(marker);
 const rel=path.relative(root,absolute);
 if(within(root,absolute)){if(!rel.split(path.sep).some(p=>['node_modules','.venv','venv'].includes(p))&&!(data?known:bound).has(absolute))read(marker);}
 else if(aliases.some(base=>within(base,absolute)))read(marker);
 }finally{busy=false;}}
for(const target of [fs,fs.promises])for(const name of ['readFile','readFileSync','createReadStream','openAsBlob','open','openSync','copyFile','copyFileSync']){
 const fn=target[name];if(typeof fn!=='function')continue;
 target[name]=function(...args){if(!name.startsWith('open')||!['w','wx','w+','wx+'].includes(args[1]))touch(args[0],true);return Reflect.apply(fn,this,args);};
}
for(const target of [fs,fs.promises])for(const name of ['stat','statSync','lstat','lstatSync','fstat','fstatSync','access','accessSync','exists','existsSync','readdir','readdirSync','opendir','opendirSync','readlink','readlinkSync','realpath','realpathSync','mkdir','mkdirSync','mkdtemp','mkdtempSync','watch','watchFile','glob','globSync']){
 const fn=target[name];if(typeof fn!=='function')continue;
 target[name]=function(...args){touch(args[0]);return Reflect.apply(fn,this,args);};
 if(fn.native)target[name].native=function(...args){touch(args[0]);return Reflect.apply(fn.native,this,args);};
}
if(typeof mod.registerHooks!=='function')read(marker);
else mod.registerHooks({resolve(specifier,context,next){try{const result=next(specifier,context);if(result.url.startsWith('file:'))touch(url.fileURLToPath(result.url));return result;}catch(error){read(marker);throw error;}}});
mod.syncBuiltinESMExports();\n`, { flag: "wx", mode: 0o600 });
      const manifestPath = observer.env.LOOP_NODE_OUTPUT_MANIFEST!, manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      manifest.preload = `${manifest.preload} --require=${JSON.stringify(addon)}`;
      writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 }); observer.env.NODE_OPTIONS = manifest.preload;
    }
    return { ...observer, finish: (result): NodeOutputReport => {
      const proof = observer.finish(result); evidence.push(proof.evidence); installation!.proof = proof.evidence;
      // 该 reason 由受信任的证明校验器生成，不读取项目输出；未知/不完整证明一律保持候选绑定。
      if (proof.enabled && proof.reason === "本次完整 Node 消费者树证明：替换前未消费原内容" && !proof.events.some((e) => e.type === "read" && e.path === markerPath)) {
        installation!.kind = "observed";
        installation!.links = testEnvironmentLinks(input.run);
        installation!.files = Object.fromEntries(proof.events.filter((e) => e.type === "read").map((e) => [e.path, hashes[e.path]]));
      }
      return proof;
    } };
  };
  const reusable = (cached: TestEnvironment): boolean => {
    if (cached.state !== "ready" || cached.basis !== basis) return false;
    const receipt = cached.installation;
    // 历史读取证明缺少链接结构时不能跨候选追认；旧 literal 回执也须经当前展开规则复核。
    if (!receipt || receipt.kind === "candidate" || receipt.kind === "observed" && !receipt.links
      || receipt.kind === "literal" && !independentRecoveryCommand(managedConfig(input.run.worktree, input.run.inputVersion === 2).preparation?.recover ?? "")) {
      return cached.candidate.commit === input.candidate.commit && cached.candidate.tree === input.candidate.tree
        && (receipt?.inputs ?? input.run.results.find((r) => r.id === cached.attempt)?.inputs) === input.inputs;
    }
    try { return (receipt.kind !== "observed" || JSON.stringify(receipt.links) === JSON.stringify(testEnvironmentLinks(input.run)))
      && Object.entries(receipt.files).every(([p, hash]) => fileDigest(join(input.run.worktree, p)) === hash); }
    catch { return false; }
  };
  const saveEnvironment = (): TestEnvironment | undefined => {
    // 只留成功恢复的依赖，既不留旧产品源码/dist，也不覆盖登记输入；以后每次仍独立复查和测试。
    const paths = gitRaw(checkout!.cwd, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]).split("\0").filter((p) => p && testDependencyRoot(p) && !protectedInput(p));
    if (!paths.length) return undefined;
    const saved = createRunResource(`kernel-test-environment:${input.run.id}:${input.taskId ?? taskDefinition(input.run).name}:${input.attempt}`, 0);
    const info = lstatSync(saved.dir), cached: TestEnvironment = { id: saved.id, run: input.run.id, task: input.taskId, attempt: input.attempt, basis, candidate: input.candidate,
      resource: saved, identity: `${info.dev}:${info.ino}`, installation, roots: [...new Set(paths.map((p) => testDependencyRoot(p)!))].sort(), evidence: join(saved.evidenceDir, "environment.json"), manifestHash: "", state: "creating" };
    try {
      updateTaskRun(input.ledger, input.taskId, (r) => { (r.testEnvironments ??= []).push(cached); });
      for (const rel of paths) copyInto(checkout!.cwd, saved.dir, rel);
      const manifest = JSON.stringify({ id: cached.id, run: cached.run, task: cached.task, attempt: input.attempt, basis, candidate: input.candidate, installation, roots: cached.roots, files: testEnvironmentFiles(saved.dir) });
      writeFileSync(cached.evidence, manifest, { mode: 0o600, flag: "wx" }); cached.manifestHash = digest(manifest);
      // 明确保留的是无消费者的已知依赖缓存；普通尝试资源仍照常释放，机器退出也不能抹去补装成果。
      releaseRunResource(saved, true); if (saved.status !== "retained") throw new Error(resourceLine(saved));
      live(); cached.state = "ready";
      updateTaskRun(input.ledger, input.taskId, (r) => { live(); Object.assign(r.testEnvironments!.find((e) => e.id === cached.id)!, cached); });
      evidence.push(cached.evidence); operations.push(`保留可复用补装依赖 ${cached.id}；归属与清单 ${cached.evidence}；不回写候选、不重置恢复次数`);
      return cached;
    } catch (error) {
      releaseRunResource(saved);
      updateTaskRun(input.ledger, input.taskId, (r) => { const entry = r.testEnvironments?.find((e) => e.id === cached.id); if (entry) Object.assign(entry, cached,
        { resource: saved, state: saved.status === "released" ? "released" : "retained", reason: String(error) }); });
      throw error;
    }
  };
  const execute = async (cmd: string, role: string, cwd = checkout!.cwd, observation?: ReturnType<typeof nodeOutputProof>): Promise<ExecResult> => {
    live(); if (Date.now() >= deadline) throw new Error("测试节点独立时间预算耗尽");
    const started = new Date().toISOString(); operations.push(`$ ${cmd}（cwd ${cwd}；候选隔离检出；${role}；${started}）`);
    appendFileSync(log, `\n${started} [${role}] $ ${cmd}\ncwd: ${cwd}\nsource: ${input.run.worktree}\nPYTHONPYCACHEPREFIX: ${runtimeCache.path}\n`);
    const witness = observation ?? (cwd === checkout?.cwd ? checkout.command(cmd) : undefined), previouslyReleased = consumersReleased; consumersReleased = false;
    let result: ExecResult;
    try {
      result = await exec("/bin/sh", ["-c", managedShell(cmd, resource)], { cwd, timeout: Math.max(1, deadline - Date.now()), signal: input.signal,
        role, env: { ...witness?.env, GIT_OPTIONAL_LOCKS: "0", PYTHONPYCACHEPREFIX: runtimeCache.path, AUTOREVIEW_RUN_DIR: input.evidenceDir, AUTOREVIEW_BASE_REV: input.run.base, AUTOREVIEW_BATCH_FILE: input.run.file, AUTOREVIEW_TASK: taskDefinition(input.run).name },
        onControl: witness?.onControl, onOutput: (chunk) => appendFileSync(log, chunk) });
    } catch (error) { witness?.finish({ code: 1, stdout: "", stderr: String(error), killed: true, processesReleased: false }); throw error; }
    witness?.finish(result);
    consumersReleased = previouslyReleased && result.processesReleased === true;
    appendFileSync(log, `\nexit=${result.code}; interrupted=${result.killed}; released=${result.processesReleased}\n${result.stdout}\n${result.stderr}\n`);
    calls.push({ command: cmd, role, cwd, runtimeCache: runtimeCache.path, started, ended: new Date().toISOString(), ...result });
    live(); return result;
  };
  try {
    input.registerResource?.(resource);
    const checkedInputs = checkInputs(input.run, "测试"); basis = testEnvironmentBasis(input.run);
    declared = Object.entries(checkedInputs.paths).filter(([key]) => !key.startsWith("测试依赖/")).flatMap(([, path]) =>
      [input.run.repo, input.run.worktree].filter((root) => inside(root, path)).map((root) => relative(root, path).replace(/\\/g, "/"))).filter(Boolean);
    const preparation = managedConfig(input.run.worktree, input.run.inputVersion === 2).preparation;
    let recoveredAndChecked = false, conditionFailure = false, cachedFailure: ExecResult | undefined;
    environment = [...(readTaskRun(input.ledger, input.taskId).testEnvironments ?? [])].reverse().find(reusable);
    if (environment && preparation) {
      const cwd = sourceWorkspace(environment); checkout = openCheckout(cwd, "cached-environment");
      const before = sourceGuard(cwd, true);
      let checked;
      try { checked = await execute(preparation.check, "测试复用环境条件复查", cwd); }
      finally { if (sourceGuard(cwd, true) !== before) throw new Error("复用环境复查改动候选、输入或稳定规则，结果无效"); }
      evidence.push(environment.evidence);
      if (checked.code !== 0 || checked.killed || !consumersReleased) {
        cachedFailure = checked; conditionFailure = true;
        operations.push(`补装依赖 ${environment.id} 的条件复查失败；只按剩余额度和原保护决定恢复，不先运行测试`);
      } else {
        operations.push(`复用补装依赖 ${environment.id}；仍对本候选独立复查/测试，不消耗或清零恢复次数`);
        recoveredAndChecked = true;
      }
    } else checkout = createTestWorkspace(input);
    operations.push(`隔离检出 ${checkout.cwd}；绑定 ${input.candidate.commit}/${input.candidate.tree} 与输入 ${input.inputs}；原候选严格守卫，产物不回写`);
    let result = cachedFailure ?? await execute(command, "任务测试"), failure: Failure | undefined;
    for (;;) {
      if (!consumersReleased) { failure = { kind: "environment", reason: "测试消费者释放未确认" }; break; }
      if (result.code === 0 && !result.killed) { failure = undefined; output = { status: "通过", evidence, operations, released: true }; break; }
      const diagnostics = `${result.stdout}\n${result.stderr}`, interrupted = result.killed || [129, 130, 137, 143].includes(result.code);
      const classified = classifyFailure(result.code, diagnostics, interrupted);
      failure = conditionFailure ? { kind: "environment", reason: `复用补装依赖的准备复查未通过；${classified.reason}；原始错误：${failureLine(result.code, diagnostics)}` } : classified;
      if (interrupted || input.signal?.aborted || Date.now() >= deadline) break;
      if (recoveredAndChecked) {
        failure = { kind: "product", reason: `补装及准备复查已通过，重跑测试仍失败，按产品失败返修；原始错误：${failureLine(result.code, diagnostics)}` }; break;
      }
      const counter = readTaskRun(input.ledger, input.taskId).counters?.测试;
      const recovery = recoveryDecision(result.code, diagnostics, { recover: preparation?.recover, maxRecoveries: preparation && preparation.maxRecoveries > 0 ? input.run.card.limits.测试.maxRecoveries : 0 }, counter?.recoveries ?? 0);
      if (!recovery.allowed && (failure.kind === "product" || recovery.reason === "项目声明方法错误，未补装")) {
        failure.reason += `；${recovery.reason}；剩余补装次数：${recovery.remaining}`; break;
      }
      const allowed = updateTaskRun(input.ledger, input.taskId, (r) => {
        const counters = (r.counters ??= {}).测试 ??= { repairs: 0, recoveries: 0 };
        if (r.stopped || r.activity?.id !== input.attempt || counters.recoveries >= r.card.limits.测试.maxRecoveries) return false;
        counters.recoveries++; return true;
      });
      if (!allowed) { failure.reason += `；${recovery.reason}；剩余补装次数：${recovery.remaining}`; break; }
      if (preparation && recovery.allowed) {
        // 恢复是可写环境动作，不借测试产物提升权限改写既有依赖。使用本轮资源下的独立 Git 副本，
        // 恢复后再装配一个全新、严格保护的测试检出；原候选、已有输入及其测试守卫始终不放松。
        const inherited = conditionFailure ? environment : undefined;
        const cwd = sourceWorkspace(inherited), before = sourceGuard(cwd, false);
        let recovered;
        try { recovered = await execute(preparation.recover!, "测试环境恢复", cwd, installationObserver(preparation.recover!, cwd)); }
        finally { if (sourceGuard(cwd, false) !== before) throw new Error("测试补装改动候选、输入或稳定规则，结果无效"); }
        if (recovered.code !== 0 || recovered.killed || !consumersReleased) { failure = { kind: "environment", reason: `已有恢复方法失败或释放未确认；原始错误：${failureLine(recovered.code, `${recovered.stdout}\n${recovered.stderr}`)}` }; break; }
        const ready = sourceGuard(cwd, true);
        let checked;
        try { checked = await execute(preparation.check, "测试只读条件复查", cwd); }
        finally { if (sourceGuard(cwd, true) !== ready) throw new Error("测试准备复查改动候选、输入或稳定规则，结果无效"); }
        if (checked.code !== 0 || checked.killed || !consumersReleased) { failure = { kind: "environment", reason: `补装后准备复查未通过；原始错误：${failureLine(checked.code, `${checked.stdout}\n${checked.stderr}`)}` }; break; }
        const previous = checkout.finish(true); evidence.push(previous.evidence); checkout = undefined;
        if (previous.reason) throw new Error(previous.reason);
        checkout = openCheckout(cwd, `recovery-${sourceIndex}`);
        if (inherited) {
          const previous = inherited.installation, current = installation!;
          // 恢复可能只修外部条件而沿用已有依赖，不能因本次没再读取本地源码就丢掉旧安装输入。
          installation = { kind: !previous || previous.kind === "candidate" || previous.kind === "observed" && !previous.links || current.kind === "candidate" ? "candidate"
            : previous.kind === "literal" && current.kind === "literal" ? "literal" : "observed", inputs: input.inputs,
            files: { ...previous?.files, ...current.files }, links: current.links ?? previous?.links, proof: current.proof, inherited: inherited.id };
        }
        environment = saveEnvironment(); recoveredAndChecked = true; conditionFailure = false;
      } else if (preparation) {
        const checked = await execute(preparation.check, "测试只读条件复查");
        if (checked.code !== 0 || checked.killed || !consumersReleased) { failure = classifyFailure(checked.code, `${checked.stdout}\n${checked.stderr}`, checked.killed); if (failure.kind === "product") failure.kind = "method"; break; }
      } else operations.push("没有已登记的适用恢复方法；仅按剩余额度重试原命令");
      result = await execute(command, "任务测试恢复重试");
    }
    if (failure) output = { status: failure.kind === "product" ? "不通过" : "没验证", failure: failure.kind, reason: failure.reason, evidence, operations, released: consumersReleased };
  } catch (error) {
    output = { status: "中断", failure: "environment", reason: String(error), evidence, operations, released: consumersReleased };
  } finally {
    await new Promise<void>((ok) => setImmediate(ok));
    try { captureCache(runtimeCache.path); runtimeCache.capturedAt = new Date().toISOString(); }
    catch (error) { output.status = "中断"; output.failure = "environment"; output.reason = [output.reason, String(error)].filter(Boolean).join("；"); }
    const lateReceipt = readTaskRun(input.ledger, input.taskId).consumerReleases?.find((r) => r.attempt === input.attempt && r.confirmed);
    const consumersKnown = consumersReleased || confirmedConsumerRelease(readTaskRun(input.ledger, input.taskId), input.attempt);
    const released = releaseRunResource(resource, !consumersKnown);
    runtimeCache.release = released.status;
    output.released = consumersKnown && released.status === "released";
    if (checkout) {
      const isolation = checkout.finish(output.released); evidence.push(isolation.evidence);
      if (isolation.reason) { output.status = "中断"; output.failure = "environment"; output.reason = [output.reason, isolation.reason].filter(Boolean).join("；"); }
      const retained = readTaskRun(input.ledger, input.taskId).testWorkspaces?.some((e) => (e.consumerAttempt ?? e.attempt) === input.attempt && e.state !== "released");
      if (retained) output.released = false;
    }
    if (!output.released) { output.status = "没验证"; output.failure = "environment"; output.reason = `${output.reason ?? ""}；${resourceLine(released)}`; }
    writeFileSync(report, JSON.stringify({ attempt: input.attempt, candidate: input.candidate, inputs: input.inputs, command, cwd: checkout?.cwd, source: input.run.worktree, deadline,
      calls, runtimeCache, environment, executorConsumersReleased: consumersReleased, consumerReleaseProof: lateReceipt, result: output.status, failure: output.failure, reason: output.reason, released: output.released, resource }, null, 2), { mode: 0o600 });
  }
  return output;
}

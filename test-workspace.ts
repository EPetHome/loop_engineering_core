/** 测试尝试的最小隔离检出：原命令、既有依赖副本；不安装依赖、不授权原候选的 ignored 写入。 */
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, readdirSync, rmdirSync, watch, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { digest, inside } from "./development-card.ts";
import { fileDigest, gitRaw, checkInputs, testingFileSource } from "./kernel-workspace.ts";
import { gitResult, gitText, worktrees } from "./workspace.ts";
import { readRun, updateRun, type KernelRun, type TestWorkspace } from "./node-ledger.ts";
import type { NodeInput } from "./kernel.ts";
import type { ExecResult } from "./git.ts";
import { nodeOutputProof, type NodeOutputReport } from "./node-output-proof.ts";
interface CommandWitness { env: NodeJS.ProcessEnv; onControl?: (chunk: string) => void; finish: (result: ExecResult) => void }
const names = (s: string): string[] => s.split("\0").filter(Boolean);
const stat = (p: string): string => { const s = lstatSync(p, { bigint: true }); return `${s.dev}:${s.ino}:${s.mode}:${s.nlink}:${s.ctimeNs}:${s.mtimeNs}`; };
const parentIdentity = (p: string): string => { const s = lstatSync(p); return `${s.dev}:${s.ino}`; };
function safeLinks(root: string, path = root): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink()) {
    const target = realpathSync(path);
    if (!inside(root, target)) throw new Error(`隔离检查输入链接越界：${path} → ${readlinkSync(path)}`);
  } else if (info.isDirectory()) { for (const name of readdirSync(path)) if (!(path === root && name === ".git")) safeLinks(root, join(path, name)); }
  else if (!info.isFile() || info.nlink !== 1) throw new Error(`隔离检查输入不是独立普通文件：${path}`);
}
/** 只释放账本登记且目录身份一致的本次检出；未知消费者/被替换路径保留。 */
export function releaseTestWorkspace(ledger: string, entry: TestWorkspace, released: boolean): string | undefined {
  let reason: string | undefined;
  try {
    const run = readRun(ledger), saved = run.testWorkspaces?.find((e) => e.attempt === entry.attempt);
    if (!saved || saved.parent !== entry.parent || saved.identity !== entry.identity || saved.run !== run.id) throw new Error("隔离检出登记身份不匹配");
    if (saved.state === "released") return undefined;
    if (!released) throw new Error("测试消费者释放未确认，隔离检出保留");
    if (!existsSync(entry.parent) || realpathSync(entry.parent) !== entry.parent || parentIdentity(entry.parent) !== entry.identity || dirname(entry.path) !== entry.parent) throw new Error("隔离检出父目录被替换或归属未知");
    if (existsSync(entry.path)) {
      const work = worktrees(run.repo).find((w) => w.path === entry.path);
      if (!work?.detached || realpathSync(entry.path) !== entry.path || realpathSync(gitText(entry.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"])) !== run.common) throw new Error("隔离 Git 检出身份变化，保留现场");
      gitText(run.repo, ["-c", "core.hooksPath=/dev/null", "worktree", "remove", "--force", entry.path]);
    }
    rmdirSync(entry.parent);
  } catch (error) { reason = String(error); }
  updateRun(ledger, (r) => { const e = r.testWorkspaces!.find((e) => e.attempt === entry.attempt)!; e.state = reason ? "retained" : "released"; e.reason = reason; });
  return reason;
}
export function createTestWorkspace(input: NodeInput): { cwd: string; command: (cmd: string) => CommandWitness; assertUnchanged: () => void; finish: (released: boolean) => { reason?: string; evidence: string } } {
  const checked = checkInputs(input.run, "测试");
  const source = input.run.worktree, parent = realpathSync(mkdtempSync(join(tmpdir(), "loop-test-"))), cwd = join(parent, "worktree");
  const entry: TestWorkspace = { attempt: input.attempt, run: input.run.id, task: input.taskId, candidate: input.candidate, inputs: input.inputs, source, parent, path: cwd, identity: parentIdentity(parent), state: "creating" };
  updateRun(input.ledger, (r) => { (r.testWorkspaces ??= []).push(entry); });
  const evidence = join(input.evidenceDir, "check-workspace.json"), events: { path?: string; event: string; at: string }[] = [];
  let watcher: ReturnType<typeof watch> | undefined, indexWatcher: ReturnType<typeof watch> | undefined, indexChanged = false;
  const protectedFiles = new Map<string, string>(), directories = new Set<string>(), initialDirectories = new Map<string, string>(), protectedDirectories = new Map<string, string>();
  const eligible = new Set<string>(), promoted = new Set<string>(), nodeProofs: NodeOutputReport[] = [];
  let initialIndex = "", initialIndexStat = "", index = "";
  const fingerprint = (path: string): string => `${fileDigest(path)}:${stat(path)}`;
  const walk = (path: string, visit: (p: string) => void): void => {
    for (const name of readdirSync(path)) {
      if (path === cwd && name === ".git") continue;
      const p = join(path, name), s = lstatSync(p);
      if (s.isDirectory()) { directories.add(relative(cwd, p)); walk(p, visit); } else visit(p);
    }
  };
  // 完整带入原有 ignored 文件，不新增登记前提。默认全部当输入；只有实际受控 Node I/O 证明完整替换且未读取旧内容的文件才提升为产物。
  // 登记输入、跟踪源码、依赖目录从不进入可提升集合；原目录完整守卫，不回写或删改。
  const declared = Object.entries(checked.paths).filter(([key]) => !key.startsWith("测试依赖/")).map(([, path]) => path);
  const protectedPaths = declared.flatMap((p) => [source, input.run.repo].filter((r) => inside(r, p)).map((r) => relative(r, p))).filter(Boolean);
  const inputPlan: { inputs: { path: string; hash: string; source: string }[]; omitted: { path: string; hash: string; reason: string }[] } = { inputs: [], omitted: [] };
  const forbidden = (rel: string): boolean => protectedFiles.has(rel) && !promoted.has(rel) || protectedPaths.some((p) => rel === p || rel.startsWith(`${p}/`)) || rel === ".git" || rel.startsWith(".git/");
  const ignored = (rel: string): boolean => gitResult(cwd, ["check-ignore", "-q", "--", rel]).status === 0;
  const artifacts = (): { path: string; hash: string; rule: string; size: number }[] => {
    const values: { path: string; hash: string; rule: string; size: number }[] = [];
    walk(cwd, (p) => {
      const rel = relative(cwd, p), s = lstatSync(p);
      if (protectedFiles.has(rel) && !promoted.has(rel)) { if (fingerprint(p) !== protectedFiles.get(rel)) throw new Error(`隔离检查输入被改写（写回同字节也无效）：${rel}`); return; }
      if (forbidden(rel) || !s.isFile() || s.nlink !== 1 || !ignored(rel)) throw new Error(`未授权隔离输出/链接/非忽略新增文件：${rel}`);
      values.push({ path: rel, hash: fileDigest(p), size: s.size, rule: gitRaw(cwd, ["check-ignore", "-v", "--", rel]).trim() });
    });
    return values;
  };
  const assertUnchanged = (): void => {
    if (realpathSync(cwd) !== cwd || parentIdentity(parent) !== entry.identity || gitText(cwd, ["rev-parse", "HEAD"]) !== input.candidate.commit
      || gitRaw(cwd, ["ls-files", "--stage", "-z"]) !== initialIndex || stat(index) !== initialIndexStat || indexChanged) throw new Error("隔离检出候选/索引或目录身份变化，结果无效");
    for (const [rel, before] of protectedFiles) if (!promoted.has(rel) && (!existsSync(join(cwd, rel)) || fingerprint(join(cwd, rel)) !== before)) throw new Error(`隔离检查输入变化：${rel}`);
    for (const [rel, before] of protectedDirectories) if (!existsSync(join(cwd, rel)) || stat(join(cwd, rel)) !== before) throw new Error(`隔离检查输入目录变化（含瞬时新增/删除）：${rel}`);
    const outputs = artifacts();
    for (const event of events) {
      if (!event.path) throw new Error("隔离目录事件路径未知，不能证明为受控产物");
      const rel = event.path, path = resolve(cwd, rel);
      if (!inside(cwd, path)) throw new Error(`隔离检查路径越界：${rel}`);
      // macOS 可延迟投递监听前的复制通知。只对已在上方逐项证明字节/inode/ctime 等完全不变的输入接受原样通知。
      // 写后还原或输入目录内瞬时创建/删除仍会改变这些元数据，不靠关监听或忽略路径放行。
      if (protectedFiles.has(rel) || protectedDirectories.has(rel) || initialDirectories.has(rel) && existsSync(path) && stat(path) === initialDirectories.get(rel)) continue;
      if (forbidden(rel)) throw new Error(`隔离检查输入事件：${rel}`);
      // 目录事件不是一概忽略：必须能关联本次登记的后代产物；未知/空目录仍拒绝。
      if (existsSync(path) && lstatSync(path).isDirectory()) {
        if (!outputs.some((p) => p.path.startsWith(`${rel}/`))) throw new Error(`隔离目录事件无受控产物证据：${rel}`);
      } else if (!ignored(rel)) throw new Error(`隔离非忽略路径发生瞬时写入：${rel}`);
    }
  };
  const command = (cmd: string): CommandWitness => {
    const witness = nodeOutputProof(cmd, cwd, [...eligible], input.evidenceDir);
    return { env: witness.env, onControl: witness.onControl, finish: (result) => {
      const proof = witness.finish(result); nodeProofs.push(proof);
      for (const rel of proof.outputs) {
        const p = join(cwd, rel);
        if (!eligible.has(rel) || !existsSync(p)) continue;
        const info = lstatSync(p);
        if (info.isFile() && info.nlink === 1 && realpathSync(p) === p && ignored(rel)) promoted.add(rel);
      }
    } };
  };
  const finish = (released: boolean): { reason?: string; evidence: string } => {
    watcher?.close(); indexWatcher?.close();
    let reason: string | undefined, outputs: ReturnType<typeof artifacts> = [];
    try { assertUnchanged(); outputs = artifacts(); } catch (error) { reason = String(error); }
    // 产物不复制回候选；完整路径、哈希/规则及事件留在原有尝试证据中。
    writeFileSync(evidence, JSON.stringify({ ...entry, candidate: input.candidate, inputs: input.inputs, sourceProtection: "原候选/输入守卫结论见同尝试 interruption.json；不以隔离目录结论代替",
      initialFiles: Object.fromEntries(protectedFiles), initialDirectories: Object.fromEntries(initialDirectories), immutableDirectories: Object.fromEntries(protectedDirectories), inputPlan, nodeProofs, promoted: [...promoted], events, artifacts: outputs, validity: !reason, reason, consumersReleased: released }, null, 2), { mode: 0o600 });
    const releaseReason = releaseTestWorkspace(input.ledger, entry, released);
    const final = readRun(input.ledger).testWorkspaces!.find((e) => e.attempt === entry.attempt)!;
    writeFileSync(evidence, JSON.stringify({ ...JSON.parse(readFileSync(evidence, "utf8")), release: final.state, releaseReason }, null, 2));
    return { reason: [reason, releaseReason].filter(Boolean).join("；") || undefined, evidence };
  };
  try {
    gitText(input.run.repo, ["-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", cwd, input.candidate.commit]);
    const ignoredFiles = names(gitRaw(source, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]));
    for (const rel of [...new Set([...ignoredFiles, ...input.run.localFiles])]) {
      const from = join(source, rel), to = join(cwd, rel);
      const fixedSource = testingFileSource(input.run, rel, checked.paths);
      inputPlan.inputs.push({ path: rel, hash: fileDigest(from), source: fixedSource ?? "既有 ignored 输入（默认保留）" });
      if (!fixedSource && lstatSync(from).isFile() && lstatSync(from).nlink === 1) eligible.add(rel);
      if (!inside(source, from) || !inside(cwd, to) || existsSync(to)) throw new Error(`隔离输入路径冲突：${rel}`);
      let p = dirname(to);
      while (inside(cwd, p) && p !== cwd) { if (existsSync(p) && lstatSync(p).isSymbolicLink()) throw new Error(`隔离输入父路径含链接：${rel}`); p = dirname(p); }
      mkdirSync(dirname(to), { recursive: true }); cpSync(from, to, { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false });
    }
    safeLinks(cwd); walk(cwd, (p) => protectedFiles.set(relative(cwd, p), fingerprint(p)));
    for (const rel of directories) {
      const value = stat(join(cwd, rel)); initialDirectories.set(rel, value);
      if (testingFileSource(input.run, rel, checked.paths)) protectedDirectories.set(rel, value);
    }
    initialIndex = gitRaw(cwd, ["ls-files", "--stage", "-z"]); index = gitText(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "index"]); initialIndexStat = stat(index);
    watcher = watch(cwd, { recursive: true }, (event, name) => events.push({ path: name?.toString(), event, at: new Date().toISOString() }));
    indexWatcher = watch(dirname(index), (_event, name) => { if (!name || name === "index" || name === "index.lock") indexChanged = true; });
    updateRun(input.ledger, (r) => { r.testWorkspaces!.find((e) => e.attempt === entry.attempt)!.state = "active"; });
    return { cwd, command, assertUnchanged, finish };
  } catch (error) {
    watcher?.close(); indexWatcher?.close(); const releaseReason = releaseTestWorkspace(input.ledger, entry, true);
    writeFileSync(evidence, JSON.stringify({ ...entry, reason: String(error), releaseReason }, null, 2));
    throw new Error(`创建隔离检查目录失败：${String(error)}；${releaseReason ?? "临时检出已释放"}；证据 ${evidence}`);
  }
}

/** 受管任务 Git 边界：私有索引、范围/本机文件排除、CAS；不处理用户独立工作区。 */
import { spawnSync } from "node:child_process";
import { closeSync, cpSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { digest, inside, type NodeName } from "./development-card.ts";
import { HERMES_BIN, findProjectRoot, loadProjectLayout, parseAcceptanceConfig, parseContext, parseDeploymentConfig, parseMethodsConfig, readMarker, resolveProjectConfig } from "./config.ts";
import { inScope, outOfScope } from "./scope.ts";
import { gitResult, gitText, worktrees, worktreeForBranch } from "./workspace.ts";
import { taskDefinition, taskView, type Candidate, type KernelRun, type DeploymentPlan, type TestEnvironment } from "./node-ledger.ts";
import { authorizationStatus, forUser, type AcceptanceItemResult } from "./acceptance-core.ts";
import { processGroup, processStartTime } from "./procs.ts";
import { resourceRoot } from "./resources.ts";

const nul = (s: string): string[] => s.split("\0").filter(Boolean);
/** macOS Pi 改写进程标题后 ps 可能不再展示环境；仅核对原生会话的完整启动链，不授予杀组权限。 */
export function nativePiOwnerConfirmed(run: KernelRun, ledger: string): boolean {
  const s = run.session, g = run.launch;
  if (process.platform !== "darwin" || run.card.host !== "pi" || s?.host !== "pi" || !s.log || !g || !g.token || s.launchId !== g.token
    || s.pid !== g.pid || s.started !== g.processStarted || processStartTime(s.pid) !== s.started || processGroup(s.pid) !== g.pid) return false;
  try {
    const file = lstatSync(s.log);
    if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || realpathSync(s.log) !== resolve(s.log)) return false;
    const fd = openSync(s.log, "r"), buffer = Buffer.alloc(8192); let size: number;
    try { size = readSync(fd, buffer, 0, buffer.length, 0); } finally { closeSync(fd); }
    const end = buffer.subarray(0, size).indexOf(10); if (end < 0) return false;
    const header = JSON.parse(buffer.subarray(0, end).toString("utf8")), cwd = realpathSync(run.worktree);
    if (header.type !== "session" || header.id !== s.id || realpathSync(header.cwd) !== cwd) return false;
    const current = spawnSync("/usr/sbin/lsof", ["-a", "-p", String(s.pid), "-d", "cwd", "-F0n"], { encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024 });
    if (current.status !== 0 || !current.stdout.split("\0").includes(`n${cwd}`)) return false;
    const parent = spawnSync("ps", ["-o", "ppid=", "-p", String(s.pid)], { encoding: "utf8", timeout: 5000 });
    const ppid = Number(parent.stdout?.trim()); if (parent.status !== 0 || !Number.isSafeInteger(ppid) || ppid < 2) return false;
    const names = [run.taskId, taskDefinition(run).name, ...(!run.taskRecords ? ["batch"] : [])].filter((n): n is string => !!n && !/[\\/]/.test(n));
    return names.some((name) => {
      try {
        const path = `${ledger}.${name}.launch.lock`, info = lstatSync(path);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) return false;
        const owner = JSON.parse(readFileSync(path, "utf8"));
        return owner.pid === ppid && typeof owner.token === "string" && /^[a-f0-9-]{36}$/.test(owner.token) && owner.started === processStartTime(ppid)
          && processStartTime(s.pid) === s.started && processGroup(s.pid) === g.pid;
      } catch { return false; }
    });
  } catch { return false; }
}
/** 路径按原始 NUL 字节拆分，不 trim 文件名中的首尾空白。 */
export function gitRaw(repo: string, args: string[]): string {
  const r = gitResult(repo, args);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} 失败：${r.stderr || r.stdout}`);
  return r.stdout;
}
export function fileDigest(path: string): string {
  const info = lstatSync(path);
  if (info.isSymbolicLink()) return digest(`link:${readlinkSync(path)}`);
  if (!info.isFile()) throw new Error(`不是普通本机文件：${path}`);
  return digest(Buffer.concat([Buffer.from(`${info.mode & 0o111}:`), readFileSync(path)]));
}
/** 有界只读来源清单；不写索引，不跟随链接，不扫描整个磁盘。 */
function sourceHashes(path: string, into: Record<string, string>, label: string, paths: Record<string, string>, contents: Record<string, string>, capture?: { text?: string }): void {
  if (Object.keys(into).length > 2000) throw new Error("检查输入超过 2000 文件");
  if (!existsSync(path)) { into[label] = "缺失"; paths[label] = path; return; }
  const info = lstatSync(path);
  if (info.isSymbolicLink()) throw new Error(`检查输入不跟随符号链接：${path}`);
  if (info.isDirectory()) {
    into[`${label}/`] = "目录"; paths[`${label}/`] = path;
    for (const name of readdirSync(path).sort()) sourceHashes(join(path, name), into, `${label}/${name}`, paths, contents);
  } else {
    if (!info.isFile() || info.size > 1024 * 1024) throw new Error(`检查输入非普通文件或超过 1MiB：${path}`);
    // 文件指纹与确认内容都取自同一份字节，不能先哈希 V2、再另读 V1 来校验。
    const bytes = readFileSync(path), key = `${label}：${path}`;
    into[key] = digest(Buffer.concat([Buffer.from(`${info.mode & 0o111}:`), bytes])); paths[key] = path; contents[key] = digest(bytes);
    if (capture) capture.text = bytes.toString("utf8");
  }
}
/** 只归一化本次 CAS/checkout 可证明造成的输入更新；外部写入、用户版本和授权不豁免。 */
function publicationInputChanges(run: KernelRun, files: Record<string, string>, paths: Record<string, string>): string[] {
  const p = run.publication;
  if (p?.local !== "merged" || !p.inputSnapshot || !p.inputRoot) return [];
  const changed = nul(gitRaw(run.repo, ["diff", "--name-only", "--no-renames", "-z", p.targetBefore, p.commit, "--"]));
  const verified = new Map<string, boolean>(), normalized: string[] = [];
  const isPublished = (path: string): boolean => {
    if (verified.has(path)) return verified.get(path)!;
    let same = false;
    if (inside(p.inputRoot!, path)) {
      const rel = relative(p.inputRoot!, path).replace(/\\/g, "/");
      if (rel && changed.some((v) => rel === v || rel.startsWith(`${v}/`) || v.startsWith(`${rel}/`))) {
        const entry = gitRaw(run.repo, ["--literal-pathspecs", "ls-tree", "-z", p.commit, "--", rel]);
        if (!entry) same = !existsSync(path);
        else {
          const info = existsSync(path) ? lstatSync(path) : undefined;
          if (entry.startsWith("040000 tree ")) same = Boolean(info?.isDirectory() && !info.isSymbolicLink());
          else if (info?.isFile() && /^100(?:644|755) blob /.test(entry)) {
            const executable = entry.startsWith("100755 ");
            const read = spawnSync("git", ["cat-file", "--filters", `--path=${rel}`, `${p.commit}:${rel}`], { cwd: run.repo, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
            same = read.status === 0 && Boolean(info.mode & 0o111) === executable
              && fileDigest(path) === digest(Buffer.concat([Buffer.from(`${info.mode & 0o111}:`), read.stdout]));
          }
        }
      }
    }
    verified.set(path, same); return same;
  };
  const before = p.inputSnapshot.files;
  for (const key of new Set([...Object.keys(before), ...Object.keys(files)])) {
    if (before[key] === files[key]) continue;
    const path = paths[key] ?? p.inputSnapshot.paths[key];
    if (!path || !isPublished(path)) continue;
    if (Object.hasOwn(before, key)) files[key] = before[key]; else delete files[key];
    normalized.push(path);
  }
  return [...new Set(normalized)];
}
/** 引用是用户确认的内容版本，不是允许程序静默采用未来文件内容的授权。 */
function verifyUserReferences(run: KernelRun, files: Record<string, string>, paths: Record<string, string>, contents: Record<string, string>, observed: Record<string, string>, publicationChanges: string[]): void {
  const canonical = (path: string): string => { try { return realpathSync(path); } catch { return resolve(path); } };
  for (const reference of run.userFiles ?? []) {
    const expected = run.userFileVersions?.[reference], actualPath = canonical(reference);
    const keys = Object.keys(files).filter((key) => {
      const path = paths[key] ?? run.publication?.inputSnapshot?.paths[key];
      return path && canonical(path) === actualPath;
    });
    const mismatch = !expected || !keys.length || keys.some((key) => {
      if (contents[key] === expected) return false;
      const path = paths[key] ?? run.publication?.inputSnapshot?.paths[key];
      // 已检查候选的发布转换仍使用原输入身份；只有原有精确 Git 证明可以归一化。
      return !(run.publication?.local === "merged" && path && publicationChanges.includes(path)
        && files[key] === run.publication.inputSnapshot?.files[key] && files[key] !== observed[key]);
    });
    if (mismatch) throw new Error(`引用检查输入已变化或缺少确认快照：${reference}；请在原开发会话重新引用确认（发送 ${/\s/.test(reference) ? `@"${reference}"` : `@${reference}`}），再交付；仅续跑不会自动采用新标准`);
  }
}
/** 只有依赖目录可跨候选复用；dist 等产品编译产物不会进入补装缓存。 */
export function testDependencyRoot(path: string): string | undefined {
  const parts = path.split("/"), at = parts.findIndex((p) => ["node_modules", ".venv", "venv"].includes(p));
  return at < 0 ? undefined : parts.slice(0, at + 1).join("/");
}
/** 范围不能代替安装输入：scope 内源码的实际读取另由补装观测绑定。 */
export function testEnvironmentSources(run: KernelRun): { files: string[]; bound: string[] } {
  const descriptor = /^(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|pnpm-workspace\.yaml|bun\.lockb?|\.npmrc|\.yarnrc(?:\.yml)?|pyproject\.toml|requirements[^/]*\.txt|Pipfile(?:\.lock)?|poetry\.lock|uv\.lock|setup\.py|setup\.cfg|\.gitignore|\.gitattributes)$/;
  const files = nul(gitRaw(run.worktree, ["ls-files", "--cached", "-z"])).sort();
  return { files, bound: files.filter((p) => !inScope(p, taskDefinition(run).scope) || descriptor.test(p.split("/").at(-1)!)) };
}
/** 覆盖全部候选链接的结构，防止模块解析先 realpath 后丢失读取别名或新增父目录链接。 */
export function testEnvironmentLinks(run: KernelRun): Record<string, string> {
  const paths = [...new Set(nul(gitRaw(run.worktree, ["ls-files", "--cached", "--others", "-z"])))].sort();
  return Object.fromEntries(paths.filter((p) => lstatSync(join(run.worktree, p)).isSymbolicLink()).map((p) => [p, fileDigest(join(run.worktree, p))]));
}
/** 仅承认不读取源码字节的直线字面量写入；任何展开、分支或未知工具都回退为候选绑定。 */
export function independentRecoveryCommand(command: string): boolean {
  if (process.env.ENV || process.env.BASH_ENV || process.env.LD_PRELOAD || process.env.DYLD_INSERT_LIBRARIES
    || Object.keys(process.env).some((k) => k.startsWith("BASH_FUNC_"))) return false;
  const commands: string[][] = [], current: string[] = [];
  let word = "", quote = "", started = false;
  const flush = (): void => { if (started) current.push(word); word = ""; started = false; };
  for (const c of command) {
    if (quote) {
      if (c === quote) quote = "";
      else { if (quote === '"' && /[$`\\\\]/.test(c)) return false; word += c; }
    } else if (c === "'" || c === '"') { quote = c; started = true; }
    else if (c === ";" || c === "\n") { flush(); if (current.length) commands.push(current.splice(0)); }
    else if (/\s/.test(c)) flush();
    else if (c === ">") { flush(); current.push(c); }
    else { if (/[&|<(){}$`\\\\*?~#]/.test(c) || c === "[" || c === "]") return false; word += c; started = true; }
  }
  if (quote) return false;
  flush(); if (current.length) commands.push(current);
  const trusted = (name: string): boolean => {
    if (name === "printf") return true; // /bin/sh 的纯字面量 printf；不允许 -v、%n 等赋值形式。
    try {
      const found = [HERMES_BIN, ...(process.env.PATH ?? "").split(":")].map((p) => join(p, name)).find((p) => existsSync(p) && (lstatSync(p).mode & 0o111));
      return !!found && ["/bin", "/usr/bin"].some((root) => existsSync(join(root, name)) && realpathSync(found) === realpathSync(join(root, name)));
    } catch { return false; }
  };
  const literalPath = (p: string): boolean => !!p && p !== ">" && !p.startsWith("-");
  return commands.length > 0 && commands.every(([name, ...args]) => {
    if (!["mkdir", "printf", "ln", "rm"].includes(name) || !trusted(name)) return false;
    if (name === "printf") {
      const redirection = args.indexOf(">"), values = redirection < 0 ? args : args.slice(0, redirection);
      return !!values.length && !values[0].startsWith("-") && !values[0].replace(/%%|%s/g, "").includes("%")
        && (redirection < 0 || redirection === args.length - 2 && literalPath(args.at(-1)!));
    }
    if (name === "ln") return args.length === 3 && args[0] === "-s" && args.slice(1).every(literalPath);
    const paths = args.filter((p) => !(name === "mkdir" ? p === "-p" : ["-r", "-f", "-rf", "-fr"].includes(p)));
    return paths.length > 0 && paths.every(literalPath);
  });
}
/** 公共依据只准省略已另行证明未消费的产品输入，绝不独自授予跨候选复用资格。 */
export function testEnvironmentBasis(run: KernelRun): string {
  const files = testEnvironmentSources(run).bound;
  const checked = checkInputs(run, "测试");
  // 普通 ignored 产品产物会随返修重建，不应使依赖安装失效；显式登记输入及原依赖仍完整绑定。
  const inputs = Object.entries(checked.files).filter(([key]) => !key.startsWith("测试依赖/")).sort(([a], [b]) => a.localeCompare(b));
  const dependencies = nul(gitRaw(run.worktree, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"])).filter((p) => testDependencyRoot(p)).sort();
  const preparation = managedConfig(run.worktree, run.inputVersion === 2).preparation;
  return digest(JSON.stringify([inputs, run.userVersion, run.userInputs, taskDefinition(run).test, preparation?.check, preparation?.recover,
    dependencies.map((p) => [p, fileDigest(join(run.worktree, p))]), files.map((p) => [p, fileDigest(join(run.worktree, p))])]));
}
/** 快照自身也绑定字节与元数据，不跟随链接或接纳硬链接/特殊文件。 */
export function testEnvironmentFiles(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (path: string): void => {
    for (const name of readdirSync(path).sort()) {
      const p = join(path, name), info = lstatSync(p, { bigint: true });
      if (info.isDirectory()) walk(p);
      else {
        if ((!info.isFile() && !info.isSymbolicLink()) || info.nlink !== 1n) throw new Error(`补装依赖快照不是独立文件：${p}`);
        files[relative(root, p).replace(/\\/g, "/")] = `${fileDigest(p)}:${info.dev}:${info.ino}:${info.mode}:${info.mtimeNs}:${info.ctimeNs}`;
      }
    }
  };
  walk(root); return files;
}
export function assertTestEnvironment(environment: TestEnvironment, run: KernelRun): Record<string, string> {
  const { resource } = environment;
  if (environment.run !== run.id || environment.task !== run.taskId || environment.id !== resource.id || resolve(resource.root) !== resolve(resourceRoot())
    || resolve(resource.dir) !== resolve(resource.root, resource.id) || realpathSync(resource.dir) !== join(realpathSync(resource.root), resource.id)
    || environment.evidence !== join(resource.evidenceDir, "environment.json")) throw new Error("补装依赖快照归属或路径变化");
  const info = lstatSync(resource.dir);
  if (!info.isDirectory() || info.isSymbolicLink() || `${info.dev}:${info.ino}` !== environment.identity) throw new Error("补装依赖快照目录身份变化");
  const saved = JSON.parse(readFileSync(join(resource.root, `${resource.id}.json`), "utf8"));
  if (saved.id !== resource.id || saved.dir !== resource.dir || saved.ownerPid !== resource.ownerPid || saved.ownerStarted !== resource.ownerStarted || saved.label !== resource.label) throw new Error("补装依赖快照资源登记变化");
  if (!environment.manifestHash) return {}; // 尚未完成的自有复制也须按登记释放，但绝不能复用。
  const bytes = readFileSync(environment.evidence);
  if (digest(bytes) !== environment.manifestHash) throw new Error("补装依赖快照清单变化");
  const manifest = JSON.parse(bytes.toString("utf8"));
  if (JSON.stringify(manifest.installation) !== JSON.stringify(environment.installation)) throw new Error("补装依赖快照安装输入绑定变化");
  const files: Record<string, string> = manifest.files;
  const roots = [...new Set(Object.keys(files).map(testDependencyRoot))].sort();
  if (roots.includes(undefined) || JSON.stringify(roots) !== JSON.stringify(environment.roots)
    || JSON.stringify(testEnvironmentFiles(resource.dir)) !== JSON.stringify(files)) throw new Error("补装依赖快照内容变化，不复用或删除未知内容");
  return files;
}

/** 已登记/依赖输入的强保护来源；其他 ignored 文件也默认带入并绑定指纹，不按忽略规则省略。 */
export function testingFileSource(run: KernelRun, rel: string, paths: Record<string, string>): string | undefined {
  if (run.localFiles.includes(rel)) return "localFiles";
  if (testDependencyRoot(rel)) return "既有依赖目录";
  const declared = Object.entries(paths).filter(([key]) => !key.startsWith("测试依赖/")).flatMap(([, path]) =>
    [run.worktree, run.repo].filter((root) => inside(root, path)).map((root) => relative(root, path))).filter(Boolean);
  if (declared.some((p) => rel === p || rel.startsWith(`${p}/`))) return "登记方法/引用输入";
  return undefined;
}
export function checkInputs(run: KernelRun, node: NodeName = "提交"): { hash: string; files: Record<string, string>; paths: Record<string, string>; observedFiles: Record<string, string>; publicationChanges: string[]; requirement: string } {
  const files: Record<string, string> = {}, paths: Record<string, string> = {}, contents: Record<string, string> = {};
  if (node === "部署") return deploymentInputs(run);
  if (run.card.nature === "评审") {
    const r = run.card.review!, config = managedConfig(run.repo, true);
    const texts: Record<string, { text?: string }> = {};
    for (const key of ["requirement", "criteria", "note"] as const) if (r[key]) {
      texts[key] = {}; sourceHashes(r[key]!, files, key, paths, contents, texts[key]);
    }
    const requirement = texts.requirement?.text ?? "未提供需求；仅评审指定已有提交差异";
    const hash = digest(JSON.stringify([run.reviewComparison, Object.entries(files).sort(), config.reviewerModel, config.reviewerThinking, config.reviewerCmd, run.card.limits.开发评审.timeoutMin]));
    if (run.reviewInputs && run.reviewInputs.hash !== hash) throw new Error("只评审需求/标准/说明、模型或时限变化；旧结论无效。请用「改卡 --from」明确确认当前输入版本，再只重跑评审；不会静默采用新输入");
    return { hash, files, paths, observedFiles: { ...files }, publicationChanges: [], requirement };
  }
  const collect = (path: string, label: string): void => sourceHashes(path, files, label, paths, contents);
  collect(run.file, "卡");
  const prompt: { text?: string } = {};
  const definitions = run.taskRecords && !run.taskId ? run.card.tasks : [taskDefinition(run)];
  for (const definition of definitions) sourceHashes(definition.prompt, files, run.taskRecords ? `提示词/${definition.name}` : "提示词", paths, contents, prompt);
  if ((node === "验收" || node === "提交") && run.card.flow.includes("验收") && run.card.acceptance) {
    collect(run.card.acceptance, "验收标准");
    if (run.acceptanceState && digest(readFileSync(run.card.acceptance)) !== run.acceptanceState.hash) throw new Error("验收标准文件已变化；请用改卡 --from 确认当前版本，旧授权不沿用");
  }
  for (const path of run.userFiles ?? []) collect(path, `用户检查输入/${path}`);
  for (const [label, root] of [["原目录", run.repo], ["任务目录", run.worktree]] as const) {
    if (!existsSync(root)) continue;
    for (const p of [...new Set([...run.localFiles, "AGENTS.md", "CLAUDE.md", ".autoreview/经验.md"])]) collect(join(root, p), `${label}/${p}`);
  }
  const configRoot = findProjectRoot(run.repo) ?? run.repo;
  const raw = existsSync(join(configRoot, ".autoreview.json")) ? readMarker(configRoot) : {};
  if (run.inputVersion === 2) for (const [label, root] of [["原目录", run.repo], ["任务目录", run.worktree]] as const) {
    if (!existsSync(root)) continue;
    const methods = parseMethodsConfig(readMarker(root).methods, root);
    for (const path of methods?.paths ?? []) collect(resolve(root, path), `测试方法/${label}/${path}`);
  }
  const acceptanceConfigs = (node === "验收" || node === "提交") && run.card.flow.includes("验收") ? [run.repo, run.worktree].filter(existsSync).map((root) => {
    const config = parseAcceptanceConfig(readMarker(root).acceptance, root, process.env);
    if (!config) throw new Error("验收方法缺失；项目须显式配置 acceptance");
    for (const field of ["guide", "actions"] as const) if (config[field]) {
      if (!existsSync(config[field]!)) throw new Error(`验收方法 ${field} 缺失：${config[field]}；补齐并登记 localFiles 或提交到开工树后再启动`);
      collect(config[field]!, `验收方法/${root === run.repo ? "原目录" : "任务目录"}/${field}`);
    }
    return config;
  }) : [];
  const context = parseContext(raw.context, configRoot);
  if (context) for (const s of context.sources.filter((s) => s.role !== "code")) {
    const path = resolve(context.root, s.path);
    if (!s.optional && !existsSync(path)) throw new Error(`上游来源缺失：${path}`);
    collect(path, `来源/${s.id}`);
    if (inside(run.repo, path) && existsSync(run.worktree)) collect(resolve(run.worktree, relative(run.repo, path)), `任务来源/${s.id}`);
  }
  if (prompt.text === undefined && !run.publication?.inputSnapshot) throw new Error(`提示词无法形成输入快照：${definitions.map((t) => t.prompt).join("、")}`);
  const requirement = run.publication?.inputSnapshot?.requirement ?? [prompt.text!, ...run.userInputs].join("\n\n");
  // 实际测试读取的既有 ignored 依赖也是输入，不凭忽略规则授予写入/复用权限。
  if (run.inputVersion === 2 && ["测试", "提交"].includes(node) && run.card.flow.includes("测试") && existsSync(run.worktree)) {
    for (const rel of nul(gitRaw(run.worktree, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"])).filter((p) => !run.localFiles.includes(p)).sort()) {
      const path = join(run.worktree, rel), key = `测试依赖/${rel}：${path}`;
      files[key] = fileDigest(path); paths[key] = path;
    }
  }
  const observedFiles = { ...files }, publicationChanges = publicationInputChanges(run, files, paths);
  verifyUserReferences(run, files, paths, contents, observedFiles, publicationChanges);
  const config = managedConfig(existsSync(run.worktree) ? run.worktree : run.repo, run.inputVersion === 2);
  const identityFiles = Object.entries(files).sort(([a], [b]) => a.localeCompare(b));
  let identity: unknown = [identityFiles, run.userVersion, run.userInputs, config.configurationHash, config.reviewerModel, config.reviewerThinking, config.reviewerCmd, run.card.limits.开发评审];
  if (run.inputVersion === 2) {
    // 原文仍留完整证据；运行卡和已知配置仅按真正消费者投影，不间接耦合测试与评审。
    const commonFiles = identityFiles.filter(([key]) => !key.startsWith("卡：") && !key.startsWith("测试依赖/") && !key.startsWith("测试方法/") && !["原目录/.autoreview.json：", "任务目录/.autoreview.json："].some((prefix) => key.startsWith(prefix)));
    const configs = [run.repo, run.worktree].filter(existsSync).map((root) => readMarker(root));
    const operational = configs.map((data) => {
      return Object.fromEntries(Object.entries(data).filter(([k]) => !["gate", "acceptance", "deployment", "preparation", "maxRepairs", "reviewTimeoutMin", "reviewerModel", "reviewerThinking", "reviewerCmd"].includes(k)));
    });
    const definition = run.taskRecords && !run.taskId ? undefined : taskDefinition(run);
    const common = [commonFiles.filter(([k]) => !k.startsWith("验收标准：")), operational, run.userVersion, run.userInputs, definition?.name];
    const review = [common, configs.map((c) => [c.reviewerModel, c.reviewerThinking, c.reviewerCmd]), definition?.prompt, definition?.scope, config.reviewerModel, config.reviewerThinking, config.reviewerCmd, run.card.limits.开发评审.timeoutMin];
    const prep = config.preparation;
    const testing = [common, identityFiles.filter(([key]) => key.startsWith("测试方法/")), configs.map((c) => {
      const p = c.preparation as any; return p ? [p.check, p.recover, p.maxRecoveries, p.timeoutMin] : null;
    }), definition?.test, run.card.limits.测试?.timeoutMin ?? 20,
      prep ? { check: prep.check, recover: prep.recover, maxRecoveries: prep.maxRecoveries, timeoutMin: prep.timeoutMin } : null];
    const runtime = identityFiles.filter(([key]) => key.startsWith("测试依赖/"));
    if (runtime.length) testing.push(runtime);
    const tasks = run.taskRecords && !run.taskId ? run.taskRecords.filter((t) => !t.removed).map((t) => {
      const view = taskView(run, t.id); return [t.id, t.candidate, checkInputs(view, "开发评审").hash, run.card.flow.includes("测试") ? checkInputs(view, "测试").hash : null];
    }) : [];
    const acceptance = [identityFiles.filter(([k]) => k.startsWith("验收标准：") || k.startsWith("验收方法/")), acceptanceConfigs, run.acceptanceState?.grants,
      run.acceptanceState?.plan?.ids, run.batch?.version, run.batch?.targetSource, run.batch?.contributions, tasks, run.card.limits.验收?.timeoutMin ?? 20];
    identity = node === "开发评审" ? review : node === "测试" ? testing : node === "验收" ? [common, acceptance]
      // 前两步单任务完整指纹没有验收投影；保持字节级身份，不改写/重绑历史结论。
      : !run.taskRecords && !run.card.flow.includes("验收") ? [review, testing, run.card.flow, run.cardRevision ?? 0, run.cardHash]
      : [review, testing, acceptance, run.card.flow, run.cardRevision ?? 0, run.cardHash];
  }
  return { hash: digest(JSON.stringify(identity)), files, paths, observedFiles, publicationChanges, requirement };
}
export function freezeDeploymentPlan(repo: string): DeploymentPlan {
  const config = parseDeploymentConfig(readMarker(repo).deployment);
  if (!config.enabled || !config.cmd || !config.check) throw new Error("卡安排部署但 deployment 未启用或缺 cmd/check；请配置 .autoreview.json.deployment.enabled:true、cmd、check，或移除部署节点（未创建资源）");
  const holder = worktreeForBranch(repo, "dev");
  if (!holder) throw new Error("部署需要已检出的 dev 运行目录；请先准备 dev worktree，未创建本卡资源");
  return { config, cwd: realpathSync(holder.path), common: realpathSync(gitText(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"])) };
}
export function deploymentInputs(run: KernelRun) {
  const plan = run.deploymentPlan;
  if (!plan || !run.card.flow.includes("部署")) throw new Error("当前卡没有冻结部署授权");
  const actual = freezeDeploymentPlan(run.repo);
  if (JSON.stringify(actual) !== JSON.stringify(plan)) throw new Error("已冻结 deployment 配置或执行目录身份变化；未执行旧/新命令。发布前请受控改卡确认，发布后恢复冻结配置再只重跑部署");
  const attempt = run.deploymentAttempts?.at(-1);
  const rolledBack = attempt?.binding && ["applied", "recovered", "failed"].includes(attempt.rollback?.state ?? "") && gitText(plan.cwd, ["rev-parse", "HEAD"]) === attempt.rollback!.to;
  const files: Record<string, string> = {}, paths: Record<string, string> = {}, contents: Record<string, string> = {};
  const methods = parseMethodsConfig(readMarker(plan.cwd).methods, plan.cwd);
  for (const path of methods?.paths ?? []) sourceHashes(resolve(plan.cwd, path), files, `部署方法/${path}`, paths, contents);
  for (const p of run.localFiles.filter((p) => p !== ".autoreview.json")) sourceHashes(join(plan.cwd, p), files, `部署本机/${p}`, paths, contents);
  const observedFiles = { ...files };
  // 仅按 Git 证明归一化已登记反向 CAS 的方法文件变化；本机/忽略方法变化绝不借回退洗白。
  const publicationChanges = rolledBack ? publicationInputChanges({ ...run, publication: { ...run.publication!, local: "merged", commit: attempt!.rollback!.to, targetBefore: attempt!.rollback!.from,
    inputRoot: plan.cwd, inputSnapshot: { ...attempt!.binding!, requirement: "登记回退转换" } } }, files, paths) : [];
  const hash = digest(JSON.stringify([run.publication && { commit: run.publication.commit, tree: run.publication.tree }, plan, Object.entries(files).sort()]));
  return { hash, files, paths, observedFiles, publicationChanges, requirement: "按卡在发布之后部署；不包含开发检查" };
}
export function acceptanceSignature(run: KernelRun): string {
  const checked = checkInputs(run, "验收");
  return digest(JSON.stringify([run.acceptanceState?.hash, run.acceptanceState?.grants, run.userVersion,
    Object.entries(checked.files).filter(([k]) => !k.startsWith("卡：") && !k.startsWith("提示词/")), parseAcceptanceConfig(readMarker(run.worktree).acceptance, run.worktree, process.env)]));
}
export function taskAcceptanceInputs(run: KernelRun): string {
  return digest(JSON.stringify([checkInputs(run, "开发评审").hash, run.card.flow.includes("测试") ? checkInputs(run, "测试").hash : null]));
}
/** 排除任务自身补充要求的版本，冻结不可借普通任务输入改变的标准、授权和共享方法。 */
export function acceptanceBasis(run: KernelRun): string {
  const checked = checkInputs(run, "验收"), state = run.acceptanceState!;
  return digest(JSON.stringify([state.hash, state.criteria, state.owners, state.grants,
    Object.entries(checked.files).filter(([k]) => !k.startsWith("卡：") && !k.startsWith("提示词/") && !k.startsWith("提示词：") && !k.startsWith("用户检查输入/")),
    parseAcceptanceConfig(readMarker(run.worktree).acceptance, run.worktree, process.env)]));
}
/** 沿用结论仍须原实测证据及未变的责任任务输入；刷新派工签名不授予任何新通过结论。 */
export function reusedAcceptanceItems(run: KernelRun): AcceptanceItemResult[] {
  const state = run.acceptanceState!, plan = state.plan;
  if (!plan) throw new Error("没有内核冻结的验收范围");
  const active = new Set(run.card.tasks.map((t) => t.name)), denied = authorizationStatus(state.criteria, state.grants).denied;
  return state.criteria.items.filter((i) => (!state.owners[i.id] || active.has(state.owners[i.id])) && !forUser(i) && !denied.includes(i.id) && !plan.ids.includes(i.id)).map((item) => {
    const old = state.previous?.items.find((i) => i.id === item.id), binding = state.bindings?.[item.id];
    const task = run.taskRecords?.find((t) => t.name === state.owners[item.id]), view = task ? taskView(run, task.id) : run;
    if (!old || old.verdict !== "通过" || !old.source || !binding || binding.candidate !== view.candidate?.commit || binding.inputs !== taskAcceptanceInputs(view)
      || !existsSync(join(old.source.runDir, "result.json")) || !existsSync(join(old.source.runDir, "evidence", `${item.id}.txt`))) throw new Error(`${item.id} 旧通过项缺少未变任务来源/原实测证据；不能冒充本树实测`);
    return old;
  });
}
export function frozenCardProblem(run: KernelRun): string | undefined {
  try { if (digest(readFileSync(run.file)) === run.cardHash) return undefined; } catch { /* 明确报卡变化 */ }
  return "开发卡文件已直接修改；不会自动采用。请先保存当前内容、恢复 frozen-card.json 中原卡，再用「改卡 --from」受控提出变更或「续跑」";
}
export function managedConfig(cwd: string, independentDeployment = false) {
  const root = findProjectRoot(cwd);
  // v2 检查消费者不解析无关的部署块；部署由卡启动/自身边界严格校验。旧完整指纹完全保留。
  return resolveProjectConfig(root, { ...(independentDeployment ? { marker: { ...(root ? readMarker(root) : {}), deployment: undefined } } : {}),
    env: { ...process.env, AUTOREVIEW_SINGLE_NODE: "1", AUTOREVIEW_BATCH_FILE: "", AUTOREVIEW_STAGE: "" } });
}
export function localCopyPlan(repo: string, base: string): string[] {
  const { root, layout } = loadProjectLayout(repo);
  if (realpathSync(root) !== realpathSync(repo)) throw new Error("开发卡目前要求 .autoreview.json 在 Git 根目录；请从项目根启动");
  const locals = [...new Set([".autoreview.json", ...layout.localFiles])];
  for (const path of locals) {
    const absolute = resolve(repo, path);
    if (!inside(repo, absolute) || path === ".git" || path.startsWith(".git/")) throw new Error(`本机文件越界：${path}`);
    const parts = relative(repo, absolute).split("/");
    for (let i = 1; i <= parts.length; i++) {
      const item = join(repo, ...parts.slice(0, i));
      if (existsSync(item) && lstatSync(item).isSymbolicLink()) throw new Error(`本机文件路径含链接：${path}`);
      const entry = gitRaw(repo, ["ls-tree", "-z", base, "--", parts.slice(0, i).join("/")]);
      if (entry.startsWith("120000 ")) throw new Error(`开工树的本机文件父路径含链接：${path}`);
    }
    if (!existsSync(absolute) || !lstatSync(absolute).isFile()) throw new Error(`声明的本机文件不存在或不是普通文件：${path}`);
    if (gitResult(repo, ["cat-file", "-e", `${base}:${path}`]).status === 0) throw new Error(`本机文件在开工树已跟踪，拒绝覆盖或夹带：${path}`);
  }
  return locals;
}
export function assertWorkspace(run: KernelRun): void {
  if (!run.workspaceCreated || !existsSync(run.worktree) || realpathSync(run.worktree) !== resolve(run.worktree)) throw new Error("任务工作区归属未确认");
  const actual = worktrees(run.repo).find((w) => resolve(w.path) === run.worktree);
  if ((run.card.nature === "评审" ? !actual?.detached : actual?.branch !== run.branch) || gitText(run.worktree, ["branch", "--show-current"]) !== run.branch
    || realpathSync(gitText(run.worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"])) !== run.common) throw new Error("任务工作区、分支或仓库身份变化");
  const hidden = nul(gitRaw(run.worktree, ["ls-files", "-v", "-z"])).filter((line) => !line.startsWith("H "));
  if (hidden.length) throw new Error(`索引含 assume-unchanged、skip-worktree 或未解决状态，不能隐藏候选改动：${hidden.join("、")}`);
}
export function createWorkspace(run: KernelRun): void {
  if (existsSync(run.worktree)) throw new Error("隐藏路径已存在，未认领或覆盖");
  if (existsSync(dirname(run.worktree))) throw new Error("隐藏任务父目录已存在，未认领或覆盖");
  mkdirSync(dirname(run.worktree), { recursive: true, mode: 0o700 }); run.workspaceParentCreated = true;
  gitText(run.repo, ["-c", "core.hooksPath=/dev/null", "worktree", "add", ...(run.card.nature === "评审" ? ["--detach"] : ["-b", run.branch]), run.worktree, run.card.nature === "评审" ? run.reviewComparison!.head.commit : run.base]);
  for (const path of run.localFiles) {
    const source = resolve(run.repo, path), target = resolve(run.worktree, path);
    // worktree 中的路径也不能沿基础树的符号链接逃逸。
    let parent = dirname(target);
    while (parent !== run.worktree) {
      if (existsSync(parent) && lstatSync(parent).isSymbolicLink()) throw new Error(`任务本机路径含链接：${path}`);
      parent = dirname(parent);
    }
    if (existsSync(target)) throw new Error(`任务本机文件已存在，未覆盖：${path}`);
    mkdirSync(dirname(target), { recursive: true }); cpSync(source, target, { errorOnExist: true, force: false });
  }
}
const local = (run: KernelRun, p: string): boolean => run.localFiles.some((l) => p === l || p.startsWith(`${l}/`));
export function dirtyPaths(run: KernelRun): string[] {
  const root = run.worktree;
  return [...new Set([...nul(gitRaw(root, ["diff", "--name-only", "--no-renames", "-z", "HEAD", "--"])),
    ...nul(gitRaw(root, ["diff", "--cached", "--name-only", "--no-renames", "-z", "HEAD", "--"])),
    ...nul(gitRaw(root, ["ls-files", "--others", "--exclude-standard", "-z"]))])].filter((p) => !local(run, p));
}
/** 包括索引和原始字节；HEAD 相同或 clean filter 归一化相同不足以证明工作区没变。 */
export function workspaceGuard(run: KernelRun, headIdentity?: string, includeIgnored = true): string {
  assertWorkspace(run);
  const paths = [...new Set([...nul(gitRaw(run.worktree, ["ls-files", "--cached", "--others", ...(includeIgnored ? [] : ["--exclude-standard"]), "-z"])), ...(!includeIgnored ? run.localFiles : [])])].sort();
  const directories = new Set<string>([run.worktree]);
  const metadata = (path: string): string => { const s = lstatSync(path, { bigint: true }); return `${s.ino}:${s.mode}:${s.mtimeNs}:${s.ctimeNs}`; };
  const files = paths.map((p) => {
    let parent = dirname(join(run.worktree, p)); while (inside(run.worktree, parent)) { directories.add(parent); if (parent === run.worktree) break; parent = dirname(parent); }
    const path = join(run.worktree, p); return [p, existsSync(path) ? [fileDigest(path), metadata(path)] : "缺失"];
  });
  const dirs = [...directories].sort().map((p) => [p, existsSync(p) ? metadata(p) : "缺失"]);
  // ctime/inode 不能靠把字节写回或 utimes 还原；同时覆盖瞬时写入和创建后删除，避免只靠异步 FS 通知漏检。
  return digest(JSON.stringify([headIdentity ?? gitText(run.worktree, ["rev-parse", "HEAD"]), gitRaw(run.worktree, ["ls-files", "--stage", "-z"]), files, includeIgnored ? dirs : []]));
}
const ancestor = (repo: string, a: string, b: string): boolean => gitResult(repo, ["merge-base", "--is-ancestor", a, b]).status === 0;
const treeEntry = (repo: string, commit: string, path: string): string => gitRaw(repo, ["--literal-pathspecs", "ls-tree", "-z", commit, "--", path]);
/** 受控增补的是文件，不因把它换成目录就获得该目录下的新路径。 */
function outsideTaskScope(run: KernelRun, files: string[]): string[] {
  const task = taskDefinition(run), additions = (run.changes ?? []).filter((c) => c.state === "applied" && c.scopeAddition?.task === task.name).map((c) => c.scopeAddition!.file);
  const original = { ...task.scope, allow: task.scope.allow?.filter((p) => !additions.includes(p)) };
  return [...new Set([...outOfScope(files, task.scope), ...files.filter((p) => additions.some((file) => p.startsWith(`${file}/`)) && !inScope(p, original))])];
}
/** 范围不扩张：已登记候选的原样文件可沿用；新增范围外内容必须能证明来自 dev 的合并父提交。 */
export function taskScopeBaseline(run: KernelRun, head: string): { target: string; base: string; imported: string[] } {
  const target = gitText(run.repo, ["rev-parse", "refs/heads/dev"]);
  const files = nul(gitRaw(run.worktree, ["diff", "--name-only", "--no-renames", "-z", run.base, head, "--"]));
  const outside = outsideTaskScope(run, files);
  const fresh = outside.filter((p) => !run.candidate || treeEntry(run.repo, head, p) !== treeEntry(run.repo, run.candidate.commit, p));
  if (!fresh.length) return { target, base: run.base, imported: outside };
  const reject = (paths: string[]): never => { throw new Error(`任务范围外变更，未自动提交（不是已核对 dev 来源）：${paths.join("、")}`); };
  if (!ancestor(run.repo, run.targetAtStart, target) || !ancestor(run.repo, run.base, head)) reject(fresh);
  const sources = [target, ...(run.batch?.integrations ?? []).flatMap((i) => [i.after.commit, ...i.mapping.flatMap((c) => [c.candidate.commit, c.contribution])])].filter((s) => ancestor(run.repo, s, head));
  const base = gitText(run.repo, ["merge-base", head, target]);
  const invalid = fresh.filter((p) => treeEntry(run.repo, head, p) !== treeEntry(run.repo, base, p) && !sources.some((s) => treeEntry(run.repo, head, p) === treeEntry(run.repo, s, p)));
  if (invalid.length) reject(invalid);
  const start = run.candidate && ancestor(run.repo, run.candidate.commit, head) ? run.candidate.commit : run.base;
  const commits = gitText(run.repo, ["rev-list", "--first-parent", "--reverse", `${start}..${head}`]).split("\n").filter(Boolean);
  for (const commit of commits) {
    if (ancestor(run.repo, commit, target) || sources.some((s) => ancestor(run.repo, commit, s))) continue;
    const parents = gitText(run.repo, ["rev-list", "--parents", "-n", "1", commit]).split(" ").slice(1);
    const touched = nul(gitRaw(run.repo, ["diff", "--name-only", "--no-renames", "-z", parents[0], commit, "--"])).filter((p) => fresh.includes(p));
    const incoming = parents.slice(1).filter((p) => ancestor(run.repo, p, target) || sources.some((s) => ancestor(run.repo, p, s)));
    const unauthorized = touched.filter((p) => !incoming.some((parent) => treeEntry(run.repo, commit, p) === treeEntry(run.repo, parent, p)));
    if (unauthorized.length) reject(unauthorized);
  }
  return { target, base, imported: outside };
}
/** 仅内核登记的工作区可自动提交；索引预先有内容不猜测归属。 */
export function deliverCandidate(run: KernelRun): Candidate {
  assertWorkspace(run);
  const target = gitText(run.worktree, ["rev-parse", "--path-format=absolute", "--git-path", "index"]), lock = `${target}.lock`;
  const fd = openSync(lock, "wx", 0o600), state = { published: false };
  try {
    const candidate = deliverWithIndex(run, fd, lock, target, state);
    run.delivery = { candidate, inputs: checkInputs(run, "开发评审").hash, userVersion: run.userVersion, at: new Date().toISOString() };
    return candidate;
  }
  finally { closeSync(fd); if (!state.published) rmSync(lock); }
}
function deliverWithIndex(run: KernelRun, fd: number, lock: string, target: string, state: { published: boolean }): Candidate {
  const head = gitText(run.worktree, ["rev-parse", "HEAD"]);
  const branchFiles = nul(gitRaw(run.worktree, ["diff", "--name-only", "--no-renames", "-z", run.base, head, "--"]));
  const imported = new Set(taskScopeBaseline(run, head).imported);
  const changed = dirtyPaths(run);
  const outside = outsideTaskScope(run, [...new Set([...branchFiles.filter((p) => !imported.has(p)), ...changed])]);
  if (outside.length) throw new Error(`任务范围外变更，未自动提交：${outside.join("、")}`);
  if (branchFiles.some((p) => local(run, p))) throw new Error("任务历史夹带本机文件，未交付");
  if (gitText(run.worktree, ["diff", "--cached", "--name-only", "-z"])) throw new Error("索引有未经登记的用户暂存改动，未自动提交；请保留成果并取消暂存后在原会话重新交付");
  if (!changed.length) return { commit: head, tree: gitText(run.worktree, ["rev-parse", "HEAD^{tree}"]) };
  const before = workspaceGuard(run), index = join(run.dir, `index-${randomUUID()}`);
  const runGit = (args: string[]): string => {
    const r = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: run.worktree, env: { ...process.env, GIT_INDEX_FILE: index }, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 120_000 });
    if (r.status !== 0) throw new Error(`程序提交失败：${r.stderr || r.stdout || r.error}`);
    return r.stdout.trim();
  };
  try {
    runGit(["read-tree", head]);
    runGit(["--literal-pathspecs", "add", "-A", "--", ...changed]);
    const tree = runGit(["write-tree"]);
    if (before !== workspaceGuard(run)) throw new Error("提交期间工作区或索引变化，未更新分支");
    if (tree === gitText(run.worktree, ["rev-parse", `${head}^{tree}`])) return { commit: head, tree };
    const commit = runGit(["commit-tree", tree, "-p", head, "-m", `chore: ${run.card.name}\n\n任务：${taskDefinition(run).name}\n程序交付提交`]);
    if (before !== workspaceGuard(run)) throw new Error("程序提交落盘前候选又变化，未更新分支");
    gitText(run.worktree, ["update-ref", `refs/heads/${run.branch}`, commit, head]);
    // 持有 Git 原生索引锁，不覆盖并发 git add；只原子安装已核对的私有索引，不改文件。
    writeFileSync(fd, readFileSync(index)); fsyncSync(fd); renameSync(lock, target); state.published = true;
    if (dirtyPaths(run).length) throw new Error("提交后又出现改动，候选已保存但需原会话重新交付");
    return { commit, tree };
  } finally { rmSync(index, { force: true }); rmSync(`${index}.lock`, { force: true }); }
}

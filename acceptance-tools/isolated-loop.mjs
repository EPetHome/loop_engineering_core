#!/usr/bin/env node
/** Controlled acceptance runner, not an OS sandbox. Never change the caller's environment. */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
const help = `用法：node acceptance-tools/isolated-loop.mjs --target DIR --evidence-dir DIR --label A1 [--write-path PATH]... [--timeout-sec N] -- COMMAND ARGS...
  --target        只读候选 Loop 根；子命令通过 LOOP_CANDIDATE_ROOT 读取它
  --evidence-dir  已存在的外层证据目录；只新建本轮唯一子目录，不覆盖旧材料
  --label         条目编号或短名称（字母、数字、下划线、连字符，最多 41 字符）
  --write-path    声明额外写入目标；相对新私有根解析，实际越界或悬空链接在派发前拒绝
  --timeout-sec   命令时限，1 至 3600 秒，默认 180；另有有界收尾时间
  --help          仅打印帮助，不创建环境、不启动进程
子命令 cwd 是新私有根；仅子进程取得私有 HOME、状态、Pi、PA 和临时环境。
成功且确认释放才删除根；失败保留现场。最后输出 ISOLATION_REPORT=<绝对 JSON 路径>。
这是受控样本方法，不是抵御任意恶意绝对路径写入的安全沙箱。
`;
const within = (root, path) => {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};
function json(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { throw new Error(`无法读取 JSON ${path}：${error.message}`); }
}
const save = (path, value, exclusive = false) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: exclusive ? 'wx' : 'w' });
const signalCode = (signal) => ({ SIGINT: 130, SIGTERM: 143, SIGHUP: 129, SIGKILL: 137 })[signal] ?? 1;

/** Resolve components in physical order: a symlink followed by '..' is not lexical '..'. */
export function checkedWritePath(root, declared) {
  let path = isAbsolute(declared) ? parse(declared).root : root;
  try {
    for (const part of declared.split(sep).filter(Boolean)) {
      if (part === '.') continue;
      path = part === '..' ? dirname(path) : join(path, part);
      let stat;
      try { stat = lstatSync(path); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (stat) path = realpathSync(path); // A dangling symlink is not proven private.
    }
  } catch (error) { throw new Error(`无法核对写入路径 ${JSON.stringify(declared)}（${path}）：${error.message}`); }
  if (!within(root, path)) throw new Error(`拒绝越界写入路径 ${JSON.stringify(declared)} → ${path}；允许根：${root}`);
  return { declared, resolved: path };
}

function argumentsOf(argv) {
  const cut = argv.indexOf('--');
  if (cut < 0 || !argv[cut + 1]) throw new Error('缺少 -- COMMAND；使用 --help 查看参数');
  const options = { writePaths: [], command: argv.slice(cut + 1) };
  const names = new Map([['--target', 'target'], ['--evidence-dir', 'evidence'], ['--label', 'label'], ['--timeout-sec', 'seconds']]);
  for (let i = 0; i < cut; i += 2) {
    const flag = argv[i], value = argv[i + 1];
    if (i + 1 >= cut || !value || value.startsWith('--')) throw new Error(`参数缺少值：${flag}`);
    if (flag === '--write-path') { options.writePaths.push(value); continue; }
    const key = names.get(flag);
    if (!key || options[key] !== undefined) throw new Error(`未知或重复参数：${flag}`);
    options[key] = value;
  }
  if (!options.target || !options.evidence || !options.label) throw new Error('必须提供 --target、--evidence-dir、--label');
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,40}$/.test(options.label)) throw new Error('label 必须是字母开头的受控短名称');
  options.seconds = Number(options.seconds ?? 180);
  if (!Number.isFinite(options.seconds) || options.seconds < 1 || options.seconds > 3600) throw new Error('timeout-sec 必须是 1 至 3600 秒');
  return options;
}

function privateEnvironment(root, target, id, paths) {
  // Allowlist, not a credential-name denylist. No outer AUTOREVIEW/PI/host/session identity survives.
  return {
    PATH: `${dirname(process.execPath)}:${process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'}`,
    LANG: process.env.LANG || 'en_US.UTF-8', LC_ALL: 'C', TZ: process.env.TZ || 'UTC',
    HOME: paths.home, TMPDIR: paths.temp, TMP: paths.temp, TEMP: paths.temp,
    AUTOREVIEW_MERGE_QUEUE_ROOT: paths.queues, AUTOREVIEW_RESOURCE_ROOT: paths.resources,
    AUTOREVIEW_PROJECTS_ROOT: paths.projects, AUTOREVIEW_MERGE_QUEUE_LAUNCHER: 'background',
    PI_CODING_AGENT_DIR: paths.agent, CODEX_HOME: paths.codex, CLAUDE_CONFIG_DIR: paths.claude,
    XDG_CACHE_HOME: paths.cache, XDG_CONFIG_HOME: paths.config, XDG_DATA_HOME: paths.data, XDG_STATE_HOME: paths.state,
    LOOP_PA_CONFIG: paths.paConfig, LOOP_ISOLATION_ROOT: root, LOOP_ISOLATION_ID: id, LOOP_CANDIDATE_ROOT: target,
    GIT_CONFIG_GLOBAL: paths.gitConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0',
    NODE_DISABLE_COMPILE_CACHE: '1', npm_config_cache: join(paths.cache, 'npm'), NPM_CONFIG_USERCONFIG: paths.npmConfig,
  };
}

async function main(argv) {
  const cut = argv.indexOf('--');
  if (argv.slice(0, cut < 0 ? argv.length : cut).includes('--help')) { process.stdout.write(help); return; }
  const options = argumentsOf(argv);
  const target = realpathSync(options.target), evidence = realpathSync(options.evidence), parent = realpathSync(tmpdir());
  for (const path of [target, evidence, parent]) if (!lstatSync(path).isDirectory()) throw new Error(`不是目录：${path}`);
  if (within(target, evidence) || within(target, parent)) throw new Error('候选根只读：证据目录与临时父目录不得位于候选根内');
  const runDir = mkdtempSync(join(evidence, `${options.label}-isolation-`));
  const reportPath = join(runDir, 'report.json');
  const report = {
    id: randomUUID(), label: options.label, target, root: null, paths: {}, command: options.command,
    timeoutSec: options.seconds, commandStarted: false, commandExitCode: null,
    processesReleased: true, rootReleased: false,
    stdoutLog: join(runDir, 'stdout.log'), stderrLog: join(runDir, 'stderr.log'),
    ownership: join(runDir, 'ownership.json'), startedAt: new Date().toISOString(),
    toolSha256: createHash('sha256').update(readFileSync(self)).digest('hex'),
  };
  let code = 75, rootStat, child, cancellation, watchdog, force;
  const fds = [];
  const stop = (signal) => {
    cancellation ??= signal;
    if (child && child.exitCode === null && child.signalCode === null) child.kill(signal);
  };
  const handlers = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => [signal, () => stop(signal)]);
  for (const [signal, handler] of handlers) process.on(signal, handler);
  const removeRoot = () => {
    const current = lstatSync(report.root);
    if (current.isSymbolicLink() || current.dev !== rootStat.dev || current.ino !== rootStat.ino
      || realpathSync(report.root) !== report.root || json(join(report.root, '.loop-isolation.json')).id !== report.id) {
      throw new Error('私有根身份发生变化，未删除');
    }
    rmSync(report.root, { recursive: true });
    report.rootReleased = !existsSync(report.root);
  };
  try {
    for (const path of [report.stdoutLog, report.stderrLog]) fds.push(openSync(path, 'wx', 0o600));
    report.root = realpathSync(mkdtempSync(join(parent, 'loop-isolated-')));
    rootStat = lstatSync(report.root);
    save(join(report.root, '.loop-isolation.json'), { id: report.id, root: report.root, parentPid: process.pid }, true);
    report.paths = Object.fromEntries(['home', 'queues', 'resources', 'projects', 'agent', 'paEvents', 'temp', 'codex', 'claude', 'cache', 'config', 'data', 'state'].map((key) => [key, join(report.root, key)]));
    for (const path of Object.values(report.paths)) mkdirSync(path, { mode: 0o700 });
    Object.assign(report.paths, { paConfig: join(report.root, 'pa.json'), gitConfig: join(report.root, 'gitconfig'), npmConfig: join(report.root, 'npmrc') });
    save(report.paths.paConfig, { pa: { eventsDir: report.paths.paEvents, localNotify: false } }, true);
    for (const path of [report.paths.gitConfig, report.paths.npmConfig]) writeFileSync(path, '', { mode: 0o600, flag: 'wx' });
    const env = privateEnvironment(report.root, target, report.id, report.paths);
    save(report.ownership, { ...report, rootIdentity: { dev: rootStat.dev, ino: rootStat.ino }, env, phase: 'before-dispatch' }, true);
    // Check all declarations before even the private worker is spawned.
    report.writePaths = options.writePaths.map((path) => checkedWritePath(report.root, path));
    const spec = { ...report, runDir, env, seconds: options.seconds };
    const input = join(runDir, 'input.json'); save(input, spec, true);
    if (cancellation) throw new Error(`派发前收到取消：${cancellation}`);
    report.processesReleased = false; // A worker without a receipt can never imply release.
    child = spawn(process.execPath, [self, '--worker', input], {
      cwd: report.root, env, stdio: ['ignore', 'pipe', 'pipe', fds[0], fds[1]],
    });
    child.stdout.on('data', (chunk) => process.stdout.write(chunk));
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    const ended = new Promise((accept, reject) => {
      child.once('error', reject); child.once('close', (status, signal) => accept({ status, signal }));
    });
    // The worker owns normal timeout/cleanup. This guard never claims to have reaped its descendants.
    watchdog = setTimeout(() => stop('SIGTERM'), options.seconds * 1000 + 20_000);
    force = setTimeout(() => child.exitCode === null && child.signalCode === null && child.kill('SIGKILL'), options.seconds * 1000 + 25_000);
    const status = await ended;
    const result = json(join(runDir, 'worker-result.json'));
    if (result.id !== report.id) throw new Error('工作进程收尾回执身份不匹配');
    Object.assign(report, result);
    code = result.exitCode;
    if (status.signal || status.status !== result.exitCode) {
      report.processesReleased = false; throw new Error(`工作进程退出与回执不一致：${JSON.stringify(status)}`);
    }
    if (cancellation) { code = signalCode(cancellation); report.reason = `收到取消 ${cancellation}；${report.reason || '命令已结束'}`; }
    // Save the actual command result, logs and ownership BEFORE deleting any private directories.
    save(join(runDir, 'before-root-cleanup.json'), report, true);
    if (code === 0 && report.processesReleased && report.resourceStatus === 'released') removeRoot();
    else report.reason ||= '命令失败或资源释放未确认，保留本轮私有根';
  } catch (error) {
    report.reason = `${report.reason ? `${report.reason}；` : ''}${cancellation ? `收到取消 ${cancellation}；` : ''}${error.message}`;
    code = cancellation ? signalCode(cancellation) : 75;
    // A rejected declaration has no consumers; it is safe to release this never-dispatched root.
    if (report.root && report.processesReleased && !child) {
      try { removeRoot(); } catch (cleanupError) { report.reason += `；${cleanupError.message}`; }
    }
  } finally {
    clearTimeout(watchdog); clearTimeout(force);
    for (const [signal, handler] of handlers) process.off(signal, handler);
    for (const fd of fds) { fsyncSync(fd); closeSync(fd); }
  }
  if (!report.rootReleased && !report.reason) report.reason = '本轮现场保留，释放未确认';
  if (code === 0 && (!report.processesReleased || !report.rootReleased)) code = 75;
  report.exitCode = code; report.finishedAt = new Date().toISOString();
  save(reportPath, report, true);
  if (report.reason) process.stderr.write(`${report.reason}\n`);
  process.stdout.write(`\nISOLATION_REPORT=${reportPath}\n`);
  process.exitCode = code;
}

/** Runs only after the child-only environment is installed, including resourceRoot()/homedir(). */
async function worker(input) {
  const spec = json(input), { root, id, runDir } = spec;
  if (process.env.LOOP_ISOLATION_ID !== id || process.env.LOOP_ISOLATION_ROOT !== root
    || realpathSync(process.cwd()) !== root || json(join(root, '.loop-isolation.json')).id !== id) throw new Error('私有工作进程身份不匹配');
  const { createRunResource, releaseRunResource } = await import('../resources.ts');
  const { registerProc, readProcs, releaseProc, signalOwnedProcessGroup } = await import('../procs.ts');
  const procs = join(runDir, 'procs.json'), consumers = join(runDir, 'consumers.json');
  const observed = new Map();
  const errors = [];
  let resource, child, entry, timer, monitor, cause, actual = { code: null, signal: null }, released = false;
  let commandStarted = false;
  let wakeStop;
  const stopped = new Promise((done) => { wakeStop = done; });
  const hasEnv = (command, key, value) => command.includes(` ${key}=${value} `) || command.endsWith(` ${key}=${value}`);
  const scoped = (item) => hasEnv(item.command, 'LOOP_ISOLATION_ROOT', root);
  const table = (pid) => {
    const result = spawnSync('ps', ['eww', ...(pid ? ['-p', String(pid)] : ['-A']), '-o', 'pid=,pgid=,stat=,lstart=,command='], {
      encoding: 'utf8', timeout: 2000, maxBuffer: 32 * 1024 * 1024,
    });
    if (pid && result.status === 1 && !result.stdout?.trim()) {
      try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return []; }
    }
    if (result.status !== 0) throw new Error(`无法核对进程表：${result.error?.message || result.stderr || result.status}`);
    return result.stdout.split('\n').filter((line) => line.trim()).map((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.*)$/.exec(line);
      if (!match) throw new Error('进程表格式无法核对，不能宣称已释放');
      return { pid: Number(match[1]), pgid: Number(match[2]), stat: match[3], started: match[4].replace(/\s+/g, ' '), command: match[5] };
    }).filter((item) => item.pid !== process.pid && item.pid !== result.pid && !item.stat.startsWith('Z'));
  };
  const identity = (item) => ({ pid: item.pid, pgid: item.pgid, started: item.started,
    owner: /(?:^|\s)AUTOREVIEW_PROCESS_OWNER=([^\s]+)/.exec(item.command)?.[1] ?? null, root });
  const capture = () => {
    const items = table().filter(scoped);
    for (const item of items) observed.set(`${item.pid}:${item.started}`, identity(item));
    return items;
  };
  const journal = (phase) => save(spec.ownership, { id, root, paths: spec.paths, env: spec.env, command: spec.command,
    workerPid: process.pid, phase, cause, actual, resource, main: entry, consumers: [...observed.values()], errors });
  const checkpoint = (phase) => { capture(); fsyncSync(3); fsyncSync(4); journal(phase); };
  const requestStop = (kind, signal) => {
    if (cause) return;
    cause = { kind, signal };
    try { checkpoint('before-cancel'); } catch (error) { errors.push(error.message); }
    if (entry) signalOwnedProcessGroup({ pid: entry.pgid, processStarted: entry.started, token: entry.token }, signal);
    wakeStop();
  };
  const handlers = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => [signal, () => requestStop('cancel', signal)]);
  for (const [signal, handler] of handlers) process.on(signal, handler);
  const writeAll = (fd, chunk) => { for (let offset = 0; offset < chunk.length;) offset += writeSync(fd, chunk, offset, chunk.length - offset); };
  const cleanupConsumers = async () => {
    try {
      checkpoint('before-process-cleanup');
      save(join(runDir, 'before-process-cleanup.json'), json(spec.ownership), true);
      // The executor's original entry retains its random token even if its registry was removed.
      let mainReleased = !entry || releaseProc(procs, entry.pgid, entry);
      // New owners/detached groups are found by the unique private root, not by name, age or PID.
      // First give each still-matching consumer its normal termination handler.
      for (const item of capture()) {
        const current = table(item.pid)[0];
        if (current?.started === item.started && scoped(current)) {
          try { process.kill(item.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
        }
      }
      await sleep(100);
      const deadline = Date.now() + 5000;
      let empty = 0;
      while (Date.now() < deadline && empty < 2) {
        const remaining = capture(); journal('process-cleanup');
        empty = remaining.length === 0 ? empty + 1 : 0;
        for (const item of remaining) {
          const current = table(item.pid)[0];
          if (!current || current.started !== item.started) continue;
          if (!scoped(current)) throw new Error(`消费者身份已变化，保留现场：${item.pid}`);
          if (current.pgid === current.pid) {
            // Reuse executor release for an independently proven group. Do not scan its arbitrary owner globally.
            registerProc(consumers, current.pid, '隔离独立消费者', 'private-root consumer', undefined, resource?.id);
            const saved = readProcs(consumers).find((value) => value.pgid === current.pid);
            if (!saved?.started || saved.started.replace(/\s+/g, ' ') !== current.started) {
              if (table(current.pid).some((value) => value.started === current.started)) throw new Error('独立消费者登记身份无法核对');
            } else if (!releaseProc(consumers, current.pid, saved)) throw new Error('独立消费者进程组释放未确认');
          } else {
            // Never signal a shared/outer group; only this revalidated individual process.
            try { process.kill(current.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
          }
        }
        await sleep(50);
      }
      if (entry && !mainReleased) mainReleased = releaseProc(procs, entry.pgid, entry);
      const knownGone = [...observed.values()].every((item) => !table(item.pid).some((value) => value.started === item.started));
      released = mainReleased && empty === 2 && knownGone;
      if (!released) errors.push('消费者释放未确认，保留本轮登记与现场');
    } catch (error) { errors.push(error.message); released = false; }
  };
  try {
    resource = createRunResource(`隔离验收 ${spec.label}`, undefined, procs);
    const token = randomUUID();
    const env = { ...process.env, AUTOREVIEW_PROCESS_OWNER: token, AUTOREVIEW_RUN_ID: resource.id,
      AUTOREVIEW_TEMP_DIR: resource.dir, AUTOREVIEW_EVIDENCE_DIR: resource.evidenceDir, AUTOREVIEW_RUN_DIR: resource.evidenceDir };
    journal('before-command');
    if (cause) throw new Error('命令派发前取消');
    child = spawn(spec.command[0], spec.command.slice(1), { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    timer = setTimeout(() => requestStop('timeout', 'SIGTERM'), spec.seconds * 1000);
    const exited = new Promise((done) => {
      child.once('error', (error) => {
        let code = 1;
        if (error.code === 'ENOENT') code = 127;
        else if (error.code === 'EACCES') code = 126;
        actual = { code, signal: null, error: error.message }; done();
      });
      child.once('exit', (code, signal) => { actual = { code, signal }; done(); });
    });
    const closed = new Promise((done) => child.once('close', done));
    child.stdout.on('data', (chunk) => { writeAll(3, chunk); process.stdout.write(chunk); });
    child.stderr.on('data', (chunk) => { writeAll(4, chunk); process.stderr.write(chunk); });
    if (child.pid) {
      commandStarted = true;
      registerProc(procs, child.pid, '隔离内层命令', spec.command[0], token, resource.id);
      entry = readProcs(procs).find((item) => item.pgid === child.pid);
      if (!entry) throw new Error('主命令进程登记未确认');
    }
    checkpoint('command-running');
    monitor = setInterval(() => { try { capture(); journal('command-running'); } catch (error) { errors.push(error.message); } }, 250);
    await Promise.race([exited, stopped]);
    if (cause) await Promise.race([exited, sleep(500)]);
    // Do not wait indefinitely for close: a detached consumer can hold the original pipes.
    await Promise.race([closed, sleep(100)]);
  } catch (error) { errors.push(error.message); }
  finally {
    clearTimeout(timer); clearInterval(monitor);
    await cleanupConsumers();
    // Drain final output after release, then detach local handles if a consumer could not be released.
    await sleep(50);
    child?.stdout?.destroy(); child?.stderr?.destroy(); child?.unref();
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
  let commandCode = actual.code;
  if (actual.signal) commandCode = signalCode(actual.signal);
  if (cause) commandCode = cause.kind === 'timeout' ? 124 : signalCode(cause.signal);
  let code = commandCode ?? 75;
  if (errors.length && code === 0) code = 75;
  if (resource) {
    journal('before-resource-cleanup');
    try { releaseRunResource(resource, code !== 0 || !released); }
    catch (error) { errors.push(error.message); }
    if (resource.status === 'cleanup-failed') errors.push(resource.detail || '资源目录释放未确认');
  }
  if ((!released || errors.length) && code === 0) code = 75;
  const reasons = [...errors];
  if (cause?.kind === 'timeout') reasons.unshift(`命令超时（${spec.seconds} 秒）`);
  else if (cause) reasons.unshift(`收到取消 ${cause.signal}`);
  else if (actual.error) reasons.unshift(actual.error);
  else if (code) reasons.unshift(`命令退出：${actual.code ?? actual.signal ?? '未启动'}`);
  if (code !== 0) reasons.push('保留本轮私有根供核对');
  journal('finished');
  const git = spawnSync('git', ['-C', spec.target, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 2000 });
  const result = { id, commandStarted, commandExitCode: commandCode,
    commandOutcome: actual, processesReleased: released, resourceStatus: resource?.status ?? 'not-created',
    candidateRevision: git.status === 0 ? git.stdout.trim() : null, exitCode: code };
  if (reasons.length) result.reason = reasons.join('；');
  save(join(runDir, 'worker-result.json'), result, true);
  process.exitCode = code;
}

if (process.argv[1] && resolve(process.argv[1]) === self) {
  const argv = process.argv.slice(2);
  (argv[0] === '--worker' ? worker(argv[1]) : main(argv)).catch((error) => {
    process.stderr.write(`${error.stack || error}\n`); process.exitCode = 75;
  });
}

/* Node rebuild witness: no replay/install/global configuration. Only a fully observed command tree can promote an old file. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), url = require('node:url'), mod = require('node:module'), crypto = require('node:crypto');
function words(command) {
  const result = []; let word = '', quote = '', started = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote === "'") { if (c === "'") quote = ''; else word += c; continue; }
    if (c === '\\') { if (++i >= command.length || /[\r\n]/.test(command[i])) return; word += command[i]; started = true; continue; }
    if (quote === '"') { if (c === '"') quote = ''; else { if (c === '$' || c === '`') return; word += c; } continue; }
    if (c === "'" || c === '"') { quote = c; started = true; continue; }
    if (/[;&|<>()$`*?~\r\n]/.test(c)) return;
    if (/\s/.test(c)) { if (started) result.push(word); word = ''; started = false; } else { word += c; started = true; }
  }
  if (quote) return; if (started) result.push(word); return result;
}
function executable(file, cwd, env) {
  try {
    const p = path.isAbsolute(file) || /[/\\]/.test(file) ? path.resolve(cwd, file) : (env.PATH || '').split(path.delimiter).map(d => path.join(d, file)).find(p => fs.existsSync(p));
    return p ? fs.realpathSync(p) : undefined;
  } catch { return; }
}
function entry(file, args, cwd, env, node, shell = false) {
  if (env.ENV || env.BASH_ENV || Object.keys(env).some(k => k.startsWith('BASH_FUNC_'))) return;
  const resolved = executable(file, cwd, env); if (!resolved) return;
  const blocked = args.some(w => /^(?:-r|--(?:require|import|loader|experimental-loader|permission|experimental-permission|inspect(?:-brk)?|watch|build-snapshot|snapshot-blob))(?:=|$)/.test(w));
  if (resolved === node) return blocked ? undefined : { kind: 'node', file: resolved };
  if (shell && fs.existsSync('/bin/sh') && resolved === fs.realpathSync('/bin/sh')) {
    if (args.length !== 2 || args[0] !== '-c') return;
    const parsed = words(args[1]); if (!parsed?.length) return;
    const child = entry(parsed[0], parsed.slice(1), cwd, env, node);
    return child ? { kind: 'node-shell', file: resolved } : undefined;
  }
  try {
    const header = fs.readFileSync(resolved, 'utf8').split(/\r?\n/, 1)[0];
    if (header === '#!/usr/bin/env node' && executable('node', cwd, env) === node) return { kind: 'node-script', file: resolved };
    if (header.startsWith('#!') && header.slice(2).trim() === node) return { kind: 'node-script', file: resolved };
  } catch { /* Not a verified Node entry. */ }
}
module.exports.plan = (command, cwd, env, node) => { const parsed = words(command); return parsed?.length ? entry(parsed[0], parsed.slice(1), cwd, env, fs.realpathSync(node)) : undefined; };

const manifestPath = process.env.LOOP_NODE_OUTPUT_MANIFEST, secret = process.env.LOOP_NODE_OUTPUT_KEY, fd = Number(process.env.LOOP_NODE_OUTPUT_FD);
const actor = process.env.LOOP_NODE_OUTPUT_ACTOR, parent = process.env.LOOP_NODE_OUTPUT_PARENT || '';
for (const name of ['KEY', 'MANIFEST', 'FD', 'ACTOR', 'PARENT']) delete process.env[`LOOP_NODE_OUTPUT_${name}`];
if (manifestPath && secret && actor && Number.isSafeInteger(fd) && fd >= 3) {
  try {
    const config = JSON.parse(fs.readFileSync(manifestPath, 'utf8')), key = Buffer.from(secret, 'base64');
    const write = fs.writeSync, realpath = fs.realpathSync, close = fs.closeSync, hmac = crypto.createHmac, uuid = crypto.randomUUID, pid = process.pid;
    const cwd = process.cwd.bind(process), apply = Reflect.apply;
    const candidates = new Map(config.eligible.map(p => [path.resolve(config.cwd, p), p])), descriptors = new Map();
    let sequence = 0, previous = '', failed = false;
    function emit(type, extra = {}) {
      if (failed) return;
      try {
        const payload = JSON.stringify({ nonce: config.nonce, actor, parent, pid, seq: ++sequence, type, ...extra });
        previous = hmac('sha256', key).update(previous).update(payload).digest('hex');
        const encoded = Buffer.from(payload).toString('base64'), count = Math.ceil(encoded.length / 256);
        // Each pipe write is below POSIX PIPE_BUF; fragmented events are reassembled by actor/sequence.
        for (let part = 0; part < count; part++) write(fd, `LOOP_NODE_OUTPUT_V2 ${actor} ${sequence} ${part + 1}/${count} ${encoded.slice(part * 256, (part + 1) * 256)} ${previous}\n`);
      } catch { failed = true; }
    }
    function opaque(reason) { emit('opaque', { reason }); }
    function location(value) {
      if (value && typeof value === 'object' && typeof value.fd === 'number') value = value.fd;
      if (typeof value === 'number') { if (!descriptors.has(value)) opaque('unobserved file descriptor'); return descriptors.get(value); }
      try {
        if (value instanceof URL) value = url.fileURLToPath(value);
        if (Buffer.isBuffer(value)) value = value.toString();
        if (typeof value !== 'string') return;
        const absolute = path.resolve(cwd(), value);
        try { return realpath(absolute); } catch { return absolute; }
      } catch { opaque('unresolved path'); }
    }
    function read(value) {
      const absolute = location(value), rel = candidates.get(absolute);
      if (absolute && (/^\/proc\//.test(absolute) || /^\/dev\/fd(?:\/|$)/.test(absolute))) opaque('process/control descriptor introspection');
      if (rel) emit('read', { path: rel });
    }
    function replace(value, op) { const rel = candidates.get(location(value)); if (rel) emit('replace', { path: rel, op }); }
    function fullFlags(flags) { return ['w', 'wx', 'w+', 'wx+'].includes(flags); }
    function writeFlags(options) { return typeof options === 'object' && options ? options.flag ?? 'w' : 'w'; }
    function wrap(object, name, before, after, async = false) {
      const original = object[name]; if (typeof original !== 'function') return;
      object[name] = function (...args) {
        const context = before?.(args);
        if (async) {
          const index = args.length - 1, callback = args[index];
          if (typeof callback === 'function') args[index] = function (error, ...values) { if (!error) after?.(args, values[0], context); return apply(callback, this, [error, ...values]); };
          else opaque(`unsupported ${name} callback`);
          return apply(original, this, args);
        }
        const result = apply(original, this, args);
        if (result && typeof result.then === 'function') return result.then(value => { after?.(args, value, context); return value; });
        after?.(args, result, context); return result;
      };
    }
    // Load ordinary process/test infrastructure before installing hooks; module loading is not itself an opaque consumer.
    const cp = require('node:child_process'), workers = require('node:worker_threads'), v8 = require('node:v8'), inspector = require('node:inspector'), net = require('node:net'), vm = require('node:vm');
    emit('begin', { node: process.version, fd });
    const promises = fs.promises;
    for (const name of ['readFileSync', 'createReadStream', 'openAsBlob']) wrap(fs, name, a => read(a[0]));
    wrap(fs, 'readFile', a => read(a[0])); for (const name of ['read', 'readSync', 'readv', 'readvSync']) wrap(fs, name, a => read(a[0]));
    wrap(promises, 'readFile', a => read(a[0]));
    function opened(args, value) { const target = location(args[0]), number = typeof value === 'number' ? value : value?.fd; if (typeof number === 'number' && target) descriptors.set(number, target); if (fullFlags(args[1])) replace(args[0], 'open-truncate'); }
    const opening = a => { if (!fullFlags(a[1])) read(a[0]); };
    wrap(fs, 'openSync', opening, opened); wrap(fs, 'open', opening, opened, true); wrap(promises, 'open', opening, opened);
    for (const name of ['writeFileSync', 'writeFile']) wrap(fs, name, a => { if (!fullFlags(writeFlags(a[2]))) read(a[0]); }, a => { if (fullFlags(writeFlags(a[2]))) replace(a[0], 'writeFile'); }, name === 'writeFile');
    wrap(promises, 'writeFile', a => { if (!fullFlags(writeFlags(a[2]))) read(a[0]); }, a => { if (fullFlags(writeFlags(a[2]))) replace(a[0], 'writeFile'); });
    for (const name of ['appendFileSync', 'appendFile']) wrap(fs, name, a => read(a[0])); wrap(promises, 'appendFile', a => read(a[0]));
    wrap(fs, 'createWriteStream', a => { if (candidates.has(location(a[0]))) { opaque('unobserved write stream completion'); read(a[0]); } });
    for (const [object, name, async] of [[fs, 'copyFileSync', false], [fs, 'copyFile', true], [promises, 'copyFile', false]]) wrap(object, name, a => read(a[0]), a => replace(a[1], 'copyFile'), async);
    for (const [object, name, async] of [[fs, 'renameSync', false], [fs, 'rename', true], [promises, 'rename', false]]) wrap(object, name, a => {
      const source = location(a[0]);
      if ([...candidates.keys()].some(p => p === source || source && p.startsWith(source + path.sep))) opaque('renamed original input or input directory; provenance not proven');
      return source;
    }, (a, _result, source) => { if (source !== location(a[1])) replace(a[1], 'rename'); }, async);
    for (const [object, name, async] of [[fs, 'truncateSync', false], [fs, 'truncate', true], [promises, 'truncate', false]]) wrap(object, name, a => { if ((a[1] ?? 0) !== 0) read(a[0]); }, a => { if ((a[1] ?? 0) === 0) replace(a[0], 'truncate'); }, async);
    for (const object of [fs, promises]) for (const name of ['cp', 'cpSync', 'link', 'linkSync', 'symlink', 'symlinkSync']) wrap(object, name, () => opaque(`opaque ${name} operation`));
    for (const name of ['close', 'closeSync']) wrap(fs, name, a => { if (a[0] === fd) opaque('control descriptor closed'); else descriptors.delete(a[0]); });
    for (const name of ['binding', '_linkedBinding', 'dlopen', '_debugProcess', '_debugEnd', 'execve']) wrap(process, name, () => opaque(`opaque process.${name}`));
    for (const name of ['getHeapSnapshot', 'writeHeapSnapshot', 'queryObjects']) wrap(v8, name, () => opaque(`opaque v8.${name}`));
    for (const name of ['open']) wrap(inspector, name, () => opaque('inspector opened')); for (const name of ['connect', 'connectToMainThread', 'post']) wrap(inspector.Session.prototype, name, () => opaque('inspector session'));
    for (const name of ['runInContext', 'runInNewContext', 'runInThisContext', 'compileFunction']) wrap(vm, name, () => opaque(`opaque vm.${name}`));
    wrap(net.Socket.prototype, 'connect', () => opaque('network consumer')); wrap(net.Server.prototype, 'listen', () => opaque('network server'));
    workers.Worker = new Proxy(workers.Worker, { construct(target, args, next) { opaque('unobserved worker thread'); return Reflect.construct(target, args, next); } });
    for (const name of ['spawnSync', 'execSync', 'execFileSync']) wrap(cp, name, () => opaque(`unobserved synchronous consumer ${name}`));
    const originalSpawn = cp.ChildProcess.prototype.spawn;
    cp.ChildProcess.prototype.spawn = function (options) {
      const env = Object.create(null);
      for (const pair of options.envPairs || []) { const i = pair.indexOf('='); if (i > 0) env[pair.slice(0, i)] = pair.slice(i + 1); }
      const childCwd = options.cwd ? String(options.cwd) : cwd(), args = (options.args || []).slice(1);
      const plan = entry(options.file, args, childCwd, env, config.node, true);
      const observed = plan && (!env.NODE_OPTIONS || env.NODE_OPTIONS === config.preload);
      const extra = [];
      // Ownership is execution metadata, independent of a project's business environment.
      if (process.env.AUTOREVIEW_PROCESS_OWNER) extra.push(`AUTOREVIEW_PROCESS_OWNER=${process.env.AUTOREVIEW_PROCESS_OWNER}`);
      if (process.env.AUTOREVIEW_RUN_ID) extra.push(`AUTOREVIEW_RUN_ID=${process.env.AUTOREVIEW_RUN_ID}`);
      const reserved = new Set(extra.map(p => p.slice(0, p.indexOf('='))));
      let stdio = options.stdio, child;
      if (observed) {
        child = uuid(); stdio = Array.isArray(stdio) ? stdio.slice() : [stdio || 'pipe', stdio || 'pipe', stdio || 'pipe'];
        while (stdio.length < 3) stdio.push(undefined);
        const childFd = stdio.length; stdio.push(fd);
        const values = { NODE_OPTIONS: config.preload, LOOP_NODE_OUTPUT_KEY: secret, LOOP_NODE_OUTPUT_MANIFEST: manifestPath, LOOP_NODE_OUTPUT_FD: String(childFd), LOOP_NODE_OUTPUT_ACTOR: child, LOOP_NODE_OUTPUT_PARENT: actor };
        for (const [name, value] of Object.entries(values)) { reserved.add(name); extra.push(`${name}=${value}`); }
        emit('delegate', { child, kind: plan.kind });
      } else opaque('unobserved child process');
      const forwarded = { ...options, stdio, envPairs: [...(options.envPairs || []).filter(pair => !reserved.has(pair.slice(0, pair.indexOf('=')))), ...extra] };
      try { const result = apply(originalSpawn, this, [forwarded]); if (child) emit('spawn-result', { child, started: result === 0 && !!this.pid }); return result; }
      catch (error) { if (child) emit('spawn-result', { child, started: false }); throw error; }
    };
    const restricted = name => /^(?:node:)?sqlite$/.test(name);
    const load = mod._load; mod._load = function (request, ...args) { if (restricted(request)) opaque(`opaque builtin ${request}`); return apply(load, this, [request, ...args]); };
    const getBuiltin = process.getBuiltinModule; if (getBuiltin) process.getBuiltinModule = function (name) { if (restricted(name)) opaque(`opaque builtin ${name}`); return getBuiltin(name); };
    if (typeof mod.registerHooks !== 'function') opaque('Node loader observation unavailable');
    else mod.registerHooks({ resolve(specifier, context, next) { if (restricted(specifier)) opaque(`opaque builtin ${specifier}`); return next(specifier, context); }, load(address, context, next) { if (address.startsWith('file:')) read(url.fileURLToPath(address)); return next(address, context); } });
    mod.syncBuiltinESMExports();
    process.on('exit', code => { emit('end', { code }); key.fill(0); try { close(fd); } catch {} });
  } catch { /* Incomplete witnesses never authorize an input rewrite. */ }
}

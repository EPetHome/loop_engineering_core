#!/usr/bin/env node
/** 本地原生宿主替身：真实 PTY 用户编辑器与独立收件 socket；只在夹具目录工作。 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
import { join } from 'node:path';

const config = JSON.parse(readFileSync(process.env.LOOP_FAKE_HOST_CONFIG, 'utf8'));
const args = process.argv.slice(2), root = config.root;
const at = (name) => join(root, name);
if (args.includes('--help')) {
  console.log('"auto" --approve-for-me --thread --message --messaging-socket-path');
} else if (args[0] === '--version') {
  console.log('fake native host');
} else if (args[0] === 'plugin') {
  const p = { id: 'autoreview@autoreview-local', pluginId: 'autoreview@autoreview-local', enabled: true, version: 'test', installPath: config.plugin, source: { path: config.plugin } };
  console.log(JSON.stringify(args.includes('--marketplace') ? { installed: [p] } : [p]));
} else if (args[0] === 'queue') {
  const value = (flag) => args[args.indexOf(flag) + 1];
  const socket = createConnection(config.apiSocket);
  socket.on('connect', () => socket.end(JSON.stringify({ type: 'codex-queue', session: value('--thread'), text: value('--message') }) + '\n'));
  socket.on('data', () => {});
  socket.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
} else {
  const session = config.session;
  const resumed = args.includes('--resume') || args[0] === 'resume';
  const phase = resumed ? 2 : 1;
  let events = 0, buffer = '', editor = '', taskStarted = false;
  const auth = `fake-auth-${process.pid}`;
  const socketIndex = args.indexOf('--messaging-socket-path');
  const apiSocket = socketIndex >= 0 ? args[socketIndex + 1] : config.apiSocket;
  if (config.host === 'claude') {
    process.env.CLAUDE_CODE_MESSAGING_SOCKET = apiSocket;
    process.env.CLAUDE_CODE_MESSAGING_TOKEN = auth;
  }
  const log = (name, data) => appendFileSync(at(name), JSON.stringify({ phase, pid: process.pid, session, ...data }) + '\n');
  const hook = (name, extra = {}) => {
    events++;
    const result = spawnSync(process.execPath, [config.hook], { input: JSON.stringify({ hook_event_name: name, cwd: process.cwd(), session_id: session, permission_mode: 'auto', ...extra }), env: process.env, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim() ? JSON.parse(result.stdout) : {};
  };
  const snapshotEditor = () => writeFileSync(at(`draft-${phase}.json`), JSON.stringify({ text: editor + buffer, at: Date.now(), events }));
  const startTask = (text, fromTerminal) => {
    if (taskStarted) throw new Error('unexpected extra user submission');
    taskStarted = true;
    hook('UserPromptSubmit', { prompt: text });
    if (fromTerminal) log('user-submissions.jsonl', { text });
    mkdirSync('src', { recursive: true });
    writeFileSync('src/a.txt', phase === 1 ? 'bad\n' : 'developer repair in original session\n');
    writeFileSync(at(`before-stop-${phase}`), 'ready');
    const wait = setInterval(() => {
      if (!existsSync(at(`run-stop-${phase}`))) return;
      clearInterval(wait);
      hook('Stop', { last_assistant_message: '【交付完成】' });
      writeFileSync(at(`host-idle-${phase}.json`), JSON.stringify({ pid: process.pid, session, events, tty: process.stdin.isTTY }));
    }, 20);
  };
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    socket.setEncoding('utf8'); let received = '', authenticated = config.host !== 'claude';
    socket.on('data', (data) => {
      received += data;
      let newline;
      while ((newline = received.indexOf('\n')) >= 0) {
        const frame = JSON.parse(received.slice(0, newline)); received = received.slice(newline + 1);
        if (frame.type === 'auth') { if (frame.token !== auth) throw new Error('wrong session token'); authenticated = true; continue; }
        if (!authenticated) throw new Error('unauthenticated original-session delivery');
        const thread = frame.session_id ?? frame.session, text = frame.message?.content ?? frame.text;
        if (thread !== session) throw new Error('wrong original session');
        const before = events;
        const prompt = config.host === 'claude' ? `<cross-session-message>\n${text}\n</cross-session-message>` : text;
        const result = hook('UserPromptSubmit', { prompt });
        log('host-receipt.jsonl', { text, context: text + '\n' + (result.hookSpecificOutput?.additionalContext ?? ''), eventsBeforeReceipt: before,
          editor: editor + buffer, transport: config.host === 'claude' ? 'claude-uds' : 'codex-queue' });
        if ((editor + buffer).includes('【合入队列返修】')) throw new Error('native channel touched the draft');
      }
    });
    socket.on('end', () => socket.end('accepted\n'));
  });
  server.listen(apiSocket, () => {
    log('host-launches.jsonl', { args });
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.setEncoding('utf8'); process.stdin.resume();
    process.stdin.on('data', (data) => {
      buffer += data;
      for (;;) {
        if (buffer.startsWith('\x1b[200~')) {
          const end = buffer.indexOf('\x1b[201~'); if (end < 0) break;
          editor += buffer.slice(6, end); buffer = buffer.slice(end + 6);
        } else if (buffer.startsWith('\r')) {
          buffer = buffer.slice(1); const submitted = editor; editor = '';
          startTask(submitted, true);
        } else {
          const control = buffer.search(/[\r\x1b]/);
          if (control < 0) { editor += buffer; buffer = ''; break; }
          if (control === 0) break;
          editor += buffer.slice(0, control); buffer = buffer.slice(control);
        }
        if (!buffer) break;
      }
      snapshotEditor();
    });
    hook('SessionStart');
    writeFileSync(at(`host-ready-${phase}`), 'ready');
    const task = args.find((arg) => arg.startsWith('请读取并执行 @'));
    if (task) startTask(task, false);
    else if (!config.terminalTask) startTask(config.requirement, false);
    const stop = setInterval(() => {
      if (existsSync(at(`host-exit-${phase}`))) { clearInterval(stop); server.close(); process.exit(0); }
    }, 25);
  });
}

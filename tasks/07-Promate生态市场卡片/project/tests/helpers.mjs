// plugins/tests 的公共工具：临时 PROMATE_HOME、跑 hook、代理会话、本地平台 stub。
//
// 所有测试都用 /tmp 下的临时目录当 PROMATE_HOME，绝不碰用户真实的 ~/.promate。

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

export const skillText = name => `---\nname: ${name}\ndescription: Isolated fixture\n---\nOnly fixture instructions.\n`;
export function zipFixture(entries) {
  const locals=[],centrals=[];let offset=0;
  for(const entry of entries){
    const name=Buffer.from(entry.path),bytes=Buffer.from(entry.text??''),compressed=deflateRawSync(bytes);
    let crc=0xffffffff;for(const b of bytes){crc^=b;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}crc=(crc^0xffffffff)>>>0;
    const l=Buffer.alloc(30);l.writeUInt32LE(0x04034b50);l.writeUInt16LE(20,4);l.writeUInt16LE(8,8);l.writeUInt32LE(crc,14);l.writeUInt32LE(compressed.length,18);l.writeUInt32LE(bytes.length,22);l.writeUInt16LE(name.length,26);
    const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50);c.writeUInt16LE(0x0314,4);c.writeUInt16LE(20,6);c.writeUInt16LE(8,10);c.writeUInt32LE(crc,16);c.writeUInt32LE(compressed.length,20);c.writeUInt32LE(entry.declaredSize??bytes.length,24);c.writeUInt16LE(name.length,28);c.writeUInt32LE(((entry.mode??0x8000)<<16)>>>0,38);c.writeUInt32LE(offset,42);
    locals.push(l,name,compressed);centrals.push(c,name);offset+=l.length+name.length+compressed.length;
  }
  const central=Buffer.concat(centrals),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(central.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...locals,central,end]);
}

export const PLUGIN_ROOT = fileURLToPath(new URL('../marketplace/plugins/promate/', import.meta.url));

/** 建一个临时 PROMATE_HOME；用完调用 cleanup()。 */
export function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'promate-test-'));
  writeFileSync(join(home,'fixture.md'),'---\nname: fixture-skill\ndescription: Isolated fixture\n---\nOnly fixture instructions.\n',{mode:0o600});
  return { home, cleanup: () => {
    const file = join(home, '.promate-recovery/page.json');
    // Only this fixture's proven page process; never kill an unknown user/WB process.
    try {
      if (existsSync(file)) {
        const entry = JSON.parse(readFileSync(file, 'utf8'));
        const command = execFileSync('/bin/ps', ['-p', String(entry.pid), '-o', 'command='],
          { encoding: 'utf8', timeout: 1000 });
        if (entry.uid === process.getuid() && entry.profile === realpathSync(join(home, '.promate-recovery'))
          && command.includes('/mcp/recovery-page.mjs')) process.kill(entry.pid, 'SIGTERM');
      }
    } catch { /* already exited, no proven owner or unavailable process metadata */ }
    rmSync(home, { recursive: true, force: true });
  } };
}

export function writeConfig(home, config) {
  writeFileSync(join(home, 'config.json'), JSON.stringify(config) + '\n', 'utf8');
}

export function readConfigFile(home) {
  return JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
}

export function stateFile(home, sessionId) {
  return join(home, 'state', `${sessionId}.json`);
}

export function readStateFile(home, sessionId) {
  return JSON.parse(readFileSync(stateFile(home, sessionId), 'utf8'));
}

export function writeStateFile(home, sessionId, state) {
  mkdirSync(join(home, 'state'), { recursive: true });
  writeFileSync(stateFile(home, sessionId), JSON.stringify(state) + '\n', 'utf8');
}

export function fileMode(file) {
  return statSync(file).mode & 0o777;
}

/**
 * 跑一个 hook 脚本，stdin 给事件 JSON。
 * 显式清掉 PROMATE_CONFIG，避免开发机上的真实配置影响测试。
 */
export function runHook(script, event, { home, env = {} } = {}) {
  return spawnSync(process.execPath, [join(PLUGIN_ROOT, 'hooks', script)], {
    input: JSON.stringify(event),
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, PROMATE_CONFIG: '', PROMATE_HOME: home, CODEBUDDY_CONFIG_DIR: join(home,'profile'), WORKBUDDY_CONFIG_DIR: join(home,'profile'), PROMATE_SKILLS_DIR: join(home, 'workbuddy-skills'), ...env },
  });
}

/**
 * 异步版 runHook：hook 需要请求测试进程里的 stub 时必须用这个，
 * 否则 spawnSync 会阻塞父进程事件循环，stub 永远回不了请求。
 */
export function runHookAsync(script, event, { home, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(PLUGIN_ROOT, 'hooks', script)], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PROMATE_CONFIG: '', PROMATE_HOME: home, CODEBUDDY_CONFIG_DIR: join(home,'profile'), WORKBUDDY_CONFIG_DIR: join(home,'profile'), PROMATE_SKILLS_DIR: join(home, 'workbuddy-skills'), ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(JSON.stringify(event));
  });
}

/** 取一个当前没人监听的端口：先占住再关掉。 */
export async function unusedPort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** 本地平台 stub：handler 收到 {method, path, request} 返回 {status, body}。 */
export async function startStub(handler) {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let request = null;
      try {
        request = JSON.parse(raw);
      } catch {
        // 保持 null，由 handler 决定怎么回应
      }
      const { status = 200, body = {}, responseHeaders = {}, disconnect = false } = handler({ method: req.method, path: req.url, request, headers: req.headers }) || {};
      if(disconnect){res.destroy();return;} // test-owned real socket reset, not a forged tool result
      res.writeHead(status, { 'Content-Type': 'application/json', ...responseHeaders });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}/api/mcp`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** 起一个常驻代理进程，按请求顺序收响应。 */
export class ProxySession {
  constructor({ home, env = {} } = {}) {
    this.pending = [];
    this.buffer = '';
    this.stderr = '';
    this.badLines = [];
    this.child = spawn(process.execPath, [join(PLUGIN_ROOT, 'mcp', 'proxy.mjs')], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PROMATE_CONFIG: '', PROMATE_HOME: home, CODEBUDDY_CONFIG_DIR: join(home,'profile'), WORKBUDDY_CONFIG_DIR: join(home,'profile'), PROMATE_SKILLS_DIR: join(home, 'workbuddy-skills'), ...env },
    });
    this.child.stdout.on('data', (chunk) => {
      this.buffer += chunk.toString('utf8');
      let index;
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        if (!line.trim()) continue;
        const resolve = this.pending.shift();
        try {
          const parsed = JSON.parse(line);
          if (resolve) resolve(parsed);
        } catch {
          this.badLines.push(line);
          if (resolve) resolve({ __badLine: line });
        }
      }
    });
    this.child.stderr.on('data', (chunk) => { this.stderr += chunk.toString('utf8'); });
  }

  /** 发一条请求并等它对应的响应（测试里只发带 id 的请求）。 */
  request(message) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`等响应超时；stderr=${this.stderr}`)), 15000);
      this.pending.push((response) => { clearTimeout(timer); resolve(response); });
      this.child.stdin.write(JSON.stringify(message) + '\n');
    });
  }

  close() {
    this.child.stdin.end();
    this.child.kill();
  }
}

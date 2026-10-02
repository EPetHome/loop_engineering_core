#!/usr/bin/env python3
"""Section 13 only: unmodified WorkBuddy CLI under an OS sandbox, no real credentials.
Creates a fresh owned /private/tmp root per invocation. No HOME override, no global cleanup.
"""
import hashlib
import json
import os
from pathlib import Path
import plistlib
import signal
import subprocess
import tempfile
import time
import uuid

APP = Path('/Applications/WorkBuddy.app/Contents')
CLI = APP / 'Resources/app.asar.unpacked/cli/bin/codebuddy'
ELECTRON = APP / 'MacOS/Electron'
EVIDENCE = Path(__file__).resolve().parent


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def inventory(root):
    import stat
    result = []
    for p in sorted(root.rglob('*')):
        item = {'path': str(p.relative_to(root))}
        try:
            info = p.lstat()
            item.update(kind='symlink' if stat.S_ISLNK(info.st_mode) else 'dir' if stat.S_ISDIR(info.st_mode) else 'file', bytes=info.st_size)
        except FileNotFoundError:
            item['kind'] = 'transient-disappeared-during-inventory'
        result.append(item)
    return result


def safe_cleanup(root, owner):
    # Only exact, owned, non-symlink roots under the canonical temporary parent.
    import shutil
    if not root or not owner:
        raise ValueError('empty cleanup target')
    p = Path(root)
    if not p.is_absolute() or p.parent != Path('/private/tmp') or not p.name.startswith('promate-first-'):
        raise ValueError('outside owned temporary namespace')
    if p.is_symlink() or p.resolve() != p or p == Path.home() or not p.is_dir():
        raise ValueError('non-canonical cleanup target')
    marker = p / '.owner'
    if marker.is_symlink() or marker.read_text() != owner:
        raise ValueError('owner mismatch')
    if any(q.is_symlink() for q in p.rglob('*')):
        raise ValueError('symlink cleanup target refused')
    shutil.rmtree(p)


def profile(root, ports=(), listen_ports=()):
    return '\n'.join([
        '(version 1)', '(allow default)',
        # Block all user homes, user caches and other temporary profiles. Metadata only is allowed.
        '(deny file-read-data file-read-xattr (subpath "/Users") (subpath "/Volumes") (subpath "/private/var/root") (subpath "/private/var/folders") (subpath "/private/var/tmp") (require-all (subpath "/private/tmp") (require-not (subpath ' + json.dumps(str(root)) + '))))',
        '(deny file-write* (require-all (require-not (subpath ' + json.dumps(str(root)) + ')) (require-not (literal "/dev/null")) (require-not (literal "/dev/tty"))))',
        '(deny network-outbound ' + ('(require-all ' + ' '.join('(require-not (remote ip "localhost:' + str(p) + '"))' for p in ports) + ')' if ports else '') + ')',
        *['(deny ' + op + ' ' + ('(require-all ' + ' '.join('(require-not (local ip "localhost:' + str(p) + '"))' for p in listen_ports) + ')' if listen_ports else '') + ')' for op in ['network-bind', 'network-inbound']],
        '(deny user-preference-read user-preference-write)',
        '(deny ipc-posix-shm-read-data ipc-posix-shm-write-data (ipc-posix-name-regex #"^apple\\\\.cfprefs"))',
        '(deny mach-lookup (global-name "com.apple.securityd") (global-name "com.apple.security.agent") (global-name "com.apple.cfprefsd.agent"))',
        '(deny process-info* (target others))',
    ]) + '\n'


def environment(root):
    # Do not inherit tokens, model accounts, proxy, agent hooks, NODE_OPTIONS or sidecar IPC.
    return {
        'HOME': os.environ['HOME'], 'USER': os.environ.get('USER', 'Admin'),
        'PATH': str(root / 'bin') + ':/usr/bin:/bin:/usr/sbin:/sbin',
        'SHELL': '/bin/bash', 'LANG': 'en_US.UTF-8', 'TERM': 'dumb',
        'ELECTRON_RUN_AS_NODE': '1', 'CODEBUDDY_FORCE_LITE_WB_BUNDLE': '1',
        'CODEBUDDY_DISABLE_COMPILE_CACHE': '1', 'CODEBUDDY_CREDENTIALS_IN_MEMORY': '1',
        'CODEBUDDY_CONFIG_DIR': str(root / 'profile'), 'WORKBUDDY_CONFIG_DIR': str(root / 'profile'),
        'CODEBUDDY_DATA_ROOT': str(root / 'data'), 'DISABLE_TELEMETRY': '1',
        'TMPDIR': str(root / 'tmp'), 'TMP': str(root / 'tmp'), 'TEMP': str(root / 'tmp'),
        'PROMATE_HOME': str(root / 'promate'), 'PROMATE_CONFIG': str(root / 'promate/config.json'),
        'PROMATE_SKILLS_DIR': str(root / 'profile/skills'),
        'XDG_CONFIG_HOME': str(root / 'xdg/config'), 'XDG_CACHE_HOME': str(root / 'xdg/cache'),
    }


def run(root, args, timeout=35, server_port=None):
    env = environment(root)
    if server_port:
        env.update(SERVER__HOST='127.0.0.1', SERVER__PORT=str(server_port))
        (root / 'sandbox.sb').write_text(profile(root, [server_port], [server_port]))
    command = ['/usr/bin/sandbox-exec', '-f', str(root / 'sandbox.sb'), str(ELECTRON), *args]
    p = subprocess.Popen(command, cwd=root / 'workspace', env=env, stdout=subprocess.PIPE,
                         stderr=subprocess.PIPE, text=True, start_new_session=True)
    expired = False
    try:
        out, err = p.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        expired = True
        os.killpg(p.pid, signal.SIGTERM)
        try:
            out, err = p.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(p.pid, signal.SIGKILL)
            out, err = p.communicate()
    return {'pid': p.pid, 'exit': p.returncode, 'timeout': expired, 'stdout': out, 'stderr': err}


def main():
    root = Path(tempfile.mkdtemp(prefix='promate-first-', dir='/private/tmp')).resolve()
    owner = str(uuid.uuid4())
    (root / '.owner').write_text(owner)
    for name in ['profile', 'workspace', 'tmp', 'data', 'bin']:
        (root / name).mkdir(mode=0o700)
    (root / 'sandbox.sb').write_text(profile(root))
    report = {'root': str(root), 'owner': owner, 'version': plistlib.loads((APP / 'Info.plist').read_bytes())['CFBundleShortVersionString'],
              'cliSha256': digest(CLI), 'bundleSha256': digest(APP / 'Resources/app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs'),
              'homeUnchanged': environment(root)['HOME'] == os.environ['HOME'], 'before': inventory(root), 'steps': []}
    # First only runtime and boundary smoke; host must not run until this passes.
    smoke = run(root, ['-e', 'console.log(JSON.stringify({node:process.version,electron:process.versions.electron,home:require("os").homedir()}))'])
    report['steps'].append({'name': 'runtime-smoke', **smoke})
    if smoke['exit'] == 0:
        import socket
        with tempfile.TemporaryDirectory(prefix='promate-first-canary-', dir='/private/tmp') as outside:
            canary = Path(outside) / 'public-canary.txt'
            canary.write_text('fictional isolation canary, not a credential')
            link = root / 'outside-link'
            link.symlink_to(canary)
            listener = socket.socket()
            listener.bind(('127.0.0.1', 0)); listener.listen()
            blocked_port = listener.getsockname()[1]
            code = r'''
const fs=require('fs'), cp=require('child_process'), net=require('net');
const [outside,link,root,port]=process.argv.slice(1), result={};
for(const [name,path] of [['outsideRead',outside],['symlinkRead',link]]){
 try { fs.readFileSync(path); result[name]=false; } catch(e){result[name]=['EPERM','EACCES'].includes(e.code);}
}
try{fs.writeFileSync(outside,'not allowed');result.outsideWrite=false;}catch(e){result.outsideWrite=['EPERM','EACCES'].includes(e.code);}
fs.writeFileSync(root+'/own-check','ok');result.insideWrite=fs.readFileSync(root+'/own-check','utf8')==='ok';
const child=cp.spawnSync('/bin/cat',[outside],{encoding:'utf8'});
result.childRead=child.status!==0 && !child.stdout && /permitted|denied/i.test(child.stderr);
const c=net.connect({host:'127.0.0.1',port:Number(port)});c.on('connect',()=>{result.blockedNetwork=false;c.destroy();finish();});
c.on('error',e=>{result.blockedNetwork=['EPERM','EACCES'].includes(e.code);finish();});
function finish(){console.log(JSON.stringify(result));process.exit(Object.values(result).every(Boolean)?0:1);}
setTimeout(()=>process.exit(2),3000).unref();
'''
            boundary = run(root, ['-e', code, str(canary), str(link), str(root), str(blocked_port)])
            report['steps'].append({'name': 'boundary-negative', **boundary})
            listener.close(); link.unlink()
            assert canary.read_text() == 'fictional isolation canary, not a credential'
        if boundary['exit'] == 0:
            report['steps'].append({'name': 'cli-help', **run(root, [str(CLI), 'plugin', '--help'])})
    report['after'] = inventory(root)
    report['retainedForInspection'] = True
    path = EVIDENCE / ('先导首次接入-隔离检查-' + time.strftime('%H%M%S') + '.json')
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(path)
    for step in report['steps']:
        print(step['name'], 'exit=', step['exit'], 'timeout=', step['timeout'])
        print(step['stdout'][-5000:]); print(step['stderr'][-5000:])


if __name__ == '__main__':
    main()

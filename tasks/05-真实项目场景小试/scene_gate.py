#!/usr/bin/env python3
"""Promax 场景门禁（拍板人写的标准，成员不得修改）。

在候选的 team 副本上真跑一场 dsh 场景，由程序判定，并导出证据包。

为什么需要它：现役 profile 和团队规则把团队目录写成了固定的绝对路径，成员在副本里
改了什么，直接真跑时读的仍是原项目。本脚本先搭一个临时运行环境，让这次真跑读候选：

  1. 把候选 team 抄到 <workspace>/stage/team，把写死的团队目录改成指向这一份；
  2. 搭临时 DSH_HOME（<workspace>/stage/dsh-home）：profile 同样改路径，凭据用符号链接指向
     原文件（不复制密钥，跑完即删链接）；
  3. 新建运行目录 <workspace>/stage/run，用原项目里的 dsh 程序真跑；
  4. 程序判定；
  5. 把压缩的会话解成可读文本，连同摘要写到 <workspace>/evidence/。

原项目（team、dsh-home、runs、kit）只读不写。候选副本（--code）只读不写。

用法：
  python3 scene_gate.py --code <候选 team 目录> --workspace <门禁工作目录> --scene C06

退出码：0 通过；1 不通过（标准输出最后一行 LOOP_FAIL_REASON=<原因>）；2 用法或环境错误。
"""
import argparse
import hashlib
import json
import os
import pwd
import re
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

PROJECT = Path('/Users/Admin/Desktop/Promax/promax-project')
ORIG_TEAM = str(PROJECT / 'team')
ORIG_DSH_HOME = PROJECT / 'dsh-home'
DSH = PROJECT / 'dsh-runtime' / 'node_modules' / '.bin' / 'dsh'
KIT = PROJECT / 'kit'
NODE_BIN = '/Users/Admin/.hermes/node/bin'
ZSTD = '/opt/homebrew/bin/zstd'
PROFILE = 'headless'

SCENES = {
    # 冒烟：不调工具，只确认临时环境能把 dsh 跑起来
    'S0': {'prompt_text': '只回复“就绪”两个字，不要调用任何工具。', 'attachments': [], 'smoke': True},
    # C06 用户分析（评分）首轮：10c-3 B 组第 1 批里没走通的那一场，用同一份提示词和材料
    'C06': {'prompt_file': KIT / 'prompts' / 'S1-v1首轮.txt', 'attachments': [KIT / '评分样本-v1.json'], 'smoke': False},
}


def sha_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def redact(value: str) -> str:
    value = re.sub(r'(?i)(Bearer\s+)[A-Za-z0-9._~+/-]{16,}', r'\1[REDACTED]', value)
    return re.sub(r'\b(?:sk|oc)-[A-Za-z0-9_-]{20,}\b', '[REDACTED]', value)


def rewrite_tree(root: Path, old: str, new: str) -> list:
    """把目录里所有文本文件中的 old 换成 new；返回被改写的相对路径。"""
    changed = []
    for path in sorted(root.rglob('*')):
        if not path.is_file() or path.is_symlink():
            continue
        try:
            body = path.read_text(encoding='utf-8')
        except (UnicodeError, OSError):
            continue
        if old in body:
            path.write_text(body.replace(old, new), encoding='utf-8')
            changed.append(path.relative_to(root).as_posix())
    return changed


def candidate_lines(code: Path, relative: str) -> list:
    """候选相对原项目多出来或改过的行（去掉首尾空白、长度大于 10）。用来证明真跑读的是候选。"""
    candidate, original = code / relative, Path(ORIG_TEAM) / relative
    if not candidate.is_file():
        return []
    old = set(x.strip() for x in original.read_text(encoding='utf-8').splitlines()) if original.is_file() else set()
    lines = []
    for raw in candidate.read_text(encoding='utf-8').splitlines():
        line = raw.strip()
        if len(line) > 10 and line not in old and line not in lines:
            lines.append(line)
    return lines


def text_of(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return '\n'.join(x.get('text', '') for x in content if isinstance(x, dict) and x.get('type') == 'text')
    return ''


def decode_sessions(session_root: Path, out: Path) -> list:
    """解压每个会话，写一份原始 jsonl 和一份人读摘录；返回会话清单。"""
    out.mkdir(parents=True, exist_ok=True)
    sessions = []
    for path in sorted(session_root.glob('*/*/session.v4.jsonl.zstd')):
        sid = path.parent.name
        proc = subprocess.run([ZSTD, '-dcf', '--', str(path)], capture_output=True)
        if proc.returncode:
            sessions.append({'id': sid, 'error': 'zstd 解压失败，退出码 %d' % proc.returncode})
            continue
        raw = redact(proc.stdout.decode('utf-8', errors='replace'))
        (out / (sid + '.jsonl')).write_text(raw, encoding='utf-8')
        role = 'Lead' if sid.startswith('session-') else None
        digest, haystack, calls = [], [], 0
        for line in raw.splitlines():
            if not line.strip():
                continue
            try:
                event = json.loads(line)
            except ValueError:
                digest.append('（此行不是完整 JSON，可能是会话尾部被截断）')
                break
            typ, data, seq = event.get('type', ''), event.get('data') or {}, event.get('seq')
            if typ in ('system/message', 'user/message', 'assistant/message'):
                message = data.get('message', data)
                body = text_of(message.get('content', [])) if isinstance(message, dict) else ''
                haystack.append(body)
                if role is None:
                    found = re.search(r'成员\s+([a-z]+(?:-[a-z]+)*)', body)
                    if found:
                        role = found.group(1)
                limit = 1200 if typ == 'system/message' else 6000
                digest.append('## seq %s · %s\n\n%s%s' % (seq, typ, body[:limit],
                              '\n…（共 %d 字，已截断，全文见同名 .jsonl）' % len(body) if len(body) > limit else ''))
            elif typ == 'tool/call':
                calls += 1
                args = data.get('arguments', {})
                shown = args if isinstance(args, str) else json.dumps(args, ensure_ascii=False)
                digest.append('## seq %s · 调用工具 %s\n\n%s%s' % (seq, data.get('name'), shown[:4000],
                              '\n…（已截断）' if len(shown) > 4000 else ''))
            elif typ == 'tool/result':
                message = data.get('message', {})
                body = text_of(message.get('content', [])) if isinstance(message, dict) else ''
                haystack.append(body)
                digest.append('## seq %s · 工具结果%s\n\n%s%s' % (seq, '（报错）' if message.get('isError') else '',
                              body[:4000], '\n…（共 %d 字，已截断）' % len(body) if len(body) > 4000 else ''))
        role = role or 'unknown'
        (out / (sid + '.md')).write_text('# 会话 %s（%s）\n\n' % (sid, role) + '\n\n'.join(digest) + '\n', encoding='utf-8')
        sessions.append({'id': sid, 'role': role, 'tool_calls': calls, 'raw': str(out / (sid + '.jsonl')),
                         'digest': str(out / (sid + '.md')), 'source_sha256': sha_file(path),
                         '_text': '\n'.join(haystack), '_raw': raw})
    return sessions


def jsonl(path: Path) -> list:
    if not path.is_file():
        return []
    rows = []
    for line in path.read_text(encoding='utf-8').splitlines():
        if line.strip():
            try:
                rows.append(json.loads(line))
            except ValueError:
                rows.append({'_unparsed': line})
    return rows


def rejection_class(errors: list) -> str:
    joined = ' '.join(str(e) for e in errors)
    if 'JSONDecodeError' in joined or 'JSON' in joined:
        return 'json-invalid'
    if '原句' in joined:
        return 'quote-not-verbatim'
    if 'SHA' in joined.upper() or '快照' in joined:
        return 'snapshot-mismatch'
    return 'other'


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--code', required=True, type=Path)
    ap.add_argument('--workspace', required=True, type=Path)
    ap.add_argument('--scene', required=True, choices=sorted(SCENES))
    ap.add_argument('--scene-timeout', type=int, default=1200)
    args = ap.parse_args()
    scene = SCENES[args.scene]
    code, workspace = args.code.resolve(), args.workspace.resolve()
    stage, evidence = workspace / 'stage', workspace / 'evidence'

    for need in (code / 'AGENTS.md', DSH, ORIG_DSH_HOME / '.credentials.yaml',
                 ORIG_DSH_HOME / 'profiles' / PROFILE / 'cordis.patch.yml', Path(ZSTD)):
        if not need.exists():
            print('环境不完整，缺少：%s' % need)
            return 2
    if stage.exists() or evidence.exists():
        print('门禁工作目录里已有 stage 或 evidence，拒绝覆盖：%s' % workspace)
        return 2
    if workspace == code or code in workspace.parents:
        print('门禁工作目录不能在候选副本里面')
        return 2

    # 1. 候选 team → 临时团队目录，改写写死的路径
    team = stage / 'team'
    shutil.copytree(code, team, ignore=shutil.ignore_patterns('__pycache__', '*.pyc', '.DS_Store'))
    for path in team.rglob('*'):
        os.chmod(path, 0o755 if path.is_dir() or os.access(path, os.X_OK) else 0o644)
    rewritten = rewrite_tree(team, ORIG_TEAM, str(team))

    # 2. 临时 DSH_HOME
    dsh_home = stage / 'dsh-home'
    shutil.copytree(ORIG_DSH_HOME / 'profiles' / PROFILE, dsh_home / 'profiles' / PROFILE)
    profile_rewritten = rewrite_tree(dsh_home / 'profiles' / PROFILE, ORIG_TEAM, str(team))
    shutil.copyfile(team / 'AGENTS.md', dsh_home / 'AGENTS.md')
    anonymous = ORIG_DSH_HOME / '.anonymous-user-id'
    if anonymous.is_file():
        shutil.copyfile(anonymous, dsh_home / '.anonymous-user-id')
    credentials = dsh_home / '.credentials.yaml'
    os.symlink(ORIG_DSH_HOME / '.credentials.yaml', credentials)

    # 3. 运行目录（同 kit/new-run.sh）
    run = stage / 'run'
    (run / '附件').mkdir(parents=True)
    (run / '交付').mkdir()
    prompt = scene['prompt_file'].read_text(encoding='utf-8') if 'prompt_file' in scene else scene['prompt_text']
    (run / 'prompt.txt').write_text(prompt, encoding='utf-8')
    inputs = {'prompt_sha256': hashlib.sha256(prompt.encode('utf-8')).hexdigest(), 'attachments': {}}
    for item in scene['attachments']:
        shutil.copyfile(item, run / '附件' / item.name)
        inputs['attachments'][item.name] = sha_file(item)
    real_home = pwd.getpwuid(os.getuid()).pw_dir
    env = dict(os.environ, DSH_HOME=str(dsh_home), HOME=real_home,
               PATH=NODE_BIN + os.pathsep + os.environ.get('PATH', ''))
    env.pop('DSH_PROFILE', None)
    git = ['git', '-c', 'user.name=promax', '-c', 'user.email=promax@local']
    subprocess.run(['git', 'init', '-q'], cwd=run, env=env, check=True)
    (run / '.gitignore').write_text('交付/\nevents-gate.jsonl\nstderr-gate.log\n', encoding='utf-8')
    subprocess.run(git + ['add', '-A'], cwd=run, env=env, check=True)
    subprocess.run(git + ['commit', '-qm', 'run baseline: gate ' + args.scene], cwd=run, env=env, check=True)

    # 4. 真跑
    print('开始真跑场景 %s（会调用业务模型）；运行目录：%s' % (args.scene, run), flush=True)
    started = time.time()
    timed_out = False
    with (run / 'prompt.txt').open('rb') as stdin, (run / 'events-gate.jsonl').open('wb') as out, \
            (run / 'stderr-gate.log').open('wb') as err:
        proc = subprocess.Popen([str(DSH), '--profile', PROFILE, '--json', '-'], cwd=run, env=env,
                                stdin=stdin, stdout=out, stderr=err, start_new_session=True)
        try:
            exit_code = proc.wait(timeout=args.scene_timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            try:
                os.killpg(proc.pid, signal.SIGTERM)
                time.sleep(2)
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            exit_code = proc.wait()
    seconds = round(time.time() - started, 1)
    try:
        credentials.unlink()
    except FileNotFoundError:
        pass

    # 5. 证据包
    sessions = decode_sessions(dsh_home / 'sessions', evidence / '会话')
    events_text = redact((run / 'events-gate.jsonl').read_text(encoding='utf-8', errors='replace'))
    all_raw = events_text + '\n' + '\n'.join(s.get('_raw', '') for s in sessions)
    all_text = '\n'.join(s.get('_text', '') for s in sessions)
    flow = jsonl(run / '交付' / '检查流水.jsonl')
    saves = jsonl(run / '交付' / '保存记录.jsonl')
    submits = [{'at': r.get('at'), 'group': r.get('group'), 'round': r.get('round'), 'accepted': r.get('accepted'),
                'verdict': r.get('verdict'), 'errors': r.get('errors', [])} for r in flow if r.get('event') == 'submit']
    rejected = [s for s in submits if not s['accepted']]
    seen = {}
    for relative in ('AGENTS.md', 'members/judge.md'):
        lines = candidate_lines(code, relative)
        seen[relative] = {'candidate_only_lines': len(lines),
                          'seen_in_sessions': sum(1 for line in lines if line in all_text),
                          'missing': [line for line in lines if line not in all_text][:10]}

    # 6. 程序判定
    checks, reason = [], None

    def check(name, ok, why, detail=''):
        nonlocal reason
        checks.append({'check': name, 'ok': bool(ok), 'detail': detail})
        if not ok and reason is None:
            reason = why

    check('场景进程在时限内结束', not timed_out, 'scene-timeout', '%s 秒' % seconds)
    check('场景进程退出码为 0', exit_code == 0, 'scene-exit-%s' % exit_code, '退出码 %s' % exit_code)
    check('至少有一个可读的原始会话', any('error' not in s for s in sessions), 'no-session', '%d 个会话' % len(sessions))
    check('没有用到原项目的团队目录', ORIG_TEAM + '/' not in all_raw, 'used-original-team',
          '原始会话与事件流里出现 %d 次原项目团队路径' % all_raw.count(ORIG_TEAM + '/'))
    check('会话里出现了临时团队目录', str(team) in all_raw, 'candidate-rules-not-loaded', str(team))
    agents_seen = seen['AGENTS.md']
    check('候选团队规则里改过的行都出现在会话里', agents_seen['seen_in_sessions'] == agents_seen['candidate_only_lines'],
          'candidate-rules-not-loaded', '%d/%d' % (agents_seen['seen_in_sessions'], agents_seen['candidate_only_lines']))
    if scene['smoke']:
        check('冒烟回复了就绪', '就绪' in events_text, 'smoke-no-reply')
    else:
        saved = [r for r in saves if r.get('status') == 'saved']
        check('有正式保存的成果', bool(saved), 'not-saved', '%d 条保存记录' % len(saved))
        mismatched = []
        for row in saved:
            target = run / str(row.get('path', ''))
            if not target.is_file() or sha_file(target) != row.get('sha256'):
                mismatched.append(str(row.get('path')))
        check('保存的文件与保存回执指纹一致', bool(saved) and not mismatched, 'sha-mismatch', '，'.join(mismatched))
        unfinished = [r for r in saved if not isinstance(r.get('检查'), dict) or r['检查'].get('sha_matches') is not True]
        cause = rejection_class(rejected[-1]['errors']) if rejected else 'no-accepted-conclusion'
        check('每份保存的成果都有被接受的检查结论', bool(saved) and not unfinished, 'check-not-completed:' + cause,
              '检查没做完的：' + '，'.join(str(r.get('file')) for r in unfinished) if unfinished else '')

    passed = all(c['ok'] for c in checks)
    summary = {
        'scene': args.scene, 'verdict': 'PASS' if passed else 'FAIL', 'fail_reason': None if passed else reason,
        'exit_code': exit_code, 'timed_out': timed_out, 'seconds': seconds, 'checks': checks,
        'gate_script_sha256': sha_file(Path(__file__).resolve()), 'inputs': inputs,
        'candidate': {'code': str(code), 'AGENTS.md': sha_file(code / 'AGENTS.md'),
                      'members/judge.md': sha_file(code / 'members' / 'judge.md') if (code / 'members' / 'judge.md').is_file() else None},
        'stage': {'team': str(team), 'dsh_home': str(dsh_home), 'run': str(run),
                  'team_files_rewritten': rewritten, 'profile_files_rewritten': profile_rewritten},
        'candidate_lines_seen': seen,
        'draft_submits': submits, 'draft_rejections': len(rejected),
        'rejection_classes': [rejection_class(s['errors']) for s in rejected],
        'saves': saves,
        'sessions': [{k: v for k, v in s.items() if not k.startswith('_')} for s in sessions],
        'files': {'events': str(run / 'events-gate.jsonl'), 'stderr': str(run / 'stderr-gate.log'),
                  'flow': str(run / '交付' / '检查流水.jsonl'), 'saves': str(run / '交付' / '保存记录.jsonl'),
                  'deliverables': str(run / '交付'), 'sessions_dir': str(evidence / '会话')},
    }
    evidence.mkdir(parents=True, exist_ok=True)
    (evidence / '摘要.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

    print('\n场景 %s：%s（%s 秒，退出码 %s）' % (args.scene, '通过' if passed else '不通过', seconds, exit_code))
    for c in checks:
        print('  %s %s%s' % ('通过  ' if c['ok'] else '不通过', c['check'], ('：' + c['detail']) if c['detail'] else ''))
    print('草稿提交 %d 次，被拒 %d 次%s' % (len(submits), len(rejected),
          ('（' + '，'.join(summary['rejection_classes']) + '）') if rejected else ''))
    for relative, item in seen.items():
        print('候选 %s 改过的行在会话里出现：%d/%d' % (relative, item['seen_in_sessions'], item['candidate_only_lines']))
    print('证据包：%s' % evidence)
    print('  摘要：%s' % (evidence / '摘要.json'))
    print('  会话（每个会话一份原始 .jsonl 和一份人读 .md）：%s' % (evidence / '会话'))
    print('  运行目录（事件流、交付、检查流水、保存记录）：%s' % run)
    if not passed:
        print('LOOP_FAIL_REASON=%s' % reason)
    return 0 if passed else 1


if __name__ == '__main__':
    sys.exit(main())

#!/usr/bin/env python3
"""U5 验收：版本号、变更记录、包内指纹清单跟着迭代更新，并且有一条可以重复执行的命令来维护。

用法（在引擎目录下）：python3 acceptance/check_release.py    全部通过退出 0，否则退出 1。

指纹清单 SHA256SUMS 的范围：引擎目录下的全部普通文件，不含 SHA256SUMS 自己，
不含扫描时本来就忽略的缓存（__pycache__、.pyc、.DS_Store 等）。每行「<sha256>  <相对路径>」，按路径排序。
命令：python3 loop.py checksums           核对，一致退出 0，不一致退出 5 并列出有差异的路径；
      python3 loop.py checksums --write   按当前文件重新生成。
本脚本不改引擎目录里的任何文件；需要改文件的检查都在临时副本里做。
"""
import hashlib
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _harness2 import Checker, ENGINE

VERSION = '0.2.0'
SKIP_DIRS = {'__pycache__', '.git', 'node_modules', '.venv', 'venv'}


def expected_sums(root: Path) -> dict:
    result = {}
    for base, dirs, files in os.walk(root):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
        for name in files:
            if name in ('SHA256SUMS', '.DS_Store') or name.endswith(('.pyc', '.pyo')) or name == '.env' or name.startswith('.env.'):
                continue
            path = Path(base) / name
            if path.is_symlink() or not path.is_file():
                continue
            result[path.relative_to(root).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    return result


def listed_sums(root: Path):
    path = root / 'SHA256SUMS'
    if not path.is_file():
        return None, []
    result, order = {}, []
    for line in path.read_text(encoding='utf-8').splitlines():
        if not line.strip():
            continue
        digest, _, name = line.partition('  ')
        result[name] = digest
        order.append(name)
    return result, order


def cli(root: Path, *args):
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE='1', LOOP_NO_NOTIFY='1')
    return subprocess.run([sys.executable, str(root / 'loop.py'), *args], capture_output=True, text=True, env=env, timeout=120)


def main() -> int:
    check = Checker('U5 验收')

    case = 'A 版本号'
    shown = cli(ENGINE, '--version')
    check.expect(case, 'loop.py --version', shown.stdout.strip(), VERSION)
    first = (ENGINE / 'README.md').read_text(encoding='utf-8').splitlines()[0]
    check.expect_true(case, 'README.md 第一行带新版本号', VERSION in first, first)
    changelog = (ENGINE / 'CHANGELOG.md').read_text(encoding='utf-8')
    headings = re.findall(r'^## (\d+\.\d+\.\d+)', changelog, flags=re.M)
    check.expect(case, 'CHANGELOG.md 里最靠前的版本小节', headings[0] if headings else None, VERSION)
    check.expect_true(case, 'CHANGELOG.md 保留 0.1.0 小节', '0.1.0' in headings, f'实际 {headings!r}')

    case = 'B 指纹清单与当前文件一致'
    listed, order = listed_sums(ENGINE)
    wanted = expected_sums(ENGINE)
    check.expect_true(case, 'SHA256SUMS 存在', listed is not None)
    listed = listed or {}
    check.expect(case, '清单里缺少的文件', sorted(set(wanted) - set(listed)), [])
    check.expect(case, '清单里多出的条目', sorted(set(listed) - set(wanted)), [])
    check.expect(case, '指纹对不上的文件', sorted(p for p in wanted if p in listed and listed[p] != wanted[p]), [])
    check.expect_true(case, '按路径排序', order == sorted(order), '顺序不是按路径排序')
    before = (ENGINE / 'SHA256SUMS').read_bytes() if (ENGINE / 'SHA256SUMS').is_file() else b''
    verify = cli(ENGINE, 'checksums')
    check.expect(case, 'loop.py checksums 退出码', verify.returncode, 0)
    after = (ENGINE / 'SHA256SUMS').read_bytes() if (ENGINE / 'SHA256SUMS').is_file() else b''
    check.expect_true(case, '核对命令不改 SHA256SUMS', before == after)

    work = Path(tempfile.mkdtemp(prefix='loop-release-'))
    try:
        copy = work / 'engine'
        shutil.copytree(ENGINE, copy, ignore=shutil.ignore_patterns('__pycache__', '*.pyc', '.DS_Store'))

        case = 'C 文件被改'
        target = copy / 'docs' / '01-快速开始.md'
        target.write_text(target.read_text(encoding='utf-8') + '\n多了一行\n', encoding='utf-8')
        changed = cli(copy, 'checksums')
        check.expect(case, 'loop.py checksums 退出码', changed.returncode, 5)
        check.expect_true(case, '输出里列出被改的文件', 'docs/01-快速开始.md' in changed.stdout + changed.stderr)

        case = 'D 多出文件'
        (copy / 'docs' / '新加的文件.md').write_text('x\n', encoding='utf-8')
        added = cli(copy, 'checksums')
        check.expect(case, 'loop.py checksums 退出码', added.returncode, 5)
        check.expect_true(case, '输出里列出多出的文件', 'docs/新加的文件.md' in added.stdout + added.stderr)

        case = 'E 重新生成'
        written = cli(copy, 'checksums', '--write')
        check.expect(case, 'loop.py checksums --write 退出码', written.returncode, 0)
        check.expect(case, '重新生成后再核对', cli(copy, 'checksums').returncode, 0)
        relisted, reorder = listed_sums(copy)
        fresh = expected_sums(copy)
        differing = sorted(p for p in set(fresh) | set(relisted or {}) if (relisted or {}).get(p) != fresh.get(p))
        check.expect(case, '重新生成的清单与独立计算有差异的路径', differing[:10], [])
        check.expect_true(case, '重新生成的清单按路径排序', reorder == sorted(reorder))

        case = 'F 缓存文件不算'
        (copy / 'loop_engineering' / '__pycache__').mkdir(exist_ok=True)
        (copy / 'loop_engineering' / '__pycache__' / 'x.cpython-312.pyc').write_bytes(b'x')
        (copy / '.DS_Store').write_bytes(b'x')
        check.expect(case, '只多出缓存文件时核对仍通过', cli(copy, 'checksums').returncode, 0)

        case = 'G 少了文件'
        (copy / 'docs' / '新加的文件.md').unlink()
        missing = cli(copy, 'checksums')
        check.expect(case, 'loop.py checksums 退出码', missing.returncode, 5)
        check.expect_true(case, '输出里列出缺少的文件', 'docs/新加的文件.md' in missing.stdout + missing.stderr)
    finally:
        shutil.rmtree(work, ignore_errors=True)

    return check.finish()


if __name__ == '__main__':
    sys.exit(main())

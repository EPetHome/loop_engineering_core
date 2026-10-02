#!/usr/bin/env python3
"""把 Loop 源码目录打成可分发的 zip 包（沿用 0.3.0 组合交付的包结构）。

用法：
  python3 scripts/package_loop.py --out /Users/Admin/Desktop/Loop-0.3.0-20261001.zip

包含：根入口（AGENTS、README）和 docs/archive 历史资料、adapters/、docs/、engine/、prompts/、run_loop.py、
      test_run_loop.py、tests/，外加 PACKAGE-MANIFEST.json 与 打包说明.txt。
不包含：loop-data/、exports/、temp/、dist/、tasks/、.pi/、.git/、__pycache__、*.pyc、.DS_Store、*.zip。
脚本只读源目录，只写目标 zip。
"""
import argparse
import hashlib
import json
import os
import sys
import zipfile
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKIP_DIRS = {'__pycache__', '.git', 'node_modules', '.venv', 'venv',
             'loop-data', 'exports', 'temp', '.pi', 'dist', 'tasks'}
SKIP_FILES = {'.DS_Store'}
TOP_FILES = ['AGENTS.md', 'README.md', 'run_loop.py', 'test_run_loop.py']
TOP_DIRS = ['adapters', 'docs', 'engine', 'prompts', 'tests', 'scripts']

NOTE = """Loop {version} 完整源码包

包括：引擎、Pi接法、统一启动入口、提示、测试和设计/使用文档。
不包含：运行历史、工作副本、任务项目、旧版备份、Git历史、Pi账号和凭据。

首次接手先读 AGENTS.md；docs/archive 为历史，不是启动必读材料。
解压后在此目录使用，原入口仍是 run_loop.py（仅用户明确启动任务时执行）：
  /opt/homebrew/bin/python3.12 run_loop.py "/实际路径/任务规则.json" --root "/源码目录之外/loop-data"

本机接法保留 Admin 用户的 Python、Pi、Node 和权限插件路径。
在本机解压后可使用现有环境；在其他机器使用时需配置这些路径及账号。
任务规则中的适配器路径应指向本次解压目录的 adapters/pi_member.py。
Pi及其权限插件不在本包内。会话复用默认关闭，真实收益尚未验证。

engine/SHA256SUMS 是引擎自身指纹清单；包内 PACKAGE-MANIFEST.json 记录本次归档的全部源文件指纹。
文档中的历史运行/开发工作目录属于当时记录，不是解压后的工作目录。
任务专用验收脚本和安装参考资料保留在原工作区及冻结候选，不属于本源码包。
"""


def collect():
    files = []
    for name in TOP_FILES:
        p = ROOT / name
        if p.is_file():
            files.append(p)
    for top in TOP_DIRS:
        base = ROOT / top
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
            for name in sorted(filenames):
                if name in SKIP_FILES or name.endswith(('.pyc', '.pyo', '.zip')):
                    continue
                p = Path(dirpath) / name
                if p.is_symlink() or not p.is_file():
                    continue
                files.append(p)
    return sorted(set(files), key=lambda p: p.relative_to(ROOT).as_posix())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    ap.add_argument('--version', default='0.3.0')
    ap.add_argument('--label', default=None, help='包内顶层目录名，默认 Loop-<version>-<YYYYMMDD>')
    args = ap.parse_args()

    stamp = datetime.now().astimezone()
    label = args.label or f'Loop-{args.version}-{stamp:%Y%m%d}'
    out = Path(args.out).expanduser().resolve()
    out.parent.mkdir(parents=True, exist_ok=True)

    files = collect()
    manifest = {
        'version': args.version,
        'packaged_at': stamp.isoformat(),
        'source_files': len(files),
        'files': {p.relative_to(ROOT).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
                  for p in files},
    }

    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for p in files:
            z.write(p, f'{label}/{p.relative_to(ROOT).as_posix()}')
        z.writestr(f'{label}/打包说明.txt', NOTE.format(version=args.version))
        z.writestr(f'{label}/PACKAGE-MANIFEST.json',
                   json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')

    size = out.stat().st_size
    print(f'打包完成: {out}')
    print(f'  顶层目录: {label}')
    print(f'  源文件: {len(files)} 个（另加 打包说明.txt / PACKAGE-MANIFEST.json）')
    print(f'  大小: {size} 字节')
    print(f'  zip sha256: {hashlib.sha256(out.read_bytes()).hexdigest()}')
    return 0


if __name__ == '__main__':
    sys.exit(main())

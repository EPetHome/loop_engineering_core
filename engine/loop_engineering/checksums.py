"""Verify or regenerate the installed engine's ordinary-file SHA256SUMS."""
from __future__ import annotations

import os
from pathlib import Path
import re
import stat

from .common import LoopError, atomic_write, file_hash


SKIP_DIRS = {'__pycache__', '.git', 'node_modules', '.venv', 'venv'}


def current_sums(root: Path) -> dict[str, str]:
    """Scan the package, not the caller's cwd; never follow links or hide scan errors."""
    if root.is_symlink() or not root.is_dir():
        raise LoopError(f'引擎目录不存在或是符号链接：{root}')

    def raise_scan_error(exc: OSError) -> None:
        raise exc

    result = {}
    for base, dirs, files in os.walk(root, onerror=raise_scan_error, followlinks=False):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS and not (Path(base) / d).is_symlink())
        for name in sorted(files):
            if (name in ('SHA256SUMS', '.DS_Store', '.env') or name.startswith('.env.')
                    or name.endswith(('.pyc', '.pyo'))):
                continue
            path = Path(base) / name
            if not stat.S_ISREG(path.lstat().st_mode):
                continue
            relative = path.relative_to(root).as_posix()
            if '\n' in relative or '\r' in relative:
                raise LoopError(f'指纹清单不支持含换行的文件名：{relative!r}')
            result[relative] = file_hash(path)
    return result


def listed_sums(path: Path) -> tuple[dict[str, str], list[str]]:
    """Read entries as data only: listed paths never cause filesystem access."""
    if path.is_symlink() or (path.exists() and not path.is_file()):
        return {}, ['SHA256SUMS 不是普通文件']
    try:
        lines = path.read_text(encoding='utf-8').splitlines()
    except FileNotFoundError:
        return {}, ['缺少清单：SHA256SUMS']
    except UnicodeError:
        return {}, ['SHA256SUMS 不是有效的 UTF-8 文本']
    result, order, errors = {}, [], []
    for number, line in enumerate(lines, 1):
        if not line.strip():
            continue
        digest, separator, name = line.partition('  ')
        if not separator or not name or not re.fullmatch(r'[0-9a-f]{64}', digest):
            errors.append(f'SHA256SUMS 第 {number} 行格式错误')
            continue
        if name in result:
            errors.append(f'SHA256SUMS 重复路径：{name}')
        result[name] = digest
        order.append(name)
    if order != sorted(order):
        errors.append('SHA256SUMS 未按路径排序')
    return result, errors


def checksums(root: Path, write: bool = False) -> int:
    current = current_sums(root)
    manifest = root / 'SHA256SUMS'
    if write:
        atomic_write(manifest, ''.join(f'{current[name]}  {name}\n' for name in sorted(current)))
        print(f'已重新生成 SHA256SUMS（{len(current)} 个文件）。')
        return 0

    listed, errors = listed_sums(manifest)
    missing = sorted(listed.keys() - current.keys())
    extra = sorted(current.keys() - listed.keys())
    changed = sorted(name for name in listed.keys() & current.keys() if listed[name] != current[name])
    for error in errors:
        print(error)
    for label, names in (('缺少文件', missing), ('多出文件', extra), ('不一致', changed)):
        for name in names:
            print(f'{label}：{name}')
    if errors or missing or extra or changed:
        return 5
    print(f'SHA256SUMS 核对一致（{len(current)} 个文件）。')
    return 0

"""Small, dependency-free persistence, identity, and filesystem primitives.

This is accidental-change detection, not a security boundary against the same UID.
"""
from __future__ import annotations

import contextlib
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import tempfile
import time
from typing import Any, Iterator


class LoopError(Exception):
    """An actionable, expected runtime or configuration error."""


class IntegrityError(LoopError):
    pass


def now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def digest(value: Any) -> str:
    return hashlib.sha256(canonical(value)).hexdigest()


def file_hash(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def load_json(path: Path, max_bytes: int = 128 * 1024 * 1024) -> Any:
    if path.is_symlink() or not path.is_file():
        raise LoopError(f"不是普通文件：{path}")
    if path.stat().st_size > max_bytes:
        raise LoopError(f"文件过大：{path}")
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError(f"重复 JSON 键：{key}")
            result[key] = value
        return result
    try:
        return json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=pairs,
                          parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
    except (UnicodeError, ValueError) as exc:
        raise LoopError(f"JSON 无效：{path}: {exc}") from exc


def atomic_write(path: Path, data: bytes | str, readonly: bool = False) -> None:
    """Same-filesystem replace; fsync data and (where supported) the parent directory."""
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_symlink():
        raise IntegrityError(f"拒绝写入符号链接：{path}")
    if isinstance(data, str):
        data = data.encode("utf-8")
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, 0o400 if readonly else 0o600)
        os.replace(tmp, path)
        with contextlib.suppress(OSError):
            dfd = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(dfd)
            finally:
                os.close(dfd)
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(tmp)


def atomic_json(path: Path, value: Any, readonly: bool = False) -> None:
    atomic_write(path, json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", readonly)


class FileLock:
    """POSIX advisory ownership lock. Never delete the lock inode."""
    def __init__(self, path: Path):
        self.path, self.fd = path, None

    def __enter__(self):
        if os.name != "posix":
            raise LoopError("本版本执行器需要 macOS / Linux / WSL；不支持原生 Windows。")
        import fcntl
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.fd = self.path.open("a+")
        try:
            fcntl.flock(self.fd.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            self.fd.close()
            self.fd = None
            raise LoopError(f"运行已被其他进程持有：{self.path}") from exc
        return self

    def __exit__(self, *_):
        if self.fd:
            self.fd.close()
            self.fd = None


def lock_busy(path: Path) -> bool:
    try:
        with FileLock(path):
            return False
    except LoopError:
        return True


def relative_path(value: str, allow_dir: bool = False) -> str:
    if not isinstance(value, str) or not value or "\\" in value or "\x00" in value:
        raise LoopError(f"无效的相对路径：{value!r}")
    raw = value[:-1] if value.endswith("/") else value
    p = PurePosixPath(raw)
    if p.is_absolute() or any(x in ("", ".", "..") for x in raw.split("/")):
        raise LoopError(f"路径必须是安全的项目内相对路径：{value}")
    if any(x in raw for x in "*?[]"):
        raise LoopError(f"本版本路径使用确切文件或以 / 结束的目录，不支持通配符：{value}")
    if value.endswith("/") and not allow_dir:
        raise LoopError(f"此处需要文件路径：{value}")
    return value


def matches(path: str, prefixes: list[str]) -> bool:
    return any(path.startswith(p) if p.endswith("/") else path == p for p in prefixes)


def overlaps(a: str, b: str) -> bool:
    return a == b or (a.endswith("/") and b.startswith(a)) or (b.endswith("/") and a.startswith(b))


def safe_child(root: Path, relative: str) -> Path:
    relative_path(relative)
    out = root / relative
    if out.is_symlink() or not out.resolve().is_relative_to(root.resolve()):
        raise IntegrityError(f"越界或符号链接：{relative}")
    return out


DEFAULT_EXCLUDES = [".git/", ".venv/", "venv/", "node_modules/", ".env", ".env.local", ".DS_Store"]


def excluded(rel: str, excludes: list[str]) -> bool:
    parts = PurePosixPath(rel).parts
    return ("__pycache__" in parts or rel.endswith((".pyc", ".pyo"))
            or any(p in (".git", "node_modules", ".venv") for p in parts)
            or any(p == ".env" or (p.startswith(".env.") and p not in (".env.example", ".env.sample")) for p in parts)
            or matches(rel, excludes) or any(rel == p.rstrip("/") for p in excludes))


def tree_manifest(root: Path, excludes: list[str] | None = None,
                  max_files: int = 30000, max_bytes: int = 512 * 1024 * 1024) -> dict:
    """Hash regular files, executable bits and directories; reject links/special files.

    Including empty directories catches otherwise invisible out-of-scope mkdirs.
    All limits apply to one snapshot, not the whole disk.
    """
    if not root.is_dir() or root.is_symlink():
        raise IntegrityError(f"代码目录不存在或是符号链接：{root}")
    result, size = {}, 0
    excludes = excludes or []
    for base, dirs, files in os.walk(root, followlinks=False):
        dirs.sort()
        files.sort()
        for name in list(dirs):
            p = Path(base) / name
            rel = p.relative_to(root).as_posix()
            if excluded(rel, excludes):
                dirs.remove(name)
                continue
            if p.is_symlink():
                raise IntegrityError(f"不支持符号链接目录：{rel}")
            if len(result) >= max_files:
                raise IntegrityError('快照超过文件/目录数量上限')
            result[rel + "/"] = {"kind": "dir"}
        for name in files:
            p = Path(base) / name
            rel = p.relative_to(root).as_posix()
            if excluded(rel, excludes):
                continue
            info = p.lstat()
            if not stat.S_ISREG(info.st_mode):
                raise IntegrityError(f"不支持链接或特殊文件：{rel}")
            size += info.st_size
            if len(result) >= max_files or size > max_bytes:
                raise IntegrityError("快照超过文件数量或大小上限；请缩小输入或调整规则。")
            result[rel] = {"kind": "file", "sha256": file_hash(p), "bytes": info.st_size,
                           "executable": bool(info.st_mode & 0o111)}
    return result


def copy_manifest(source: Path, target: Path, manifest: dict, readonly: bool = False) -> None:
    if target.exists():
        raise IntegrityError(f"目标已存在，拒绝覆盖：{target}")
    target.mkdir(parents=True)
    for rel, info in sorted(manifest.items()):
        if info["kind"] == "dir":
            (target / rel).mkdir(parents=True, exist_ok=True)
            continue
        p, q = safe_child(source, rel), target / rel
        if not p.is_file() or file_hash(p) != info["sha256"]:
            raise IntegrityError(f"复制前输入发生变化：{rel}")
        q.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(p, q)
        os.chmod(q, (0o500 if readonly else 0o700) if info["executable"] else (0o400 if readonly else 0o600))
        if file_hash(q) != info["sha256"]:
            raise IntegrityError(f"复制期间输入发生变化：{rel}")
    if readonly:
        for base, dirs, _ in os.walk(target, topdown=False):
            for name in dirs:
                os.chmod(Path(base) / name, 0o500)
        os.chmod(target, 0o500)


def changes(before: dict, after: dict) -> list[str]:
    return sorted(p for p in before.keys() | after.keys() if before.get(p) != after.get(p))


def writable_change(path: str, writable: list[str], protected: list[str]) -> bool:
    if matches(path, protected):
        return False
    if path.endswith("/"):
        # Parent directory creation is necessary for an explicitly allowed new file.
        return matches(path, writable) or any(p.startswith(path) for p in writable)
    return matches(path, writable)


def check_boundary(before: dict, after: dict, writable: list[str], protected: list[str]) -> list[str]:
    changed = changes(before, after)
    bad = [p for p in changed if not writable_change(p, writable, protected)]
    if bad:
        raise IntegrityError("检测到范围外改动：" + ", ".join(bad[:20]))
    return changed


def environment(extra_names: list[str] | None = None, gate_home: Path | None = None) -> dict[str, str]:
    names = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "SHELL", "TMPDIR",
             "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]
    if extra_names:
        names += extra_names
    result = {k: os.environ[k] for k in names if k in os.environ}
    result.update(PYTHONDONTWRITEBYTECODE="1", PYTHONUNBUFFERED="1", TERM="dumb", NO_COLOR="1")
    if gate_home:
        gate_home.mkdir(parents=True, exist_ok=True)
        result["HOME"] = str(gate_home)
    return result

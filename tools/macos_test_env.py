#!/usr/bin/env python3
"""Run a Python test/acceptance script with a private short macOS temporary directory."""
from contextlib import contextmanager
from datetime import datetime, timezone
import argparse
import json
import os
from pathlib import Path
import platform
import runpy
import signal
import socket
import sys
import tempfile

TEMP_KEYS = ("TMPDIR", "TMP", "TEMP")


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


@contextmanager
def macos_temp(report_path):
    """Allocate only our own short directory and restore environment/cache on exit."""
    previous_env = {k: os.environ.get(k) for k in TEMP_KEYS}
    previous_cache = tempfile.tempdir
    report = {
        "system": platform.system(), "macos": platform.mac_ver()[0],
        "machine": platform.machine(), "python": sys.version,
        "started_at": datetime.now(timezone.utc).isoformat(),
        "inherited": previous_env,
        "cached_tempdir_before": str(previous_cache) if previous_cache is not None else None,
        "status": "STARTING",
    }
    workspace = None
    try:
        if sys.platform != "darwin":
            raise RuntimeError("This recipe targets macOS; another OS is not acceptance evidence")
        # Explicit dir avoids both inherited TMPDIR and an already-populated cache.
        workspace = tempfile.TemporaryDirectory(prefix="li-", dir="/private/tmp")
        short = workspace.name
        report["temporary_directory"] = short
        report["temporary_directory_bytes"] = len(os.fsencode(short))
        if report["temporary_directory_bytes"] > 40:
            raise RuntimeError("Temporary directory is not short enough for nested macOS sockets")
        save(Path(short) / ".loop-acceptance-owner.json",
             {"pid": os.getpid(), "created_at": report["started_at"],
              "purpose": "isolated macOS test/acceptance script"})
        for key in TEMP_KEYS:
            os.environ[key] = short
        tempfile.tempdir = None
        if tempfile.gettempdir() != short:
            raise RuntimeError("Python tempfile cache did not select the private directory")
        # Real Darwin capability check, not an existence-only check.
        probe = Path(short) / "probe.sock"
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
            sock.bind(str(probe))
        probe.unlink()
        report.update(status="READY", socket_bind="PASS",
                      effective={k: os.environ[k] for k in TEMP_KEYS},
                      cached_tempdir_effective=tempfile.gettempdir())
        save(report_path, report)
        yield report
    except BaseException as exc:
        if report["status"] == "STARTING":
            report.update(status="INFRASTRUCTURE_FAILURE", error=str(exc))
        elif not isinstance(exc, SystemExit) or exc.code not in (None, 0):
            report["child_exception"] = type(exc).__name__
        raise
    finally:
        for key, value in previous_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        tempfile.tempdir = previous_cache
        cleanup_error = None
        if workspace is not None:
            try:
                workspace.cleanup()
            except OSError as exc:
                cleanup_error = str(exc)
        report.update(
            finished_at=datetime.now(timezone.utc).isoformat(),
            environment_restored=all(os.environ.get(k) == v for k, v in previous_env.items()),
            cache_restored=tempfile.tempdir == previous_cache,
            temporary_directory_removed=workspace is not None and not Path(workspace.name).exists(),
            cleanup_error=cleanup_error,
        )
        save(report_path, report)
        if cleanup_error is not None:
            raise RuntimeError("Our temporary directory cleanup failed: " + cleanup_error)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, required=True,
                        help="environment evidence path; declare it as a recipe output")
    parser.add_argument("script", type=Path, help="Python test or acceptance script")
    parser.add_argument("args", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    script = args.script.resolve()
    if not script.is_file():
        parser.error("The Python script does not exist")
    previous_argv, previous_path = sys.argv[:], sys.path[:]
    previous_handler = signal.getsignal(signal.SIGTERM)

    def terminate(signum, frame):
        raise SystemExit(128 + signum)

    signal.signal(signal.SIGTERM, terminate)
    try:
        with macos_temp(args.report.resolve()):
            sys.argv = [str(script), *args.args]
            sys.path.insert(0, str(script.parent))
            runpy.run_path(str(script), run_name="__main__")
    except SystemExit:
        raise  # Preserve Python exit status/message, including non-integer codes.
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 70
    finally:
        signal.signal(signal.SIGTERM, previous_handler)
        sys.argv, sys.path[:] = previous_argv, previous_path
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

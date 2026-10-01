#!/usr/bin/env python3
"""Run directly after extracting the archive; no pip install required."""
import sys
if sys.version_info < (3, 10):
    sys.exit("Loop Engineering 需要 Python 3.10 或更高版本。")
from loop_engineering.cli import main
if __name__ == "__main__":
    raise SystemExit(main())

"""Bounded *diagnostic* storage. Never used as input to the protocol parser.

A retained prefix may end mid-record. Retention metadata says exactly what was
lost; authoritative delivery, lifecycle projection and evidence are separate.
"""
from __future__ import annotations
from pathlib import Path
from .common import atomic_json, LoopError


class PrefixLog:
    def __init__(self, path: Path, limit: int):
        if type(limit) is not int or limit < 1:
            raise LoopError('diagnostic limit must be a positive integer')
        if path.is_symlink():
            raise LoopError('refusing diagnostic symlink: ' + str(path))
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path, self.limit = path, limit
        self.observed = self.retained = 0
        self.file = path.open('wb')
        self.closed = False

    def write(self, data: bytes) -> int:
        self.observed += len(data)
        keep = data[:max(0, self.limit - self.retained)]
        if keep:
            self.file.write(keep)
            self.retained += len(keep)
        return len(data)

    def flush(self):
        if not self.closed:
            self.file.flush()

    def summary(self) -> dict:
        return {'policy': 'prefix', 'observed_bytes': self.observed,
                'retained_bytes': self.retained, 'discarded_bytes': self.observed - self.retained,
                'limit_bytes': self.limit, 'complete': self.observed == self.retained,
                'authoritative_delivery': False,
                'note': 'Diagnostic prefix only; truncated records are not parseable evidence.'}

    def close(self):
        if not self.closed:
            self.file.close()
            self.closed = True
            atomic_json(self.path.with_name(self.path.name + '.retention.json'), self.summary())

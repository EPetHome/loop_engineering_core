"""Single-user local authorization ledger. BEGIN IMMEDIATE serializes claims.

This protects managed operations, not a same-UID administrator who can replace
this database or program. Keep this directory outside the model's write sandbox.
"""
from __future__ import annotations
from contextlib import contextmanager
import json
import os
from pathlib import Path
import sqlite3
import time
import uuid
from .common import LoopError, canonical


def state_path() -> Path:
    return Path(os.environ.get('LOOP_GUARD_STATE', '~/.local/share/loop-guard')).expanduser().resolve()


class Ledger:
    def __init__(self, state: Path):
        self.state = state.expanduser().resolve()
        self.state.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.path = self.state / 'guard.sqlite3'
        if self.path.is_symlink():
            raise LoopError('ledger symlink refused')
        with self.connect() as db:
            db.executescript('''
            CREATE TABLE IF NOT EXISTS objects(kind TEXT, id TEXT, value TEXT NOT NULL,
                                               PRIMARY KEY(kind,id));
            CREATE TABLE IF NOT EXISTS authorizations(id TEXT PRIMARY KEY, project TEXT NOT NULL,
                              maxima TEXT NOT NULL, created REAL NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS launches(request TEXT PRIMARY KEY, authorization TEXT NOT NULL,
                              project TEXT NOT NULL, root TEXT NOT NULL, run_id TEXT NOT NULL UNIQUE,
                              binding TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'CLAIMED');
            CREATE TABLE IF NOT EXISTS reservations(authorization TEXT, dimension TEXT, operation TEXT,
                              run_id TEXT NOT NULL, created REAL NOT NULL,
                              PRIMARY KEY(authorization,dimension,operation));
            ''')
        os.chmod(self.path, 0o600)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA busy_timeout=10000')
        db.execute('PRAGMA foreign_keys=ON')
        try:
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    def get(self, kind: str, key: str) -> dict:
        with self.connect() as db:
            row = db.execute('SELECT value FROM objects WHERE kind=? AND id=?', (kind, key)).fetchone()
            if not row:
                raise LoopError(f'未登记的 {kind}: {key}')
            return json.loads(row['value'])

    def put(self, kind: str, key: str, value: dict, *, expected_revision: int | None = None,
            create_only: bool = False):
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            old = db.execute('SELECT value FROM objects WHERE kind=? AND id=?', (kind, key)).fetchone()
            if create_only and old:
                raise LoopError('对象已存在，不覆盖')
            if expected_revision is not None and (not old or json.loads(old['value']).get('revision') != expected_revision):
                raise LoopError('准备版本冲突，请读取当前状态，不覆盖他人修改')
            db.execute('INSERT OR REPLACE INTO objects VALUES(?,?,?)', (kind, key, canonical(value).decode()))

    def objects(self, kind: str) -> list[dict]:
        with self.connect() as db:
            return [json.loads(x['value']) for x in db.execute('SELECT value FROM objects WHERE kind=? ORDER BY id', (kind,))]

    def authorize(self, project: str, maxima: dict) -> str:
        if not maxima or any(type(x) is not int or x < 0 for x in maxima.values()):
            raise LoopError('invalid authorization maxima')
        key = 'auth-' + uuid.uuid4().hex
        with self.connect() as db:
            db.execute('INSERT INTO authorizations(id,project,maxima,created) VALUES(?,?,?,?)',
                       (key, project, canonical(maxima).decode(), time.time()))
        return key

    def authorization(self, key: str) -> dict:
        with self.connect() as db:
            row = db.execute('SELECT * FROM authorizations WHERE id=?', (key,)).fetchone()
            if not row or row['revoked']:
                raise LoopError('授权不存在或已撤销')
            out = dict(row)
            out['maxima'] = json.loads(out['maxima'])
            out['used'] = {r['dimension']: r['n'] for r in db.execute(
                'SELECT dimension, COUNT(*) n FROM reservations WHERE authorization=? GROUP BY dimension', (key,))}
            return out

    def claim(self, request: str, authorization: str, project: str, root: str, rid: str, binding: dict) -> tuple[dict, bool]:
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT * FROM launches WHERE request=?', (request,)).fetchone()
            if row:
                old = dict(row)
                if (old['authorization'], old['project'], old['root'], json.loads(old['binding'])) != (authorization, project, root, binding):
                    raise LoopError('同一启动请求绑定变化，拒绝重复执行')
                return old, False
            auth = db.execute('SELECT * FROM authorizations WHERE id=?', (authorization,)).fetchone()
            if not auth or auth['revoked'] or auth['project'] != project:
                raise LoopError('启动没有对应项目的有效人工授权')
            db.execute('INSERT INTO launches(request,authorization,project,root,run_id,binding) VALUES(?,?,?,?,?,?)',
                       (request, authorization, project, root, rid, canonical(binding).decode()))
            return {'request': request, 'authorization': authorization, 'project': project,
                    'root': root, 'run_id': rid, 'binding': canonical(binding).decode(), 'state': 'CLAIMED'}, True

    def launch(self, request: str) -> dict:
        with self.connect() as db:
            row = db.execute('SELECT * FROM launches WHERE request=?', (request,)).fetchone()
            if not row:
                raise LoopError('启动请求没有被授权认领')
            value = dict(row)
            value['binding'] = json.loads(value['binding'])
            return value

    def mark_created(self, request: str):
        with self.connect() as db:
            db.execute("UPDATE launches SET state='CREATED' WHERE request=?", (request,))

    def reserve_many(self, authorization: str, dimensions: list[str], operation: str, run_id: str) -> bool:
        """No automatic refund after an uncertain launch; records remain auditable."""
        dimensions = sorted(set(dimensions))
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            auth = db.execute('SELECT * FROM authorizations WHERE id=?', (authorization,)).fetchone()
            if not auth or auth['revoked']:
                raise LoopError('授权失效')
            if not db.execute('SELECT 1 FROM launches WHERE authorization=? AND run_id=?', (authorization, run_id)).fetchone():
                raise LoopError('该运行不属于指定授权')
            maxima = json.loads(auth['maxima'])
            for dimension in dimensions:
                if dimension not in maxima:
                    raise LoopError('授权未包含此计量维度：' + dimension)
                old = db.execute('SELECT run_id FROM reservations WHERE authorization=? AND dimension=? AND operation=?',
                                 (authorization, dimension, operation)).fetchone()
                if old:
                    if old['run_id'] != run_id:
                        raise LoopError('reservation identity conflict')
                    continue
                used = db.execute('SELECT COUNT(*) FROM reservations WHERE authorization=? AND dimension=?',
                                  (authorization, dimension)).fetchone()[0]
                if used >= maxima[dimension]:
                    return False
            for dimension in dimensions:
                db.execute('INSERT OR IGNORE INTO reservations VALUES(?,?,?,?,?)',
                           (authorization, dimension, operation, run_id, time.time()))
        return True

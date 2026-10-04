"""Versioned, deterministic build profiles. No inference of arbitrary plugin effects."""
from __future__ import annotations
import copy
from pathlib import Path
from .common import LoopError, overlaps, relative_path, matches

V2_LIMITS = {'max_event_bytes': 8 * 1024 * 1024, 'max_evidence_bytes': 32 * 1024 * 1024,
             'max_build_bytes': 1024 * 1024 * 1024, 'max_build_files': 100000,
             'max_run_bytes': 4 * 1024 * 1024 * 1024, 'max_run_files': 300000,
             'max_selftests': 20, 'max_gate_executions': 40, 'max_total_repairs': 10}


def normalize_profiles(raw: dict) -> dict:
    from .rules import fields, ident, argv, strings, number
    if not isinstance(raw, dict):
        raise LoopError('execution_profiles must be an object')
    result = copy.deepcopy(raw)
    for name, p in result.items():
        ident(name, 'execution profile')
        fields(p, ['argv', 'cwd', 'output_paths', 'evidence_paths', 'timeout_seconds',
                   'network', 'inherit_env', 'max_reruns', 'probe_allowed', 'description', 'cache_dir', 'max_cache_bytes', 'max_cache_files'],
               ['argv', 'output_paths', 'timeout_seconds'], 'profile.' + name)
        argv(p['argv'], 'profile.argv')
        p.setdefault('cwd', '.')
        if p['cwd'] != '.':
            relative_path(p['cwd'].rstrip('/') + '/', True)
        strings(p['output_paths'], 'profile.output_paths', True)
        p.setdefault('evidence_paths', [])
        strings(p['evidence_paths'], 'profile.evidence_paths')
        for path in p['evidence_paths']:
            relative_path(path)
            if not matches(path, p['output_paths']):
                raise LoopError('evidence must be under declared new outputs: ' + path)
        number(p['timeout_seconds'], 'profile.timeout_seconds', .1)
        for key in ('network', 'probe_allowed'):
            p.setdefault(key, False)
            if type(p[key]) is not bool:
                raise LoopError(key + ' must be boolean')
        p.setdefault('inherit_env', [])
        strings(p['inherit_env'], 'profile.inherit_env')
        for key in p['inherit_env']:
            import re
            if not re.fullmatch('[A-Za-z_][A-Za-z0-9_]*', key) or key.startswith('LOOP_'):
                raise LoopError('invalid profile environment variable')
        p.setdefault('max_reruns', 0)
        number(p['max_reruns'], 'profile.max_reruns', 0, True)
        if p['max_reruns'] > 5:
            raise LoopError('max_reruns > 5')
        p.setdefault('cache_dir', None)
        if p['cache_dir'] is not None:
            if not isinstance(p['cache_dir'], str) or not Path(p['cache_dir']).expanduser().is_absolute():
                raise LoopError('cache_dir must be an explicitly approved absolute path')
            if Path(p['cache_dir']).expanduser().is_symlink():
                raise LoopError('cache_dir cannot be a symlink')
            p['cache_dir'] = str(Path(p['cache_dir']).expanduser().resolve())
        elif any('{cache}' in arg for arg in p['argv']):
            raise LoopError('argv references {cache} without cache_dir')
        p.setdefault('max_cache_bytes', 2 * 1024 * 1024 * 1024)
        p.setdefault('max_cache_files', 200000)
        number(p['max_cache_bytes'], 'max_cache_bytes', 1, True)
        number(p['max_cache_files'], 'max_cache_files', 1, True)
        p.setdefault('description', '')
        if not isinstance(p['description'], str):
            raise LoopError('description must be text')
    return result


def compile_unit(unit: dict, profiles: dict) -> None:
    """Write linked fields from ONE profile; inconsistent hand overrides are errors."""
    from .rules import strings
    unit.setdefault('build_profiles', [])
    strings(unit['build_profiles'], 'build_profiles')
    errors = []
    for name in unit['build_profiles']:
        if name not in profiles:
            errors.append('unknown self-test profile: ' + name)
    for gate in unit.get('gates', []):
        name = gate.get('profile')
        if name not in profiles:
            errors.append('gate ' + str(gate.get('id')) + ': explicit registered profile required')
            continue
        p = profiles[name]
        for key in ('argv', 'output_paths', 'timeout_seconds', 'max_reruns'):
            expected = p[key]
            if key in gate and gate[key] != expected:
                errors.append(f"gate {gate.get('id')}: {key} conflicts with profile {name}")
            gate[key] = copy.deepcopy(expected)
    if errors:
        raise LoopError('; '.join(errors))


def unit_selftest_cap(rules: dict, unit: dict) -> int:
    """Per-unit self-test share, so an early unit cannot starve the later ones.

    Explicit unit.max_selftests wins (never above the run total); otherwise the run total
    is split evenly across the units that build.
    """
    total = rules['limits']['max_selftests']
    if unit.get('max_selftests'):
        return min(unit['max_selftests'], total)
    builders = [u for u in rules['units'] if u.get('build_profiles') and u.get('kind') != 'verify'] or [unit]
    return max(1, -(-total // len(builders)))


def round_selftest_cap(rules: dict, unit: dict, round_number: int) -> int:
    """Cumulative share; unused self-tests carry into the next business round."""
    cap = unit_selftest_cap(rules, unit)
    rounds = unit.get('max_repairs', 0) + 1
    current = min(max(1, round_number), rounds)
    return -(-cap * current // rounds)


def capability_summary() -> dict:
    return {'version': '0.4.0', 'schemas': [1, 2],
            'managed_schema': 2, 'unit_kinds': ['work', 'integration', 'verify'],
            'prepare': ['begin', 'patch', 'check', 'probe', 'seal', 'status'],
            'build': 'single isolated-copy executor for probe/selftest/gate',
            'sandbox': {'strict': 'macOS sandbox-exec; fail closed elsewhere',
                        'audit-only': 'explicit offline/development mode, NOT containment'},
            'not_supported': ['arbitrary Maven plugin output inference', 'automatic business correctness proof',
                              'live model/account validation without authorization',
                              'automatic cross-DAG checkpoint recovery', 'automatic baseline merge']}

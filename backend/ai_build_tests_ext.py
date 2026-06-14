"""AI Auto-Test runner — executes the local pytest suite after an AI
Build PR opens and stamps the verdict on the plan doc.

Why
---
The operator asked the AIs to "automatically run the comprehensive
testing agent when they code, so everything will be correct". We can't
invoke the agent's privileged testing tool from the runtime API, but we
CAN run the existing `/app/backend/tests/` pytest suite — that's what
the agent uses under the hood anyway. Combined with:

  - text code review (`deploy/code_review.py`)
  - visual verify (`ai_visual_verify_ext.py`)
  - this pytest run

…the auto-merge sweep now has three independent green lights before
shipping. Visual fail OR test fail blocks the merge.

Mechanics
---------
- Operator-only endpoint `POST /api/operator/ai-build/run-tests/{plan_id}`.
- Spawns `pytest /app/backend/tests/ -x -q` with a hard 180s timeout.
- Parses the exit code + last 4 KB of stdout into a structured verdict.
- Stamps `{verdict, passed, failed, errors, summary, ran_at}` on the
  ai_build_plans doc.
- Auto-fix loop honours the new `auto_run_tests` config flag: when on,
  it auto-fires this endpoint immediately after `_schedule_visual_verify`
  and waits for the verdict before considering the PR mergeable.
"""
from __future__ import annotations

import asyncio
import logging
import re
import shlex
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException

from auth_utils import get_current_operator
from db import db

logger = logging.getLogger('tbc')

router = APIRouter(prefix='/api/operator/ai-build', tags=['ai-build-tests'])

_TESTS_DIR = Path('/app/backend/tests')
_PYTEST_TIMEOUT_S = 180.0
# Tail size on stdout — pytest's `-q` output is compact, ~50 lines max
# for a green run. We keep the last 4 KB so failing assertion diffs are
# preserved.
_MAX_OUTPUT_BYTES = 4 * 1024


def _summarise_pytest(stdout: str) -> dict:
    """Best-effort parse of pytest's `-q` summary line.

    Expected tail line shapes:
      `5 passed in 0.42s`
      `2 failed, 3 passed in 1.10s`
      `1 error, 4 passed in 0.5s`
    """
    tail = stdout[-_MAX_OUTPUT_BYTES:] if len(stdout) > _MAX_OUTPUT_BYTES else stdout
    summary = (tail.strip().splitlines() or ['(no output)'])[-1]
    passed = failed = errors = 0
    m = re.search(r'(\d+)\s+passed', tail)
    if m:
        passed = int(m.group(1))
    m = re.search(r'(\d+)\s+failed', tail)
    if m:
        failed = int(m.group(1))
    m = re.search(r'(\d+)\s+error', tail)
    if m:
        errors = int(m.group(1))
    return {
        'passed': passed,
        'failed': failed,
        'errors': errors,
        'summary_line': summary,
        'output_tail': tail,
    }


async def _run_pytest() -> dict:
    """Spawn pytest as a subprocess and return a structured verdict.
    Never raises — failures are stamped as `verdict='error'`."""
    if not _TESTS_DIR.exists():
        return {
            'verdict': 'error',
            'summary': f'Tests dir not found at {_TESTS_DIR}',
            'passed': 0, 'failed': 0, 'errors': 0, 'exit_code': -1,
        }
    cmd = f'python -m pytest {shlex.quote(str(_TESTS_DIR))} -x -q --no-header --tb=short'
    try:
        proc = await asyncio.create_subprocess_shell(
            cmd,
            cwd='/app/backend',
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            limit=2 * 1024 * 1024,  # 2 MB log buffer
        )
    except Exception as e:
        return {
            'verdict': 'error',
            'summary': f'Failed to spawn pytest: {e}',
            'passed': 0, 'failed': 0, 'errors': 0, 'exit_code': -1,
        }
    try:
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=_PYTEST_TIMEOUT_S)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return {
            'verdict': 'error',
            'summary': f'pytest exceeded {_PYTEST_TIMEOUT_S}s timeout',
            'passed': 0, 'failed': 0, 'errors': 0, 'exit_code': -1,
        }
    text = stdout.decode('utf-8', errors='replace')
    parts = _summarise_pytest(text)
    exit_code = proc.returncode or 0
    verdict = 'pass' if exit_code == 0 and parts['failed'] == 0 and parts['errors'] == 0 else 'fail'
    return {
        'verdict': verdict,
        'summary': parts['summary_line'][:280],
        'passed': parts['passed'],
        'failed': parts['failed'],
        'errors': parts['errors'],
        'exit_code': exit_code,
        'output_tail': parts['output_tail'],
        'ran_at': datetime.now(timezone.utc).isoformat(),
    }


async def run_tests_for_plan(plan_id: str) -> dict:
    """Engine — also called by the auto-fix loop. Stamps the verdict on
    the plan doc and returns it."""
    plan = await db.ai_build_plans.find_one({'plan_id': plan_id}, {'plan_id': 1})
    if not plan:
        return {'ok': False, 'reason': 'plan_not_found'}
    result = await _run_pytest()
    await db.ai_build_plans.update_one(
        {'plan_id': plan_id},
        {'$set': {'test_run': result}},
    )
    return {'ok': True, **result}


@router.post('/run-tests/{plan_id}')
async def trigger_tests(plan_id: str, op: dict = Depends(get_current_operator)):
    """Operator-triggered pytest run for a specific AI Build plan.
    Runs synchronously (pytest is fast) and returns the verdict body
    directly so the UI can show a green/red badge without re-fetching."""
    result = await run_tests_for_plan(plan_id)
    if not result.get('ok'):
        raise HTTPException(404, 'Plan not found')
    return result


@router.get('/run-tests/{plan_id}')
async def get_test_run(plan_id: str, op: dict = Depends(get_current_operator)):
    """Read the last stored test verdict (no run)."""
    doc = await db.ai_build_plans.find_one({'plan_id': plan_id}, {'test_run': 1})
    if not doc:
        raise HTTPException(404, 'Plan not found')
    return doc.get('test_run') or {'verdict': 'not_run', 'summary': 'pytest has not been run on this plan yet.'}

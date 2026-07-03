"""Lightweight in-process rate limiting.

Used to cap expensive operator actions (LLM-backed AI-build plan/PR calls) so a
compromised or misbehaving operator account cannot trigger unbounded model spend
via rapid plan/review loops — one of the concerns raised by code review.

This is a simple per-key sliding-window counter kept in memory. It is
intentionally dependency-free (no Redis) and process-local, which is sufficient
for the single-worker backend here. If the app is ever scaled to multiple
workers, swap the store for Redis/Mongo behind the same `check()` interface.
"""
from __future__ import annotations

import time
import threading
from collections import defaultdict, deque

from fastapi import HTTPException

# key -> deque[timestamps]
_hits: dict[str, deque] = defaultdict(deque)
_lock = threading.Lock()


def check(key: str, *, limit: int, window_seconds: int) -> None:
    """Record a hit for `key`; raise HTTP 429 if it exceeds `limit` per window.

    Args:
        key: unique bucket, e.g. f"ai-build:plan:{operator_id}".
        limit: max allowed hits within the window.
        window_seconds: rolling window length in seconds.
    """
    now = time.monotonic()
    cutoff = now - window_seconds
    with _lock:
        q = _hits[key]
        # Drop timestamps older than the window.
        while q and q[0] < cutoff:
            q.popleft()
        if len(q) >= limit:
            retry_after = max(1, int(q[0] + window_seconds - now))
            raise HTTPException(
                status_code=429,
                detail=(
                    f'Rate limit exceeded: max {limit} requests per '
                    f'{window_seconds}s. Try again in ~{retry_after}s.'
                ),
                headers={'Retry-After': str(retry_after)},
            )
        q.append(now)


def rate_limit_operator(operator: dict, action: str, *, limit: int, window_seconds: int) -> None:
    """Convenience wrapper that buckets by the operator's id (falls back to email)."""
    op_id = str(operator.get('id') or operator.get('sub') or operator.get('email') or 'operator')
    check(f'{action}:{op_id}', limit=limit, window_seconds=window_seconds)

import React, { useEffect, useState } from 'react';

/**
 * SessionStatusDot — tiny live indicator for "am I still signed in?".
 *
 *   • green pulse → `/api/auth/me` returned 200 in the last poll
 *   • amber       → network error (offline / backend unreachable)
 *   • red         → `/api/auth/me` returned 401 — session expired
 *
 * The JWT lives in an httpOnly cookie so we can't decode `exp` from JS.
 * Instead we lightly ping `/auth/me` every 30s + on visibility-change.
 * Cheap (cached projection), invisible (no UI churn), and gives the
 * operator a "you're about to bounce" warning before they hit a 401
 * page mid-action.
 */
export default function SessionStatusDot({ position = 'corner' }) {
  const [tick, setTick] = useState(0);
  const [state, setState] = useState('green');

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    const onVis = () => { if (!document.hidden) setTick((t) => t + 1); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVis); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${process.env.REACT_APP_BACKEND_URL}/api/auth/me`, {
          credentials: 'include',
        });
        if (!cancelled) setState(r.ok ? 'green' : 'red');
      } catch {
        if (!cancelled) setState('amber');
      }
    })();
    return () => { cancelled = true; };
  }, [tick]);

  const palette =
    state === 'green'
      ? 'bg-emerald-400 ring-emerald-300/40'
      : state === 'amber'
        ? 'bg-amber-400 ring-amber-300/40'
        : 'bg-rose-500 ring-rose-300/40';
  const title =
    state === 'green'
      ? 'Signed in — session valid'
      : state === 'amber'
        ? 'Connection unstable — refresh if pages start failing'
        : 'Session expired — sign in again';

  // `corner` mode anchors against an absolute-positioned parent (avatar
  // bubble in the Navbar). `inline` is a free-standing pill for headers
  // that don't have an avatar to lean on.
  if (position === 'inline') {
    return (
      <span
        data-testid="session-status-dot"
        data-state={state}
        title={title}
        className="relative inline-flex h-2 w-2 flex-shrink-0"
      >
        <span className={`relative inline-flex h-2 w-2 rounded-full ring-2 ring-slate-900 ${palette}`} />
        {state === 'green' && (
          <span className="absolute inset-0 h-2 w-2 animate-ping rounded-full bg-emerald-400 opacity-60" />
        )}
      </span>
    );
  }

  return (
    <span
      data-testid="session-status-dot"
      data-state={state}
      title={title}
      className={`absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full ring-2 ring-slate-900 ${palette}`}
    >
      {state === 'green' && (
        <span className="absolute inset-0 h-2 w-2 animate-ping rounded-full bg-emerald-400 opacity-60" />
      )}
    </span>
  );
}

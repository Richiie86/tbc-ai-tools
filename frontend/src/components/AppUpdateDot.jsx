import React, { useCallback, useEffect, useRef, useState } from 'react';

/**
 * AppUpdateDot — tiny live indicator for "is this app up to date?".
 *
 *   • green  → you're running the latest deployed build
 *   • amber  → checking / can't verify right now (offline or blocked)
 *   • blue   → a NEWER build has shipped — click to refresh onto it
 *
 * How it works (no backend needed): Create React App writes an
 * `/asset-manifest.json` that changes on every deploy (hashed bundle
 * filenames). We snapshot it on first load, then re-fetch it every 60s +
 * whenever the tab regains focus. If the served manifest differs from the
 * one we booted with, a new build is live and we flip to "update available".
 *
 * This replaces the old sign-in dot: the operator asked for the dot to
 * mean "app-update status", so a colour + click here tells them at a
 * glance whether they're on the freshest code.
 */
const MANIFEST_URL = '/asset-manifest.json';
const POLL_MS = 60_000;

async function fetchManifest() {
  const res = await fetch(`${MANIFEST_URL}?_=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`manifest ${res.status}`);
  const json = await res.json();
  // Fingerprint the hashed entrypoints — those change on every build.
  return JSON.stringify(json.files || json.entrypoints || json);
}

export default function AppUpdateDot({ position = 'corner' }) {
  // 'checking' until the first fetch resolves, then 'current' | 'update' | 'unknown'.
  const [state, setState] = useState('checking');
  const baselineRef = useRef(null);

  const check = useCallback(async () => {
    try {
      const fp = await fetchManifest();
      if (baselineRef.current == null) {
        baselineRef.current = fp;
        setState('current');
        return;
      }
      setState(fp === baselineRef.current ? 'current' : 'update');
    } catch {
      // Couldn't verify — don't cry wolf, just show "checking/unknown".
      setState((s) => (s === 'update' ? 'update' : 'unknown'));
    }
  }, []);

  useEffect(() => {
    check();
    const id = setInterval(() => { if (!document.hidden) check(); }, POLL_MS);
    const onVis = () => { if (!document.hidden) check(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVis); };
  }, [check]);

  const tone =
    state === 'update' ? 'blue'
      : state === 'current' ? 'green'
        : 'amber'; // checking + unknown both read as amber

  const palette =
    tone === 'green'
      ? 'bg-emerald-400 ring-emerald-300/40'
      : tone === 'blue'
        ? 'bg-sky-400 ring-sky-300/40'
        : 'bg-amber-400 ring-amber-300/40';

  const title =
    state === 'current' ? 'App is up to date — you have the latest build'
      : state === 'update' ? 'A new build is available — click to refresh'
        : state === 'checking' ? 'Checking for updates…'
          : 'Could not check for updates — will retry shortly';

  const dot = (
    <>
      <span className={`relative inline-flex h-2 w-2 rounded-full ring-2 ring-slate-900 ${palette}`} />
      {(tone === 'green' || tone === 'blue') && (
        <span className={`absolute inset-0 h-2 w-2 animate-ping rounded-full opacity-60 ${tone === 'blue' ? 'bg-sky-400' : 'bg-emerald-400'}`} />
      )}
    </>
  );

  const onClick = state === 'update' ? () => window.location.reload() : undefined;

  // Inline: free-standing pill for headers. When an update is available we
  // render a small "Update" affordance so the meaning is unmistakable.
  if (position === 'inline') {
    if (state === 'update') {
      return (
        <button
          type="button"
          onClick={onClick}
          data-testid="app-update-dot"
          data-state={state}
          title={title}
          className="inline-flex items-center gap-1.5 rounded-full border border-sky-400/40 bg-sky-500/10 px-2 py-0.5 text-[11px] font-semibold text-sky-200 transition hover:bg-sky-500/20"
        >
          <span className="relative inline-flex h-2 w-2">{dot}</span>
          Update
        </button>
      );
    }
    return (
      <span
        data-testid="app-update-dot"
        data-state={state}
        title={title}
        className="relative inline-flex h-2 w-2 flex-shrink-0"
      >
        {dot}
      </span>
    );
  }

  // Corner: anchors against an absolute-positioned parent (avatar bubble).
  return (
    <span
      data-testid="app-update-dot"
      data-state={state}
      title={title}
      onClick={onClick}
      className={`absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full ring-2 ring-slate-900 ${palette} ${onClick ? 'cursor-pointer' : ''}`}
    >
      {(tone === 'green' || tone === 'blue') && (
        <span className={`absolute inset-0 h-2 w-2 animate-ping rounded-full opacity-60 ${tone === 'blue' ? 'bg-sky-400' : 'bg-emerald-400'}`} />
      )}
    </span>
  );
}

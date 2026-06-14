import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Bell, Loader2, Sparkles, Tag, X } from 'lucide-react';
import api from '../lib/api';

/**
 * "What's new" popover that lives next to the user avatar in the navbar.
 *
 * Pulls from `GET /api/changelog` on mount + every 60s. Displays a blue
 * dot when `unread_count > 0`. Opening the popover fires
 * `POST /api/changelog/mark-read` so the dot clears — but only once per
 * open, never on hover (matches Slack/Linear behaviour).
 *
 * Layout: dropdown anchored to the bell icon; click-outside + ESC close.
 * Per-entry body_md rendered as plain-text with newlines preserved —
 * keeps the popover lightweight (no markdown lib).
 */
export default function WhatsNewPopover() {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const rootRef = useRef(null);
  const markedRef = useRef(false);  // ensure mark-read fires once per open

  const load = useCallback(async () => {
    // Skip the fetch when no auth cookie/header is present — the bell
    // mounts inside the Navbar which renders on public pages too, and
    // we'd otherwise emit a noisy 401 in the browser console.
    if (!document.cookie.includes('session') && !localStorage.getItem('token')) {
      setLoading(false);
      setEntries([]);
      setUnread(0);
      return;
    }
    try {
      const { data } = await api.get('/changelog?limit=10');
      setEntries(data?.entries || []);
      setUnread(Number(data?.unread_count || 0));
    } catch {
      // Anonymous / unauthed responses just hide the dot — popover stays empty.
      setEntries([]);
      setUnread(0);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  // Mark-read fires the first time the popover opens since last close.
  useEffect(() => {
    if (!open || markedRef.current || unread === 0) return;
    markedRef.current = true;
    api.post('/changelog/mark-read').catch(() => { /* non-fatal */ });
    setUnread(0);
  }, [open, unread]);

  // Click outside + ESC to close.
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (!rootRef.current?.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const toggle = () => {
    if (open) markedRef.current = false;  // reset so next open re-marks
    setOpen(!open);
  };

  return (
    <div ref={rootRef} className="relative" data-testid="whats-new-root">
      <button
        type="button"
        onClick={toggle}
        aria-label="What's new"
        data-testid="whats-new-bell"
        className="relative grid h-9 w-9 place-items-center rounded-lg border border-slate-800 bg-slate-900/60 text-slate-200 hover:bg-slate-800 transition-colors"
      >
        <Bell className="h-4 w-4" />
        {unread > 0 && (
          <span
            data-testid="whats-new-unread-dot"
            className="absolute -right-0.5 -top-0.5 grid h-4 min-w-[1rem] place-items-center rounded-full bg-tbc-400 px-1 text-[9px] font-bold text-ink-950"
          >
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          data-testid="whats-new-popover"
          className="absolute right-0 z-40 mt-2 w-[22rem] overflow-hidden rounded-xl border border-slate-800 bg-slate-900 text-slate-100 shadow-xl"
        >
          <header className="flex items-center justify-between border-b border-slate-800 px-4 py-2.5">
            <div className="flex items-center gap-2 text-sm font-bold">
              <Sparkles className="h-4 w-4 text-tbc-300" /> What's new
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-slate-400 hover:text-slate-200"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </header>

          <div className="max-h-[28rem] overflow-y-auto" data-testid="whats-new-list">
            {loading ? (
              <div className="grid place-items-center py-8">
                <Loader2 className="h-4 w-4 animate-spin text-slate-400" />
              </div>
            ) : entries.length === 0 ? (
              <div className="px-4 py-6 text-center text-xs text-slate-400">
                No updates yet — when we ship something, you'll see it here.
              </div>
            ) : (
              <ul className="divide-y divide-slate-800">
                {entries.map((e) => (
                  <li
                    key={e.id}
                    data-testid={`whats-new-entry-${e.id}`}
                    className="px-4 py-3"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <h4 className="text-sm font-semibold text-slate-100">{e.title}</h4>
                      {e.tag && (
                        <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-tbc-500/15 px-1.5 py-0.5 text-[9px] font-mono uppercase text-tbc-300">
                          <Tag className="h-2.5 w-2.5" />{e.tag}
                        </span>
                      )}
                    </div>
                    {e.body_md && (
                      <p className="mt-1 whitespace-pre-wrap text-[11px] text-slate-300/90">
                        {e.body_md}
                      </p>
                    )}
                    <div className="mt-1.5 flex items-center gap-2 text-[10px] text-slate-500">
                      <time dateTime={e.created_at}>
                        {e.created_at ? new Date(e.created_at).toLocaleString() : ''}
                      </time>
                      {e.source === 'promote' && (
                        <span className="rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[9px] text-emerald-300">
                          deploy
                        </span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

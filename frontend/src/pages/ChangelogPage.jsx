import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, Sparkles, Tag, Loader2, Activity } from 'lucide-react';
import api from '../lib/api';

/**
 * Public changelog page (`/changelog`). Reads `/api/changelog/public` —
 * no auth. Designed as a marketing trust signal for tbctools.org: shows
 * the cadence of shipped updates, deploy badges, and version tags.
 */
export default function ChangelogPage() {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  useEffect(() => {
    api.get('/changelog/public?limit=30')
      .then((r) => setEntries(r.data?.entries || []))
      .catch((e) => setErr(e?.response?.data?.detail || 'Could not load changelog'))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="min-h-screen bg-ink-950 text-tbc-100">
      <header className="border-b border-tbc-900/60 bg-ink-900/60">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
          <Link to="/" className="flex items-center gap-2 text-tbc-100 hover:text-tbc-300">
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-tbc-500/15 text-tbc-300">
              <Sparkles className="h-4 w-4" />
            </span>
            <div>
              <div className="text-sm font-bold">TBC AI Tools</div>
              <div className="text-[10px] uppercase tracking-wider text-tbc-200/50">Changelog</div>
            </div>
          </Link>
          <Link
            to="/"
            className="inline-flex items-center gap-1 rounded-md border border-tbc-900/60 bg-ink-900 px-3 py-1.5 text-xs text-tbc-200 hover:bg-ink-950"
          >
            <ChevronLeft className="h-3 w-3" /> Home
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-10" data-testid="changelog-page">
        <h1 className="text-4xl sm:text-5xl font-bold tracking-tight">What we've shipped</h1>
        <p className="mt-2 max-w-xl text-base text-tbc-200/70">
          Every production promote shows up here automatically. No fluff, no marketing copy —
          just what changed and when.
        </p>

        <div className="mt-8">
          {loading ? (
            <div className="grid place-items-center py-16 text-tbc-200/40">
              <Loader2 className="h-6 w-6 animate-spin" />
            </div>
          ) : err ? (
            <div className="rounded-xl border border-rose-500/40 bg-rose-500/[0.06] px-6 py-6 text-center text-rose-200">
              {err}
            </div>
          ) : entries.length === 0 ? (
            <div className="rounded-xl border border-tbc-900/60 bg-ink-900/40 px-6 py-12 text-center">
              <p className="text-tbc-200/70">No updates yet — check back soon.</p>
            </div>
          ) : (
            <ol className="space-y-6" data-testid="changelog-list">
              {entries.map((e) => (
                <li
                  key={e.id}
                  data-testid={`changelog-entry-${e.id}`}
                  className="rounded-xl border border-tbc-900/60 bg-ink-900/40 p-5"
                >
                  <div className="flex items-start justify-between gap-3">
                    <h2 className="text-base font-semibold text-tbc-100">{e.title}</h2>
                    <div className="flex shrink-0 items-center gap-2">
                      {e.tag && (
                        <span className="inline-flex items-center gap-0.5 rounded-full bg-tbc-500/15 px-2 py-0.5 text-[10px] font-mono uppercase text-tbc-300">
                          <Tag className="h-2.5 w-2.5" />{e.tag}
                        </span>
                      )}
                      {e.source === 'promote' && (
                        <span className="inline-flex items-center gap-0.5 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] uppercase text-emerald-300">
                          <Activity className="h-2.5 w-2.5" />deploy
                        </span>
                      )}
                    </div>
                  </div>
                  {e.body_md && (
                    <p className="mt-2 whitespace-pre-wrap text-sm text-tbc-200/85">{e.body_md}</p>
                  )}
                  <time className="mt-3 block text-[11px] text-tbc-200/50" dateTime={e.created_at}>
                    {e.created_at ? new Date(e.created_at).toLocaleString() : ''}
                  </time>
                </li>
              ))}
            </ol>
          )}
        </div>

        <footer className="mt-12 border-t border-tbc-900/60 pt-4 text-[11px] text-tbc-200/50">
          <p>
            Want to know more? <Link to="/status" className="text-tbc-300 hover:text-tbc-100 underline">System status</Link> ·{' '}
            <Link to="/contact" className="text-tbc-300 hover:text-tbc-100 underline">Contact</Link>
          </p>
        </footer>
      </main>
    </div>
  );
}

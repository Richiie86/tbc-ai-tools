import React from 'react';
import { Activity, Terminal, Rocket, ExternalLink, Loader2, Trash2 } from 'lucide-react';

/**
 * Wipe every client-side cache so the browser is forced to pull the freshest
 * build and data on the next load. This is the fix for "I deployed but still
 * see the old version / a stale screen" — it clears the Cache Storage API,
 * sessionStorage and localStorage, then hard-reloads.
 *
 * The login session lives in an httpOnly `tbc_session` cookie that JavaScript
 * cannot read or clear, so the operator stays signed in afterwards.
 */
async function clearClientCaches() {
  try {
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch (e) {
    console.warn('clearClientCaches: Cache API clear failed (ignored)', e?.message);
  }
  try {
    // Ask any service workers to unregister so a stale precache can't respawn.
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
  } catch (e) {
    console.warn('clearClientCaches: SW unregister failed (ignored)', e?.message);
  }
  try { sessionStorage.clear(); } catch (_) {}
  try { localStorage.clear(); } catch (_) {}
  // Cache-busting reload so index.html + JS bundles are re-fetched from origin.
  const url = new URL(window.location.href);
  url.searchParams.set('_cc', Date.now().toString());
  window.location.replace(url.toString());
}

/**
 * Top-of-tab neon-indigo quick actions: Health check · Code review · Re-deploy.
 * Each callback is wired up by the parent so they can share the loading state.
 */
export function OpsQuickActions({
  onHealth, onReview, healthLoading, reviewLoading, healthSummary,
}) {
  const [clearing, setClearing] = React.useState(false);

  const handleClearCache = async () => {
    if (clearing) return;
    const ok = window.confirm(
      'Clear cached data and reload?\n\nThis wipes this browser\u2019s cached app files and local data so you get the freshest deployed version. You will stay signed in.',
    );
    if (!ok) return;
    setClearing(true);
    await clearClientCaches();
  };

  return (
    <section>
      <div className="grid gap-3 sm:grid-cols-3">
        <button
          data-testid="ops-quick-health"
          onClick={onHealth}
          disabled={healthLoading}
          className="group relative overflow-hidden rounded-xl border border-indigo-400/40 bg-indigo-600/90 px-5 py-4 text-left transition hover:bg-indigo-500 hover:border-indigo-300 hover:shadow-[0_0_24px_rgba(99,102,241,0.55)] disabled:opacity-60"
        >
          <div className="absolute inset-0 bg-gradient-to-br from-indigo-400/20 to-transparent opacity-0 transition group-hover:opacity-100" />
          <div className="relative flex items-center gap-3">
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-indigo-300/20 text-indigo-100 ring-1 ring-indigo-300/40">
              {healthLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Activity className="h-4 w-4" />}
            </span>
            <div>
              <div className="text-sm font-bold text-white">Run health check</div>
              <div className="text-[11px] text-indigo-100/80">
                {healthSummary ? `${healthSummary.passing}/${healthSummary.total} passing` : 'tap to scan'}
              </div>
            </div>
          </div>
        </button>

        <button
          data-testid="ops-quick-review"
          onClick={onReview}
          disabled={reviewLoading}
          className="group relative overflow-hidden rounded-xl border border-indigo-500/40 bg-indigo-800/95 px-5 py-4 text-left transition hover:bg-indigo-700 hover:border-indigo-400 hover:shadow-[0_0_24px_rgba(79,70,229,0.55)] disabled:opacity-60"
        >
          <div className="absolute inset-0 bg-gradient-to-br from-indigo-500/20 to-transparent opacity-0 transition group-hover:opacity-100" />
          <div className="relative flex items-center gap-3">
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-indigo-400/20 text-indigo-100 ring-1 ring-indigo-400/40">
              {reviewLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Terminal className="h-4 w-4" />}
            </span>
            <div>
              <div className="text-sm font-bold text-white">Run code review</div>
              <div className="text-[11px] text-indigo-100/80">ruff lint + format</div>
            </div>
          </div>
        </button>

        <a
          data-testid="ops-quick-redeploy"
          href="/dashboard"
          className="group relative overflow-hidden rounded-xl border border-indigo-300/60 bg-indigo-500 px-5 py-4 text-left transition hover:bg-indigo-400 hover:border-indigo-200 hover:shadow-[0_0_32px_rgba(129,140,248,0.75)]"
        >
          <div className="absolute inset-0 bg-gradient-to-br from-white/15 to-transparent opacity-0 transition group-hover:opacity-100" />
          <div className="relative flex items-center gap-3">
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-white/15 text-white ring-1 ring-white/30">
              <Rocket className="h-4 w-4" />
            </span>
            <div className="flex-1">
              <div className="text-sm font-bold text-white">Re-deploy changes</div>
              <div className="text-[11px] text-indigo-100/90 flex items-center gap-1">
                Open the Deploy button in chat <ExternalLink className="h-2.5 w-2.5" />
              </div>
            </div>
          </div>
        </a>
      </div>

      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-[11px] text-tbc-200/40">
          Deploy, health check and code review all run from the Deploy controls in the chat header.
        </p>
        <button
          data-testid="ops-clear-cache"
          onClick={handleClearCache}
          disabled={clearing}
          title="Wipe cached files and local data, then reload the freshest deployed version. You stay signed in."
          className="inline-flex shrink-0 items-center gap-2 self-start rounded-lg border border-tbc-900/70 bg-ink-900/80 px-3 py-2 text-xs font-semibold text-tbc-100 transition hover:border-tbc-500/60 hover:bg-ink-800 disabled:opacity-60 sm:self-auto"
        >
          {clearing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
          {clearing ? 'Clearing…' : 'Clear cache & reload'}
        </button>
      </div>
    </section>
  );
}

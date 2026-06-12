import React from 'react';
import { Activity, Terminal, Rocket, ExternalLink, Loader2 } from 'lucide-react';

/**
 * Top-of-tab neon-indigo quick actions: Health check · Code review · Re-deploy.
 * Each callback is wired up by the parent so they can share the loading state.
 */
export function OpsQuickActions({
  onHealth, onReview, healthLoading, reviewLoading, healthSummary,
}) {
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
          href="https://app.emergent.sh/chat"
          target="_blank"
          rel="noreferrer"
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
                Opens Emergent deploy <ExternalLink className="h-2.5 w-2.5" />
              </div>
            </div>
          </div>
        </a>
      </div>
      <p className="mt-2 text-[11px] text-tbc-200/40">
        Heads-up: the deploy itself runs on Emergent&apos;s side. Health check + code review run live inside this app.
      </p>
    </section>
  );
}

import React from 'react';
import { Rocket } from 'lucide-react';

/**
 * BuildBadge — a tiny but unmistakable visual marker that proves the
 * latest code reached production. Sits at the top of the Operator
 * console. Click it to see the full build details in a popover.
 *
 * Bump `BUILD_TAG` whenever we cut a meaningful release. If you can see
 * the tag on tbctools.org, the deploy worked.
 */
const BUILD_TAG = 'v2.4 · Feb 2026';
const BUILD_HIGHLIGHTS = [
  'Backup / restore: copy projects + codes between environments',
  'Universal operator search: ⌘K finds tabs, settings, users, projects, contacts, audit',
  'One-click "Push Code" button (Ops tab)',
  'AI improvement suggestions (per project)',
  'Operator Security card: re-registration approvals + KYC bypass',
  'Frontend health-check: skipped gracefully on serverless prod',
];

export default function BuildBadge() {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="relative inline-flex" data-testid="build-badge">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/50 bg-gradient-to-r from-amber-500/15 to-tbc-500/15 px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-amber-200 shadow-[0_0_12px_rgba(251,191,36,0.35)] transition hover:from-amber-500/25 hover:to-tbc-500/25"
      >
        <Rocket className="h-3 w-3" />
        Build {BUILD_TAG}
      </button>
      {open && (
        <div
          role="dialog"
          className="absolute left-0 top-full z-50 mt-2 w-72 rounded-xl border border-tbc-900/70 bg-ink-950/95 p-3 shadow-2xl backdrop-blur-sm"
          data-testid="build-badge-popover"
        >
          <p className="text-[10px] font-bold uppercase tracking-wider text-amber-300">
            What shipped in this build
          </p>
          <ul className="mt-2 space-y-1.5">
            {BUILD_HIGHLIGHTS.map((h) => (
              <li key={h} className="flex gap-2 text-xs text-tbc-100/90">
                <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
                <span>{h}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 border-t border-tbc-900/60 pt-2 text-[10px] text-tbc-200/50">
            If you can see this badge on tbctools.org, the latest build deployed
            successfully. Tap to close.
          </p>
        </div>
      )}
    </div>
  );
}

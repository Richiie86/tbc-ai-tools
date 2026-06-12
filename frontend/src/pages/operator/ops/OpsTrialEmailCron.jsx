import React from 'react';
import { Button } from '../../../components/ui/button';
import { Mail, Loader2 } from 'lucide-react';

/** Trial-reminder cron controls + result panel. */
export function OpsTrialEmailCron({ trialRun, busy, onRun }) {
  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-sky-500/15 text-sky-300">
            <Mail className="h-4 w-4" />
          </span>
          <div>
            <h3 className="text-base font-bold text-tbc-100">Trial reminder emails</h3>
            <p className="text-xs text-tbc-200/60">
              Runs automatically every hour. Sends a T-3 days reminder + a T-0 expired notice per user — idempotently.
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button
            data-testid="ops-trial-dryrun"
            variant="outline"
            onClick={() => onRun(true)}
            disabled={busy}
            className="border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950"
          >
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Preview (dry-run)
          </Button>
          <Button
            data-testid="ops-trial-run"
            onClick={() => onRun(false)}
            disabled={busy}
            className="bg-tbc-500 text-ink-950 hover:bg-tbc-400 font-semibold"
          >
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Mail className="mr-2 h-4 w-4" />}
            Send now
          </Button>
        </div>
      </div>

      {trialRun && (
        <div className="rounded-xl border border-tbc-900/60 bg-ink-900/60 p-4" data-testid="ops-trial-output">
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <span className="rounded-full border border-sky-500/30 bg-sky-500/10 px-3 py-1 text-sky-300">
              T-3 sent: <strong>{trialRun.t3_sent}</strong>
            </span>
            <span className="rounded-full border border-rose-500/30 bg-rose-500/10 px-3 py-1 text-rose-300">
              Expired sent: <strong>{trialRun.expired_sent}</strong>
            </span>
            {trialRun.errors > 0 && (
              <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-amber-300">
                Errors: <strong>{trialRun.errors}</strong>
              </span>
            )}
            {trialRun.dry_run && (
              <span className="rounded-full border border-tbc-900/60 bg-ink-950 px-3 py-1 text-tbc-200/60">
                dry-run · no emails sent
              </span>
            )}
            <span className="text-tbc-200/40">ran {new Date(trialRun.ran_at).toLocaleTimeString()}</span>
          </div>
          {trialRun.events?.length > 0 && (
            <ul className="mt-3 space-y-1 text-xs">
              {trialRun.events.slice(0, 8).map((ev) => (
                <li key={`${ev.type}-${ev.email}`} className="flex items-center justify-between rounded bg-ink-950 px-2 py-1">
                  <span className="text-tbc-100">{ev.email}</span>
                  <span className={ev.error ? 'text-rose-300' : ev.type === 't3' ? 'text-sky-300' : 'text-rose-200'}>
                    {ev.error
                      ? `error: ${ev.error}`
                      : ev.type === 't3' ? `T-${ev.days_left}` : 'expired'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

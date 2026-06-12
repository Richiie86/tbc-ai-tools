import React from 'react';
import { Button } from '../../../components/ui/button';
import { Card } from '../../../components/ui/card';
import {
  RotateCw, Loader2, ServerCog, Rocket, GitBranch, ExternalLink, Copy, Check,
} from 'lucide-react';

/** Restart services + Deploy/Redeploy cards (paired in a two-column section). */
export function OpsRestartAndDeploy({
  restartingSvc, onRestart, deployInfo, copied, onCopyCommit,
}) {
  return (
    <section className="grid gap-4 lg:grid-cols-2">
      <Card className="border-tbc-900/60 bg-ink-900/60 p-5">
        <div className="mb-3 flex items-center gap-2">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-amber-500/15 text-amber-300">
            <RotateCw className="h-4 w-4" />
          </span>
          <div>
            <h3 className="text-base font-bold text-tbc-100">Restart services</h3>
            <p className="text-xs text-tbc-200/60">In-cluster soft restart. Use this if a service feels stuck.</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {['backend', 'frontend', 'all'].map((svc) => (
            <Button
              key={svc}
              data-testid={`ops-restart-${svc}`}
              onClick={() => onRestart(svc)}
              disabled={restartingSvc !== null}
              variant="outline"
              className="border-tbc-900/60 bg-ink-950 text-tbc-100 hover:bg-ink-900"
            >
              {restartingSvc === svc
                ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                : <ServerCog className="mr-2 h-4 w-4" />}
              {svc === 'all' ? 'Restart everything' : `Restart ${svc}`}
            </Button>
          ))}
        </div>
      </Card>

      <Card className="border-tbc-500/30 bg-gradient-to-br from-tbc-500/10 via-ink-900/60 to-ink-900/60 p-5">
        <div className="mb-3 flex items-center gap-2">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-tbc-500/20 text-tbc-300">
            <Rocket className="h-4 w-4" />
          </span>
          <div>
            <h3 className="text-base font-bold text-tbc-100">Deploy / Redeploy</h3>
            <p className="text-xs text-tbc-200/60">
              Production deploy is triggered from Emergent&apos;s top-right Deploy button.
            </p>
          </div>
        </div>

        {deployInfo && (
          <div className="rounded-lg border border-tbc-900/60 bg-ink-950 p-3">
            <div className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-1.5 text-tbc-200/70">
                <GitBranch className="h-3.5 w-3.5" />
                Latest commit
              </div>
              <button
                data-testid="ops-copy-commit"
                onClick={onCopyCommit}
                className="inline-flex items-center gap-1 rounded border border-tbc-900/60 bg-ink-900 px-2 py-0.5 text-[11px] text-tbc-200 hover:bg-ink-950"
              >
                {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                {copied ? 'copied' : (deployInfo.commit?.sha || '—')}
              </button>
            </div>
            <div className="mt-1 truncate text-sm font-semibold text-tbc-100" title={deployInfo.commit?.subject}>
              {deployInfo.commit?.subject || '—'}
            </div>
            <div className="mt-1 text-[11px] text-tbc-200/50">
              {deployInfo.commit?.author} · {deployInfo.commit?.date ? new Date(deployInfo.commit.date).toLocaleString() : '—'}
            </div>
          </div>
        )}

        <ol className="mt-3 space-y-1 text-xs text-tbc-200/70">
          <li>1. Click <strong className="text-tbc-100">Deploy</strong> in the Emergent chat panel (top right).</li>
          <li>2. Wait for the green check — your preview &amp; production update together.</li>
          <li>3. Hit <strong className="text-tbc-100">Refresh</strong> on Health Check above to confirm.</li>
        </ol>

        <a
          href="https://app.emergent.sh"
          target="_blank"
          rel="noreferrer"
          className="mt-3 inline-flex items-center gap-1 text-xs text-tbc-300 hover:text-tbc-200"
        >
          Open Emergent <ExternalLink className="h-3 w-3" />
        </a>
      </Card>
    </section>
  );
}

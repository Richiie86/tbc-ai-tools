import React, { useState } from 'react';
import {
  ShieldCheck, FileCode2, Loader2, CheckCircle2, XCircle,
  Rocket, GitPullRequest, ExternalLink,
} from 'lucide-react';
import { toast } from 'sonner';
import { streamApplyProposal, rejectProposal } from '../../lib/api';

// Human labels for the Vercel deploy states we stream back while waiting.
const STATE_LABEL = {
  QUEUED: 'Queued…',
  INITIALIZING: 'Initializing…',
  BUILDING: 'Building…',
  READY: 'Live',
  ERROR: 'Build failed',
  CANCELED: 'Build canceled',
};

/**
 * The Allow/Build approval gate. Every AI code change is staged as a proposal;
 * nothing touches the repo or the live app until the user presses Allow here.
 *
 * On approve it streams the commit + (for the operator) the deploy, WAITING for
 * the build and showing live progress so the user knows it's not done yet, then
 * reports the live URL. Reject discards the change with zero side effects.
 */
export default function ProposalGate({ proposal, sessionId, onDone }) {
  const [phase, setPhase] = useState('pending'); // pending | applying | done | error | rejected
  const [log, setLog] = useState('');
  const [deploy, setDeploy] = useState(null); // { state, elapsed, url, done }
  const [busy, setBusy] = useState(false);

  const {
    proposal_id: proposalId, files = [], summary,
    is_platform: isPlatform, will_deploy: willDeploy, will_pr: willPr,
  } = proposal || {};

  const allowLabel = willPr ? 'Allow & Open PR' : willDeploy ? 'Allow & Build' : 'Allow & Save';
  const AllowIcon = willPr ? GitPullRequest : willDeploy ? Rocket : CheckCircle2;

  async function approve() {
    if (busy) return;
    setBusy(true);
    setPhase('applying');
    setLog('');
    setDeploy(null);
    try {
      for await (const ev of streamApplyProposal(sessionId, proposalId)) {
        if (ev.type === 'delta') {
          setLog((t) => t + (ev.content || ''));
        } else if (ev.type === 'deploy_progress') {
          setDeploy({ state: ev.state, elapsed: ev.elapsed, url: ev.url });
        } else if (ev.type === 'deploy_done') {
          setDeploy({ state: ev.state, elapsed: null, url: ev.url, done: true });
        } else if (ev.type === 'done') {
          break;
        } else if (ev.type === 'error') {
          throw new Error(ev.message || 'Apply failed');
        }
      }
      setPhase('done');
      onDone?.({ status: 'applied' });
    } catch (e) {
      setPhase('error');
      toast.error(e.message || 'Could not apply the change');
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    if (busy) return;
    setBusy(true);
    try {
      await rejectProposal(sessionId, proposalId);
      setPhase('rejected');
      onDone?.({ status: 'rejected' });
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Could not discard the change');
    } finally {
      setBusy(false);
    }
  }

  if (phase === 'rejected') {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-900/40 px-4 py-3 text-sm text-slate-400">
        <XCircle className="h-4 w-4 shrink-0 text-slate-500" />
        Change discarded — nothing was committed or deployed.
      </div>
    );
  }

  const deployLive = deploy?.done && deploy?.state === 'READY';
  const deployFailed = deploy?.done && deploy?.state !== 'READY';

  return (
    <div className="overflow-hidden rounded-2xl border border-tbc-500/30 bg-slate-900/60">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-slate-800 bg-tbc-500/5 px-4 py-3">
        <ShieldCheck className="h-4 w-4 text-tbc-300" strokeWidth={2.4} />
        <span className="text-sm font-semibold text-white">Review changes before they apply</span>
        {isPlatform && (
          <span className="ml-auto rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-semibold text-amber-300">
            Platform · PR only
          </span>
        )}
      </div>

      <div className="px-4 py-3">
        <p className="text-xs text-slate-400">
          {files.length} file{files.length === 1 ? '' : 's'} will change. Nothing is
          committed or deployed until you approve.
        </p>

        {/* Changed files */}
        <ul className="mt-2 space-y-1">
          {files.map((f) => (
            <li key={f} className="flex items-center gap-2 text-[13px] text-slate-200">
              <FileCode2 className="h-3.5 w-3.5 shrink-0 text-tbc-300/70" />
              <code className="truncate">{f}</code>
            </li>
          ))}
        </ul>

        {summary && (
          <p className="mt-3 rounded-lg border border-slate-800 bg-ink-950/50 px-3 py-2 text-[13px] leading-relaxed text-slate-300">
            {summary}
          </p>
        )}

        {/* Live apply / deploy progress */}
        {phase !== 'pending' && (
          <div className="mt-3 rounded-lg border border-slate-800 bg-ink-950/60 px-3 py-2">
            {log && (
              <pre className="whitespace-pre-wrap break-words font-sans text-[13px] leading-relaxed text-slate-300">
                {log.trim()}
              </pre>
            )}
            {deploy && !deploy.done && (
              <div className="mt-1 flex items-center gap-2 text-[13px] text-tbc-200">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span>
                  {STATE_LABEL[deploy.state] || deploy.state}
                  {typeof deploy.elapsed === 'number' && deploy.elapsed > 0
                    ? ` (${deploy.elapsed}s — still going, hang tight)`
                    : ''}
                </span>
              </div>
            )}
            {deployLive && (
              <div className="mt-1 flex flex-wrap items-center gap-2 text-[13px] font-semibold text-emerald-300">
                <CheckCircle2 className="h-4 w-4" /> Live
                {deploy.url && (
                  <a
                    href={deploy.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-tbc-300 underline-offset-2 hover:underline"
                  >
                    Open <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
            )}
            {deployFailed && (
              <div className="mt-1 flex items-center gap-2 text-[13px] font-semibold text-red-300">
                <XCircle className="h-4 w-4" /> {STATE_LABEL[deploy.state] || deploy.state}
              </div>
            )}
          </div>
        )}

        {/* Actions */}
        {phase === 'pending' && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="proposal-allow"
              onClick={approve}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg bg-tbc-500 px-3.5 py-2 text-sm font-semibold text-ink-950 transition hover:bg-tbc-400 disabled:opacity-60"
            >
              <AllowIcon className="h-4 w-4" /> {allowLabel}
            </button>
            <button
              type="button"
              data-testid="proposal-reject"
              onClick={reject}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-ink-900 px-3.5 py-2 text-sm font-medium text-slate-200 transition hover:bg-ink-950 disabled:opacity-60"
            >
              <XCircle className="h-4 w-4" /> Reject
            </button>
            {willDeploy && (
              <span className="text-[11px] text-slate-500">
                Approving commits and deploys — I&apos;ll wait for the build.
              </span>
            )}
          </div>
        )}

        {phase === 'applying' && (
          <div className="mt-3 flex items-center gap-2 text-[13px] text-slate-400">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Applying — please keep this open.
          </div>
        )}

        {phase === 'error' && (
          <button
            type="button"
            onClick={approve}
            className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-ink-900 px-3.5 py-2 text-sm font-medium text-slate-200 hover:bg-ink-950"
          >
            <Rocket className="h-4 w-4" /> Retry
          </button>
        )}
      </div>
    </div>
  );
}

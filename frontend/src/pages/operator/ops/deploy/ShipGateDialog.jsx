import React from 'react';
import { ShieldCheck, MessageSquare, AlertTriangle, Loader2 } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '../../../../components/ui/dialog';
import { Button } from '../../../../components/ui/button';

const SEVERITY_TONE = {
  high: 'border-rose-500/40 bg-rose-500/10 text-rose-300',
  medium: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  low: 'border-tbc-500/40 bg-tbc-500/10 text-tbc-200',
};

/**
 * Modal shown when the backend ship-gate (HTTP 412) refuses a production
 * deploy because the last AI code review verdict was `do_not_ship`. Offers:
 *
 *   1. **Open fix chat** — jump to the pre-seeded chat session where the AI
 *      already has the findings as context, ready to propose patches.
 *   2. **Bypass and ship anyway** — operator-only override; the backend
 *      accepts `bypass_review=true` only because the caller is the operator
 *      (AI surface callers can also pass it but defaults stay safe).
 *   3. **Cancel** — close the dialog and do nothing.
 */
export function ShipGateDialog({ open, onOpenChange, project, block, onOpenChat, onBypass, busy }) {
  if (!block) return null;
  const review = block.review || {};
  const findings = Array.isArray(review.findings) ? review.findings : [];
  const high = findings.filter((f) => f.severity === 'high').length;
  const medium = findings.filter((f) => f.severity === 'medium').length;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid={`ship-gate-${project.id}`}
        className="max-h-[85vh] max-w-2xl overflow-y-auto border-rose-500/40 bg-ink-950 text-tbc-100"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-rose-200">
            <AlertTriangle className="h-5 w-5 text-rose-400" />
            Deploy blocked by AI code review
          </DialogTitle>
          <DialogDescription className="text-tbc-200/70">
            The last review of <code className="rounded bg-ink-900 px-1 font-mono text-tbc-300">{project.repo}</code>
            {' '}returned verdict
            {' '}<span className="font-semibold text-rose-300">{review.verdict || 'do_not_ship'}</span>.
            Resolve the findings or override at your own risk.
          </DialogDescription>
        </DialogHeader>

        {review.summary && (
          <p className="rounded-lg border border-tbc-900/60 bg-ink-900/60 p-3 text-sm leading-relaxed text-tbc-100/90">
            {review.summary}
          </p>
        )}

        <div className="flex flex-wrap gap-2 text-[11px]">
          {high > 0 && (
            <span className="rounded-full border border-rose-500/40 bg-rose-500/10 px-2 py-0.5 uppercase tracking-wider text-rose-300">
              {high} high
            </span>
          )}
          {medium > 0 && (
            <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 uppercase tracking-wider text-amber-300">
              {medium} medium
            </span>
          )}
          <span className="rounded-full border border-tbc-900/60 bg-ink-900 px-2 py-0.5 uppercase tracking-wider text-tbc-200/70">
            {findings.length} total
          </span>
        </div>

        {findings.length > 0 && (
          <div className="space-y-2">
            {findings.slice(0, 6).map((f, i) => (
              <div
                key={`${f.severity || 'low'}-${f.file || 'unknown'}-${i}`}
                data-testid={`ship-gate-finding-${project.id}-${i}`}
                className="rounded border border-tbc-900/60 bg-ink-900/60 p-2"
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className={`rounded-full border px-1.5 py-0.5 text-[9px] uppercase tracking-wider ${SEVERITY_TONE[f.severity] || SEVERITY_TONE.low}`}>
                    {f.severity || 'low'}
                  </span>
                  {f.file && (
                    <code className="rounded bg-ink-950 px-1 font-mono text-[10px] text-tbc-300">{f.file}</code>
                  )}
                  {f.title && (
                    <span className="text-xs font-semibold text-tbc-100">{f.title}</span>
                  )}
                </div>
              </div>
            ))}
            {findings.length > 6 && (
              <p className="text-[10px] text-tbc-200/60">
                {findings.length - 6} more findings — open the fix chat for the full list.
              </p>
            )}
          </div>
        )}

        <DialogFooter className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
            className="border-tbc-900/60 bg-ink-900 text-tbc-200 hover:bg-ink-950"
          >
            Cancel
          </Button>
          <Button
            data-testid={`ship-gate-bypass-${project.id}`}
            onClick={onBypass}
            disabled={busy}
            variant="outline"
            title="Operator override — ships despite the review"
            className="border-rose-500/40 bg-ink-900 text-rose-200 hover:bg-rose-500/10"
          >
            {busy ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : <AlertTriangle className="mr-1.5 h-3 w-3" />}
            Ship anyway
          </Button>
          <Button
            data-testid={`ship-gate-open-chat-${project.id}`}
            onClick={onOpenChat}
            disabled={busy || !block.fix_chat_session_id}
            className="bg-tbc-500 text-ink-950 hover:bg-tbc-400 font-semibold"
          >
            <MessageSquare className="mr-1.5 h-3 w-3" />
            Open fix chat
          </Button>
        </DialogFooter>

        <p className="mt-2 text-[10px] text-tbc-200/50">
          <ShieldCheck className="mr-1 inline h-2.5 w-2.5" />
          The fix chat is pre-seeded with the failing findings — just hit Send and the AI will draft patches.
        </p>
      </DialogContent>
    </Dialog>
  );
}

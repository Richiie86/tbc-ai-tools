import React from 'react';
import { ShieldCheck } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '../../../../components/ui/dialog';

const VERDICT_TONE = {
  ship: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
  ship_with_fixes: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  do_not_ship: 'border-rose-500/40 bg-rose-500/10 text-rose-300',
};
const SEVERITY_TONE = {
  high: 'border-rose-500/40 bg-rose-500/10 text-rose-300',
  medium: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  low: 'border-tbc-500/40 bg-tbc-500/10 text-tbc-200',
};

/**
 * Modal that renders the structured AI code review for a single deploy
 * project. Pure render — fetching/state lives on the parent so this can be
 * unit-tested with a static review payload.
 */
export function CodeReviewDialog({ open, onOpenChange, review, project }) {
  if (!review) return null;
  const findings = Array.isArray(review.findings) ? review.findings : [];
  const missing = Array.isArray(review.missing_files) ? review.missing_files : [];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid={`review-dialog-${project.id}`}
        className="max-h-[85vh] max-w-3xl overflow-y-auto border-tbc-900/60 bg-ink-950 text-tbc-100"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-tbc-100">
            <ShieldCheck className="h-4 w-4 text-violet-300" />
            Code review · <span className="font-mono text-sm text-tbc-200">{project.repo}</span>
          </DialogTitle>
          <DialogDescription className="text-tbc-200/70">
            Reviewed {review.reviewed_at ? new Date(review.reviewed_at).toLocaleString() : 'just now'}
            {review.ref && <> · branch <code className="rounded bg-ink-900 px-1 text-tbc-300">{review.ref}</code></>}
            {Array.isArray(review.files_sampled) && <> · {review.files_sampled.length} files sampled</>}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <span
              data-testid={`review-verdict-${project.id}`}
              className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs uppercase tracking-wider ${VERDICT_TONE[review.verdict] || VERDICT_TONE.ship_with_fixes}`}
            >
              {review.verdict || 'unknown'}
            </span>
            {review.summary && (
              <p className="mt-2 text-sm leading-relaxed text-tbc-100/90">{review.summary}</p>
            )}
          </div>

          {findings.length > 0 ? (
            <div className="space-y-3">
              <h4 className="text-xs font-bold uppercase tracking-wider text-tbc-200/70">
                Findings ({findings.length})
              </h4>
              {findings.map((f, i) => (
                <div
                  key={`${f.severity || 'low'}-${f.file || 'unknown'}-${i}`}
                  data-testid={`review-finding-${project.id}-${i}`}
                  className="rounded-lg border border-tbc-900/60 bg-ink-900/60 p-3"
                >
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className={`rounded-full border px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${SEVERITY_TONE[f.severity] || SEVERITY_TONE.low}`}>
                      {f.severity || 'low'}
                    </span>
                    {f.file && (
                      <code className="rounded bg-ink-950 px-1.5 py-0.5 font-mono text-[11px] text-tbc-300">
                        {f.file}
                      </code>
                    )}
                    {f.line_hint && f.line_hint !== 'N/A' && (
                      <span className="text-[10px] text-tbc-200/60">{f.line_hint}</span>
                    )}
                  </div>
                  {f.title && <p className="text-sm font-semibold text-tbc-100">{f.title}</p>}
                  {f.explanation && <p className="mt-1 text-xs text-tbc-200/80 leading-relaxed">{f.explanation}</p>}
                  {f.suggested_fix && (
                    <div className="mt-2 rounded border border-emerald-500/30 bg-emerald-500/5 p-2">
                      <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-emerald-300">
                        Suggested fix
                      </p>
                      <pre className="whitespace-pre-wrap break-words font-mono text-[11px] text-emerald-100">
                        {f.suggested_fix}
                      </pre>
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-tbc-200/60">No findings.</p>
          )}

          {missing.length > 0 && (
            <div>
              <h4 className="text-xs font-bold uppercase tracking-wider text-tbc-200/70">
                Missing essentials
              </h4>
              <ul className="mt-1 list-disc pl-5 text-xs text-tbc-200/80">
                {missing.map((m, i) => (
                  <li key={`missing-${m}-${i}`}><code className="rounded bg-ink-900 px-1 font-mono">{m}</code></li>
                ))}
              </ul>
            </div>
          )}

          {review.raw_text && (
            <details className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-2 text-[11px] text-amber-200">
              <summary className="cursor-pointer font-semibold">Raw model output (couldn&apos;t parse JSON)</summary>
              <pre className="mt-1 whitespace-pre-wrap break-words font-mono">{review.raw_text}</pre>
            </details>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

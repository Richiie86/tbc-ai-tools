import React, { useState } from 'react';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
import {
  CheckCircle2, AlertTriangle, XCircle, ChevronDown, ChevronUp, Wrench,
} from 'lucide-react';

/**
 * Color-coded result modal for the operator "Run Code Review" and
 * "Run Health Check" quick actions. Replaces the old raw window.alert()
 * wall of gray text.
 *
 * The whole point (operator request): make the verdict instantly readable —
 *   GREEN  = OK to ship
 *   YELLOW = OK to ship, but needs work / has concerns
 *   RED    = do NOT ship
 * …with a collapsed-by-default "Read full explanation" section so the
 * operator can drill into exactly what to fix without being buried in text.
 */

// Map a raw verdict / health result to a display tone + headline.
function classify(result) {
  if (!result) return null;
  if (result.kind === 'health') {
    return result.ok
      ? { tone: 'green', headline: 'Healthy — OK to ship' }
      : { tone: 'red', headline: 'Unhealthy — do not ship' };
  }
  switch (result.verdict) {
    case 'ship':
    case 'ok':
    case 'pass':
    case 'approved':
    case 'completed':
      return { tone: 'green', headline: 'OK to ship' };
    case 'ship_with_fixes':
    case 'ship_with_concerns':
      return { tone: 'yellow', headline: 'OK to ship — but needs work' };
    case 'do_not_ship':
      return { tone: 'red', headline: 'Do NOT ship' };
    case 'repo_empty':
      return { tone: 'yellow', headline: 'Repo has no code yet' };
    default:
      return { tone: 'yellow', headline: result.verdict || 'Review complete' };
  }
}

const TONES = {
  green: {
    ring: 'border-emerald-500/40',
    bg: 'bg-emerald-500/10',
    text: 'text-emerald-300',
    dot: 'bg-emerald-400',
    Icon: CheckCircle2,
  },
  yellow: {
    ring: 'border-amber-500/40',
    bg: 'bg-amber-500/10',
    text: 'text-amber-300',
    dot: 'bg-amber-400',
    Icon: AlertTriangle,
  },
  red: {
    ring: 'border-rose-500/40',
    bg: 'bg-rose-500/10',
    text: 'text-rose-300',
    dot: 'bg-rose-400',
    Icon: XCircle,
  },
};

// Render a single finding whether it's a plain string or a structured object.
function findingText(f) {
  if (typeof f === 'string') return f;
  if (!f || typeof f !== 'object') return String(f);
  const sev = f.severity ? `[${String(f.severity).toUpperCase()}] ` : '';
  const loc = f.file ? `${f.file}${f.line ? `:${f.line}` : ''} — ` : '';
  const body = f.title || f.message || f.detail || f.description || JSON.stringify(f);
  return `${sev}${loc}${body}`;
}

export default function ReviewResultModal({ result, onClose, onOpenFixChat }) {
  const [expanded, setExpanded] = useState(false);
  const cls = classify(result);
  const open = !!result && !!cls;

  // Reset the expand state whenever a new result comes in.
  React.useEffect(() => { setExpanded(false); }, [result]);

  if (!cls) return null;
  const tone = TONES[cls.tone] || TONES.yellow;
  const { Icon } = tone;
  const isReview = result.kind === 'review';

  const findings = isReview ? (result.findings || []) : [];
  const concerns = isReview ? (result.second?.concerns || []) : [];
  const hasDetail =
    (result.summary && result.summary.length > 0) ||
    findings.length > 0 ||
    concerns.length > 0 ||
    (result.second && result.second.summary);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="border-slate-800 bg-slate-900 text-slate-100 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-slate-200">
            {isReview ? 'Code review result' : 'Health check result'}
          </DialogTitle>
        </DialogHeader>

        {/* Verdict banner — the at-a-glance color-coded status. */}
        <div className={`flex items-center gap-3 rounded-xl border ${tone.ring} ${tone.bg} px-4 py-3`}>
          <Icon className={`h-7 w-7 shrink-0 ${tone.text}`} aria-hidden="true" />
          <div className="min-w-0">
            <p className={`text-base font-bold leading-tight ${tone.text}`}>
              {cls.headline}
            </p>
            <p className="mt-0.5 text-xs text-slate-400">
              {isReview
                ? `Verdict: ${result.verdict || 'n/a'}${
                    result.promotedBySecond ? ' · escalated by cross-AI reviewer' : ''
                  }`
                : [
                    result.status && `Status: ${result.status}`,
                    result.httpStatus && `HTTP ${result.httpStatus}`,
                    result.latencyMs && `${result.latencyMs}ms`,
                  ].filter(Boolean).join(' · ')}
            </p>
          </div>
        </div>

        {/* Short summary always visible so the operator gets the gist. */}
        {result.summary && (
          <p className="text-sm leading-relaxed text-slate-300">
            {result.summary.length > 240 && !expanded
              ? `${result.summary.slice(0, 240)}…`
              : result.summary}
          </p>
        )}
        {!isReview && result.detail && (
          <p className="text-sm leading-relaxed text-slate-300">{result.detail}</p>
        )}
        {!isReview && result.url && (
          <p className="truncate text-xs text-slate-500">{result.url}</p>
        )}

        {/* Read full explanation toggle. */}
        {hasDetail && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="inline-flex w-fit items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:bg-slate-800"
            aria-expanded={expanded}
          >
            {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            {expanded ? 'Hide explanation' : 'Read full explanation — what to fix'}
          </button>
        )}

        {expanded && (
          <div className="max-h-64 space-y-4 overflow-y-auto rounded-lg border border-slate-800 bg-slate-950/50 p-3 text-sm">
            {findings.length > 0 && (
              <div>
                <p className="mb-1.5 text-xs font-bold uppercase tracking-wide text-slate-400">
                  Findings ({findings.length})
                </p>
                <ul className="space-y-1.5">
                  {findings.map((f, i) => (
                    <li key={i} className="flex gap-2 text-slate-300">
                      <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot}`} />
                      <span className="leading-relaxed">{findingText(f)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {result.second && result.second.verdict && result.second.verdict !== 'review_skipped' && (
              <div>
                <p className="mb-1.5 text-xs font-bold uppercase tracking-wide text-slate-400">
                  Cross-AI reviewer ({result.second.reviewer_model || 'second opinion'}): {result.second.verdict}
                </p>
                {result.second.summary && (
                  <p className="mb-1.5 leading-relaxed text-slate-300">{result.second.summary}</p>
                )}
                {concerns.length > 0 && (
                  <ul className="space-y-1.5">
                    {concerns.map((c, i) => (
                      <li key={i} className="flex gap-2 text-slate-300">
                        <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
                        <span className="leading-relaxed">{c}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          {isReview && result.fixSession && (
            <Button
              variant="outline"
              onClick={() => { onOpenFixChat?.(result.fixSession); onClose(); }}
              className="border-slate-700 bg-slate-800 text-slate-100 hover:bg-slate-700"
            >
              <Wrench className="mr-1.5 h-4 w-4" />
              Open fix chat
            </Button>
          )}
          <Button
            onClick={onClose}
            className="bg-tbc-500 font-semibold text-slate-950 hover:bg-tbc-400"
          >
            Got it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

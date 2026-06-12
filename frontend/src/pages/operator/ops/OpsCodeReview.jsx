import React from 'react';
import { Button } from '../../../components/ui/button';
import { Card } from '../../../components/ui/card';
import { Terminal, Loader2 } from 'lucide-react';

function ReviewBlock({ title, result }) {
  if (!result) return null;
  const ok = result.ok;
  const out = (result.stdout || result.stderr || '').trim();
  return (
    <Card className={`border p-4 ${ok ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-rose-500/40 bg-rose-500/5'}`}>
      <div className="mb-2 flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wider text-tbc-200/60">{title}</div>
        <div className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wider ${
          ok ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
             : 'border-rose-500/40 bg-rose-500/10 text-rose-300'
        }`}>
          {ok ? 'pass' : 'fail'} · {result.ms}ms
        </div>
      </div>
      <pre className="max-h-64 overflow-auto rounded-md bg-ink-950 p-3 text-[11px] leading-relaxed text-tbc-200/80 whitespace-pre-wrap break-words">
        {out || (ok ? 'No issues.' : `exit ${result.exit_code}`)}
      </pre>
    </Card>
  );
}

/** Code-review section: header + run button + result blocks. */
export function OpsCodeReview({ review, loading, onRun }) {
  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-violet-500/15 text-violet-300">
            <Terminal className="h-4 w-4" />
          </span>
          <div>
            <h3 className="text-base font-bold text-tbc-100">Code Review</h3>
            <p className="text-xs text-tbc-200/60">
              Runs ruff (lint + format) across the backend and surfaces issues inline.
            </p>
          </div>
        </div>
        <Button
          data-testid="ops-review-run"
          onClick={onRun}
          disabled={loading}
          className="bg-tbc-500 text-ink-950 hover:bg-tbc-400 font-semibold"
        >
          {loading
            ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            : <Terminal className="mr-2 h-4 w-4" />}
          Run code review
        </Button>
      </div>

      {review && (
        <div className="grid gap-3 lg:grid-cols-2" data-testid="ops-review-output">
          <ReviewBlock title="Backend · ruff check"  result={review.python?.lint} />
          <ReviewBlock title="Backend · ruff format" result={review.python?.format} />
          <Card className="border-tbc-900/60 bg-ink-900/60 p-4 lg:col-span-2">
            <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-tbc-200/60">Frontend</div>
            <div className="text-sm text-tbc-100">{review.frontend?.note}</div>
            <div className="mt-1 text-[11px] text-tbc-200/50">
              JS/JSX files indexed: {review.frontend?.js_file_count || '—'}
            </div>
          </Card>
        </div>
      )}
    </section>
  );
}

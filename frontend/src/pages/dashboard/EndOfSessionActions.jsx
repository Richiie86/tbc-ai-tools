import React, { useMemo } from 'react';
import { Rocket, ShieldCheck, Wrench, HeartPulse } from 'lucide-react';

/**
 * Big end-of-session action bar — Deploy / Run Code Review /
 * Run Health Check / Fix Errors.
 *
 * A prominent button strip shown after an agent turn,
 * so the operator can act on a finished chat without scrolling up to find
 * the small per-message Quick Actions. Rendered ONCE at the bottom of the
 * message list, only when streaming is finished and the last message is
 * from the assistant.
 *
 * The "Fix errors" button is conditional — only shows when we detect
 * error/exception/traceback signal in the last assistant message (or in
 * a fenced Python traceback inside markdown).
 */
export default function EndOfSessionActions({ messages, streaming, onAction }) {
  const visible = useMemo(() => {
    if (streaming) return false;
    if (!messages?.length) return false;
    const last = messages[messages.length - 1];
    return last && last.role === 'assistant' && (last.content || '').trim().length > 0;
  }, [messages, streaming]);

  // Heuristic: enable "Fix errors" when the assistant clearly described a
  // failure. Catches plain prose AND fenced Python tracebacks inside
  // markdown (```python Traceback (most recent call last)...```).
  const hasErrorSignal = useMemo(() => {
    if (!visible) return false;
    const text = (messages[messages.length - 1]?.content || '');
    if (/```[\s\S]*?Traceback \(most recent call last\)[\s\S]*?```/i.test(text)) return true;
    const lc = text.toLowerCase();
    return /(error|exception|traceback|stack ?trace|failed|crash|undefined|cannot read)/.test(lc);
  }, [visible, messages]);

  if (!visible) return null;
  return (
    <div
      data-testid="end-of-session-actions"
      className="mt-6 flex flex-wrap items-center justify-center gap-3 border-t border-slate-800/60 pt-5"
    >
      <button
        type="button"
        onClick={() => onAction('deploy')}
        data-testid="eos-action-deploy"
        className="inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-sky-500 to-tbc-500 px-5 py-2 text-sm font-bold text-ink-950 shadow-md shadow-tbc-500/20 transition hover:from-sky-400 hover:to-tbc-400"
      >
        <Rocket className="h-4 w-4" />
        Deploy
      </button>
      <button
        type="button"
        onClick={() => onAction('review')}
        data-testid="eos-action-review"
        className="inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-emerald-500 to-emerald-400 px-5 py-2 text-sm font-bold text-ink-950 shadow-md shadow-emerald-500/20 transition hover:from-emerald-400 hover:to-emerald-300"
      >
        <ShieldCheck className="h-4 w-4" />
        Run Code Review
      </button>
      <button
        type="button"
        onClick={() => onAction('health')}
        data-testid="eos-action-health"
        title="Probe the deployed project's public URL"
        className="inline-flex items-center gap-2 rounded-full border border-slate-700 bg-slate-900 px-5 py-2 text-sm font-bold text-slate-100 shadow-md transition hover:bg-slate-800"
      >
        <HeartPulse className="h-4 w-4" />
        Run Health Check
      </button>
      {hasErrorSignal && (
        <button
          type="button"
          onClick={() => onAction('fix-errors')}
          data-testid="eos-action-fix"
          title="Open an AI Build fix PR for the error the AI just described"
          className="inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-amber-500 to-rose-500 px-5 py-2 text-sm font-bold text-ink-950 shadow-md shadow-rose-500/20 transition hover:from-amber-400 hover:to-rose-400"
        >
          <Wrench className="h-4 w-4" />
          Fix Errors
        </button>
      )}
    </div>
  );
}

import React from 'react';
import { Cpu } from 'lucide-react';
import Markdown from '../../components/Markdown';

/** Suggestion-card empty state when a chat session has no messages yet. */
export function EmptyState({ onPick, model }) {
  const suggestions = [
    'Build me a simple to-do app with React + FastAPI',
    'Explain JWT vs session-based auth in 100 words',
    'Write a Python script to backtest a moving average strategy',
    'Design a MongoDB schema for an e-commerce store',
  ];
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-tbc-300 to-tbc-500 shadow-lg shadow-tbc-500/30">
        <Cpu className="h-7 w-7 text-slate-950" strokeWidth={2.4} />
      </div>
      <h2 className="mt-5 text-3xl font-bold text-white">How can I help you build today?</h2>
      <p className="mt-2 text-sm text-slate-400">
        Using <span className="text-tbc-300">{model}</span> — switch model anytime
      </p>
      <div className="mt-8 grid w-full max-w-2xl gap-2 sm:grid-cols-2">
        {suggestions.map((s) => (
          <button
            key={s}
            onClick={() => onPick(s)}
            className="rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-3 text-left text-sm text-slate-200 transition-colors hover:border-tbc-500/40 hover:bg-slate-900"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

/** A single chat bubble — user (right, gold) or assistant (left, dark). */
export function MessageBubble({ role, content, streaming }) {
  if (role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-tbc-500 px-4 py-2.5 text-[15px] font-medium text-slate-950 shadow-sm">
          <div className="whitespace-pre-wrap leading-relaxed">{content}</div>
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-tbc-300 to-tbc-500">
        <Cpu className="h-4 w-4 text-slate-950" strokeWidth={2.4} />
      </div>
      <div className="min-w-0 flex-1 rounded-2xl rounded-tl-md border border-slate-800 bg-slate-900/60 px-4 py-3">
        {content
          ? <Markdown>{content}</Markdown>
          : <div className="text-sm text-slate-500">Thinking…</div>}
        {streaming && content && <span className="caret-blink" />}
      </div>
    </div>
  );
}

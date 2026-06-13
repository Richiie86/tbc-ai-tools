import React from 'react';
import { Button } from '../../../components/ui/button';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '../../../components/ui/select';
import {
  Pencil, Trash2, ExternalLink, MessageSquare, Tag,
  ArrowRight, Sparkles, Plus,
} from 'lucide-react';
import { STAGES, stageOf } from './stages';

function NextStageButton({ current, onMove }) {
  const order = STAGES.map((s) => s.v);
  const idx = order.indexOf(current.status);
  if (idx < 0 || idx >= order.length - 1) return null;
  const next = STAGES[idx + 1];
  return (
    <button
      data-testid={`project-promote-${current.id}`}
      onClick={() => onMove(current, next.v)}
      className={`mt-3 inline-flex items-center gap-1 rounded-md border border-tbc-900/60 bg-ink-950 px-2 py-1 text-[11px] ${next.accent} hover:bg-ink-900`}
      title={`Move to ${next.label}`}
    >
      Promote to {next.short} <ArrowRight className="h-3 w-3" />
    </button>
  );
}

/**
 * Single project card in the Projects grid. Pure presentational — every
 * mutation is delegated up to the parent via callbacks.
 */
export function ProjectCard({ project: p, onEdit, onDelete, onMove, onLaunchChat }) {
  const st = stageOf(p.status);
  return (
    <article
      key={p.id}
      data-testid={`project-card-${p.id}`}
      className="group relative rounded-xl border border-tbc-900/60 bg-ink-900/60 p-5 transition hover:border-tbc-700/60"
    >
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2">
          <div className={`grid h-9 w-9 place-items-center rounded-lg ${st.tile}`}>
            <st.Icon className="h-4 w-4" />
          </div>
          <div>
            <div className="text-base font-bold text-tbc-100 line-clamp-1">{p.title}</div>
            <div className={`mt-0.5 inline-block rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wider ${st.pill}`}>
              {st.short}
            </div>
          </div>
        </div>
        <div className="flex gap-1 opacity-0 transition group-hover:opacity-100">
          <Button
            size="icon" variant="outline"
            data-testid={`project-edit-${p.id}`}
            className="h-8 w-8 border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950"
            onClick={() => onEdit(p)}
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="icon" variant="outline"
            data-testid={`project-delete-${p.id}`}
            className="h-8 w-8 border-rose-900/60 bg-ink-900 text-rose-300 hover:bg-rose-500/10"
            onClick={() => onDelete(p.id)}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {p.description && (
        <p className="mt-3 line-clamp-3 text-sm text-tbc-200/70">{p.description}</p>
      )}

      {(p.tags || []).length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1">
          {p.tags.map((t) => {
            // Workspace tags (lowercase slug, not 'bootstrap') get a
            // gold-tinted pill so the operator can scan parallel workstreams.
            const isWorkspace = typeof t === 'string'
              && /^[a-z0-9][a-z0-9_-]{0,30}$/.test(t)
              && t !== 'bootstrap';
            return (
              <span
                key={t}
                data-testid={isWorkspace ? `project-workspace-tag-${p.id}-${t}` : undefined}
                className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] ${
                  isWorkspace
                    ? 'bg-tbc-500/15 text-tbc-200 ring-1 ring-tbc-500/30 font-semibold'
                    : 'bg-ink-950 text-tbc-200/80'
                }`}
              >
                <Tag className="h-2.5 w-2.5" />{t}
              </span>
            );
          })}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          data-testid={`project-launch-chat-${p.id}`}
          onClick={() => onLaunchChat(p)}
          title="Open this project in a new TBC chat — its brief is auto-injected as the first prompt"
          className="inline-flex items-center gap-1 rounded-md bg-tbc-500 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider text-ink-950 hover:bg-tbc-400"
        >
          <Sparkles className="h-3 w-3" /> Launch in chat
        </button>
        <Select value={p.status} onValueChange={(v) => onMove(p, v)}>
          <SelectTrigger
            data-testid={`project-move-${p.id}`}
            className="h-7 w-36 bg-ink-950 border-tbc-900/60 text-xs text-tbc-100"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="bg-ink-900 border-tbc-900/60 text-tbc-100">
            {STAGES.map((s) => (
              <SelectItem key={s.v} value={s.v}>{s.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {p.chat_session_id && (
          <a
            href={`/dashboard/${p.chat_session_id}`}
            className="inline-flex items-center gap-1 rounded-md border border-tbc-900/60 bg-ink-950 px-2 py-1 text-[11px] text-tbc-200 hover:bg-ink-900"
          >
            <MessageSquare className="h-3 w-3" /> Open chat
          </a>
        )}
        {p.link_url && (
          <a
            href={p.link_url} target="_blank" rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-md border border-tbc-900/60 bg-ink-950 px-2 py-1 text-[11px] text-tbc-200 hover:bg-ink-900"
          >
            <ExternalLink className="h-3 w-3" /> Link
          </a>
        )}
      </div>

      <NextStageButton current={p} onMove={onMove} />
    </article>
  );
}

export function ProjectEmptyState({ stage, onCreate }) {
  return (
    <div className="col-span-full rounded-xl border border-dashed border-tbc-900/60 p-10 text-center">
      <div className={`mx-auto grid h-12 w-12 place-items-center rounded-xl ${stage.tile}`}>
        <stage.Icon className="h-6 w-6" />
      </div>
      <div className="mt-3 text-base font-bold text-tbc-100">Nothing in {stage.short} yet</div>
      <p className="mx-auto mt-1 max-w-md text-sm text-tbc-200/60">{stage.desc}</p>
      <Button
        onClick={onCreate}
        className="mt-4 bg-tbc-500 text-ink-950 hover:bg-tbc-400 font-semibold"
        data-testid="projects-empty-create"
      >
        <Plus className="mr-1.5 h-4 w-4" /> Add to {stage.short}
      </Button>
    </div>
  );
}

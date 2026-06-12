import React, { useEffect, useMemo, useState } from 'react';
import api from '../../lib/api';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Textarea } from '../../components/ui/textarea';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '../../components/ui/select';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '../../components/ui/dialog';
import { toast } from 'sonner';
import {
  Plus, Pencil, Trash2, Loader2, ExternalLink, MessageSquare, Tag,
  Code2, Lightbulb, Hammer, Rocket, Activity, ArrowRight, Sparkles,
} from 'lucide-react';

const EMPTY = { title: '', description: '', status: 'idea', tags: [], link_url: '', chat_session_id: '' };

// Five lifecycle stages — order matters (left → right on the tab strip).
const STAGES = [
  {
    v: 'expand',
    label: 'Code to expand',
    short: 'Expand',
    Icon: Code2,
    accent: 'text-violet-300',
    pill:  'bg-violet-500/15 text-violet-200 border-violet-500/30',
    tile:  'bg-violet-500/10 text-violet-300',
    desc:  'Boilerplates, snippets, and reusable code you can clone into a new TBC build.',
  },
  {
    v: 'idea',
    label: 'Start new project',
    short: 'Idea',
    Icon: Lightbulb,
    accent: 'text-sky-300',
    pill:  'bg-sky-500/15 text-sky-200 border-sky-500/30',
    tile:  'bg-sky-500/10 text-sky-300',
    desc:  'Scoping & planning. Capture the pitch, target users, and rough stack.',
  },
  {
    v: 'dev',
    label: 'Under development',
    short: 'Dev',
    Icon: Hammer,
    accent: 'text-amber-300',
    pill:  'bg-amber-500/15 text-amber-200 border-amber-500/30',
    tile:  'bg-amber-500/10 text-amber-300',
    desc:  'Actively building. Track in-progress builds and their chat sessions.',
  },
  {
    v: 'launched',
    label: 'Launched',
    short: 'Launched',
    Icon: Rocket,
    accent: 'text-emerald-300',
    pill:  'bg-emerald-500/15 text-emerald-200 border-emerald-500/30',
    tile:  'bg-emerald-500/10 text-emerald-300',
    desc:  'Shipped to the world. Capture launch URL + share assets.',
  },
  {
    v: 'running',
    label: 'Running',
    short: 'Running',
    Icon: Activity,
    accent: 'text-teal-300',
    pill:  'bg-teal-500/15 text-teal-200 border-teal-500/30',
    tile:  'bg-teal-500/10 text-teal-300',
    desc:  'Live & in maintenance — monitor and iterate without disruption.',
  },
];

const stageOf = (v) => STAGES.find((s) => s.v === v) || STAGES[1];

export default function ProjectsTab() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState('idea'); // selected sub-section
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [tagsText, setTagsText] = useState('');
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/operator/projects');
      setItems(data);
    } catch {
      toast.error('Failed to load projects');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const counts = useMemo(() => {
    const c = Object.fromEntries(STAGES.map((s) => [s.v, 0]));
    for (const p of items) c[p.status] = (c[p.status] || 0) + 1;
    return c;
  }, [items]);

  const visible = useMemo(
    () => items.filter((p) => (p.status || 'idea') === active),
    [items, active],
  );

  const openCreate = (preset) => {
    setEditing(null);
    setForm({ ...EMPTY, status: preset || active });
    setTagsText('');
    setOpen(true);
  };
  const openEdit = (p) => {
    setEditing(p.id);
    setForm({ ...EMPTY, ...p, tags: p.tags || [] });
    setTagsText((p.tags || []).join(', '));
    setOpen(true);
  };

  const save = async () => {
    if (!form.title) return toast.error('Title required');
    setSaving(true);
    try {
      const payload = {
        ...form,
        tags: tagsText.split(',').map((s) => s.trim()).filter(Boolean),
      };
      if (editing) await api.put(`/operator/projects/${editing}`, payload);
      else await api.post('/operator/projects', payload);
      toast.success('Saved');
      setOpen(false);
      load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const del = async (id) => {
    if (!window.confirm('Delete project?')) return;
    try {
      await api.delete(`/operator/projects/${id}`);
      toast.success('Deleted');
      load();
    } catch {
      toast.error('Delete failed');
    }
  };

  const moveTo = async (p, s) => {
    try {
      await api.put(`/operator/projects/${p.id}`, { ...p, status: s, tags: p.tags || [] });
      toast.success(`Moved to ${stageOf(s).label}`);
      load();
    } catch {
      toast.error('Move failed');
    }
  };

  const launchInChat = async (p) => {
    try {
      const { data } = await api.post(`/operator/projects/${p.id}/launch-chat`);
      toast.success(`Opening ${p.title} in TBC chat…`);
      // Send the user to the new session.
      window.location.href = `/dashboard/${data.session_id}`;
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Failed to open chat');
    }
  };

  if (loading) {
    return (
      <div className="grid place-items-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-tbc-400" />
      </div>
    );
  }

  const activeStage = stageOf(active);

  return (
    <div data-testid="projects-tab">
      {/* Sub-section tabs */}
      <div className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-5" data-testid="projects-subnav">
        {STAGES.map((s) => {
          const isActive = active === s.v;
          return (
            <button
              key={s.v}
              data-testid={`projects-stage-${s.v}`}
              onClick={() => setActive(s.v)}
              className={[
                'group relative overflow-hidden rounded-xl border p-3 text-left transition',
                isActive
                  ? 'border-tbc-500/40 bg-ink-900 shadow-[0_0_0_1px_rgba(212,169,58,0.25)]'
                  : 'border-tbc-900/60 bg-ink-900/50 hover:border-tbc-700/60 hover:bg-ink-900/80',
              ].join(' ')}
            >
              <div className="flex items-center justify-between">
                <span className={`grid h-8 w-8 place-items-center rounded-lg ${s.tile}`}>
                  <s.Icon className="h-4 w-4" />
                </span>
                <span className="text-2xl font-extrabold tracking-tight text-tbc-100">
                  {counts[s.v]}
                </span>
              </div>
              <div className={`mt-2 text-[11px] font-bold uppercase tracking-wider ${s.accent}`}>
                {s.short}
              </div>
              <div className="text-[13px] font-medium text-tbc-100 leading-tight">{s.label}</div>
            </button>
          );
        })}
      </div>

      {/* Header for current section */}
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-lg ${activeStage.tile}`}>
            <activeStage.Icon className="h-5 w-5" />
          </span>
          <div>
            <h3 className="text-lg font-bold text-tbc-100">{activeStage.label}</h3>
            <p className="text-xs text-tbc-200/60">{activeStage.desc}</p>
          </div>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button
              data-testid="projects-new-btn"
              onClick={() => openCreate(active)}
              className="bg-tbc-500 text-ink-950 hover:bg-tbc-400 font-semibold"
            >
              <Plus className="mr-1.5 h-4 w-4" /> New in {activeStage.short}
            </Button>
          </DialogTrigger>
          <DialogContent className="border-tbc-900/60 bg-ink-900 text-tbc-100 max-w-xl">
            <DialogHeader>
              <DialogTitle>{editing ? 'Edit project' : `New project · ${stageOf(form.status).label}`}</DialogTitle>
            </DialogHeader>
            <div className="grid gap-3">
              <Field label="Title">
                <Input
                  data-testid="projects-form-title"
                  className="bg-ink-950 border-tbc-900/60 text-tbc-100"
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  placeholder="My awesome SaaS"
                />
              </Field>
              <Field label="Description">
                <Textarea
                  rows={3}
                  data-testid="projects-form-description"
                  className="bg-ink-950 border-tbc-900/60 text-tbc-100"
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Stage">
                  <Select value={form.status} onValueChange={(v) => setForm({ ...form, status: v })}>
                    <SelectTrigger
                      data-testid="projects-form-status"
                      className="bg-ink-950 border-tbc-900/60 text-tbc-100"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-ink-900 border-tbc-900/60 text-tbc-100">
                      {STAGES.map((s) => (
                        <SelectItem key={s.v} value={s.v}>{s.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Tags (comma separated)">
                  <Input
                    data-testid="projects-form-tags"
                    className="bg-ink-950 border-tbc-900/60 text-tbc-100"
                    value={tagsText}
                    onChange={(e) => setTagsText(e.target.value)}
                    placeholder="react, fastapi, mvp"
                  />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="External link">
                  <Input
                    data-testid="projects-form-link"
                    className="bg-ink-950 border-tbc-900/60 text-tbc-100"
                    value={form.link_url}
                    onChange={(e) => setForm({ ...form, link_url: e.target.value })}
                    placeholder="https://..."
                  />
                </Field>
                <Field label="Chat session id">
                  <Input
                    data-testid="projects-form-chat"
                    className="bg-ink-950 border-tbc-900/60 text-tbc-100 font-mono text-xs"
                    value={form.chat_session_id}
                    onChange={(e) => setForm({ ...form, chat_session_id: e.target.value })}
                    placeholder="copy from TBC dashboard URL"
                  />
                </Field>
              </div>
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setOpen(false)}
                className="border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950"
              >
                Cancel
              </Button>
              <Button
                data-testid="projects-form-save"
                onClick={save}
                disabled={saving}
                className="bg-tbc-500 text-ink-950 hover:bg-tbc-400 font-semibold"
              >
                {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Save
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {/* Cards in the active stage */}
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3" data-testid="projects-grid">
        {visible.length === 0 && (
          <EmptyState stage={activeStage} onCreate={() => openCreate(active)} />
        )}
        {visible.map((p) => {
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
                    onClick={() => openEdit(p)}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="icon" variant="outline"
                    data-testid={`project-delete-${p.id}`}
                    className="h-8 w-8 border-rose-900/60 bg-ink-900 text-rose-300 hover:bg-rose-500/10"
                    onClick={() => del(p.id)}
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
                  {p.tags.map((t) => (
                    <span key={t} className="inline-flex items-center gap-1 rounded-full bg-ink-950 px-2 py-0.5 text-[10px] text-tbc-200/80">
                      <Tag className="h-2.5 w-2.5" />{t}
                    </span>
                  ))}
                </div>
              )}

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  data-testid={`project-launch-chat-${p.id}`}
                  onClick={() => launchInChat(p)}
                  title="Open this project in a new TBC chat — its brief is auto-injected as the first prompt"
                  className="inline-flex items-center gap-1 rounded-md bg-tbc-500 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider text-ink-950 hover:bg-tbc-400"
                >
                  <Sparkles className="h-3 w-3" /> Launch in chat
                </button>
                <Select value={p.status} onValueChange={(v) => moveTo(p, v)}>
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

              {/* Quick promote → next stage */}
              <NextStageButton current={p} onMove={moveTo} />
            </article>
          );
        })}
      </div>
    </div>
  );
}

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

function EmptyState({ stage, onCreate }) {
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

function Field({ label, children }) {
  return (
    <div>
      <label className="text-xs font-semibold uppercase tracking-wider text-tbc-200/60">{label}</label>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

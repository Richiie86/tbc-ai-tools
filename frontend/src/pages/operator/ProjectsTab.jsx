import React, { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../../lib/api';
import { Button } from '../../components/ui/button';
import { toast } from 'sonner';
import { Plus, Loader2, Copy } from 'lucide-react';

import { STAGES, stageOf, EMPTY_PROJECT } from './projects/stages';
import { ProjectStageNav } from './projects/ProjectStageNav';
import { ProjectCard, ProjectEmptyState } from './projects/ProjectCard';
import { ProjectFormDialog } from './projects/ProjectFormDialog';
import { WorkspaceSwitcher } from './projects/WorkspaceSwitcher';

// Helper that pulls a project's workspace tags (lowercase slugs in `tags`
// that match the workspace regex and aren't the generic 'bootstrap' marker).
// Used both for filtering and to render the workspace pill on each card.
const _WORKSPACE_RE = /^[a-z0-9][a-z0-9_-]{0,30}$/;
const _NON_WORKSPACE_TAGS = new Set(['bootstrap']);
const workspaceTagsOf = (p) => (p.tags || []).filter(
  (t) => typeof t === 'string' && _WORKSPACE_RE.test(t) && !_NON_WORKSPACE_TAGS.has(t),
);
const _WS_KEY = 'tbc_projects_workspace_v1';

export default function ProjectsTab() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState('idea'); // selected sub-section
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY_PROJECT);
  const [tagsText, setTagsText] = useState('');
  const [saving, setSaving] = useState(false);
  const [cloningAll, setCloningAll] = useState(false);
  // Workspace filter persisted across reloads so an operator working in
  // tbc1 doesn't get bumped back to 'all' every page refresh.
  const [workspace, setWorkspace] = useState(() => {
    try { return localStorage.getItem(_WS_KEY) || 'all'; } catch { return 'all'; }
  });
  useEffect(() => {
    try { localStorage.setItem(_WS_KEY, workspace); } catch { /* ignore */ }
  }, [workspace]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/operator/projects');
      setItems(data);
    } catch (err) {
      console.error('Failed to load projects', err);
      toast.error('Failed to load projects');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  // Filter by workspace BEFORE filtering by stage so the stage counts
  // reflect only what the operator can actually see.
  const inWorkspace = useMemo(() => {
    if (workspace === 'all') return items;
    if (workspace === 'default') {
      return items.filter((p) => workspaceTagsOf(p).length === 0);
    }
    return items.filter((p) => workspaceTagsOf(p).includes(workspace));
  }, [items, workspace]);

  const counts = useMemo(() => {
    const c = Object.fromEntries(STAGES.map((s) => [s.v, 0]));
    for (const p of inWorkspace) c[p.status] = (c[p.status] || 0) + 1;
    return c;
  }, [inWorkspace]);

  const visible = useMemo(
    () => inWorkspace.filter((p) => (p.status || 'idea') === active),
    [inWorkspace, active],
  );

  const openCreate = (preset) => {
    setEditing(null);
    setForm({ ...EMPTY_PROJECT, status: preset || active });
    setTagsText('');
    setOpen(true);
  };
  const openEdit = (p) => {
    setEditing(p.id);
    setForm({ ...EMPTY_PROJECT, ...p, tags: p.tags || [] });
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
    } catch (err) {
      console.error('Project delete failed', err);
      toast.error('Delete failed');
    }
  };

  const moveTo = async (p, s) => {
    try {
      await api.put(`/operator/projects/${p.id}`, { ...p, status: s, tags: p.tags || [] });
      toast.success(`Moved to ${stageOf(s).label}`);
      load();
    } catch (err) {
      console.error('Project move failed', err);
      toast.error('Move failed');
    }
  };

  const launchInChat = async (p) => {
    try {
      const { data } = await api.post(`/operator/projects/${p.id}/launch-chat`);
      toast.success(`Opening ${p.title} in TBC chat…`);
      window.location.href = `/dashboard/${data.session_id}`;
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Failed to open chat');
    }
  };

  const cloneAllToWorkspace = async () => {
    // Default target: the currently-selected workspace if it isn't a
    // virtual one ('all'/'default'), otherwise the historical 'tbc1'.
    const target = (workspace !== 'all' && workspace !== 'default') ? workspace : 'tbc1';
    if (!window.confirm(
      `Clone every project into the "${target}" workspace?\n\n` +
      `• Each project gets a "-${target}" suffix and a "${target}" tag.\n` +
      `• Cloned items get a fresh chat session so you can continue work.\n` +
      `• "crypto-forex-tax" is bootstrapped if missing.\n` +
      `• Re-running is safe (already-cloned projects are skipped).`,
    )) return;
    setCloningAll(true);
    try {
      const { data } = await api.post('/operator/projects/clone-all', { workspace: target });
      const c = data?.cloned_count || 0;
      const b = data?.bootstrapped_count || 0;
      const s = data?.skipped_count || 0;
      toast.success(
        `${c} cloned${b ? ` · ${b} bootstrapped` : ''}${s ? ` · ${s} skipped` : ''} → ${target}`,
      );
      // Hop to the target workspace so the operator immediately sees the result.
      setWorkspace(target);
      load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Clone-all failed');
    } finally {
      setCloningAll(false);
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
      <WorkspaceSwitcher
        selected={workspace}
        onSelect={setWorkspace}
        onAfterChange={load}
      />
      <ProjectStageNav active={active} counts={counts} onSelect={setActive} />

      {/* Header for current section */}
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-lg ${activeStage.tile}`}>
            <activeStage.Icon className="h-5 w-5" />
          </span>
          <div>
            <h3 className="text-lg font-bold text-tbc-100">{activeStage.label}</h3>
            <p className="text-xs text-tbc-200/60">
              {activeStage.desc}
              {workspace !== 'all' && (
                <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-tbc-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-tbc-300">
                  {workspace === 'default' ? 'Default workspace' : `Workspace · ${workspace}`}
                </span>
              )}
            </p>
          </div>
        </div>
        {/* DialogTrigger lives outside the Dialog body so it can sit in the
            header row. Kept as a fragment so the Dialog itself is rendered
            once below. */}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            data-testid="projects-clone-all-btn"
            onClick={cloneAllToWorkspace}
            disabled={cloningAll}
            variant="outline"
            title={(workspace !== 'all' && workspace !== 'default')
              ? `Copy every project into ${workspace}`
              : 'Copy every project into the tbc1 workspace so you can continue work there'}
            className="border-tbc-500/40 bg-ink-900 text-tbc-100 hover:bg-tbc-500/10"
          >
            {cloningAll ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Copy className="mr-1.5 h-4 w-4" />}
            Clone all to {(workspace !== 'all' && workspace !== 'default') ? workspace : 'tbc1'}
          </Button>
          <Button
            data-testid="projects-new-btn"
            onClick={() => openCreate(active)}
            className="bg-tbc-500 text-ink-950 hover:bg-tbc-400 font-semibold"
          >
            <Plus className="mr-1.5 h-4 w-4" /> New in {activeStage.short}
          </Button>
        </div>
      </div>

      <ProjectFormDialog
        open={open}
        onOpenChange={setOpen}
        editing={editing}
        form={form}
        setForm={setForm}
        tagsText={tagsText}
        setTagsText={setTagsText}
        saving={saving}
        onSave={save}
      />

      {/* Cards in the active stage */}
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3" data-testid="projects-grid">
        {visible.length === 0 && (
          <ProjectEmptyState stage={activeStage} onCreate={() => openCreate(active)} />
        )}
        {visible.map((p) => (
          <ProjectCard
            key={p.id}
            project={p}
            onEdit={openEdit}
            onDelete={del}
            onMove={moveTo}
            onLaunchChat={launchInChat}
          />
        ))}
      </div>
    </div>
  );
}

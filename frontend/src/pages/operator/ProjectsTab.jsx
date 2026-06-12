import React, { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../../lib/api';
import { Button } from '../../components/ui/button';
import { toast } from 'sonner';
import { Plus, Loader2 } from 'lucide-react';

import { STAGES, stageOf, EMPTY_PROJECT } from './projects/stages';
import { ProjectStageNav } from './projects/ProjectStageNav';
import { ProjectCard, ProjectEmptyState } from './projects/ProjectCard';
import { ProjectFormDialog } from './projects/ProjectFormDialog';

export default function ProjectsTab() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState('idea'); // selected sub-section
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY_PROJECT);
  const [tagsText, setTagsText] = useState('');
  const [saving, setSaving] = useState(false);

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
      <ProjectStageNav active={active} counts={counts} onSelect={setActive} />

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
        {/* DialogTrigger lives outside the Dialog body so it can sit in the
            header row. Kept as a fragment so the Dialog itself is rendered
            once below. */}
        <Button
          data-testid="projects-new-btn"
          onClick={() => openCreate(active)}
          className="bg-tbc-500 text-ink-950 hover:bg-tbc-400 font-semibold"
        >
          <Plus className="mr-1.5 h-4 w-4" /> New in {activeStage.short}
        </Button>
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

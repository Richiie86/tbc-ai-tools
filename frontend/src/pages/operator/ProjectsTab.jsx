import React, { useEffect, useState } from 'react';
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
  Plus, Pencil, Trash2, Loader2, FolderKanban, ExternalLink, MessageSquare, Tag,
} from 'lucide-react';

const EMPTY = { title: '', description: '', status: 'idea', tags: [], link_url: '', chat_session_id: '' };
const STATUSES = [
  { v: 'idea',   label: 'Idea',    color: 'bg-tbc-200/10 text-tbc-200/80' },
  { v: 'active', label: 'Active',  color: 'bg-tbc-500/15 text-tbc-300' },
  { v: 'paused', label: 'Paused',  color: 'bg-amber-500/20 text-amber-300' },
  { v: 'done',   label: 'Done',    color: 'bg-emerald-500/15 text-emerald-300' },
];

export default function ProjectsTab() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [tagsText, setTagsText] = useState('');
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try { const { data } = await api.get('/operator/projects'); setItems(data); }
    catch { toast.error('Failed to load projects'); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const openCreate = () => { setEditing(null); setForm(EMPTY); setTagsText(''); setOpen(true); };
  const openEdit = (p) => { setEditing(p.id); setForm({ ...EMPTY, ...p, tags: p.tags || [] }); setTagsText((p.tags || []).join(', ')); setOpen(true); };
  const save = async () => {
    if (!form.title) return toast.error('Title required');
    setSaving(true);
    try {
      const payload = { ...form, tags: tagsText.split(',').map((s) => s.trim()).filter(Boolean) };
      if (editing) await api.put(`/operator/projects/${editing}`, payload);
      else await api.post('/operator/projects', payload);
      toast.success('Saved');
      setOpen(false);
      load();
    } catch (e) { toast.error(e?.response?.data?.detail || 'Save failed'); }
    finally { setSaving(false); }
  };
  const del = async (id) => {
    if (!window.confirm('Delete project?')) return;
    try { await api.delete(`/operator/projects/${id}`); toast.success('Deleted'); load(); }
    catch { toast.error('Delete failed'); }
  };
  const setStatus = async (p, s) => {
    try { await api.put(`/operator/projects/${p.id}`, { ...p, status: s, tags: p.tags || [] }); toast.success('Updated'); load(); }
    catch { toast.error('Update failed'); }
  };

  if (loading) return <div className="grid place-items-center py-12"><Loader2 className="h-6 w-6 animate-spin text-tbc-400" /></div>;

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm text-tbc-200/60">Track every app you’re building. Link each project to a TBC chat session for instant context.</p>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button onClick={openCreate} className="bg-tbc-500 text-ink-950 hover:bg-tbc-400 font-semibold"><Plus className="mr-1.5 h-4 w-4" /> New project</Button>
          </DialogTrigger>
          <DialogContent className="border-tbc-900/60 bg-ink-900 text-tbc-100 max-w-xl">
            <DialogHeader><DialogTitle>{editing ? 'Edit project' : 'New project'}</DialogTitle></DialogHeader>
            <div className="grid gap-3">
              <Field label="Title"><Input className="bg-ink-950 border-tbc-900/60 text-tbc-100" value={form.title} onChange={(e)=>setForm({...form, title:e.target.value})} placeholder="My awesome SaaS" /></Field>
              <Field label="Description"><Textarea rows={3} className="bg-ink-950 border-tbc-900/60 text-tbc-100" value={form.description} onChange={(e)=>setForm({...form, description:e.target.value})} /></Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Status">
                  <Select value={form.status} onValueChange={(v)=>setForm({...form, status:v})}>
                    <SelectTrigger className="bg-ink-950 border-tbc-900/60 text-tbc-100"><SelectValue /></SelectTrigger>
                    <SelectContent className="bg-ink-900 border-tbc-900/60 text-tbc-100">
                      {STATUSES.map((s) => <SelectItem key={s.v} value={s.v}>{s.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Tags (comma separated)"><Input className="bg-ink-950 border-tbc-900/60 text-tbc-100" value={tagsText} onChange={(e)=>setTagsText(e.target.value)} placeholder="react, fastapi, mvp" /></Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="External link"><Input className="bg-ink-950 border-tbc-900/60 text-tbc-100" value={form.link_url} onChange={(e)=>setForm({...form, link_url:e.target.value})} placeholder="https://..." /></Field>
                <Field label="Chat session id"><Input className="bg-ink-950 border-tbc-900/60 text-tbc-100 font-mono text-xs" value={form.chat_session_id} onChange={(e)=>setForm({...form, chat_session_id:e.target.value})} placeholder="copy from TBC dashboard URL" /></Field>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={()=>setOpen(false)} className="border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950">Cancel</Button>
              <Button onClick={save} disabled={saving} className="bg-tbc-500 text-ink-950 hover:bg-tbc-400 font-semibold">{saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}Save</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        {items.length === 0 && (
          <div className="col-span-full rounded-xl border border-dashed border-tbc-900/60 p-10 text-center text-tbc-200/50">
            No projects yet. Click “New project” to add your first one.
          </div>
        )}
        {items.map((p) => {
          const st = STATUSES.find((x) => x.v === p.status) || STATUSES[0];
          return (
            <div key={p.id} className="rounded-xl border border-tbc-900/60 bg-ink-900/60 p-5">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-2">
                  <div className="grid h-9 w-9 place-items-center rounded-lg bg-tbc-500/15 text-tbc-300"><FolderKanban className="h-4 w-4" /></div>
                  <div>
                    <div className="text-base font-bold text-tbc-100">{p.title}</div>
                    <div className={`mt-0.5 inline-block rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider ${st.color}`}>{st.label}</div>
                  </div>
                </div>
                <div className="flex gap-1">
                  <Button size="icon" variant="outline" className="h-8 w-8 border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950" onClick={() => openEdit(p)}><Pencil className="h-3.5 w-3.5" /></Button>
                  <Button size="icon" variant="outline" className="h-8 w-8 border-rose-900/60 bg-ink-900 text-rose-300 hover:bg-rose-500/10" onClick={() => del(p.id)}><Trash2 className="h-3.5 w-3.5" /></Button>
                </div>
              </div>
              {p.description && <p className="mt-3 line-clamp-3 text-sm text-tbc-200/70">{p.description}</p>}
              {(p.tags || []).length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1">
                  {p.tags.map((t) => (
                    <span key={t} className="inline-flex items-center gap-1 rounded-full bg-ink-950 px-2 py-0.5 text-[10px] text-tbc-200/80"><Tag className="h-2.5 w-2.5" />{t}</span>
                  ))}
                </div>
              )}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Select value={p.status} onValueChange={(v) => setStatus(p, v)}>
                  <SelectTrigger className="h-7 w-28 bg-ink-950 border-tbc-900/60 text-xs text-tbc-100"><SelectValue /></SelectTrigger>
                  <SelectContent className="bg-ink-900 border-tbc-900/60 text-tbc-100">
                    {STATUSES.map((s) => <SelectItem key={s.v} value={s.v}>{s.label}</SelectItem>)}
                  </SelectContent>
                </Select>
                {p.chat_session_id && <a href={`/dashboard/${p.chat_session_id}`} className="inline-flex items-center gap-1 rounded-md border border-tbc-900/60 bg-ink-950 px-2 py-1 text-[11px] text-tbc-200 hover:bg-ink-900"><MessageSquare className="h-3 w-3" /> Open chat</a>}
                {p.link_url && <a href={p.link_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-md border border-tbc-900/60 bg-ink-950 px-2 py-1 text-[11px] text-tbc-200 hover:bg-ink-900"><ExternalLink className="h-3 w-3" /> Link</a>}
              </div>
            </div>
          );
        })}
      </div>
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

import React, { useEffect, useState } from 'react';
import api from '../../lib/api';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Textarea } from '../../components/ui/textarea';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '../../components/ui/dialog';
import { toast } from 'sonner';
import {
  Plus, KeyRound, Copy, Check, Pencil, Ban, RotateCcw, Trash2, Loader2,
} from 'lucide-react';

const EMPTY = { holder_name: '', holder_email: '', company: '', royalty_pct: 10, notes: '' };

export default function LicensesTab() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState('');

  const load = async () => {
    setLoading(true);
    try { const { data } = await api.get('/operator/licenses'); setItems(data); }
    catch { toast.error('Failed to load licenses'); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const openCreate = () => { setEditing(null); setForm(EMPTY); setOpen(true); };
  const openEdit = (l) => { setEditing(l.id); setForm({ holder_name: l.holder_name, holder_email: l.holder_email, company: l.company || '', royalty_pct: l.royalty_pct, notes: l.notes || '' }); setOpen(true); };
  const save = async () => {
    if (!form.holder_name || !form.holder_email) return toast.error('Holder name and email required');
    setSaving(true);
    try {
      const payload = { ...form, royalty_pct: Number(form.royalty_pct || 10) };
      if (editing) await api.put(`/operator/licenses/${editing}`, payload);
      else await api.post('/operator/licenses', payload);
      toast.success('Saved');
      setOpen(false);
      load();
    } catch (e) { toast.error(e?.response?.data?.detail || 'Save failed'); }
    finally { setSaving(false); }
  };
  const revoke = async (id) => { try { await api.post(`/operator/licenses/${id}/revoke`); toast.success('Revoked'); load(); } catch { toast.error('Revoke failed'); } };
  const reactivate = async (id) => { try { await api.post(`/operator/licenses/${id}/activate`); toast.success('Reactivated'); load(); } catch { toast.error('Activate failed'); } };
  const del = async (id) => { if (!window.confirm('Delete this license permanently?')) return; try { await api.delete(`/operator/licenses/${id}`); toast.success('Deleted'); load(); } catch { toast.error('Delete failed'); } };
  const copy = (id, v) => { navigator.clipboard.writeText(v); setCopied(id); setTimeout(() => setCopied(''), 1500); };

  if (loading) return <div className="grid place-items-center py-12"><Loader2 className="h-6 w-6 animate-spin text-tbc-400" /></div>;

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <div>
          <p className="text-sm text-tbc-200/60">Issue license keys to partners who run a copy of TBC. Every license owes you a flat royalty on all earnings.</p>
          <p className="text-[11px] text-tbc-300/70">Licensees must call <code className="rounded bg-ink-950 px-1 py-0.5 font-mono text-[10px]">POST /api/license/report-earnings</code> on each paid transaction.</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button onClick={openCreate} className="bg-tbc-500 text-ink-950 hover:bg-tbc-400 font-semibold"><Plus className="mr-1.5 h-4 w-4" /> Issue license</Button>
          </DialogTrigger>
          <DialogContent className="border-tbc-900/60 bg-ink-900 text-tbc-100">
            <DialogHeader><DialogTitle>{editing ? 'Edit license' : 'Issue new license'}</DialogTitle></DialogHeader>
            <div className="grid gap-3">
              <Field label="Holder name"><Input className="bg-ink-950 border-tbc-900/60 text-tbc-100" value={form.holder_name} onChange={(e)=>setForm({...form, holder_name:e.target.value})} /></Field>
              <Field label="Holder email"><Input className="bg-ink-950 border-tbc-900/60 text-tbc-100" value={form.holder_email} onChange={(e)=>setForm({...form, holder_email:e.target.value})} /></Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Company"><Input className="bg-ink-950 border-tbc-900/60 text-tbc-100" value={form.company} onChange={(e)=>setForm({...form, company:e.target.value})} /></Field>
                <Field label="Royalty %"><Input type="number" step="0.1" className="bg-ink-950 border-tbc-900/60 text-tbc-100" value={form.royalty_pct} onChange={(e)=>setForm({...form, royalty_pct:e.target.value})} /></Field>
              </div>
              <Field label="Internal notes"><Textarea rows={2} className="bg-ink-950 border-tbc-900/60 text-tbc-100" value={form.notes} onChange={(e)=>setForm({...form, notes:e.target.value})} /></Field>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)} className="border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950">Cancel</Button>
              <Button onClick={save} disabled={saving} className="bg-tbc-500 text-ink-950 hover:bg-tbc-400 font-semibold">{saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}{editing ? 'Save' : 'Issue license'}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid gap-3">
        {items.length === 0 && (
          <div className="rounded-xl border border-dashed border-tbc-900/60 p-10 text-center text-tbc-200/50">No licenses issued yet.</div>
        )}
        {items.map((l) => (
          <div key={l.id} className={`rounded-xl border p-5 ${l.status === 'active' ? 'border-tbc-900/60 bg-ink-900/60' : 'border-rose-900/40 bg-rose-500/[0.03]'}`}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <KeyRound className="h-4 w-4 text-tbc-300" />
                  <span className="text-base font-bold text-tbc-100">{l.holder_name}</span>
                  {l.company && <span className="text-xs text-tbc-200/60">• {l.company}</span>}
                  <span className={`rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider ${l.status === 'active' ? 'bg-tbc-500/15 text-tbc-300' : 'bg-rose-500/20 text-rose-300'}`}>{l.status}</span>
                  <span className="rounded-full bg-ink-950 px-2 py-0.5 text-[10px] uppercase tracking-wider text-tbc-200/70">{l.royalty_pct}% royalty</span>
                </div>
                <div className="mt-1 text-xs text-tbc-200/60">{l.holder_email}</div>
                <div className="mt-3 flex items-center gap-2">
                  <code className="truncate rounded-md border border-tbc-900/60 bg-ink-950 px-2 py-1 text-xs font-mono text-tbc-300">{l.key}</code>
                  <Button size="sm" variant="outline" className="border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950" onClick={() => copy(l.id, l.key)}>
                    {copied === l.id ? <Check className="h-3.5 w-3.5 text-tbc-300" /> : <Copy className="h-3.5 w-3.5" />}
                  </Button>
                </div>
                {l.last_report_at && <div className="mt-1 text-[11px] text-tbc-200/50">Last report: {new Date(l.last_report_at).toLocaleString()}</div>}
              </div>
              <div className="text-right text-xs">
                <div className="text-tbc-300">Owed: <span className="font-bold text-tbc-100">${(l.owed_amount || 0).toFixed(2)}</span> ({l.owed_count || 0})</div>
                <div className="text-tbc-200/60">Remitted: ${(l.remitted_amount || 0).toFixed(2)}</div>
                <div className="mt-3 flex gap-1">
                  <Button size="sm" variant="outline" className="border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950" onClick={() => openEdit(l)}><Pencil className="h-3.5 w-3.5" /></Button>
                  {l.status === 'active' ? (
                    <Button size="sm" variant="outline" className="border-tbc-900/60 bg-ink-900 text-amber-300 hover:bg-ink-950" onClick={() => revoke(l.id)}><Ban className="h-3.5 w-3.5" /></Button>
                  ) : (
                    <Button size="sm" variant="outline" className="border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950" onClick={() => reactivate(l.id)}><RotateCcw className="h-3.5 w-3.5" /></Button>
                  )}
                  <Button size="sm" variant="outline" className="border-rose-900/60 bg-ink-900 text-rose-300 hover:bg-rose-500/10" onClick={() => del(l.id)}><Trash2 className="h-3.5 w-3.5" /></Button>
                </div>
              </div>
            </div>
          </div>
        ))}
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

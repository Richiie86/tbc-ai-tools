import React, { useEffect, useState } from 'react';
import api from '../../lib/api';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Textarea } from '../../components/ui/textarea';
import { Switch } from '../../components/ui/switch';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '../../components/ui/dialog';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, Loader2, Sparkles } from 'lucide-react';

const EMPTY_PLAN = { id: '', name: '', price: 0, regular_price: 0, credits: 0, intro: false, features: [], enabled: true, order: 0 };

export default function PlansTab() {
  const [plans, setPlans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY_PLAN);
  const [saving, setSaving] = useState(false);
  const [featuresText, setFeaturesText] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/operator/plans');
      setPlans(data);
    } catch { toast.error('Failed to load plans'); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_PLAN);
    setFeaturesText('');
    setOpen(true);
  };
  const openEdit = (p) => {
    setEditing(p.id);
    setForm({ ...p });
    setFeaturesText((p.features || []).join('\n'));
    setOpen(true);
  };
  const save = async () => {
    if (!form.name || form.price < 0 || form.credits < 0) return toast.error('Name, price and credits are required');
    setSaving(true);
    try {
      const payload = {
        ...form,
        features: featuresText.split('\n').map((s) => s.trim()).filter(Boolean),
        price: Number(form.price),
        regular_price: Number(form.regular_price || form.price),
        credits: Number(form.credits),
        order: Number(form.order || 0),
      };
      if (editing) {
        await api.put(`/operator/plans/${editing}`, payload);
        toast.success('Plan updated');
      } else {
        await api.post('/operator/plans', payload);
        toast.success('Plan created');
      }
      setOpen(false);
      load();
    } catch (e) { toast.error(e?.response?.data?.detail || 'Save failed'); }
    finally { setSaving(false); }
  };
  const del = async (id) => {
    if (!window.confirm('Delete plan ' + id + '?')) return;
    try { await api.delete(`/operator/plans/${id}`); toast.success('Deleted'); load(); }
    catch { toast.error('Delete failed'); }
  };

  if (loading) return <div className="grid place-items-center py-12"><Loader2 className="h-6 w-6 animate-spin text-tbc-400" /></div>;

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm text-tbc-200/60">Edit pricing, credits, and visibility of subscription plans. Changes apply instantly.</p>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button onClick={openCreate} className="bg-tbc-500 text-ink-950 hover:bg-tbc-400 font-semibold"><Plus className="mr-1.5 h-4 w-4" /> New plan</Button>
          </DialogTrigger>
          <DialogContent className="border-tbc-900/60 bg-ink-900 text-tbc-100">
            <DialogHeader><DialogTitle>{editing ? 'Edit plan' : 'New plan'}</DialogTitle></DialogHeader>
            <div className="grid gap-3">
              <div className="grid grid-cols-2 gap-3">
                <Field label="ID (unique)"><Input className="bg-ink-950 border-tbc-900/60 text-tbc-100" value={form.id} onChange={(e)=>setForm({...form, id:e.target.value})} disabled={!!editing} /></Field>
                <Field label="Name"><Input className="bg-ink-950 border-tbc-900/60 text-tbc-100" value={form.name} onChange={(e)=>setForm({...form, name:e.target.value})} /></Field>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <Field label="Price ($)"><Input type="number" step="0.01" className="bg-ink-950 border-tbc-900/60 text-tbc-100" value={form.price} onChange={(e)=>setForm({...form, price:e.target.value})} /></Field>
                <Field label="Regular price ($)"><Input type="number" step="0.01" className="bg-ink-950 border-tbc-900/60 text-tbc-100" value={form.regular_price} onChange={(e)=>setForm({...form, regular_price:e.target.value})} /></Field>
                <Field label="Credits"><Input type="number" className="bg-ink-950 border-tbc-900/60 text-tbc-100" value={form.credits} onChange={(e)=>setForm({...form, credits:e.target.value})} /></Field>
              </div>
              <Field label="Features (one per line)">
                <Textarea rows={4} className="bg-ink-950 border-tbc-900/60 text-tbc-100" value={featuresText} onChange={(e)=>setFeaturesText(e.target.value)} />
              </Field>
              <div className="grid grid-cols-3 gap-3">
                <Field label="Order"><Input type="number" className="bg-ink-950 border-tbc-900/60 text-tbc-100" value={form.order} onChange={(e)=>setForm({...form, order:e.target.value})} /></Field>
                <Field label="Intro pricing"><div className="pt-2"><Switch checked={!!form.intro} onCheckedChange={(v)=>setForm({...form, intro:v})} /></div></Field>
                <Field label="Enabled"><div className="pt-2"><Switch checked={!!form.enabled} onCheckedChange={(v)=>setForm({...form, enabled:v})} /></div></Field>
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
        {plans.map((p) => (
          <div key={p.id} className="rounded-xl border border-tbc-900/60 bg-ink-900/60 p-5">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-2">
                <div className="grid h-9 w-9 place-items-center rounded-lg bg-tbc-500/15 text-tbc-300"><Sparkles className="h-4 w-4" /></div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-base font-bold text-tbc-100">{p.name}</span>
                    {!p.enabled && <span className="rounded-full bg-rose-500/15 px-2 py-0.5 text-[10px] uppercase text-rose-300">disabled</span>}
                  </div>
                  <div className="text-[10px] uppercase tracking-wider text-tbc-200/50">{p.id}</div>
                </div>
              </div>
              <div className="flex gap-1">
                <Button size="icon" variant="outline" className="h-8 w-8 border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950" onClick={() => openEdit(p)}><Pencil className="h-3.5 w-3.5" /></Button>
                <Button size="icon" variant="outline" className="h-8 w-8 border-rose-900/60 bg-ink-900 text-rose-300 hover:bg-rose-500/10" onClick={() => del(p.id)}><Trash2 className="h-3.5 w-3.5" /></Button>
              </div>
            </div>
            <div className="mt-3 flex items-baseline gap-1">
              <span className="text-3xl font-bold text-tbc-50">${p.price}</span>
              <span className="text-xs text-tbc-200/60">/mo</span>
              {p.intro && p.regular_price > p.price && (
                <span className="ml-2 text-xs text-tbc-300">then ${p.regular_price}/mo</span>
              )}
            </div>
            <div className="text-xs text-tbc-300">{p.credits.toLocaleString()} credits</div>
            <ul className="mt-3 space-y-1 text-xs text-tbc-200/80">
              {p.features.slice(0, 4).map((f) => <li key={`${p.id}-feat-${f}`}>• {f}</li>)}
              {p.features.length > 4 && <li className="text-tbc-200/40">+ {p.features.length - 4} more</li>}
            </ul>
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

import React, { useEffect, useState, useCallback } from 'react';
import api from '../../lib/api';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Textarea } from '../../components/ui/textarea';
import { Switch } from '../../components/ui/switch';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '../../components/ui/dialog';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, Loader2, Sparkles, Clock, Percent } from 'lucide-react';

const EMPTY_PLAN = { id: '', name: '', price: 0, regular_price: 0, credits: 0, intro: false, features: [], enabled: true, order: 0, trial_days: 0 };

const computeDiscountPct = (regular, price) => {
  const r = Number(regular) || 0;
  const p = Number(price) || 0;
  if (r <= 0 || p < 0 || p > r) return 0;
  return Math.round(((r - p) / r) * 100);
};

const applyDiscountPct = (regular, pct) => {
  const r = Number(regular) || 0;
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  return Math.round(r * (1 - p / 100) * 100) / 100;
};

export default function PlansTab() {
  const [plans, setPlans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY_PLAN);
  const [saving, setSaving] = useState(false);
  const [featuresText, setFeaturesText] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/operator/plans');
      setPlans(data);
    } catch { toast.error('Failed to load plans'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

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
        trial_days: Number(form.trial_days || 0),
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
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-sm text-tbc-200/60">Edit pricing, credits, and visibility of subscription plans. Changes apply instantly.</p>
        <div className="flex items-center gap-2">
          <DiscountCampaignButton onDone={load} />
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
              <div className="grid grid-cols-4 gap-3">
                <Field label="Regular price ($)">
                  <Input
                    type="number"
                    step="0.01"
                    data-testid="plans-form-regular-price"
                    className="bg-ink-950 border-tbc-900/60 text-tbc-100"
                    value={form.regular_price}
                    onChange={(e)=>{
                      const newReg = e.target.value;
                      const pct = computeDiscountPct(form.regular_price, form.price);
                      // If price was a clean discount of old regular, recompute price for new regular
                      const newPrice = pct > 0 ? applyDiscountPct(newReg, pct) : form.price;
                      setForm({...form, regular_price: newReg, price: newPrice, intro: pct > 0});
                    }}
                  />
                </Field>
                <Field label="% off">
                  <div className="relative">
                    <Input
                      type="number"
                      step="1"
                      min="0"
                      max="100"
                      data-testid="plans-form-discount-pct"
                      className="bg-ink-950 border-tbc-900/60 text-tbc-100 pr-7"
                      value={computeDiscountPct(form.regular_price, form.price)}
                      onChange={(e)=>{
                        const pct = e.target.value;
                        const newPrice = applyDiscountPct(form.regular_price, pct);
                        setForm({...form, price: newPrice, intro: Number(pct) > 0});
                      }}
                    />
                    <Percent className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-tbc-300/60" />
                  </div>
                </Field>
                <Field label="Price ($)">
                  <Input
                    type="number"
                    step="0.01"
                    data-testid="plans-form-price"
                    className="bg-ink-950 border-tbc-900/60 text-tbc-100"
                    value={form.price}
                    onChange={(e)=>setForm({...form, price:e.target.value})}
                  />
                </Field>
                <Field label="Credits"><Input type="number" className="bg-ink-950 border-tbc-900/60 text-tbc-100" value={form.credits} onChange={(e)=>setForm({...form, credits:e.target.value})} /></Field>
              </div>
              {Number(form.regular_price) > 0 && Number(form.price) >= 0 && Number(form.price) < Number(form.regular_price) && (
                <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200" data-testid="plans-form-discount-summary">
                  Customers save <span className="font-bold">${(Number(form.regular_price) - Number(form.price)).toFixed(2)}</span> ({computeDiscountPct(form.regular_price, form.price)}% off) — first month at <span className="font-bold">${Number(form.price).toFixed(2)}</span>, then <span className="font-bold">${Number(form.regular_price).toFixed(2)}/mo</span>.
                </div>
              )}
              <Field label="Features (one per line)">
                <Textarea rows={4} className="bg-ink-950 border-tbc-900/60 text-tbc-100" value={featuresText} onChange={(e)=>setFeaturesText(e.target.value)} />
              </Field>
              <div className="grid grid-cols-4 gap-3">
                <Field label="Order"><Input type="number" className="bg-ink-950 border-tbc-900/60 text-tbc-100" value={form.order} onChange={(e)=>setForm({...form, order:e.target.value})} /></Field>
                <Field label="Trial days (0 = permanent)">
                  <Input
                    type="number"
                    min="0"
                    data-testid="plans-form-trial-days"
                    className="bg-ink-950 border-tbc-900/60 text-tbc-100"
                    value={form.trial_days ?? 0}
                    onChange={(e)=>setForm({...form, trial_days:e.target.value})}
                  />
                </Field>
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
                    {p.trial_days > 0 && (
                      <span className="inline-flex items-center gap-1 rounded-full border border-sky-500/30 bg-sky-500/15 px-2 py-0.5 text-[10px] uppercase text-sky-300" data-testid={`plan-trial-badge-${p.id}`}>
                        <Clock className="h-2.5 w-2.5" /> {p.trial_days}-day trial
                      </span>
                    )}
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
                <>
                  <span className="ml-2 text-xs text-tbc-300">then ${p.regular_price}/mo</span>
                  <span className="ml-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase text-emerald-300" data-testid={`plan-discount-badge-${p.id}`}>
                    -{computeDiscountPct(p.regular_price, p.price)}%
                  </span>
                </>
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

function DiscountCampaignButton({ onDone }) {
  const [open, setOpen] = useState(false);
  const [percent, setPercent] = useState(20);
  const [announce, setAnnounce] = useState(true);
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [bannerText, setBannerText] = useState('');
  const [busy, setBusy] = useState(false);

  const apply = async (clear) => {
    setBusy(true);
    try {
      const { data } = await api.post('/operator/plans/discount-campaign', {
        percent: Number(percent) || 0,
        clear,
        announce_on_banner: announce,
        starts_at: startsAt || null,
        ends_at: endsAt || null,
        banner_text: bannerText || null,
      });
      const bannerNote = data.banner_updated ? ' · banner updated' : '';
      toast.success(
        clear
          ? `Cleared discounts on ${data.updated} plans${bannerNote}`
          : `Applied ${percent}% off to ${data.updated} plans${bannerNote}`
      );
      setOpen(false);
      onDone?.();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Campaign failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          className="border-emerald-500/40 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20"
          data-testid="plans-campaign-open-btn"
        >
          <Percent className="mr-1.5 h-4 w-4" /> Discount campaign
        </Button>
      </DialogTrigger>
      <DialogContent className="border-tbc-900/60 bg-ink-900 text-tbc-100 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Apply a global discount campaign</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-xs text-tbc-200/60">
            Sets each plan&apos;s first-month price to its regular price minus this percentage.
            Optionally pushes a matching message into the scrolling banner, scheduled to
            auto-start and auto-end at the times you pick.
          </p>
          <Field label="% off (0-100)">
            <Input
              type="number"
              min="0"
              max="100"
              data-testid="plans-campaign-pct-input"
              className="bg-ink-950 border-tbc-900/60 text-tbc-100"
              value={percent}
              onChange={(e) => setPercent(e.target.value)}
            />
          </Field>
          <label className="flex items-center justify-between rounded-md border border-tbc-900/60 bg-ink-950/50 px-3 py-2">
            <div className="flex flex-col">
              <span className="text-xs font-semibold text-tbc-100">Also announce on marketing banner</span>
              <span className="text-[10px] text-tbc-200/60">Adds a scrolling message linking to /pricing across landing + dashboard.</span>
            </div>
            <input
              type="checkbox"
              data-testid="plans-campaign-announce"
              checked={announce}
              onChange={(e) => setAnnounce(e.target.checked)}
              className="h-4 w-4 accent-emerald-500"
            />
          </label>
          {announce && (
            <>
              <Field label="Banner text (optional — defaults to '20% off all plans!')">
                <Input
                  data-testid="plans-campaign-banner-text"
                  className="bg-ink-950 border-tbc-900/60 text-tbc-100"
                  placeholder={`Limited offer — ${percent || 20}% off all plans!`}
                  value={bannerText}
                  onChange={(e) => setBannerText(e.target.value)}
                />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Starts at (date + time)">
                  <Input
                    type="datetime-local"
                    data-testid="plans-campaign-starts-at"
                    className="bg-ink-950 border-tbc-900/60 text-tbc-100"
                    value={startsAt}
                    onChange={(e) => setStartsAt(e.target.value)}
                  />
                </Field>
                <Field label="Ends at (date + time)">
                  <Input
                    type="datetime-local"
                    data-testid="plans-campaign-ends-at"
                    className="bg-ink-950 border-tbc-900/60 text-tbc-100"
                    value={endsAt}
                    onChange={(e) => setEndsAt(e.target.value)}
                  />
                </Field>
              </div>
              <p className="text-[10px] text-tbc-200/50">
                Leave both blank to start immediately and run until you retract it.
                Banner only renders to users when the current time falls inside the window.
              </p>
            </>
          )}
        </div>
        <DialogFooter className="flex-col gap-2 sm:flex-row">
          <Button
            variant="outline"
            onClick={() => apply(true)}
            disabled={busy}
            className="border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950"
            data-testid="plans-campaign-clear-btn"
          >
            Clear discounts &amp; retract banner
          </Button>
          <Button
            onClick={() => apply(false)}
            disabled={busy || !percent}
            className="bg-emerald-500 text-ink-950 hover:bg-emerald-400 font-semibold"
            data-testid="plans-campaign-apply-btn"
          >
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Apply {percent}% off
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

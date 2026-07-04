import React, { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../../lib/api';
import { toast } from 'sonner';
import {
  DollarSign, Loader2, Save, TrendingUp, Percent, Coins, Lock,
  UserCog, Trash2, Plus, Info,
} from 'lucide-react';
import { Input } from '../../components/ui/input';
import { Button } from '../../components/ui/button';

function money(n) {
  const v = Number(n) || 0;
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
}

export default function PricingTab({ users = [] }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [pricing, setPricing] = useState(null);
  const [examples, setExamples] = useState([]);
  const [overrides, setOverrides] = useState([]);

  // per-user override form
  const [ovUser, setOvUser] = useState('');
  const [ovCredits, setOvCredits] = useState('1');
  const [ovSaving, setOvSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/operator/amai/pricing');
      setPricing(data.pricing);
      setExamples(data.examples || []);
      setOverrides(data.user_overrides || []);
    } catch {
      toast.error('Could not load pricing.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const setField = (k, v) => setPricing((p) => ({ ...p, [k]: v }));

  const save = async () => {
    setSaving(true);
    try {
      const { data } = await api.put('/operator/amai/pricing', {
        mode: pricing.mode,
        margin_pct: Number(pricing.margin_pct),
        usd_per_credit: Number(pricing.usd_per_credit),
        fixed_cost_credits: Number(pricing.fixed_cost_credits),
        min_credits_per_msg: Number(pricing.min_credits_per_msg),
      });
      setPricing(data.pricing);
      setExamples(data.examples || []);
      setOverrides(data.user_overrides || []);
      toast.success('Pricing saved. It applies to the next message.');
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not save pricing.');
    } finally {
      setSaving(false);
    }
  };

  const addOverride = async () => {
    if (!ovUser) { toast.error('Pick a user first.'); return; }
    setOvSaving(true);
    try {
      const { data } = await api.put('/operator/amai/pricing/user-override', {
        user_id: ovUser, credits: Number(ovCredits),
      });
      setOverrides(data.user_overrides || []);
      setOvUser(''); setOvCredits('1');
      toast.success('Per-user cost set.');
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not set override.');
    } finally {
      setOvSaving(false);
    }
  };

  const clearOverride = async (uid) => {
    try {
      const { data } = await api.put('/operator/amai/pricing/user-override', {
        user_id: uid, credits: null,
      });
      setOverrides(data.user_overrides || []);
      toast.success('Override removed.');
    } catch {
      toast.error('Could not remove override.');
    }
  };

  const availableUsers = useMemo(() => {
    const taken = new Set(overrides.map((o) => o.user_id));
    return users.filter((u) => !taken.has(u.id));
  }, [users, overrides]);

  if (loading || !pricing) {
    return (
      <div className="flex items-center gap-2 py-16 text-tbc-200/60">
        <Loader2 className="h-5 w-5 animate-spin" /> Loading pricing…
      </div>
    );
  }

  const isFixed = pricing.mode === 'fixed';

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-bold text-tbc-100">
            <DollarSign className="h-5 w-5 text-emerald-400" /> Pricing — what a message costs
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-tbc-200/60">
            Charge each AI message the provider&apos;s <span className="font-semibold text-tbc-100">actual cost plus a
            margin</span> so you profit on every question — or pin a fixed credit cost for everyone or for one user.
            BYOK and operator messages are always free.
          </p>
        </div>
        <Button onClick={save} disabled={saving}
          className="bg-emerald-500 font-semibold text-ink-950 hover:bg-emerald-400">
          {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Save className="mr-1.5 h-4 w-4" />} Save pricing
        </Button>
      </header>

      {/* Mode selector */}
      <div className="grid gap-4 sm:grid-cols-2">
        <button type="button" onClick={() => setField('mode', 'margin')}
          className={`rounded-xl border p-4 text-left transition ${
            !isFixed ? 'border-emerald-500/50 bg-emerald-500/10' : 'border-tbc-900/60 bg-ink-900 hover:border-tbc-500/40'
          }`}>
          <div className="flex items-center gap-2 font-semibold text-tbc-100">
            <TrendingUp className="h-4 w-4 text-emerald-400" /> Cost + margin
          </div>
          <p className="mt-1 text-sm text-tbc-200/60">
            Auto-charges the real AI cost plus your margin. Scales with model & length — you never lose money.
          </p>
        </button>
        <button type="button" onClick={() => setField('mode', 'fixed')}
          className={`rounded-xl border p-4 text-left transition ${
            isFixed ? 'border-emerald-500/50 bg-emerald-500/10' : 'border-tbc-900/60 bg-ink-900 hover:border-tbc-500/40'
          }`}>
          <div className="flex items-center gap-2 font-semibold text-tbc-100">
            <Lock className="h-4 w-4 text-emerald-400" /> Fixed cost
          </div>
          <p className="mt-1 text-sm text-tbc-200/60">
            Every message costs the same number of credits, whatever the model.
          </p>
        </button>
      </div>

      {/* Numeric controls */}
      <div className="grid gap-4 rounded-xl border border-tbc-900/60 bg-ink-900 p-5 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Margin %" icon={Percent} disabled={isFixed}
          hint="Profit added on top of the AI's real cost."
          value={pricing.margin_pct}
          onChange={(v) => setField('margin_pct', v)} />
        <Field label="USD per credit" icon={Coins}
          hint="What one credit is worth (100 credits = $9 → 0.09)."
          value={pricing.usd_per_credit} step="0.01"
          onChange={(v) => setField('usd_per_credit', v)} />
        <Field label="Fixed cost (credits)" icon={Lock} disabled={!isFixed}
          hint="Credits per message in Fixed mode."
          value={pricing.fixed_cost_credits}
          onChange={(v) => setField('fixed_cost_credits', v)} />
        <Field label="Min credits / message" icon={Info}
          hint="Never charge less than this in margin mode."
          value={pricing.min_credits_per_msg}
          onChange={(v) => setField('min_credits_per_msg', v)} />
      </div>

      {/* Profit preview */}
      <div className="rounded-xl border border-tbc-900/60 bg-ink-900 p-5">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-tbc-100">
          <TrendingUp className="h-4 w-4 text-emerald-400" /> Profit preview (typical message)
        </h3>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-tbc-200/50">
                <th className="pb-2">Model</th>
                <th className="pb-2">AI cost</th>
                <th className="pb-2">Credits charged</th>
                <th className="pb-2">User pays</th>
                <th className="pb-2">Your profit</th>
              </tr>
            </thead>
            <tbody className="text-tbc-100">
              {examples.map((e) => (
                <tr key={e.model} className="border-t border-tbc-900/60">
                  <td className="py-2 font-mono text-xs text-tbc-200/80">{e.model}</td>
                  <td className="py-2">{money(e.ai_cost_usd)}</td>
                  <td className="py-2">{e.credits_charged}</td>
                  <td className="py-2">{money(e.user_pays_usd)}</td>
                  <td className={`py-2 font-semibold ${e.your_profit_usd >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {money(e.your_profit_usd)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Per-user overrides */}
      <div className="rounded-xl border border-tbc-900/60 bg-ink-900 p-5">
        <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold text-tbc-100">
          <UserCog className="h-4 w-4 text-tbc-300" /> Per-user fixed cost
        </h3>
        <p className="mb-4 text-sm text-tbc-200/60">
          Override the cost for a specific user (e.g. a free VIP at 0 credits, or a heavy user at a flat rate).
          This always wins over the global rule.
        </p>

        <div className="mb-4 flex flex-wrap items-end gap-3">
          <div className="min-w-[220px] flex-1">
            <label className="mb-1 block text-xs font-medium text-tbc-200/60">User</label>
            <select value={ovUser} onChange={(e) => setOvUser(e.target.value)}
              className="w-full rounded-md border border-tbc-900/60 bg-ink-950 px-3 py-2 text-sm text-tbc-100">
              <option value="">Select a user…</option>
              {availableUsers.map((u) => (
                <option key={u.id} value={u.id}>{u.name || u.email || u.id}</option>
              ))}
            </select>
          </div>
          <div className="w-40">
            <label className="mb-1 block text-xs font-medium text-tbc-200/60">Credits / message</label>
            <Input type="number" min="0" step="1" value={ovCredits}
              onChange={(e) => setOvCredits(e.target.value)} />
          </div>
          <Button onClick={addOverride} disabled={ovSaving}
            className="bg-tbc-500 font-semibold text-ink-950 hover:bg-tbc-400">
            {ovSaving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Plus className="mr-1.5 h-4 w-4" />} Set cost
          </Button>
        </div>

        {overrides.length === 0 ? (
          <p className="text-sm text-tbc-200/40">No per-user overrides yet.</p>
        ) : (
          <ul className="divide-y divide-tbc-900/60">
            {overrides.map((o) => (
              <li key={o.user_id} className="flex items-center justify-between py-2.5">
                <div>
                  <p className="text-sm font-medium text-tbc-100">{o.label}</p>
                  {o.email && <p className="text-xs text-tbc-200/50">{o.email}</p>}
                </div>
                <div className="flex items-center gap-3">
                  <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 text-xs font-semibold text-emerald-300">
                    {o.credits} credit{Number(o.credits) === 1 ? '' : 's'} / msg
                  </span>
                  <button type="button" onClick={() => clearOverride(o.user_id)}
                    className="rounded-md p-1.5 text-tbc-200/40 hover:bg-rose-500/10 hover:text-rose-300"
                    title="Remove override" aria-label="Remove override">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Field({ label, icon: Icon, value, onChange, hint, step = '1', disabled = false }) {
  return (
    <div className={disabled ? 'opacity-50' : ''}>
      <label className="mb-1 flex items-center gap-1.5 text-xs font-medium text-tbc-200/60">
        <Icon className="h-3.5 w-3.5" /> {label}
      </label>
      <Input type="number" step={step} value={value} disabled={disabled}
        onChange={(e) => onChange(e.target.value)} />
      {hint && <p className="mt-1 text-[11px] leading-snug text-tbc-200/40">{hint}</p>}
    </div>
  );
}

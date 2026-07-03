import React, { useCallback, useEffect, useState } from 'react';
import api from '../../lib/api';
import { toast } from 'sonner';
import {
  Gauge, ExternalLink, Plus, Trash2, Save, Loader2, RefreshCw,
} from 'lucide-react';
import { Input } from '../../components/ui/input';
import { Button } from '../../components/ui/button';

const UNITS = ['USD', 'EUR', 'credits', 'requests', 'tokens', 'emails', 'GB'];

function pct(used, total) {
  if (!total || total <= 0) return null;
  return Math.min(100, Math.max(0, (used / total) * 100));
}

function fmt(n) {
  const v = Number(n) || 0;
  return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function MeterCard({ m, onChange, onRemove }) {
  const remaining = Math.max(0, (Number(m.total) || 0) - (Number(m.used) || 0));
  const p = pct(Number(m.used), Number(m.total));
  const danger = p != null && p >= 90;
  const warn = p != null && p >= 70 && p < 90;
  const barColor = danger ? 'bg-rose-400' : warn ? 'bg-amber-400' : 'bg-emerald-400';

  return (
    <div className="rounded-xl border border-tbc-900/60 bg-ink-900 p-4">
      <div className="flex items-center justify-between gap-2">
        <Input
          value={m.provider}
          onChange={(e) => onChange({ ...m, provider: e.target.value })}
          className="h-8 max-w-[60%] border-transparent bg-transparent px-1 text-base font-semibold text-tbc-100 focus:border-tbc-900/60 focus:bg-ink-950"
          aria-label="Provider name"
        />
        <div className="flex items-center gap-1">
          {m.refill_url && (
            <a href={m.refill_url} target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded-md border border-tbc-500/40 px-2 py-1 text-[11px] font-medium text-tbc-300 hover:bg-tbc-500/10"
              title="Open billing / refill page">
              Refill <ExternalLink className="h-3 w-3" />
            </a>
          )}
          <button type="button" onClick={onRemove}
            className="rounded-md p-1.5 text-tbc-200/40 hover:bg-rose-500/10 hover:text-rose-300"
            title="Remove meter" aria-label="Remove meter">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Progress */}
      <div className="mt-3">
        <div className="flex items-center justify-between text-[11px] text-tbc-200/60">
          <span>{p == null ? 'No limit set' : `${p.toFixed(0)}% used`}</span>
          <span className="font-mono text-tbc-100">{fmt(remaining)} {m.unit} left</span>
        </div>
        <div className="mt-1 h-2 overflow-hidden rounded-full bg-ink-950">
          <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${p ?? 0}%` }} />
        </div>
      </div>

      {/* Editable used / total / unit */}
      <div className="mt-3 grid grid-cols-3 gap-2">
        <label className="block">
          <span className="text-[10px] uppercase tracking-wider text-tbc-200/50">Used</span>
          <Input inputMode="decimal" value={m.used}
            onChange={(e) => onChange({ ...m, used: e.target.value })}
            className="mt-0.5 h-8 border-tbc-900/60 bg-ink-950 text-sm text-tbc-100" />
        </label>
        <label className="block">
          <span className="text-[10px] uppercase tracking-wider text-tbc-200/50">Total</span>
          <Input inputMode="decimal" value={m.total}
            onChange={(e) => onChange({ ...m, total: e.target.value })}
            className="mt-0.5 h-8 border-tbc-900/60 bg-ink-950 text-sm text-tbc-100" />
        </label>
        <label className="block">
          <span className="text-[10px] uppercase tracking-wider text-tbc-200/50">Unit</span>
          <select value={m.unit} onChange={(e) => onChange({ ...m, unit: e.target.value })}
            className="mt-0.5 h-8 w-full rounded-md border border-tbc-900/60 bg-ink-950 px-1 text-sm text-tbc-100">
            {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
          </select>
        </label>
      </div>

      <Input value={m.refill_url || ''} placeholder="https://…billing/refill link"
        onChange={(e) => onChange({ ...m, refill_url: e.target.value })}
        className="mt-2 h-7 border-tbc-900/60 bg-ink-950 text-[11px] text-tbc-200/70" />
    </div>
  );
}

export default function TaxameterTab() {
  const [meters, setMeters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [updatedAt, setUpdatedAt] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/operator/usage-meters');
      setMeters(data.meters || []);
      setUpdatedAt(data.updated_at || null);
    } catch {
      toast.error('Failed to load usage meters');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      const payload = meters.map((m) => ({
        ...m,
        used: parseFloat(String(m.used).replace(',', '.')) || 0,
        total: parseFloat(String(m.total).replace(',', '.')) || 0,
      }));
      const { data } = await api.put('/operator/usage-meters', { meters: payload });
      setMeters(data.meters || []);
      setUpdatedAt(data.updated_at || null);
      toast.success('Usage meters saved');
    } catch {
      toast.error('Failed to save');
    } finally {
      setSaving(false);
    }
  }, [meters]);

  const updateMeter = (idx, next) =>
    setMeters((prev) => prev.map((m, i) => (i === idx ? next : m)));
  const removeMeter = (idx) =>
    setMeters((prev) => prev.filter((_, i) => i !== idx));
  const addMeter = () =>
    setMeters((prev) => [
      ...prev,
      { id: `m_${Date.now()}`, provider: 'New provider', unit: 'USD', used: 0, total: 0, refill_url: '' },
    ]);

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-bold text-tbc-100">
            <Gauge className="h-5 w-5 text-tbc-300" /> Taxameter — provider usage
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-tbc-200/60">
            Track how much of each provider&apos;s budget/quota you&apos;ve used and how much is left, with a one-click
            refill link. Update the figures from each provider&apos;s dashboard — they persist across your devices.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" onClick={load} disabled={loading}
            className="border-tbc-900/60 bg-ink-900 text-tbc-200 hover:bg-ink-800">
            <RefreshCw className={`mr-1.5 h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Reload
          </Button>
          <Button onClick={save} disabled={saving}
            className="bg-tbc-500 font-semibold text-ink-950 hover:bg-tbc-400">
            {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Save className="mr-1.5 h-4 w-4" />} Save
          </Button>
        </div>
      </div>

      {updatedAt && (
        <p className="text-[11px] text-tbc-200/40">
          Last saved {new Date(updatedAt).toLocaleString()}
        </p>
      )}

      {loading ? (
        <div className="grid place-items-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-tbc-400" />
        </div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {meters.map((m, i) => (
              <MeterCard
                key={m.id || i}
                m={m}
                onChange={(next) => updateMeter(i, next)}
                onRemove={() => removeMeter(i)}
              />
            ))}
          </div>
          <Button variant="outline" onClick={addMeter}
            className="border-dashed border-tbc-900/60 bg-transparent text-tbc-200/70 hover:bg-ink-900">
            <Plus className="mr-1.5 h-4 w-4" /> Add provider
          </Button>
        </>
      )}
    </div>
  );
}

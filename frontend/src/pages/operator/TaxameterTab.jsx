import React, { useCallback, useEffect, useState } from 'react';
import api from '../../lib/api';
import { toast } from 'sonner';
import {
  Gauge, ExternalLink, Plus, Trash2, Save, Loader2, RefreshCw,
  Zap, CircleDot, KeyRound, Check, X, Link2, Sparkles,
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

function timeAgo(iso) {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// Small live/manual status badge driven by the backend sync metadata.
function StatusBadge({ m }) {
  if (m.source === 'live') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-200">
        <Zap className="h-3 w-3 fill-current" /> Live{timeAgo(m.synced_at) ? ` · ${timeAgo(m.synced_at)}` : ''}
      </span>
    );
  }
  const canGoLive = m.live_supported;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
        canGoLive
          ? 'border-amber-500/30 bg-amber-500/10 text-amber-200'
          : 'border-tbc-900/60 bg-ink-950 text-tbc-200/50'
      }`}
      title={m.sync_reason || 'Update this figure manually'}
    >
      <CircleDot className="h-3 w-3" /> Manual
    </span>
  );
}

// Shows WHY a card exists: linked to a key the operator added, or hand-made.
function OriginBadge({ m }) {
  if (m.origin === 'custom-key') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-sky-200"
        title="Auto-added from a custom key you saved. Delete the key to remove this card.">
        <Sparkles className="h-3 w-3" /> Custom key
      </span>
    );
  }
  if (m.origin === 'provider-key') {
    const set = m.key_present;
    return (
      <span
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
          set ? 'border-tbc-500/30 bg-tbc-500/10 text-tbc-200' : 'border-tbc-900/60 bg-ink-950 text-tbc-200/40'
        }`}
        title={set ? 'A key for this provider is configured.' : 'No key configured yet — add one in My Keys.'}
      >
        <Link2 className="h-3 w-3" /> {set ? 'Key set' : 'No key'}
      </span>
    );
  }
  return null;
}

// Inline billing/admin-key entry — only rendered for providers that CAN go live
// (OpenAI, Anthropic). Lets the operator paste an admin key so sync works.
function ProviderKeyField({ keyInfo, onSave }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async (clear = false) => {
    setBusy(true);
    try {
      await onSave(clear ? '' : value.trim());
      setValue('');
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-tbc-300 hover:text-tbc-100"
      >
        <KeyRound className="h-3 w-3" />
        {keyInfo.set ? `Billing key set (${keyInfo.masked}) — change` : `Add billing key for live sync`}
      </button>
    );
  }

  return (
    <div className="mt-2 rounded-md border border-tbc-900/60 bg-ink-950 p-2">
      <p className="mb-1 text-[10px] text-tbc-200/60">Paste {keyInfo.needs}</p>
      <div className="flex items-center gap-1">
        <Input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={keyInfo.masked || 'sk-…'}
          className="h-7 flex-1 border-tbc-900/60 bg-ink-900 text-[11px] text-tbc-100"
        />
        <button
          type="button" onClick={() => save(false)} disabled={busy || !value.trim()}
          className="rounded-md bg-emerald-500/20 p-1.5 text-emerald-200 hover:bg-emerald-500/30 disabled:opacity-40"
          title="Save key" aria-label="Save key"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
        </button>
        {keyInfo.set && (
          <button
            type="button" onClick={() => save(true)} disabled={busy}
            className="rounded-md p-1.5 text-tbc-200/50 hover:bg-rose-500/10 hover:text-rose-300"
            title="Remove key" aria-label="Remove key"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          type="button" onClick={() => { setOpen(false); setValue(''); }}
          className="rounded-md p-1.5 text-tbc-200/50 hover:bg-ink-800"
          title="Cancel" aria-label="Cancel"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function MeterCard({ m, keyInfo, onChange, onRemove, onSaveKey }) {
  const remaining = Math.max(0, (Number(m.total) || 0) - (Number(m.used) || 0));
  const p = pct(Number(m.used), Number(m.total));
  const danger = p != null && p >= 90;
  const warn = p != null && p >= 70 && p < 90;
  const barColor = danger ? 'bg-rose-400' : warn ? 'bg-amber-400' : 'bg-emerald-400';
  const isLive = m.source === 'live';

  return (
    <div className="rounded-xl border border-tbc-900/60 bg-ink-900 p-4">
      <div className="flex items-center justify-between gap-2">
        <Input
          value={m.provider}
          onChange={(e) => onChange({ ...m, provider: e.target.value })}
          className="h-8 max-w-[52%] border-transparent bg-transparent px-1 text-base font-semibold text-tbc-100 focus:border-tbc-900/60 focus:bg-ink-950"
          aria-label="Provider name"
        />
        <div className="flex items-center gap-1">
          <OriginBadge m={m} />
          <StatusBadge m={m} />
          {m.refill_url && (
            <a href={m.refill_url} target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded-md border border-tbc-500/40 px-2 py-1 text-[11px] font-medium text-tbc-300 hover:bg-tbc-500/10"
              title="Open billing / refill page">
              Refill <ExternalLink className="h-3 w-3" />
            </a>
          )}
          {/* Auto cards are managed by their key — remove the key to remove the
              card. Only hand-made meters get a delete button. */}
          {!m.auto && (
            <button type="button" onClick={onRemove}
              className="rounded-md p-1.5 text-tbc-200/40 hover:bg-rose-500/10 hover:text-rose-300"
              title="Remove meter" aria-label="Remove meter">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
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
          <span className="text-[10px] uppercase tracking-wider text-tbc-200/50">
            Used{isLive ? ' (live)' : ''}
          </span>
          <Input inputMode="decimal" value={m.used}
            onChange={(e) => onChange({ ...m, used: e.target.value })}
            className={`mt-0.5 h-8 border-tbc-900/60 bg-ink-950 text-sm ${isLive ? 'text-emerald-200' : 'text-tbc-100'}`} />
        </label>
        <label className="block">
          <span className="text-[10px] uppercase tracking-wider text-tbc-200/50">Total / budget</span>
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

      {/* Honest reason line when this provider isn't live */}
      {m.source !== 'live' && m.sync_reason && (
        <p className={`mt-2 text-[11px] ${m.live_supported ? 'text-amber-200/70' : 'text-tbc-200/40'}`}>
          {m.sync_reason}
        </p>
      )}

      {/* Billing-key entry for providers that can go live */}
      {keyInfo && <ProviderKeyField keyInfo={keyInfo} onSave={onSaveKey} />}

      <Input value={m.refill_url || ''} placeholder="https://…billing/refill link"
        onChange={(e) => onChange({ ...m, refill_url: e.target.value })}
        className="mt-2 h-7 border-tbc-900/60 bg-ink-950 text-[11px] text-tbc-200/70" />
    </div>
  );
}

export default function TaxameterTab() {
  const [meters, setMeters] = useState([]);
  const [providerKeys, setProviderKeys] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [meterRes, keyRes] = await Promise.all([
        api.get('/operator/usage-meters'),
        api.get('/operator/usage-meters/keys').catch(() => ({ data: { providers: {} } })),
      ]);
      setMeters(meterRes.data.meters || []);
      setUpdatedAt(meterRes.data.updated_at || null);
      setProviderKeys(keyRes.data.providers || {});
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

  const syncLive = useCallback(async () => {
    setSyncing(true);
    try {
      const { data } = await api.post('/operator/usage-meters/sync');
      setMeters(data.meters || []);
      setUpdatedAt(data.updated_at || null);
      toast.success(
        data.live_count > 0
          ? `Synced live — ${data.live_count} provider${data.live_count === 1 ? '' : 's'} pulled real spend.`
          : 'Synced. No provider returned live spend yet — add an admin/billing key to light one up.',
      );
    } catch {
      toast.error('Live sync failed. Try again.');
    } finally {
      setSyncing(false);
    }
  }, []);

  const saveProviderKey = useCallback(async (provider, value) => {
    try {
      await api.put('/operator/usage-meters/keys', { provider, value });
      toast.success(value ? 'Billing key saved — press Sync live.' : 'Billing key removed.');
      const keyRes = await api.get('/operator/usage-meters/keys').catch(() => null);
      if (keyRes) setProviderKeys(keyRes.data.providers || {});
    } catch {
      toast.error('Could not save the billing key.');
    }
  }, []);

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
            Every key you add anywhere in the app shows up here automatically — no setup. Press{' '}
            <span className="font-semibold text-tbc-100">Sync live</span> to pull real month-to-date spend from each
            provider&apos;s API. OpenAI and Anthropic need an admin/billing key (add it on the card); providers without
            a public spend API stay manual and say so.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button onClick={syncLive} disabled={syncing || loading}
            className="bg-emerald-500 font-semibold text-ink-950 hover:bg-emerald-400">
            {syncing ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Zap className="mr-1.5 h-4 w-4" />} Sync live
          </Button>
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
          Last updated {new Date(updatedAt).toLocaleString()}
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
                keyInfo={providerKeys[m.id]}
                onChange={(next) => updateMeter(i, next)}
                onRemove={() => removeMeter(i)}
                onSaveKey={(value) => saveProviderKey(m.id, value)}
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

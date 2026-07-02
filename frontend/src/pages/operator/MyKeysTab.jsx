import React, { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../../lib/api';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { toast } from 'sonner';
import {
  KeyRound, Loader2, Wand2, Eye, EyeOff, CheckCircle2, XCircle,
  Plus, ChevronDown, ShieldCheck,
} from 'lucide-react';
import { SecretRow } from './SecretsCard';

/**
 * "My Keys" — one place for every key the app needs.
 *
 * Top: a smart paste box ("add new key"). Drop ANY supported key and the
 * backend (/operator/keys/auto-detect) figures out which provider it belongs
 * to, validates it live, and saves it to the right slot.
 *
 * Below: a single sorted "Your keys" list of everything already added, so it
 * is easy to see and manage at a glance. Providers not yet added live in a
 * collapsible "Add a specific key" section underneath.
 */

// Every key kind the app understands, with the settings field it maps to.
const ALL_KINDS = [
  { kind: 'anthropic', setKey: 'anthropic_api_key' },
  { kind: 'openai', setKey: 'openai_api_key' },
  { kind: 'groq', setKey: 'groq_api_key' },
  { kind: 'vercel', setKey: 'vercel_token' },
  { kind: 'github', setKey: 'github_token' },
  { kind: 'render', setKey: 'render_api_key' },
];

const PRETTY = {
  vercel: 'Vercel', github: 'GitHub', anthropic: 'Anthropic (Claude)',
  openai: 'OpenAI', groq: 'Groq', render: 'Render', resend: 'Resend', stripe: 'Stripe',
};

export default function MyKeysTab() {
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  // Default open so providers that aren't added yet (e.g. Render, Groq) are
  // visible without an extra click — operators kept "not finding" them.
  const [showAdd, setShowAdd] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/operator/settings');
      setSettings(data);
    } catch {
      toast.error('Failed to load keys');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Split into added vs not-yet-added, each sorted alphabetically by label.
  const { added, missing } = useMemo(() => {
    if (!settings) return { added: [], missing: [] };
    const byLabel = (a, b) => (PRETTY[a.kind] || a.kind).localeCompare(PRETTY[b.kind] || b.kind);
    const added = ALL_KINDS.filter((k) => settings[`${k.setKey}_set`]).sort(byLabel);
    const missing = ALL_KINDS.filter((k) => !settings[`${k.setKey}_set`]).sort(byLabel);
    return { added, missing };
  }, [settings]);

  if (loading || !settings) {
    return (
      <div className="grid place-items-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-tbc-400" />
      </div>
    );
  }

  const row = ({ kind, setKey }) => (
    <SecretRow
      key={kind}
      kind={kind}
      isSet={settings[`${setKey}_set`]}
      masked={settings[`${setKey}_masked`]}
      rotatedAt={settings[`${setKey}_rotated_at`]}
      onChanged={load}
    />
  );

  return (
    <div className="space-y-6" data-testid="my-keys-tab">
      <div className="flex items-center gap-3">
        <div className="grid h-10 w-10 place-items-center rounded-xl bg-tbc-500/15 text-tbc-300">
          <KeyRound className="h-5 w-5" />
        </div>
        <div>
          <h2 className="text-xl font-bold text-tbc-100">My Keys</h2>
          <p className="text-sm text-tbc-200/60">
            Add a key once — we detect the provider, verify it, and file it in
            the list below so everything stays sorted and easy to manage.
          </p>
        </div>
      </div>

      {/* Add new key */}
      <SmartPaste onSaved={load} />

      {/* Your keys — sorted list of everything already added */}
      <div className="rounded-xl border border-tbc-500/30 bg-gradient-to-br from-tbc-500/[0.04] via-ink-900/60 to-ink-900/60 p-5">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-tbc-300" />
            <h3 className="text-base font-bold text-tbc-100">Your keys</h3>
          </div>
          <span className="rounded-full bg-tbc-500/15 px-2 py-0.5 text-xs font-semibold text-tbc-200">
            {added.length} added
          </span>
        </div>

        {added.length > 0 ? (
          <div className="space-y-3" data-testid="added-keys">{added.map(row)}</div>
        ) : (
          <p className="rounded-md border border-dashed border-tbc-500/25 bg-ink-900/40 px-3 py-4 text-center text-sm text-tbc-200/60">
            No keys added yet. Paste your first key in the box above to get started.
          </p>
        )}
      </div>

      {/* Add a specific key — providers not yet added */}
      {missing.length > 0 && (
        <div className="rounded-xl border border-tbc-500/20 bg-ink-900/40">
          <button
            type="button"
            onClick={() => setShowAdd((s) => !s)}
            data-testid="toggle-add-specific"
            className="flex w-full items-center justify-between px-5 py-3 text-left"
          >
            <span className="flex items-center gap-2 text-sm font-semibold text-tbc-100">
              <Plus className="h-4 w-4 text-tbc-300" />
              Add a specific key
              <span className="text-xs font-normal text-tbc-200/50">
                — {missing.map((m) => PRETTY[m.kind] || m.kind).join(', ')}
              </span>
            </span>
            <ChevronDown className={`h-4 w-4 text-tbc-300 transition-transform ${showAdd ? 'rotate-180' : ''}`} />
          </button>
          {showAdd && (
            <div className="space-y-3 border-t border-tbc-500/15 px-5 py-4" data-testid="missing-keys">
              {missing.map(row)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SmartPaste({ onSaved }) {
  const [value, setValue] = useState('');
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null); // {ok, kind, message}

  const submit = async () => {
    const v = value.trim();
    if (!v) { toast.error('Paste a key first'); return; }
    setBusy(true);
    setResult(null);
    try {
      const { data } = await api.post('/operator/keys/auto-detect', { value: v });
      if (data.saved) {
        setResult({ ok: true, kind: data.kind, message: data.message });
        toast.success(`${PRETTY[data.kind] || data.kind} key detected and saved`);
        setValue('');
        onSaved?.();
      } else {
        setResult({ ok: false, kind: data.kind, message: data.message });
        toast.error(data.message || 'Key rejected');
      }
    } catch (e) {
      const msg = e?.response?.data?.detail || 'Could not detect this key';
      setResult({ ok: false, message: msg });
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="rounded-xl border border-tbc-400/40 bg-gradient-to-br from-tbc-500/10 via-ink-900/70 to-ink-900/70 p-5"
      data-testid="smart-paste"
    >
      <div className="mb-3 flex items-center gap-2">
        <div className="grid h-8 w-8 place-items-center rounded-lg bg-tbc-500/25 text-tbc-100">
          <Wand2 className="h-4 w-4" />
        </div>
        <div>
          <h3 className="text-base font-bold text-tbc-100">Add new key</h3>
          <p className="text-xs text-tbc-200/60">
            Paste any key — Anthropic, OpenAI, Groq, Vercel, GitHub or Render.
            We figure out what it is and file it in your list automatically.
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Input
            type={reveal ? 'text' : 'password'}
            value={value}
            onChange={(e) => { setValue(e.target.value); setResult(null); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) submit();
            }}
            placeholder="Paste a key and press Enter…"
            data-testid="smart-paste-input"
            name="smart-paste-key"
            autoComplete="off"
            data-1p-ignore="true"
            data-lpignore="true"
            spellCheck={false}
            className="bg-ink-900 border-tbc-900/60 text-tbc-100 pr-9"
          />
          <button
            type="button"
            onClick={() => setReveal((r) => !r)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-tbc-200/60 hover:text-tbc-100"
            data-testid="smart-paste-reveal"
          >
            {reveal ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </button>
        </div>
        <Button
          disabled={!value || busy}
          onClick={submit}
          data-testid="smart-paste-submit"
          className="bg-tbc-500 text-ink-950 font-semibold hover:bg-tbc-400"
        >
          {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Wand2 className="mr-1 h-3.5 w-3.5" />}
          Detect &amp; save
        </Button>
      </div>

      {result && (
        <div
          data-testid="smart-paste-result"
          className={`mt-3 flex items-center gap-2 rounded-md px-2 py-1.5 text-xs ${
            result.ok
              ? 'border border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
              : 'border border-rose-500/30 bg-rose-500/10 text-rose-200'
          }`}
        >
          {result.ok ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0" /> : <XCircle className="h-3.5 w-3.5 shrink-0" />}
          <span className="leading-tight">
            {result.ok
              ? <>Saved as <span className="font-bold">{PRETTY[result.kind] || result.kind}</span> key.</>
              : result.message}
          </span>
        </div>
      )}
    </div>
  );
}

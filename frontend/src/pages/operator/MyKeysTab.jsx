import React, { useCallback, useEffect, useState } from 'react';
import api from '../../lib/api';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { toast } from 'sonner';
import {
  KeyRound, Loader2, Wand2, Eye, EyeOff, Sparkles, Cloud, CheckCircle2, XCircle,
} from 'lucide-react';
import { SecretRow } from './SecretsCard';

/**
 * "My Keys" — one place for every key the app needs.
 *
 * Top: a smart paste box. Drop ANY supported key and the backend
 * (/operator/keys/auto-detect) figures out which provider it belongs to,
 * validates it live, and saves it to the right slot. No dropdown, no guessing.
 *
 * Below: explicit per-provider rows (reusing the shared SecretRow) so the
 * operator can also rotate/clear a specific key deliberately.
 */
export default function MyKeysTab() {
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);

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

  if (loading || !settings) {
    return (
      <div className="grid place-items-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-tbc-400" />
      </div>
    );
  }

  // Grouped so AI keys and infrastructure keys read as distinct sections.
  const aiKinds = [
    { kind: 'anthropic', setKey: 'anthropic_api_key' },
    { kind: 'openai', setKey: 'openai_api_key' },
  ];
  const infraKinds = [
    { kind: 'vercel', setKey: 'vercel_token' },
    { kind: 'github', setKey: 'github_token' },
    { kind: 'render', setKey: 'render_api_key' },
  ];

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
            Every key the app needs, in one place. Paste once — we detect the
            provider, verify it, and wire it up automatically.
          </p>
        </div>
      </div>

      <SmartPaste onSaved={load} />

      <div className="rounded-xl border border-tbc-500/30 bg-gradient-to-br from-tbc-500/[0.04] via-ink-900/60 to-ink-900/60 p-5">
        <div className="mb-3 flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-tbc-300" />
          <h3 className="text-base font-bold text-tbc-100">AI provider keys</h3>
          <span className="text-xs text-tbc-200/50">— power the build &amp; review tools</span>
        </div>
        <div className="space-y-3">{aiKinds.map(row)}</div>
      </div>

      <div className="rounded-xl border border-tbc-500/30 bg-gradient-to-br from-tbc-500/[0.04] via-ink-900/60 to-ink-900/60 p-5">
        <div className="mb-3 flex items-center gap-2">
          <Cloud className="h-4 w-4 text-tbc-300" />
          <h3 className="text-base font-bold text-tbc-100">Deploy &amp; infrastructure</h3>
          <span className="text-xs text-tbc-200/50">— Vercel, GitHub, Render</span>
        </div>
        <div className="space-y-3">{infraKinds.map(row)}</div>
      </div>
    </div>
  );
}

const PRETTY = {
  vercel: 'Vercel', github: 'GitHub', anthropic: 'Anthropic (Claude)',
  openai: 'OpenAI', render: 'Render', resend: 'Resend', stripe: 'Stripe',
};

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
          <h3 className="text-base font-bold text-tbc-100">Smart paste</h3>
          <p className="text-xs text-tbc-200/60">
            Paste any key — Anthropic, OpenAI, Vercel, GitHub or Render. We
            figure out what it is and save it in the right spot.
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

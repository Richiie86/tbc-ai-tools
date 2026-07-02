import React, { useMemo, useState } from 'react';
import api from '../../lib/api';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { toast } from 'sonner';
import {
  KeyRound, Save, Loader2, ShieldCheck, ShieldAlert, Eye, EyeOff,
  RotateCw, CheckCircle2, XCircle, Github, Cloud, Sparkles, Bot, Server,
} from 'lucide-react';

export const KIND_META = {
  vercel: {
    label: 'Vercel Personal Access Token',
    icon: Cloud,
    fieldKey: 'vercel_token',
    placeholder: 'Paste new Vercel PAT — get one at vercel.com/account/tokens',
    helperUrl: 'https://vercel.com/account/tokens',
  },
  github: {
    label: 'GitHub Personal Access Token',
    icon: Github,
    fieldKey: 'github_token',
    placeholder: 'Paste new GitHub PAT — needs Contents: Write for auto-fix to commit patches',
    helperUrl: 'https://github.com/settings/personal-access-tokens',
  },
  anthropic: {
    label: 'Anthropic (Claude) API Key',
    icon: Sparkles,
    fieldKey: 'anthropic_api_key',
    placeholder: 'Paste your Anthropic key (sk-ant-…) — powers the AI build tools',
    helperUrl: 'https://console.anthropic.com/settings/keys',
  },
  openai: {
    label: 'OpenAI API Key',
    icon: Bot,
    fieldKey: 'openai_api_key',
    placeholder: 'Paste your OpenAI key (sk-…) — powers the AI build tools',
    helperUrl: 'https://platform.openai.com/api-keys',
  },
  render: {
    label: 'Render API Key',
    icon: Server,
    fieldKey: 'render_api_key',
    placeholder: 'Paste your Render key (rnd_…) — manage the backend host',
    helperUrl: 'https://dashboard.render.com/u/settings/api-keys',
  },
};

const ROT_WARN_DAYS = 60;   // amber after 60 days
const ROT_DANGER_DAYS = 90; // red after 90 — Vercel default PAT lifespan

const daysSince = (iso) => {
  if (!iso) return null;
  try {
    return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  } catch { return null; }
};

/**
 * Dedicated "rotation-friendly" secrets card.
 *
 * Built for the keys the operator has to swap most often (Vercel + GitHub).
 * Every row offers:
 *   1. Live "Test" before save — calls /api/operator/keys/test which pings
 *      the provider's identity endpoint so we fail fast on expired tokens.
 *   2. One-click Save that persists the new value, auto-clears the input,
 *      and stamps `*_rotated_at`.
 *   3. "Rotated N days ago" badge that turns amber > 60 d, red > 90 d.
 */
export default function SecretsCard({ settings, onChanged }) {
  return (
    <div className="rounded-xl border border-tbc-500/30 bg-gradient-to-br from-tbc-500/[0.04] via-ink-900/60 to-ink-900/60 p-5" data-testid="secrets-card">
      <div className="mb-4 flex items-center gap-2">
        <div className="grid h-8 w-8 place-items-center rounded-lg bg-tbc-500/20 text-tbc-200">
          <KeyRound className="h-4 w-4" />
        </div>
        <div className="flex-1">
          <h3 className="text-base font-bold text-tbc-100">Rotation-ready secrets</h3>
          <p className="text-xs text-tbc-200/60">
            Paste a fresh Vercel or GitHub token whenever the old one expires.
            Test before save so we never persist a dead token.
          </p>
        </div>
      </div>

      <div className="space-y-3">
        <SecretRow
          kind="vercel"
          isSet={settings.vercel_token_set}
          masked={settings.vercel_token_masked}
          rotatedAt={settings.vercel_token_rotated_at}
          onChanged={onChanged}
        />
        <SecretRow
          kind="github"
          isSet={settings.github_token_set}
          masked={settings.github_token_masked}
          rotatedAt={settings.github_token_rotated_at}
          onChanged={onChanged}
        />
      </div>
    </div>
  );
}

export function SecretRow({ kind, isSet, masked, rotatedAt, onChanged }) {
  const meta = KIND_META[kind];
  const Icon = meta.icon;
  const [draft, setDraft] = useState('');
  const [reveal, setReveal] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState(null); // {ok, identity, message}

  const rotAge = useMemo(() => daysSince(rotatedAt), [rotatedAt]);
  const rotTone = rotAge == null
    ? null
    : rotAge >= ROT_DANGER_DAYS
      ? 'rose'
      : rotAge >= ROT_WARN_DAYS
        ? 'amber'
        : 'emerald';

  const runTest = async () => {
    if (!draft.trim()) {
      toast.error('Paste a token first');
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const { data } = await api.post('/operator/keys/test', { kind, value: draft });
      setTestResult(data);
      if (data.ok) {
        toast.success(`${meta.label.split(' ')[0]} valid · ${data.identity}`);
      } else {
        toast.error(data.message || 'Test failed');
      }
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Test failed');
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    if (!draft.trim()) {
      toast.error('Paste a token first');
      return;
    }
    setSaving(true);
    try {
      await api.put('/operator/settings', { [meta.fieldKey]: draft });
      toast.success(`${meta.label} rotated`);
      setDraft('');
      setTestResult(null);
      onChanged?.();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const clear = async () => {
    if (!window.confirm(`Clear the current ${meta.label}? Anything depending on it will stop working.`)) return;
    try {
      await api.post(`/operator/settings/clear?key=${meta.fieldKey}`);
      toast.success('Cleared');
      onChanged?.();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Clear failed');
    }
  };

  return (
    <div
      className="rounded-lg border border-tbc-900/60 bg-ink-950/50 p-3"
      data-testid={`secret-row-${kind}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-tbc-300" />
          <span className="text-sm font-bold text-tbc-100">{meta.label}</span>
        </div>
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider">
          {isSet ? (
            <>
              <span className="font-mono text-tbc-200" data-testid={`secret-masked-${kind}`}>
                {masked || '••••'}
              </span>
              {rotAge != null && (
                <span
                  data-testid={`secret-rotation-age-${kind}`}
                  className={`rounded-full px-2 py-0.5 font-semibold ${
                    rotTone === 'rose' ? 'bg-rose-500/15 text-rose-300' :
                    rotTone === 'amber' ? 'bg-amber-500/15 text-amber-300' :
                    'bg-emerald-500/15 text-emerald-300'
                  }`}
                >
                  Rotated {rotAge === 0 ? 'today' : `${rotAge}d ago`}
                </span>
              )}
            </>
          ) : (
            <span className="rounded-full bg-rose-500/15 px-2 py-0.5 font-semibold text-rose-300">
              <ShieldAlert className="mr-0.5 inline h-3 w-3" /> Not set
            </span>
          )}
        </div>
      </div>

      {/* Helper / "get a new token" link */}
      <a
        href={meta.helperUrl}
        target="_blank"
        rel="noreferrer"
        className="mt-1 inline-block text-[10px] text-tbc-300/80 hover:text-tbc-200"
        data-testid={`secret-helper-link-${kind}`}
      >
        Get a fresh token →
      </a>

      {/* Paste field + actions */}
      <div className="mt-3 flex items-center gap-2">
        <div className="relative flex-1">
          <Input
            type={reveal ? 'text' : 'password'}
            value={draft}
            onChange={(e) => { setDraft(e.target.value); setTestResult(null); }}
            placeholder={meta.placeholder}
            data-testid={`secret-input-${kind}`}
            name={`secret-rotation-${kind}`}
            id={`secret-rotation-${kind}`}
            autoComplete="off"
            data-1p-ignore="true"
            data-lpignore="true"
            data-bwignore="true"
            data-form-type="other"
            spellCheck={false}
            className="bg-ink-900 border-tbc-900/60 text-tbc-100 pr-9"
          />
          <button
            type="button"
            onClick={() => setReveal((r) => !r)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-tbc-200/60 hover:text-tbc-100"
            data-testid={`secret-reveal-${kind}`}
          >
            {reveal ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </button>
        </div>
        <Button
          variant="outline"
          disabled={!draft || testing || saving}
          onClick={runTest}
          data-testid={`secret-test-${kind}`}
          className="border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950"
        >
          {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="mr-1 h-3.5 w-3.5" />}
          Test
        </Button>
        <Button
          disabled={!draft || saving}
          onClick={save}
          data-testid={`secret-save-${kind}`}
          className="bg-tbc-500 text-ink-950 font-semibold hover:bg-tbc-400"
        >
          {saving ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RotateCw className="mr-1 h-3.5 w-3.5" />}
          {isSet ? 'Rotate' : 'Save'}
        </Button>
        {isSet && (
          <Button
            variant="outline"
            onClick={clear}
            data-testid={`secret-clear-${kind}`}
            className="border-rose-900/60 bg-ink-900 text-rose-300 hover:bg-rose-500/10"
          >
            Clear
          </Button>
        )}
      </div>

      {/* Inline test verdict */}
      {testResult && (
        <div
          data-testid={`secret-test-result-${kind}`}
          className={`mt-2 flex items-center gap-2 rounded-md px-2 py-1.5 text-xs ${
            testResult.ok
              ? 'border border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
              : 'border border-rose-500/30 bg-rose-500/10 text-rose-200'
          }`}
        >
          {testResult.ok
            ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
            : <XCircle className="h-3.5 w-3.5 shrink-0" />}
          <span className="leading-tight">
            {testResult.ok
              ? <>Valid · identity <span className="font-bold">{testResult.identity}</span> — safe to save.</>
              : testResult.message}
          </span>
        </div>
      )}
    </div>
  );
}

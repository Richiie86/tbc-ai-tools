import React, { useCallback, useEffect, useState } from 'react';
import api from '../../lib/api';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { toast } from 'sonner';
import {
  Loader2, Server, Database, Cloud, CheckCircle2, RotateCcw, Save, Zap,
} from 'lucide-react';

/**
 * Operator → Server tab.
 *
 * Controls where AI build/preview screenshots are stored. Two modes:
 *   - default: Vercel/MongoDB (built-in, no setup).
 *   - custom:  the operator's own storage server (they build it later).
 *
 * The operator can switch to a custom server and switch back to the default
 * with one click. Secrets (the bearer token) are write-only — the backend
 * only ever tells us whether a token is set, never its value.
 */
export default function ServerTab() {
  const [cfg, setCfg] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/operator/storage/config');
      setCfg(data);
      setUrl(data.custom_url || '');
      setToken('');
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Failed to load storage config');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const mode = cfg?.mode || 'default';

  const saveConfig = async (patch, successMsg) => {
    setSaving(true);
    try {
      const { data } = await api.put('/operator/storage/config', patch);
      setCfg(data);
      setUrl(data.custom_url || '');
      setToken('');
      toast.success(successMsg || 'Storage settings saved');
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const switchToCustom = () => {
    if (!url.trim()) { toast.error('Enter your server URL first'); return; }
    const patch = { mode: 'custom', custom_url: url.trim() };
    if (token.trim()) patch.custom_token = token.trim();
    saveConfig(patch, 'Switched to your custom server');
  };

  const saveCustomDetails = () => {
    const patch = { custom_url: url.trim() };
    if (token.trim()) patch.custom_token = token.trim();
    saveConfig(patch, 'Custom server details saved');
  };

  const switchToDefault = async () => {
    setSaving(true);
    try {
      const { data } = await api.post('/operator/storage/reset');
      setCfg(data);
      toast.success('Switched back to Vercel / MongoDB');
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Switch failed');
    } finally {
      setSaving(false);
    }
  };

  const testCustom = async () => {
    setTesting(true);
    try {
      const { data } = await api.post('/operator/storage/test');
      toast.success('Custom server accepted the upload', {
        description: data?.url ? `Returned: ${data.url}` : undefined,
      });
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Custom server test failed');
    } finally {
      setTesting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-10 text-tbc-200/60">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading storage settings…
      </div>
    );
  }

  return (
    <div className="max-w-3xl space-y-6">
      <header className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-tbc-500/10 text-tbc-300">
          <Server className="h-5 w-5" />
        </div>
        <div>
          <h2 className="text-lg font-bold text-tbc-100">Server &amp; Storage</h2>
          <p className="text-sm text-tbc-200/60">
            Choose where AI build &amp; preview screenshots are stored.
          </p>
        </div>
      </header>

      {/* Current mode banner */}
      <div className="flex items-center gap-2 rounded-lg border border-tbc-900/60 bg-ink-900/50 px-4 py-3 text-sm">
        <span className="text-tbc-200/60">Active storage:</span>
        <span className="inline-flex items-center gap-1.5 font-bold text-tbc-100">
          {mode === 'custom'
            ? <><Server className="h-4 w-4 text-amber-300" /> Your custom server</>
            : <><Cloud className="h-4 w-4 text-emerald-300" /> Vercel / MongoDB (default)</>}
        </span>
      </div>

      {/* Default option */}
      <section
        className={`rounded-lg border p-4 ${
          mode === 'default'
            ? 'border-emerald-500/40 bg-emerald-500/[0.04]'
            : 'border-tbc-900/60 bg-ink-900/40'
        }`}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <Database className="mt-0.5 h-5 w-5 shrink-0 text-emerald-300" />
            <div>
              <h3 className="font-bold text-tbc-100">Vercel / MongoDB</h3>
              <p className="mt-1 text-sm text-tbc-200/60">
                Built-in. Screenshots are stored securely in your MongoDB and
                served through the app. No setup required.
              </p>
            </div>
          </div>
          {mode === 'default'
            ? (
              <span className="inline-flex shrink-0 items-center gap-1 text-xs font-bold text-emerald-300">
                <CheckCircle2 className="h-4 w-4" /> In use
              </span>
            )
            : (
              <Button
                onClick={switchToDefault}
                disabled={saving}
                className="shrink-0 bg-emerald-500 font-bold text-ink-950 hover:bg-emerald-400"
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <><RotateCcw className="mr-1.5 h-4 w-4" />Use this</>}
              </Button>
            )}
        </div>
      </section>

      {/* Custom option */}
      <section
        className={`rounded-lg border p-4 ${
          mode === 'custom'
            ? 'border-amber-500/40 bg-amber-500/[0.04]'
            : 'border-tbc-900/60 bg-ink-900/40'
        }`}
      >
        <div className="flex items-start gap-3">
          <Server className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" />
          <div className="flex-1">
            <h3 className="font-bold text-tbc-100">Your own server</h3>
            <p className="mt-1 text-sm text-tbc-200/60">
              Point storage at a server you host. On save we POST JSON{' '}
              <code className="rounded bg-ink-950 px-1 text-[11px] text-tbc-200">
                {'{ key, content_type, data_base64 }'}
              </code>{' '}
              (with an optional <code className="text-[11px]">Bearer</code> token) and
              expect <code className="text-[11px]">{'{ "url": "…" }'}</code> back.
            </p>

            <div className="mt-4 space-y-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-tbc-200/70">
                  Server URL
                </label>
                <Input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://storage.yourserver.com/upload"
                  className="bg-ink-950 font-mono text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-tbc-200/70">
                  Bearer token{' '}
                  <span className="text-tbc-200/40">
                    {cfg?.custom_token_set ? '(set — leave blank to keep)' : '(optional)'}
                  </span>
                </label>
                <Input
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder={cfg?.custom_token_set ? '••••••••' : 'Optional auth token'}
                  className="bg-ink-950 font-mono text-sm"
                />
              </div>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              {mode === 'custom'
                ? (
                  <>
                    <Button onClick={saveCustomDetails} disabled={saving} variant="outline" className="font-bold">
                      {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Save className="mr-1.5 h-4 w-4" />Save details</>}
                    </Button>
                    <Button onClick={testCustom} disabled={testing} variant="outline" className="font-bold">
                      {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Zap className="mr-1.5 h-4 w-4" />Test connection</>}
                    </Button>
                    <span className="inline-flex items-center gap-1 self-center text-xs font-bold text-amber-300">
                      <CheckCircle2 className="h-4 w-4" /> In use
                    </span>
                  </>
                )
                : (
                  <Button
                    onClick={switchToCustom}
                    disabled={saving}
                    className="bg-amber-500 font-bold text-ink-950 hover:bg-amber-400"
                  >
                    {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Server className="mr-1.5 h-4 w-4" />Switch to my server</>}
                  </Button>
                )}
            </div>
          </div>
        </div>
      </section>

      <p className="text-xs text-tbc-200/40">
        Tip: if a custom upload ever fails, the app automatically falls back to
        MongoDB so a screenshot is never lost. You can switch back to the
        default at any time with one click.
      </p>
    </div>
  );
}

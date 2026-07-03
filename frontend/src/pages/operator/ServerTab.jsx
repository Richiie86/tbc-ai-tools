import React, { useCallback, useEffect, useState } from 'react';
import api from '../../lib/api';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { toast } from 'sonner';
import {
  Loader2, Server, Database, Cloud, CheckCircle2, RotateCcw, Save, Zap,
  Rocket, KeyRound, RefreshCw,
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

  // ── Deploy (Render) state ──
  const [dep, setDep] = useState(null);
  const [services, setServices] = useState([]);
  const [loadingServices, setLoadingServices] = useState(false);
  const [deploying, setDeploying] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [storageRes, deployRes] = await Promise.allSettled([
        api.get('/operator/storage/config'),
        api.get('/operator/deploy/config'),
      ]);
      if (storageRes.status === 'fulfilled') {
        setCfg(storageRes.value.data);
        setUrl(storageRes.value.data.custom_url || '');
        setToken('');
      } else {
        toast.error('Failed to load storage config');
      }
      if (deployRes.status === 'fulfilled') {
        setDep(deployRes.value.data);
      }
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

  // ── Deploy (Render) handlers ──
  const loadServices = async () => {
    setLoadingServices(true);
    try {
      const { data } = await api.get('/operator/deploy/services');
      setServices(data.services || []);
      if (!data.services?.length) toast.info('No Render services found on this account');
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not list Render services');
    } finally {
      setLoadingServices(false);
    }
  };

  const pickService = async (svc) => {
    try {
      const { data } = await api.put('/operator/deploy/config', {
        service_id: svc.id, service_name: svc.name || '',
      });
      setDep(data);
      toast.success(`Selected ${svc.name || svc.id}`);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not select service');
    }
  };

  const triggerDeploy = async () => {
    setDeploying(true);
    try {
      const { data } = await api.post('/operator/deploy/trigger');
      toast.success('Deploy triggered on Render', {
        description: data?.status ? `Status: ${data.status}` : undefined,
      });
      // Refresh status shortly after.
      setTimeout(async () => {
        try {
          const { data: s } = await api.get('/operator/deploy/status');
          setDep((d) => ({ ...(d || {}), last_deploy_status: s.status, last_deploy_id: s.deploy_id }));
        } catch { /* best-effort */ }
      }, 3000);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Deploy failed');
    } finally {
      setDeploying(false);
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

      {/* ── Deploy (Render) ───────────────────────────────────────── */}
      <header className="flex items-center gap-3 pt-4">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-tbc-500/10 text-tbc-300">
          <Rocket className="h-5 w-5" />
        </div>
        <div>
          <h2 className="text-lg font-bold text-tbc-100">Backend deploy</h2>
          <p className="text-sm text-tbc-200/60">
            Redeploy the backend on Render from inside the app.
          </p>
        </div>
      </header>

      <section className="rounded-lg border border-tbc-900/60 bg-ink-900/40 p-4 space-y-4">
        {/* Render API key status — the key itself is managed in My Keys */}
        <div className="flex items-center gap-2 rounded-md border border-tbc-900/60 bg-ink-950 px-3 py-2 text-xs">
          <KeyRound className="h-3.5 w-3.5 shrink-0 text-tbc-300" />
          {dep?.api_key_set ? (
            <span className="inline-flex items-center gap-1.5 text-emerald-300">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Using the Render API key from <span className="font-bold">My Keys</span>.
            </span>
          ) : (
            <span className="text-amber-300">
              No Render API key found. Add one in the <span className="font-bold">My Keys</span> tab
              (paste your <code className="text-[11px]">rnd_…</code> key) to enable deploys.
            </span>
          )}
        </div>

        {/* Service picker */}
        {dep?.api_key_set && (
          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className="text-xs font-medium text-tbc-200/70">
                Service to deploy
                {dep?.service_name && (
                  <span className="ml-2 font-bold text-tbc-100">{dep.service_name}</span>
                )}
              </label>
              <Button onClick={loadServices} disabled={loadingServices} variant="outline" size="sm" className="h-7 text-xs">
                {loadingServices ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <><RefreshCw className="mr-1 h-3.5 w-3.5" />Load services</>}
              </Button>
            </div>
            {services.length > 0 && (
              <div className="mt-2 grid gap-1.5">
                {services.map((svc) => (
                  <button
                    key={svc.id}
                    type="button"
                    onClick={() => pickService(svc)}
                    className={`flex items-center justify-between rounded border px-3 py-2 text-left text-sm transition ${
                      dep?.service_id === svc.id
                        ? 'border-tbc-500/50 bg-tbc-500/[0.08] text-tbc-100'
                        : 'border-tbc-900/60 bg-ink-950 text-tbc-200/80 hover:bg-ink-900'
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <Server className="h-4 w-4 text-tbc-300" />
                      <span className="font-medium">{svc.name || svc.id}</span>
                      {svc.branch && <code className="text-[10px] text-tbc-200/40">{svc.branch}</code>}
                    </span>
                    {dep?.service_id === svc.id && <CheckCircle2 className="h-4 w-4 text-tbc-300" />}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Deploy button + status */}
        <div className="flex flex-wrap items-center gap-3 border-t border-tbc-900/60 pt-4">
          <Button
            onClick={triggerDeploy}
            disabled={deploying || (!dep?.service_id && !dep?.hook_set)}
            className="bg-emerald-500 font-bold text-ink-950 hover:bg-emerald-400"
          >
            {deploying ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Rocket className="mr-1.5 h-4 w-4" />Deploy latest commit</>}
          </Button>
          {dep?.last_deploy_status && (
            <span className="text-xs text-tbc-200/60">
              Last deploy: <span className="font-bold text-tbc-100">{dep.last_deploy_status}</span>
              {dep.last_deploy_at && (
                <span className="text-tbc-200/40"> · {new Date(dep.last_deploy_at).toLocaleString()}</span>
              )}
            </span>
          )}
          {!dep?.service_id && !dep?.hook_set && (
            <span className="text-xs text-tbc-200/40">
              {dep?.api_key_set
                ? 'Load your services and pick one to enable deploys.'
                : 'Add a Render API key in My Keys, then pick a service.'}
            </span>
          )}
        </div>
      </section>
    </div>
  );
}

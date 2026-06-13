import React, { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import api from '../lib/api';
import Navbar from '../components/Navbar';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Card } from '../components/ui/card';
import { toast } from 'sonner';
import {
  ArrowLeft, Mail, KeyRound, Save, Loader2, Plus, Trash2,
  Rocket, Activity, ShieldCheck, RotateCw,
} from 'lucide-react';
import { PreviewReadyPill } from './dashboard/PostAiDeploySuggestion';

/**
 * Per-project settings page: lets the operator manage the project admin
 * email/password and any number of API-key env-vars, plus fire the same
 * Deploy / Redeploy / Health-check / Code-review actions in one place.
 */
export default function ProjectSettings() {
  const { projectId } = useParams();
  const navigate = useNavigate();

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [savingMain, setSavingMain] = useState(false);
  const [savingEnv, setSavingEnv] = useState(false);
  const [busy, setBusy] = useState(null); // 'deploy' | 'redeploy' | 'health' | 'review' | null
  const [previewUrl, setPreviewUrl] = useState('');

  const [emailDraft, setEmailDraft] = useState('');
  const [passwordDraft, setPasswordDraft] = useState('');
  const [envDrafts, setEnvDrafts] = useState({});            // { key: value to upsert }
  const [newEnvKey, setNewEnvKey] = useState('');
  const [newEnvVal, setNewEnvVal] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data: d } = await api.get(`/operator/deploy/${projectId}/settings`);
      setData(d);
      setEmailDraft(d.admin_email || '');
      // Seed the "Preview ready" pill with the last known deployment so
      // operators can open the live site immediately on every visit.
      try {
        const { data: proj } = await api.get('/operator/deploy/projects');
        const me = (proj || []).find((p) => p.id === projectId);
        if (me?.last_deployment_url) {
          const u = me.last_deployment_url;
          setPreviewUrl(u.startsWith('http') ? u : `https://${u}`);
        }
      } catch { /* non-fatal */ }
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Failed to load project');
      navigate('/operator');
    } finally {
      setLoading(false);
    }
  }, [projectId, navigate]);

  useEffect(() => { load(); }, [load]);

  const saveCreds = async () => {
    setSavingMain(true);
    try {
      const payload = {};
      if (emailDraft && emailDraft !== (data?.admin_email || '')) payload.admin_email = emailDraft;
      if (passwordDraft) payload.admin_password = passwordDraft;
      if (!Object.keys(payload).length) {
        toast.info('Nothing to save');
        return;
      }
      const { data: fresh } = await api.put(`/operator/deploy/${projectId}/settings`, payload);
      setData(fresh);
      setPasswordDraft('');
      toast.success('Credentials updated');
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Save failed');
    } finally {
      setSavingMain(false);
    }
  };

  const persistEnv = async (envUpdates) => {
    setSavingEnv(true);
    try {
      const { data: fresh } = await api.put(`/operator/deploy/${projectId}/settings`, {
        env_vars: envUpdates,
      });
      setData(fresh);
      setEnvDrafts({});
      setNewEnvKey('');
      setNewEnvVal('');
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Env save failed');
    } finally {
      setSavingEnv(false);
    }
  };

  const upsertNewEnv = async () => {
    const k = newEnvKey.trim();
    if (!k) { toast.error('Key required'); return; }
    if (!newEnvVal) { toast.error('Value required'); return; }
    await persistEnv({ [k]: newEnvVal });
    toast.success(`Saved ${k}`);
  };

  const updateEnv = async (key) => {
    const v = envDrafts[key];
    if (!v) { toast.error('Enter a new value'); return; }
    await persistEnv({ [key]: v });
    toast.success(`Rotated ${key}`);
  };

  const deleteEnv = async (key) => {
    if (!window.confirm(`Delete env var "${key}"?`)) return;
    await persistEnv({ [key]: '' });
    toast.success(`Deleted ${key}`);
  };

  const runAction = async (kind) => {
    setBusy(kind);
    try {
      const map = {
        deploy: `/operator/deploy/${projectId}/deploy`,
        redeploy: `/operator/deploy/${projectId}/redeploy`,
        health: `/operator/deploy/${projectId}/healthcheck`,
        review: `/operator/deploy/${projectId}/code-review`,
      };
      const { data: res } = await api.post(map[kind], {});
      if ((kind === 'deploy' || kind === 'redeploy')) {
        const u = res?.url || res?.deployment_url || res?.preview_url;
        if (u) setPreviewUrl(u.startsWith('http') ? u : `https://${u}`);
      }
      const label = {
        deploy: `Deploy queued — ${res?.url || res?.id || 'OK'}`,
        redeploy: `Redeploy queued — ${res?.url || res?.id || 'OK'}`,
        health: `Health: ${res?.status || (res?.ok ? 'OK' : 'unknown')}`,
        review: `Review: ${res?.verdict || res?.summary || 'done'}`,
      }[kind];
      toast.success(label);
    } catch (e) {
      toast.error(e?.response?.data?.detail || `${kind} failed`);
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-ink-950 text-tbc-100">
        <Navbar />
        <div className="grid place-items-center py-20"><Loader2 className="h-6 w-6 animate-spin text-tbc-400" /></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-ink-950 text-tbc-100" data-testid="project-settings-page">
      <Navbar />
      <section className="mx-auto max-w-5xl px-5 py-10">
        <Link
          to="/operator"
          className="mb-4 inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-tbc-300 hover:text-tbc-100"
          data-testid="project-settings-back"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to Operator
        </Link>

        <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-tbc-200/60">Project</div>
            <h1 className="mt-1 text-2xl font-bold text-tbc-50">{data.projectName}</h1>
            <div className="mt-1 text-xs text-tbc-200/60">id: <code className="rounded bg-ink-900 px-1.5 py-0.5">{data.id}</code></div>
          </div>

          <div className="flex flex-wrap items-center gap-2" data-testid="project-settings-actions">
            <ActionBtn label="Deploy"     icon={Rocket}       tone="primary" busy={busy==='deploy'}   disabled={!!busy} onClick={() => runAction('deploy')}    testid="proj-set-deploy" />
            <ActionBtn label="Redeploy"   icon={RotateCw}     tone="ghost"   busy={busy==='redeploy'} disabled={!!busy} onClick={() => runAction('redeploy')}  testid="proj-set-redeploy" />
            <ActionBtn label="Health"     icon={Activity}     tone="ghost"   busy={busy==='health'}   disabled={!!busy} onClick={() => runAction('health')}    testid="proj-set-health" />
            <ActionBtn label="Code Review" icon={ShieldCheck} tone="ghost"   busy={busy==='review'}   disabled={!!busy} onClick={() => runAction('review')}    testid="proj-set-review" />
          </div>
        </div>

        {previewUrl && (
          <div className="mb-4 flex justify-center">
            <PreviewReadyPill url={previewUrl} onDismiss={() => setPreviewUrl('')} />
          </div>
        )}

        <div className="grid gap-5 lg:grid-cols-2">
          <Card className="border-tbc-900/60 bg-ink-900/60 p-5">
            <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-tbc-200">
              <Mail className="h-4 w-4 text-tbc-300" /> Admin credentials
            </h2>
            <p className="mt-1 text-xs text-tbc-200/60">
              Used as the seed admin account for this project's deployed app.
              Password is hashed (bcrypt) — only its presence is shown back.
            </p>
            <div className="mt-4 space-y-3">
              <Field label="Admin email">
                <Input
                  type="email"
                  data-testid="proj-set-email-input"
                  className="bg-ink-950 border-tbc-900/60 text-tbc-100"
                  value={emailDraft}
                  onChange={(e) => setEmailDraft(e.target.value)}
                  placeholder="admin@example.com"
                />
              </Field>
              <Field label={data.admin_password_set ? 'New password (leave blank to keep)' : 'Set initial password'}>
                <Input
                  type="password"
                  data-testid="proj-set-password-input"
                  className="bg-ink-950 border-tbc-900/60 text-tbc-100"
                  value={passwordDraft}
                  onChange={(e) => setPasswordDraft(e.target.value)}
                  placeholder={data.admin_password_set ? '••••••••' : 'Pick a strong password'}
                  autoComplete="new-password"
                />
                {data.admin_password_set && (
                  <div className="mt-1 text-[10px] uppercase tracking-wider text-emerald-300">Password is set</div>
                )}
              </Field>
              <div className="flex justify-end">
                <Button
                  onClick={saveCreds}
                  disabled={savingMain}
                  data-testid="proj-set-save-creds"
                  className="bg-tbc-500 text-ink-950 font-semibold hover:bg-tbc-400"
                >
                  {savingMain ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-1.5 h-4 w-4" />}
                  Save credentials
                </Button>
              </div>
            </div>
          </Card>

          <Card className="border-tbc-900/60 bg-ink-900/60 p-5">
            <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-tbc-200">
              <KeyRound className="h-4 w-4 text-tbc-300" /> API keys & env vars
            </h2>
            <p className="mt-1 text-xs text-tbc-200/60">
              Per-project secrets pushed into the deployed app's environment.
              Values are stored encrypted at rest; only the last 4 characters are shown back.
            </p>

            <div className="mt-4 space-y-2" data-testid="proj-set-env-list">
              {(data.env_vars || []).length === 0 && (
                <div className="rounded-lg border border-dashed border-tbc-900/60 p-3 text-xs text-tbc-200/60">
                  No env vars yet — add your first below.
                </div>
              )}
              {(data.env_vars || []).map((row) => (
                <div key={row.key} className="flex items-center gap-2 rounded-lg border border-tbc-900/60 bg-ink-950/60 px-2.5 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-xs text-tbc-100">{row.key}</div>
                    <div className="font-mono text-[10px] text-tbc-200/60">{row.masked || '—'}</div>
                  </div>
                  <Input
                    type="password"
                    placeholder="New value"
                    data-testid={`proj-set-env-input-${row.key}`}
                    value={envDrafts[row.key] || ''}
                    onChange={(e) => setEnvDrafts({ ...envDrafts, [row.key]: e.target.value })}
                    className="h-8 w-44 bg-ink-900 border-tbc-900/60 text-xs text-tbc-100"
                  />
                  <Button
                    size="icon"
                    variant="outline"
                    disabled={savingEnv}
                    onClick={() => updateEnv(row.key)}
                    data-testid={`proj-set-env-rotate-${row.key}`}
                    className="h-8 w-8 border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950"
                  >
                    <Save className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="icon"
                    variant="outline"
                    disabled={savingEnv}
                    onClick={() => deleteEnv(row.key)}
                    data-testid={`proj-set-env-delete-${row.key}`}
                    className="h-8 w-8 border-rose-900/60 bg-ink-900 text-rose-300 hover:bg-rose-500/10"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>

            <div className="mt-4 grid grid-cols-[1fr_1.4fr_auto] gap-2">
              <Input
                placeholder="KEY"
                data-testid="proj-set-env-new-key"
                value={newEnvKey}
                onChange={(e) => setNewEnvKey(e.target.value.replace(/[^A-Z0-9_]/gi, '_').toUpperCase())}
                className="bg-ink-950 border-tbc-900/60 font-mono text-tbc-100"
              />
              <Input
                type="password"
                placeholder="value"
                data-testid="proj-set-env-new-val"
                value={newEnvVal}
                onChange={(e) => setNewEnvVal(e.target.value)}
                className="bg-ink-950 border-tbc-900/60 text-tbc-100"
              />
              <Button
                onClick={upsertNewEnv}
                disabled={savingEnv}
                data-testid="proj-set-env-add"
                className="bg-tbc-500 text-ink-950 font-semibold hover:bg-tbc-400"
              >
                {savingEnv ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              </Button>
            </div>
          </Card>
        </div>
      </section>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <label className="text-[10px] font-semibold uppercase tracking-wider text-tbc-200/60">{label}</label>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

function ActionBtn({ label, icon: Icon, tone, busy, disabled, onClick, testid }) {
  const base = 'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-40';
  const styles = tone === 'primary'
    ? 'bg-tbc-500 text-ink-950 hover:bg-tbc-400'
    : 'border border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`${base} ${styles}`}
      data-testid={testid}
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Icon className="h-3.5 w-3.5" />}
      {label}
    </button>
  );
}

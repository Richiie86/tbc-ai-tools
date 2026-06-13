import React, { useCallback, useEffect, useState } from 'react';
import api from '../../../lib/api';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Card } from '../../../components/ui/card';
import { toast } from 'sonner';
import {
  Rocket, Loader2, KeyRound, RefreshCw, Eye, EyeOff, Copy, Check,
  ExternalLink, Save,
} from 'lucide-react';
import { ProjectRow } from './deploy/ProjectRow';

// ---------- Self-source download button --------------------------------
/**
 * Top-right button on the Vercel deploys section: streams a fresh zip of
 * THIS app's exact live source code (every newly added feature included),
 * stripping node_modules / .git / secrets so the operator can fork the
 * platform on their own infra.
 */
function SelfSourceDownloadButton() {
  const [busy, setBusy] = useState(false);
  const onClick = () => {
    setBusy(true);
    try {
      const url = `${api.defaults.baseURL}/operator/deploy/self/download-app`;
      const a = document.createElement('a');
      a.href = url;
      a.rel = 'noopener';
      a.download = '';
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast.success('Self-source download started');
    } catch {
      toast.error('Could not start download');
    } finally {
      // Give the browser ~1s to attach the download; then re-enable.
      setTimeout(() => setBusy(false), 1200);
    }
  };
  return (
    <Button
      size="sm"
      data-testid="download-self-source"
      onClick={onClick}
      disabled={busy}
      variant="outline"
      title="Download a zip of this app's live source (with every feature)"
      className="border-tbc-500/40 bg-ink-900 text-tbc-100 hover:bg-tbc-500/10 shrink-0"
    >
      {busy ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : <Save className="mr-1.5 h-3 w-3" />}
      Download this app
    </Button>
  );
}


// ---------- Keys card ---------------------------------------------------
function KeysCard({ keysStatus, onSaved }) {
  const [vercelToken, setVercelToken] = useState('');
  const [teamId, setTeamId] = useState(keysStatus.vercel_team_id || '');
  const [githubToken, setGithubToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [showAiKey, setShowAiKey] = useState(false);
  const [revealedKey, setRevealedKey] = useState(null);
  const [copied, setCopied] = useState(false);

  // Re-sync team id when the operator first loads with a value already saved.
  useEffect(() => { setTeamId(keysStatus.vercel_team_id || ''); }, [keysStatus.vercel_team_id]);

  const saveVercelToken = async () => {
    if (!vercelToken && !teamId) {
      toast.error('Paste a Vercel token or team id first');
      return;
    }
    setSaving(true);
    try {
      await api.post('/operator/deploy/key', {
        vercel_token: vercelToken || undefined,
        vercel_team_id: teamId || undefined,
      });
      toast.success(vercelToken ? 'Vercel token saved' : 'Vercel team id saved');
      setVercelToken('');
      onSaved();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const saveGithubToken = async () => {
    if (!githubToken) {
      toast.error('Paste a GitHub token first');
      return;
    }
    setSaving(true);
    try {
      await api.post('/operator/deploy/key', { github_token: githubToken });
      toast.success('GitHub token saved — code review + private downloads unlocked');
      setGithubToken('');
      onSaved();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const regenerateAiKey = async () => {
    if (keysStatus.has_ai_api_key &&
        !window.confirm('Rotate the AI API key?\n\nAny external program using the previous key will stop working immediately.')) {
      return;
    }
    setSaving(true);
    try {
      const { data } = await api.post('/operator/deploy/key', {
        regenerate_ai_api_key: true,
      });
      setRevealedKey(data.revealed_ai_api_key);
      setShowAiKey(true);
      toast.success('New AI API key generated — copy it now, you won\'t see it again');
      onSaved();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not generate key');
    } finally {
      setSaving(false);
    }
  };

  const copyKey = async () => {
    if (!revealedKey) return;
    await navigator.clipboard.writeText(revealedKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Card className="border-tbc-900/60 bg-ink-900/60 p-5" data-testid="deploy-keys-card">
      <div className="mb-3 flex items-center gap-2">
        <span className="grid h-9 w-9 place-items-center rounded-lg bg-emerald-500/15 text-emerald-300">
          <KeyRound className="h-4 w-4" />
        </span>
        <div>
          <h3 className="text-base font-bold text-tbc-100">Deploy keys</h3>
          <p className="text-xs text-tbc-200/60">
            Stored encrypted on the server, never echoed back. Vercel token powers the
            Deploy/Redeploy/Preview buttons; AI API key authenticates external POSTs to
            <code className="ml-1 rounded bg-ink-950 px-1 text-[10px] text-tbc-300">/api/projects</code>.
          </p>
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <div className="rounded-lg border border-tbc-900/60 bg-ink-950 p-3">
          <div className="mb-2 flex items-center justify-between">
            <label className="text-[10px] font-semibold uppercase tracking-wider text-tbc-200/70">
              Vercel Personal Access Token
            </label>
            {keysStatus.has_vercel_token ? (
              <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[9px] uppercase tracking-wider text-emerald-300">
                ✓ configured
              </span>
            ) : (
              <span className="rounded-full border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-[9px] uppercase tracking-wider text-rose-300">
                not set
              </span>
            )}
          </div>
          <Input
            data-testid="deploy-key-vercel-token"
            type="password"
            placeholder={keysStatus.has_vercel_token ? '••••••••  (paste a new value to rotate)' : 'Paste your Vercel PAT'}
            value={vercelToken}
            onChange={(e) => setVercelToken(e.target.value)}
            className="border-tbc-900/60 bg-ink-900 font-mono text-xs text-tbc-100"
          />
          <div className="mt-2">
            <label className="text-[10px] font-semibold uppercase tracking-wider text-tbc-200/70">
              Team ID (optional)
            </label>
            <Input
              data-testid="deploy-key-vercel-team"
              placeholder="team_..."
              value={teamId}
              onChange={(e) => setTeamId(e.target.value)}
              className="mt-1 border-tbc-900/60 bg-ink-900 font-mono text-xs text-tbc-100"
            />
          </div>
          <div className="mt-2 flex items-center justify-between">
            <a
              href="https://vercel.com/account/tokens"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-[10px] text-tbc-300 hover:text-tbc-200"
            >
              Generate a Vercel token <ExternalLink className="h-2.5 w-2.5" />
            </a>
            <Button
              size="sm"
              data-testid="deploy-key-vercel-save"
              onClick={saveVercelToken}
              disabled={saving || (!vercelToken && teamId === (keysStatus.vercel_team_id || ''))}
              className="bg-tbc-500 text-ink-950 hover:bg-tbc-400 font-semibold"
            >
              {saving ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : <Save className="mr-1.5 h-3 w-3" />}
              Save
            </Button>
          </div>
        </div>

        <div className="rounded-lg border border-tbc-900/60 bg-ink-950 p-3">
          <div className="mb-2 flex items-center justify-between">
            <label className="text-[10px] font-semibold uppercase tracking-wider text-tbc-200/70">
              AI API Key (for /api/projects)
            </label>
            {keysStatus.has_ai_api_key ? (
              <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[9px] uppercase tracking-wider text-emerald-300">
                ✓ active
              </span>
            ) : (
              <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[9px] uppercase tracking-wider text-amber-300">
                not generated
              </span>
            )}
          </div>

          {revealedKey ? (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2">
              <div className="mb-1 flex items-center justify-between">
                <span className="text-[10px] font-bold uppercase tracking-wider text-amber-200">
                  Copy this now · won&apos;t be shown again
                </span>
                <button
                  onClick={() => setShowAiKey((v) => !v)}
                  className="text-amber-200 hover:text-amber-100"
                  title={showAiKey ? 'Hide' : 'Reveal'}
                >
                  {showAiKey ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                </button>
              </div>
              <div className="flex items-center gap-1.5">
                <code
                  data-testid="deploy-ai-key-reveal"
                  className="flex-1 truncate rounded bg-ink-950 px-2 py-1 font-mono text-[11px] text-tbc-100"
                >
                  {showAiKey ? revealedKey : '••••••••••••••••••••••••••'}
                </code>
                <button
                  onClick={copyKey}
                  className="rounded border border-tbc-900/60 bg-ink-900 p-1 text-tbc-200 hover:bg-ink-950"
                  title="Copy"
                >
                  {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                </button>
              </div>
            </div>
          ) : (
            <p className="text-[11px] text-tbc-200/60">
              {keysStatus.has_ai_api_key
                ? 'A key is set. Rotate it to generate a new one (will invalidate the old immediately).'
                : 'Generate one to let an external AI program POST projects to /api/projects.'}
            </p>
          )}

          <div className="mt-2 flex items-center justify-end">
            <Button
              size="sm"
              data-testid="deploy-ai-key-rotate"
              onClick={regenerateAiKey}
              disabled={saving}
              variant="outline"
              className="border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950"
            >
              {saving
                ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                : <RefreshCw className="mr-1.5 h-3 w-3" />}
              {keysStatus.has_ai_api_key ? 'Rotate key' : 'Generate key'}
            </Button>
          </div>
        </div>

        <div className="rounded-lg border border-tbc-900/60 bg-ink-950 p-3">
          <div className="mb-2 flex items-center justify-between">
            <label className="text-[10px] font-semibold uppercase tracking-wider text-tbc-200/70">
              GitHub token (for code review &amp; private repo downloads)
            </label>
            {keysStatus.has_github_token ? (
              <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[9px] uppercase tracking-wider text-emerald-300">
                ✓ configured
              </span>
            ) : (
              <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[9px] uppercase tracking-wider text-amber-300">
                optional
              </span>
            )}
          </div>
          <Input
            data-testid="deploy-key-github-token"
            type="password"
            placeholder={keysStatus.has_github_token ? '••••••••  (paste a new value to rotate)' : 'ghp_... or github_pat_...'}
            value={githubToken}
            onChange={(e) => setGithubToken(e.target.value)}
            className="border-tbc-900/60 bg-ink-900 font-mono text-xs text-tbc-100"
          />
          <p className="mt-2 text-[10px] text-tbc-200/60">
            Unlocks private-repo downloads + raises the GitHub API limit from
            60/hr (anonymous) to 5 000/hr (authenticated) so the code review +
            autopilot loop never get rate-limited mid-run.
          </p>
          <div className="mt-2 flex items-center justify-between">
            <a
              href="https://github.com/settings/tokens?type=beta"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-[10px] text-tbc-300 hover:text-tbc-200"
            >
              Generate a fine-grained PAT <ExternalLink className="h-2.5 w-2.5" />
            </a>
            <Button
              size="sm"
              data-testid="deploy-key-github-save"
              onClick={saveGithubToken}
              disabled={saving || !githubToken}
              className="bg-tbc-500 text-ink-950 hover:bg-tbc-400 font-semibold"
            >
              {saving ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : <Save className="mr-1.5 h-3 w-3" />}
              Save
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}



// ---------- Main section ------------------------------------------------
/**
 * Ops-tab "Vercel deploy" section: keys management + project list + per-row
 * Deploy/Redeploy/Preview buttons. Projects themselves are created by the AI
 * agent via POST /api/projects — the operator just consumes them here.
 */
export function OpsDeploySection() {
  const [keysStatus, setKeysStatus] = useState(null);
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [k, p] = await Promise.all([
        api.get('/operator/deploy/key'),
        api.get('/operator/deploy/projects'),
      ]);
      setKeysStatus(k.data);
      setProjects(p.data);
    } catch (e) {
      console.warn('Failed to load deploy info', e);
      toast.error('Failed to load deploy projects');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading || !keysStatus) {
    return (
      <div className="grid place-items-center py-10">
        <Loader2 className="h-6 w-6 animate-spin text-tbc-400" />
      </div>
    );
  }

  return (
    <section data-testid="ops-deploy-section">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-tbc-500/15 text-tbc-300">
            <Rocket className="h-4 w-4" />
          </span>
          <div>
            <h3 className="text-base font-bold text-tbc-100">Vercel deploys</h3>
            <p className="text-xs text-tbc-200/60">
              Paste your Vercel token to power the Deploy/Redeploy/Preview buttons.
              Projects in the list come from your AI agent calling{' '}
              <code className="rounded bg-ink-950 px-1 text-[10px] text-tbc-300">POST /api/projects</code>.
            </p>
          </div>
        </div>
        <SelfSourceDownloadButton />
      </div>

      <KeysCard keysStatus={keysStatus} onSaved={load} />

      <div className="mt-4">
        {projects.length === 0 ? (
          <Card className="border-tbc-900/60 bg-ink-900/40 p-6 text-center">
            <p className="text-sm text-tbc-200/80">No deploy projects yet.</p>
            <p className="mt-2 text-xs text-tbc-200/50">
              Have your AI agent POST to{' '}
              <code className="rounded bg-ink-950 px-1 text-tbc-300">/api/projects</code>{' '}
              with the AI API key above, or seed one manually with{' '}
              <code className="rounded bg-ink-950 px-1 text-tbc-300">curl</code>.
            </p>
          </Card>
        ) : (
          <div className="space-y-2" data-testid="ops-deploy-projects">
            {projects.map((p) => (
              <ProjectRow key={p.id} project={p} onDeployed={load} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

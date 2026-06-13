import React, { useCallback, useEffect, useState } from 'react';
import api from '../../../lib/api';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Card } from '../../../components/ui/card';
import { toast } from 'sonner';
import {
  Rocket, Globe, Loader2, KeyRound, RefreshCw, Eye, EyeOff, Copy, Check,
  GitBranch, ExternalLink, RotateCw, Save, Sparkles, Activity, AlertCircle, CheckCircle2,
  GitFork, Pencil, ShieldCheck,
} from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '../../../components/ui/dialog';

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

      <div className="grid gap-3 lg:grid-cols-2">
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
      </div>
    </Card>
  );
}


// ---------- Project row -------------------------------------------------
const SELF_PROJECT_ID = 'tbctools-self';

function HealthPill({ health }) {
  if (!health) return null;
  const tone = health.ok
    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
    : 'border-rose-500/40 bg-rose-500/10 text-rose-300';
  const Icon = health.ok ? CheckCircle2 : AlertCircle;
  return (
    <span
      data-testid={`health-pill-${health.project_id}`}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wider ${tone}`}
      title={health.error || `HTTP ${health.http_status} · Vercel ${health.vercel_state || '—'}`}
    >
      <Icon className="h-3 w-3" />
      {health.ok ? 'healthy' : 'down'} · {health.http_status ?? 'no-resp'}
    </span>
  );
}

// ---------- Code review modal ------------------------------------------
const VERDICT_TONE = {
  ship: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
  ship_with_fixes: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  do_not_ship: 'border-rose-500/40 bg-rose-500/10 text-rose-300',
};
const SEVERITY_TONE = {
  high: 'border-rose-500/40 bg-rose-500/10 text-rose-300',
  medium: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  low: 'border-tbc-500/40 bg-tbc-500/10 text-tbc-200',
};

function CodeReviewDialog({ open, onOpenChange, review, project }) {
  if (!review) return null;
  const findings = Array.isArray(review.findings) ? review.findings : [];
  const missing = Array.isArray(review.missing_files) ? review.missing_files : [];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid={`review-dialog-${project.id}`}
        className="max-h-[85vh] max-w-3xl overflow-y-auto border-tbc-900/60 bg-ink-950 text-tbc-100"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-tbc-100">
            <ShieldCheck className="h-4 w-4 text-violet-300" />
            Code review · <span className="font-mono text-sm text-tbc-200">{project.repo}</span>
          </DialogTitle>
          <DialogDescription className="text-tbc-200/70">
            Reviewed {review.reviewed_at ? new Date(review.reviewed_at).toLocaleString() : 'just now'}
            {review.ref && <> · branch <code className="rounded bg-ink-900 px-1 text-tbc-300">{review.ref}</code></>}
            {Array.isArray(review.files_sampled) && <> · {review.files_sampled.length} files sampled</>}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <span
              data-testid={`review-verdict-${project.id}`}
              className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs uppercase tracking-wider ${VERDICT_TONE[review.verdict] || VERDICT_TONE.ship_with_fixes}`}
            >
              {review.verdict || 'unknown'}
            </span>
            {review.summary && (
              <p className="mt-2 text-sm leading-relaxed text-tbc-100/90">{review.summary}</p>
            )}
          </div>

          {findings.length > 0 ? (
            <div className="space-y-3">
              <h4 className="text-xs font-bold uppercase tracking-wider text-tbc-200/70">
                Findings ({findings.length})
              </h4>
              {findings.map((f, i) => (
                <div
                  key={i}
                  data-testid={`review-finding-${project.id}-${i}`}
                  className="rounded-lg border border-tbc-900/60 bg-ink-900/60 p-3"
                >
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className={`rounded-full border px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${SEVERITY_TONE[f.severity] || SEVERITY_TONE.low}`}>
                      {f.severity || 'low'}
                    </span>
                    {f.file && (
                      <code className="rounded bg-ink-950 px-1.5 py-0.5 font-mono text-[11px] text-tbc-300">
                        {f.file}
                      </code>
                    )}
                    {f.line_hint && f.line_hint !== 'N/A' && (
                      <span className="text-[10px] text-tbc-200/60">{f.line_hint}</span>
                    )}
                  </div>
                  {f.title && <p className="text-sm font-semibold text-tbc-100">{f.title}</p>}
                  {f.explanation && <p className="mt-1 text-xs text-tbc-200/80 leading-relaxed">{f.explanation}</p>}
                  {f.suggested_fix && (
                    <div className="mt-2 rounded border border-emerald-500/30 bg-emerald-500/5 p-2">
                      <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-emerald-300">
                        Suggested fix
                      </p>
                      <pre className="whitespace-pre-wrap break-words font-mono text-[11px] text-emerald-100">
                        {f.suggested_fix}
                      </pre>
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-tbc-200/60">No findings 🎉</p>
          )}

          {missing.length > 0 && (
            <div>
              <h4 className="text-xs font-bold uppercase tracking-wider text-tbc-200/70">
                Missing essentials
              </h4>
              <ul className="mt-1 list-disc pl-5 text-xs text-tbc-200/80">
                {missing.map((m, i) => (
                  <li key={i}><code className="rounded bg-ink-900 px-1 font-mono">{m}</code></li>
                ))}
              </ul>
            </div>
          )}

          {review.raw_text && (
            <details className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-2 text-[11px] text-amber-200">
              <summary className="cursor-pointer font-semibold">Raw model output (couldn&apos;t parse JSON)</summary>
              <pre className="mt-1 whitespace-pre-wrap break-words font-mono">{review.raw_text}</pre>
            </details>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}


function ProjectRow({ project, onDeployed }) {
  const [busy, setBusy] = useState(null); // 'deploy' | 'preview' | 'redeploy' | 'health' | 'clone' | 'domain' | 'review' | 'download'
  const [health, setHealth] = useState(null);
  const [copied, setCopied] = useState(false);
  const [editingDomain, setEditingDomain] = useState(!project.domain);
  const [domainDraft, setDomainDraft] = useState(project.domain || '');
  const [review, setReview] = useState(project.last_code_review || null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const isSelf = project.id === SELF_PROJECT_ID;

  const trigger = async (kind) => {
    setBusy(kind);
    try {
      if (kind === 'redeploy') {
        const { data } = await api.post(`/operator/deploy/${project.id}/redeploy`);
        toast.success(`Redeploy started · ${data.state || 'queued'}`);
      } else if (kind === 'health') {
        const { data } = await api.post(`/operator/deploy/${project.id}/healthcheck`);
        setHealth(data);
        if (data.ok) toast.success(`${project.projectName}: healthy (${data.http_status} · ${data.latency_ms}ms)`);
        else toast.error(`${project.projectName}: ${data.error || `HTTP ${data.http_status ?? '—'}`}`);
        return; // skip onDeployed
      } else if (kind === 'clone') {
        const newName = window.prompt(
          'Name for the cloned project?',
          `${project.projectName} (copy)`,
        );
        if (newName === null) return; // cancelled
        const { data } = await api.post(`/operator/deploy/${project.id}/clone`, {
          new_name: newName || undefined,
        });
        toast.success(`Cloned → ${data.project.projectName} · set its domain to deploy`);
      } else if (kind === 'review') {
        toast.message('Running AI code review… this can take 20-40s');
        const { data } = await api.post(`/operator/deploy/${project.id}/code-review`);
        setReview(data);
        setReviewOpen(true);
        const findings = (data.findings || []).length;
        toast.success(`Review done · ${data.verdict || 'ok'} · ${findings} finding${findings === 1 ? '' : 's'}`);
        return; // skip onDeployed (no deploy state changed)
      } else if (kind === 'download') {
        // Stream the zip via a programmatic <a download> click so cookies travel.
        const apiBase = api.defaults.baseURL || '';
        const url = `${apiBase}/operator/deploy/${project.id}/download`;
        const a = document.createElement('a');
        a.href = url;
        a.rel = 'noopener';
        a.download = '';
        document.body.appendChild(a);
        a.click();
        a.remove();
        toast.success('Download started');
        return;
      } else {
        const target = kind === 'preview' ? 'preview' : 'production';
        const { data } = await api.post(`/operator/deploy/${project.id}/deploy`, {
          target,
        });
        toast.success(`${target === 'production' ? 'Deploy' : 'Preview'} started · ${data.state || 'queued'}`);
      }
      onDeployed();
    } catch (e) {
      toast.error(e?.response?.data?.detail || `${kind} failed`);
    } finally {
      setBusy(null);
    }
  };

  const previewUrl = project.last_deployment_url
    ? (project.last_deployment_url.startsWith('http') ? project.last_deployment_url : `https://${project.last_deployment_url}`)
    : null;
  const domainUrl = project.domain
    ? (project.domain.startsWith('http') ? project.domain : `https://${project.domain}`)
    : null;
  const copyableUrl = previewUrl || domainUrl;

  const copyUrl = async () => {
    if (!copyableUrl) {
      toast.error('No URL yet — deploy this project first');
      return;
    }
    try {
      await navigator.clipboard.writeText(copyableUrl);
      setCopied(true);
      toast.success('URL copied to clipboard');
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Clipboard blocked — copy manually');
    }
  };

  const saveDomain = async () => {
    const next = domainDraft.trim();
    if (!next) {
      toast.error('Domain required');
      return;
    }
    setBusy('domain');
    try {
      await api.patch(`/operator/deploy/${project.id}/domain`, { domain: next });
      toast.success('Domain saved');
      setEditingDomain(false);
      onDeployed();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Save failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      data-testid={`deploy-project-${project.id}`}
      className={`rounded-xl border p-4 ${
        isSelf
          ? 'border-tbc-500/40 bg-gradient-to-br from-tbc-500/10 via-ink-900/60 to-ink-900/60'
          : 'border-tbc-900/60 bg-ink-900/60'
      }`}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`grid h-8 w-8 place-items-center rounded-lg ${
              isSelf ? 'bg-tbc-500/30 text-tbc-100 ring-1 ring-tbc-300/40' : 'bg-tbc-500/15 text-tbc-300'
            }`}>
              <Rocket className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-2 truncate">
                <span className="truncate text-sm font-bold text-tbc-100">{project.projectName}</span>
                {isSelf && (
                  <span className="rounded-full bg-tbc-500 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-slate-950">this app</span>
                )}
                <HealthPill health={health} />
              </div>
              <div className="flex items-center gap-2 text-[11px] text-tbc-200/60">
                <span className="font-mono">{project.repo}</span>
                {project.gitRef && (
                  <span className="inline-flex items-center gap-1">
                    <GitBranch className="h-2.5 w-2.5" />
                    {project.gitRef}
                  </span>
                )}
              </div>
            </div>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px]">
            {editingDomain ? (
              <div className="flex items-center gap-1.5">
                <Globe className="h-3 w-3 text-tbc-300" />
                <Input
                  data-testid={`domain-input-${project.id}`}
                  autoFocus
                  placeholder="my-app.tbctools.org"
                  value={domainDraft}
                  onChange={(e) => setDomainDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') saveDomain(); }}
                  className="h-7 w-56 border-tbc-900/60 bg-ink-900 font-mono text-[11px] text-tbc-100"
                />
                <Button
                  size="sm"
                  data-testid={`domain-save-${project.id}`}
                  onClick={saveDomain}
                  disabled={busy === 'domain'}
                  className="h-7 bg-tbc-500 px-2 text-ink-950 hover:bg-tbc-400 font-semibold"
                >
                  {busy === 'domain' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                </Button>
                {project.domain && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => { setDomainDraft(project.domain); setEditingDomain(false); }}
                    className="h-7 border-tbc-900/60 bg-ink-900 px-2 text-[10px] text-tbc-200 hover:bg-ink-950"
                  >
                    Cancel
                  </Button>
                )}
              </div>
            ) : (
              <div className="inline-flex items-center gap-1">
                <a
                  href={domainUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-tbc-300 hover:text-tbc-200"
                >
                  <Globe className="h-3 w-3" /> {project.domain}
                </a>
                <button
                  data-testid={`domain-edit-${project.id}`}
                  onClick={() => setEditingDomain(true)}
                  title="Edit domain"
                  className="rounded p-0.5 text-tbc-200/50 hover:bg-ink-950 hover:text-tbc-200"
                >
                  <Pencil className="h-2.5 w-2.5" />
                </button>
              </div>
            )}
            {previewUrl && (
              <a
                data-testid={`view-preview-${project.id}`}
                href={previewUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-tbc-300 hover:text-tbc-200"
              >
                <ExternalLink className="h-3 w-3" /> View last preview
              </a>
            )}
            {project.last_deployed_at && (
              <span className="text-tbc-200/50">
                Last deploy: <span className="text-tbc-200/80">{project.last_deployment_state || '—'}</span>
                {' · '}
                {new Date(project.last_deployed_at).toLocaleString()}
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            data-testid={`deploy-${project.id}`}
            onClick={() => trigger('deploy')}
            disabled={busy !== null || !project.domain}
            title={!project.domain ? 'Set a domain first' : 'Deploy production'}
            className="bg-tbc-500 text-ink-950 hover:bg-tbc-400 font-semibold"
          >
            {busy === 'deploy' ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : <Rocket className="mr-1.5 h-3 w-3" />}
            {isSelf ? 'Deploy this app' : 'Deploy'}
          </Button>
          <Button
            size="sm"
            data-testid={`preview-${project.id}`}
            onClick={() => trigger('preview')}
            disabled={busy !== null || !project.domain}
            variant="outline"
            className="border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950"
          >
            {busy === 'preview' ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : <Sparkles className="mr-1.5 h-3 w-3" />}
            Preview
          </Button>
          <Button
            size="sm"
            data-testid={`redeploy-${project.id}`}
            onClick={() => trigger('redeploy')}
            disabled={busy !== null || !project.last_deployment_id}
            variant="outline"
            title={!project.last_deployment_id ? 'No prior deployment — run Deploy first' : 'Redeploy the last deployment exactly'}
            className="border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950"
          >
            {busy === 'redeploy' ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : <RotateCw className="mr-1.5 h-3 w-3" />}
            Redeploy
          </Button>
          <Button
            size="sm"
            data-testid={`copy-url-${project.id}`}
            onClick={copyUrl}
            disabled={busy !== null}
            variant="outline"
            title={copyableUrl ? `Copy ${copyableUrl}` : 'Deploy first to get a URL'}
            className="border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950"
          >
            {copied ? <Check className="mr-1.5 h-3 w-3 text-emerald-400" /> : <Copy className="mr-1.5 h-3 w-3" />}
            Copy URL
          </Button>
          <Button
            size="sm"
            data-testid={`clone-${project.id}`}
            onClick={() => trigger('clone')}
            disabled={busy !== null}
            variant="outline"
            title="Duplicate this project (same repo, blank domain)"
            className="border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950"
          >
            {busy === 'clone' ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : <GitFork className="mr-1.5 h-3 w-3" />}
            Clone
          </Button>
          <Button
            size="sm"
            data-testid={`download-${project.id}`}
            onClick={() => trigger('download')}
            disabled={busy !== null}
            variant="outline"
            title="Download this repo as a zip"
            className="border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950"
          >
            <Save className="mr-1.5 h-3 w-3" />
            Download
          </Button>
          <Button
            size="sm"
            data-testid={`code-review-${project.id}`}
            onClick={() => trigger('review')}
            disabled={busy !== null}
            variant="outline"
            title="Run AI code review on this repo"
            className="border-violet-500/40 bg-ink-900 text-violet-300 hover:bg-violet-500/10"
          >
            {busy === 'review' ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : <ShieldCheck className="mr-1.5 h-3 w-3" />}
            Code Review
          </Button>
          <Button
            size="sm"
            data-testid={`health-${project.id}`}
            onClick={() => trigger('health')}
            disabled={busy !== null}
            variant="outline"
            className="border-emerald-500/40 bg-ink-900 text-emerald-300 hover:bg-emerald-500/10"
          >
            {busy === 'health' ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : <Activity className="mr-1.5 h-3 w-3" />}
            Health
          </Button>
        </div>
      </div>

      {review && (
        <button
          data-testid={`view-review-${project.id}`}
          onClick={() => setReviewOpen(true)}
          className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-violet-300 hover:text-violet-200"
        >
          <ShieldCheck className="h-3 w-3" />
          Last review: <span className="font-semibold">{review.verdict || 'completed'}</span>
          {Array.isArray(review.findings) && (
            <span className="text-violet-300/70">· {review.findings.length} finding{review.findings.length === 1 ? '' : 's'}</span>
          )}
          <span className="text-violet-300/50">— click to view</span>
        </button>
      )}

      <CodeReviewDialog
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        review={review}
        project={project}
      />
    </div>
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

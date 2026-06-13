import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../../../lib/api';
import { Button } from '../../../../components/ui/button';
import { Input } from '../../../../components/ui/input';
import { Switch } from '../../../../components/ui/switch';
import { toast } from 'sonner';
import {
  Rocket, Globe, Loader2, Copy, Check, GitBranch, ExternalLink, RotateCw, Save,
  Sparkles, Activity, AlertCircle, CheckCircle2, GitFork, Pencil, ShieldCheck, Bot,
  Cog, BadgeCheck, Zap, ArrowUpCircle,
} from 'lucide-react';

import { CodeReviewDialog } from './CodeReviewDialog';
import { CloneProjectDialog } from './CloneProjectDialog';
import { ShipGateDialog } from './ShipGateDialog';
import { AutopilotDialog } from './AutopilotDialog';
import { useInlineDomain } from './useInlineDomain';

export const SELF_PROJECT_ID = 'tbctools-self';

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

/**
 * One row in the Vercel deploys list. Owns its own per-row state machine
 * (`busy`, `health`, `review`, domain editor, clone dialog) so other rows
 * can spin or open dialogs independently.
 *
 * Extracted from OpsDeploySection.jsx (Feb 2026) to keep that file under
 * ~500 lines and to make ProjectRow unit-testable in isolation.
 */
export function ProjectRow({ project, onDeployed }) {
  const [busy, setBusy] = useState(null); // 'deploy'|'preview'|'redeploy'|'health'|'clone'|'review'|'download'
  const [health, setHealth] = useState(null);
  const [copied, setCopied] = useState(false);
  const [review, setReview] = useState(project.last_code_review || null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [autopilotOpen, setAutopilotOpen] = useState(false);
  // When the backend ship-gate fires (HTTP 412), we stash the failing review
  // + seeded fix-chat id here so the dialog can offer "Open fix chat" /
  // "Bypass and ship anyway" without re-fetching.
  const [gateBlock, setGateBlock] = useState(null); // { review, fix_chat_session_id }
  const isSelf = project.id === SELF_PROJECT_ID;
  const navigate = useNavigate();
  const domain = useInlineDomain(project, onDeployed);

  const previewUrl = project.last_deployment_url
    ? (project.last_deployment_url.startsWith('http') ? project.last_deployment_url : `https://${project.last_deployment_url}`)
    : null;
  const domainUrl = project.domain
    ? (project.domain.startsWith('http') ? project.domain : `https://${project.domain}`)
    : null;
  const copyableUrl = previewUrl || domainUrl;

  // --- deploy / preview / redeploy / health / download dispatcher -------
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
      } else if (kind === 'review') {
        toast.message('Running AI code review… this can take 20-40s');
        try {
          const { data } = await api.post(`/operator/deploy/${project.id}/code-review`, undefined, {
            timeout: 120000,
          });
          setReview(data);
          setReviewOpen(true);
          const findings = (data.findings || []).length;
          toast.success(`Review done · ${data.verdict || 'ok'} · ${findings} finding${findings === 1 ? '' : 's'}`);
        } catch (e) {
          // Gateway returns HTML on 502/504 so e.response.data.detail is
          // undefined — surface a specific message instead of the generic
          // outer catch which would say "review failed".
          const detail = e?.response?.data?.detail;
          const status = e?.response?.status;
          if (typeof detail === 'string') toast.error(detail);
          else if (status === 502 || status === 504) {
            toast.error('Code review timed out at the gateway — LLM likely too slow. Try again or configure github_token to skip GitHub fetch failures.');
          } else {
            toast.error(`Code review failed${status ? ` (HTTP ${status})` : ''}`);
          }
        }
        return;
      } else if (kind === 'download') {
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
        await runDeploy(target, false);
        return;
      }
      onDeployed();
    } catch (e) {
      toast.error(e?.response?.data?.detail || `${kind} failed`);
    } finally {
      setBusy(null);
    }
  };

  // Production deploys go through this helper so we can re-call with
  // `bypass_review=true` if the operator chooses to override the gate.
  const runDeploy = async (target, bypassReview) => {
    try {
      const { data } = await api.post(`/operator/deploy/${project.id}/deploy`, {
        target,
        bypass_review: bypassReview,
      });
      toast.success(`${target === 'production' ? 'Deploy' : 'Preview'} started · ${data.state || 'queued'}`);
      setGateBlock(null);
      onDeployed();
    } catch (e) {
      const status = e?.response?.status;
      const detail = e?.response?.data?.detail;
      // FastAPI HTTPException with a dict detail surfaces as
      // {"detail": {error: 'review_blocked', review, fix_chat_session_id, message}}.
      if (status === 412 && detail && typeof detail === 'object' && detail.error === 'review_blocked') {
        setGateBlock({
          review: detail.review,
          fix_chat_session_id: detail.fix_chat_session_id,
          target,
        });
        return;
      }
      // Any non-gate failure (503 missing Vercel token, 502 from Vercel, etc)
      // must clear gateBlock so the modal doesn't linger after a bypass
      // attempt that failed for an unrelated reason.
      setGateBlock(null);
      toast.error(typeof detail === 'string' ? detail : `Deploy failed${status ? ` (HTTP ${status})` : ''}`);
    }
  };

  // Operator clicked "Open fix chat" in the ship-gate dialog: jump to the
  // pre-seeded chat session so the AI can propose patches in one click.
  const openFixChat = () => {
    if (!gateBlock?.fix_chat_session_id) {
      toast.error('Fix chat session unavailable — open a regular chat and paste the findings');
      return;
    }
    navigate(`/dashboard/${gateBlock.fix_chat_session_id}`);
    setGateBlock(null);
  };

  const bypassAndShip = async () => {
    if (!gateBlock) return;
    setBusy('deploy');
    try {
      await runDeploy(gateBlock.target || 'production', true);
    } finally {
      setBusy(null);
    }
  };

  // --- clone (shadcn dialog) -------------------------------------------
  const submitClone = async (newName) => {
    setBusy('clone');
    try {
      const { data } = await api.post(`/operator/deploy/${project.id}/clone`, {
        new_name: newName || undefined,
      });
      toast.success(`Cloned → ${data.project.projectName} · set its domain to deploy`);
      setCloneOpen(false);
      onDeployed();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Clone failed');
    } finally {
      setBusy(null);
    }
  };

  // --- copy URL --------------------------------------------------------
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

  // --- promote-to-prod (separate from runDeploy to avoid the gate path) ---
  const promote = async () => {
    if (!project.last_deployment_id) {
      toast.error('No preview deployment to promote — run a Preview first.');
      return;
    }
    if (!window.confirm(`Promote the last preview of ${project.projectName} to production?`)) return;
    setBusy('promote');
    try {
      const { data } = await api.post(`/operator/deploy/${project.id}/promote`, {});
      toast.success(`Promoted to production · ${data?.state || 'queued'}`);
      onDeployed();
    } catch (e) {
      const detail = e?.response?.data?.detail;
      toast.error(typeof detail === 'string' ? detail : 'Promote failed');
    } finally {
      setBusy(null);
    }
  };

  // --- auto-promote toggle (PATCH /api/operator/deploy/{id}) -----------
  const toggleAutoPromote = async (next) => {
    setBusy('auto-promote');
    try {
      await api.patch(`/operator/deploy/${project.id}`, { auto_promote: next });
      toast.success(next ? 'Auto-promote ON · successful previews ship on their own' : 'Auto-promote OFF');
      onDeployed();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not toggle auto-promote');
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
                <button
                  type="button"
                  onClick={() => navigate(`/operator/projects/${project.id}/settings`)}
                  data-testid={`project-settings-link-${project.id}`}
                  title="Open project settings"
                  className="ml-1 grid h-6 w-6 place-items-center rounded text-tbc-200/70 transition-colors hover:bg-tbc-500/20 hover:text-tbc-100"
                >
                  <Cog className="h-3.5 w-3.5" />
                </button>
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
            {domain.editing ? (
              <div className="flex items-center gap-1.5">
                <Globe className="h-3 w-3 text-tbc-300" />
                <Input
                  data-testid={`domain-input-${project.id}`}
                  autoFocus
                  placeholder="my-app.tbctools.org"
                  value={domain.draft}
                  onChange={(e) => domain.setDraft(e.target.value)}
                  onKeyDown={domain.onKeyDown}
                  className="h-7 w-56 border-tbc-900/60 bg-ink-900 font-mono text-[11px] text-tbc-100"
                />
                <Button
                  size="sm"
                  data-testid={`domain-save-${project.id}`}
                  onClick={domain.save}
                  disabled={domain.saving}
                  className="h-7 bg-tbc-500 px-2 text-ink-950 hover:bg-tbc-400 font-semibold"
                >
                  {domain.saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                </Button>
                {project.domain && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={domain.cancel}
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
                  onClick={() => domain.setEditing(true)}
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
            {project.last_promoted_at && (
              <span
                data-testid={`project-promoted-at-${project.id}`}
                className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 font-semibold text-emerald-300"
              >
                <BadgeCheck className="h-3 w-3" />
                Promoted {new Date(project.last_promoted_at).toLocaleString()}
              </span>
            )}
            {project.auto_promote && (
              <span
                data-testid={`project-auto-promote-${project.id}`}
                className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 px-2 py-0.5 font-semibold text-emerald-300"
                title="Auto-promote enabled — successful previews ship on their own"
              >
                <Zap className="h-3 w-3" />
                Auto-promote
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
            onClick={() => setCloneOpen(true)}
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
            data-testid={`autopilot-${project.id}`}
            onClick={() => setAutopilotOpen(true)}
            disabled={busy !== null}
            variant="outline"
            title="Run the full propose → review → ship → watch → react loop"
            className="border-tbc-500/40 bg-ink-900 text-tbc-100 hover:bg-tbc-500/10"
          >
            <Bot className="mr-1.5 h-3 w-3" />
            Autopilot
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
          <Button
            size="sm"
            data-testid={`promote-${project.id}`}
            onClick={promote}
            disabled={busy !== null || !project.last_deployment_id}
            variant="outline"
            title={
              !project.last_deployment_id
                ? 'No preview deployment yet — run Preview first'
                : 'Promote the last preview to production'
            }
            className="border-amber-500/40 bg-ink-900 text-amber-300 hover:bg-amber-500/10"
          >
            {busy === 'promote' ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : <ArrowUpCircle className="mr-1.5 h-3 w-3" />}
            Promote to Prod
          </Button>
          <label
            className="inline-flex items-center gap-2 rounded-md border border-tbc-900/60 bg-ink-900 px-2.5 py-1.5 text-[11px] text-tbc-200/80"
            title="When ON, a successful preview deploy is automatically promoted to production."
          >
            <Switch
              data-testid={`auto-promote-${project.id}`}
              checked={!!project.auto_promote}
              onCheckedChange={toggleAutoPromote}
              disabled={busy !== null}
            />
            <span>Auto-promote</span>
          </label>
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
      <CloneProjectDialog
        open={cloneOpen}
        onOpenChange={setCloneOpen}
        project={project}
        onConfirm={submitClone}
        busy={busy === 'clone'}
      />
      <ShipGateDialog
        open={!!gateBlock}
        onOpenChange={(v) => { if (!v) setGateBlock(null); }}
        project={project}
        block={gateBlock}
        onOpenChat={openFixChat}
        onBypass={bypassAndShip}
        busy={busy === 'deploy'}
      />
      <AutopilotDialog
        open={autopilotOpen}
        onOpenChange={setAutopilotOpen}
        project={project}
      />
    </div>
  );
}

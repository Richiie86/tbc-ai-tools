import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../../../../components/ui/button';
import { Input } from '../../../../components/ui/input';
import { Switch } from '../../../../components/ui/switch';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '../../../../components/ui/alert-dialog';
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
import { useProjectActions } from './useProjectActions';

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
 * One row in the Vercel deploys list. UI-only — all handlers and dialog
 * state live in `useProjectActions` (Feb 2026 refactor) so this file
 * stays focused on layout.
 */
export function ProjectRow({ project, onDeployed }) {
  const isSelf = project.id === SELF_PROJECT_ID;
  const navigate = useNavigate();
  const domain = useInlineDomain(project, onDeployed);
  const a = useProjectActions(project, onDeployed);

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
                <HealthPill health={a.health} />
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
                  href={a.domainUrl}
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
            {a.previewUrl && (
              <a
                data-testid={`view-preview-${project.id}`}
                href={a.previewUrl}
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
            onClick={() => a.trigger('deploy')}
            disabled={a.busy !== null || !project.domain}
            title={!project.domain ? 'Set a domain first' : 'Deploy production'}
            className="bg-tbc-500 text-ink-950 hover:bg-tbc-400 font-semibold"
          >
            {a.busy === 'deploy' ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : <Rocket className="mr-1.5 h-3 w-3" />}
            {isSelf ? 'Deploy this app' : 'Deploy'}
          </Button>
          <Button
            size="sm"
            data-testid={`preview-${project.id}`}
            onClick={() => a.trigger('preview')}
            disabled={a.busy !== null || !project.domain}
            variant="outline"
            className="border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950"
          >
            {a.busy === 'preview' ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : <Sparkles className="mr-1.5 h-3 w-3" />}
            Preview
          </Button>
          <Button
            size="sm"
            data-testid={`redeploy-${project.id}`}
            onClick={() => a.trigger('redeploy')}
            disabled={a.busy !== null || !project.last_deployment_id}
            variant="outline"
            title={!project.last_deployment_id ? 'No prior deployment — run Deploy first' : 'Redeploy the last deployment exactly'}
            className="border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950"
          >
            {a.busy === 'redeploy' ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : <RotateCw className="mr-1.5 h-3 w-3" />}
            Redeploy
          </Button>
          <Button
            size="sm"
            data-testid={`copy-url-${project.id}`}
            onClick={a.copyUrl}
            disabled={a.busy !== null}
            variant="outline"
            title={a.copyableUrl ? `Copy ${a.copyableUrl}` : 'Deploy first to get a URL'}
            className="border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950"
          >
            {a.copied ? <Check className="mr-1.5 h-3 w-3 text-emerald-400" /> : <Copy className="mr-1.5 h-3 w-3" />}
            Copy URL
          </Button>
          <Button
            size="sm"
            data-testid={`clone-${project.id}`}
            onClick={() => a.setCloneOpen(true)}
            disabled={a.busy !== null}
            variant="outline"
            title="Duplicate this project (same repo, blank domain)"
            className="border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950"
          >
            {a.busy === 'clone' ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : <GitFork className="mr-1.5 h-3 w-3" />}
            Clone
          </Button>
          <Button
            size="sm"
            data-testid={`download-${project.id}`}
            onClick={() => a.trigger('download')}
            disabled={a.busy !== null}
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
            onClick={() => a.trigger('review')}
            disabled={a.busy !== null}
            variant="outline"
            title="Run AI code review on this repo"
            className="border-violet-500/40 bg-ink-900 text-violet-300 hover:bg-violet-500/10"
          >
            {a.busy === 'review' ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : <ShieldCheck className="mr-1.5 h-3 w-3" />}
            Code Review
          </Button>
          <Button
            size="sm"
            data-testid={`autopilot-${project.id}`}
            onClick={() => a.setAutopilotOpen(true)}
            disabled={a.busy !== null}
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
            onClick={() => a.trigger('health')}
            disabled={a.busy !== null}
            variant="outline"
            className="border-emerald-500/40 bg-ink-900 text-emerald-300 hover:bg-emerald-500/10"
          >
            {a.busy === 'health' ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : <Activity className="mr-1.5 h-3 w-3" />}
            Health
          </Button>
          <Button
            size="sm"
            data-testid={`promote-${project.id}`}
            onClick={() => a.setPromoteOpen(true)}
            disabled={a.busy !== null || !project.last_deployment_id}
            variant="outline"
            title={
              !project.last_deployment_id
                ? 'No preview deployment yet — run Preview first'
                : 'Promote the last preview to production'
            }
            className="border-amber-500/40 bg-ink-900 text-amber-300 hover:bg-amber-500/10"
          >
            {a.busy === 'promote' ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : <ArrowUpCircle className="mr-1.5 h-3 w-3" />}
            Promote to Prod
          </Button>
          <label
            className="inline-flex items-center gap-2 rounded-md border border-tbc-900/60 bg-ink-900 px-2.5 py-1.5 text-[11px] text-tbc-200/80"
            title="When ON, a successful preview deploy is automatically promoted to production."
          >
            <Switch
              data-testid={`auto-promote-${project.id}`}
              checked={!!project.auto_promote}
              onCheckedChange={a.toggleAutoPromote}
              disabled={a.busy !== null}
            />
            <span>Auto-promote</span>
          </label>
        </div>
      </div>

      {a.review && (
        <button
          data-testid={`view-review-${project.id}`}
          onClick={() => a.setReviewOpen(true)}
          className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-violet-300 hover:text-violet-200"
        >
          <ShieldCheck className="h-3 w-3" />
          Last review: <span className="font-semibold">{a.review.verdict || 'completed'}</span>
          {Array.isArray(a.review.findings) && (
            <span className="text-violet-300/70">· {a.review.findings.length} finding{a.review.findings.length === 1 ? '' : 's'}</span>
          )}
          <span className="text-violet-300/50">— click to view</span>
        </button>
      )}

      <CodeReviewDialog
        open={a.reviewOpen}
        onOpenChange={a.setReviewOpen}
        review={a.review}
        project={project}
      />
      <CloneProjectDialog
        open={a.cloneOpen}
        onOpenChange={a.setCloneOpen}
        project={project}
        onConfirm={a.submitClone}
        busy={a.busy === 'clone'}
      />
      <ShipGateDialog
        open={!!a.gateBlock}
        onOpenChange={(v) => { if (!v) a.setGateBlock(null); }}
        project={project}
        block={a.gateBlock}
        onOpenChat={a.openFixChat}
        onBypass={a.bypassAndShip}
        busy={a.busy === 'deploy'}
      />
      <AutopilotDialog
        open={a.autopilotOpen}
        onOpenChange={a.setAutopilotOpen}
        project={project}
      />

      {/* Promote-to-prod confirmation. Replaces window.confirm() so the
          visual language matches the rest of our shadcn dialogs. */}
      <AlertDialog open={a.promoteOpen} onOpenChange={a.setPromoteOpen}>
        <AlertDialogContent
          data-testid={`promote-confirm-${project.id}`}
          className="border-tbc-900/60 bg-ink-950 text-tbc-100"
        >
          <AlertDialogHeader>
            <AlertDialogTitle className="text-tbc-100">
              Promote {project.projectName} to production?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-tbc-200/70">
              This ships the last preview deployment to your production domain on Vercel.
              Make sure the preview looks right — the operation is immediate and visible
              to every customer.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              data-testid={`promote-cancel-${project.id}`}
              className="border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950"
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              data-testid={`promote-confirm-btn-${project.id}`}
              onClick={a.promote}
              className="bg-amber-500 text-ink-950 hover:bg-amber-400 font-semibold"
            >
              Yes, promote to production
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

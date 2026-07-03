import React, { useState, useEffect } from 'react';
import { toast } from 'sonner';
import { Rocket, Loader2, X, Activity, ShieldCheck, Eye, ExternalLink, BadgeCheck } from 'lucide-react';
import api from '../../lib/api';

const STORAGE_KEY = 'tbc.inChat.selectedProjectId';
const PREVIEW_KEY = 'tbc.inChat.lastPreviewUrl';

const readPreview = () => {
  try { return localStorage.getItem(PREVIEW_KEY) || ''; } catch { return ''; }
};

const writePreview = (url) => {
  try {
    if (url) localStorage.setItem(PREVIEW_KEY, url);
    else localStorage.removeItem(PREVIEW_KEY);
  } catch { /* ignore */ }
};

/**
 * Two-state pill that sits directly above the chat composer:
 *
 * 1. After an AI streaming completion (`visible=true`, no preview yet) it
 *    asks the operator to ship — Review / Health / Redeploy buttons.
 * 2. After a successful deploy it morphs into a "Your Preview is ready"
 *    pill with a clickable thumbnail that pops the live
 *    URL in a new tab.
 *
 * Hidden for non-operators and when no deploy project is picked.
 */
export function PostAiDeploySuggestion({ user, visible, onDismiss }) {
  const [busy, setBusy] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(readPreview);

  // Cross-tab sync — if another tab fires a deploy, surface the pill here too.
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key === PREVIEW_KEY) setPreviewUrl(e.newValue || '');
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // Read latest preview each time the pill is asked to show — keeps the
  // pill alive across navigations without a global store.
  useEffect(() => {
    if (visible) setPreviewUrl(readPreview());
  }, [visible]);

  if (user?.role !== 'operator') return null;

  let projectId = '';
  try { projectId = localStorage.getItem(STORAGE_KEY) || ''; } catch { /* ignore */ }

  // Preview pill is the highest-priority state. It survives even when the
  // suggestion itself is dismissed, so operators can re-open the preview.
  if (previewUrl) {
    return (
      <PreviewReadyPill
        url={previewUrl}
        projectId={projectId}
        onDismiss={() => {
          writePreview('');
          setPreviewUrl('');
          onDismiss?.();
        }}
      />
    );
  }

  if (!visible || !projectId) return null;

  const run = async (kind) => {
    setBusy(kind);
    try {
      const map = {
        deploy: `/operator/deploy/${projectId}/redeploy`,
        health: `/operator/deploy/${projectId}/healthcheck`,
        review: `/operator/deploy/${projectId}/code-review`,
      };
      const { data } = await api.post(map[kind], {});
      if (kind === 'deploy') {
        const url = data?.url || data?.deployment_url || data?.preview_url;
        if (url) {
          const fullUrl = url.startsWith('http') ? url : `https://${url}`;
          writePreview(fullUrl);
          setPreviewUrl(fullUrl);
          toast.success('Preview is ready');
        } else {
          toast.success(`Redeploy queued — ${data?.id || 'OK'}`);
        }
      } else if (kind === 'health') {
        toast.success(`Health: ${data?.status || (data?.ok ? 'OK' : 'unknown')}`);
      } else if (kind === 'review') {
        toast.success(`Review: ${data?.verdict || data?.summary || 'done'}`);
      }
    } catch (e) {
      toast.error(e?.response?.data?.detail || `${kind} failed`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className="mx-auto my-3 flex max-w-3xl items-center gap-3 rounded-xl border border-tbc-500/40 bg-gradient-to-r from-tbc-500/10 via-ink-950 to-tbc-500/10 px-4 py-2.5 text-xs text-tbc-100 shadow-[0_0_20px_rgba(212,160,40,0.08)]"
      data-testid="post-ai-deploy-suggestion"
    >
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-tbc-500/25 text-tbc-200">
        <Rocket className="h-3.5 w-3.5" />
      </span>
      <div className="flex-1 leading-tight">
        <div className="font-semibold text-tbc-100">AI is done — ship it?</div>
        <div className="text-[11px] text-tbc-200/60">
          Run review &amp; health, then redeploy to push the changes live.
        </div>
      </div>
      <button
        type="button"
        onClick={() => run('review')}
        disabled={!!busy}
        data-testid="post-ai-review-btn"
        className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold text-tbc-100 hover:bg-ink-900 disabled:opacity-40"
      >
        {busy === 'review' ? <Loader2 className="h-3 w-3 animate-spin" /> : <ShieldCheck className="h-3 w-3" />}
        Review
      </button>
      <button
        type="button"
        onClick={() => run('health')}
        disabled={!!busy}
        data-testid="post-ai-health-btn"
        className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold text-tbc-100 hover:bg-ink-900 disabled:opacity-40"
      >
        {busy === 'health' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Activity className="h-3 w-3" />}
        Health
      </button>
      <button
        type="button"
        onClick={() => run('deploy')}
        disabled={!!busy}
        data-testid="post-ai-redeploy-btn"
        className="inline-flex items-center gap-1.5 rounded-md bg-tbc-500 px-2.5 py-1 text-[11px] font-bold text-ink-950 transition hover:bg-tbc-400 disabled:opacity-50"
      >
        {busy === 'deploy' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Rocket className="h-3 w-3" />}
        Redeploy now
      </button>
      <button
        type="button"
        onClick={onDismiss}
        data-testid="post-ai-dismiss"
        aria-label="Dismiss"
        className="grid h-6 w-6 shrink-0 place-items-center rounded text-tbc-200/60 hover:bg-ink-900 hover:text-tbc-100"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

/**
 * "Your Preview is ready" pill — agent-style. Sits above the message
 * field, shows a tiny live-preview thumbnail (sandboxed iframe), and
 * clicking opens the full URL in a new tab.
 *
 * Optional `projectId` enables a one-click "Promote to prod" gate that
 * calls Vercel's promote API — letting the operator ship the exact build
 * they just eyeballed, without leaving the chat.
 */
export function PreviewReadyPill({ url, projectId, onDismiss }) {
  const [promoting, setPromoting] = useState(false);
  const [promoted, setPromoted] = useState(false);

  const open = () => {
    try { window.open(url, '_blank', 'noopener,noreferrer'); }
    catch { window.location.href = url; }
  };

  const host = (() => {
    try { return new URL(url).host; } catch { return url; }
  })();

  const promote = async (e) => {
    e.stopPropagation();
    if (!projectId) return;
    if (!window.confirm('Promote this preview to production?\nIt will become live at the project domain.')) return;
    setPromoting(true);
    try {
      const { data } = await api.post(`/operator/deploy/${projectId}/promote`, {});
      const prodUrl = data?.production_url || data?.url || url;
      toast.success('Promoted to production');
      setPromoted(true);
      // Bump the iframe to the production URL so the thumbnail reflects
      // the live site, not the now-old preview.
      try { window.open(prodUrl, '_blank', 'noopener,noreferrer'); } catch { /* ignore */ }
    } catch (err) {
      toast.error(err?.response?.data?.detail || 'Promote failed');
    } finally {
      setPromoting(false);
    }
  };

  return (
    <div
      data-testid="preview-ready-pill"
      className="group relative mx-auto my-3 flex max-w-fit items-center gap-3 rounded-full border border-tbc-500/30 bg-ink-900/95 py-1.5 pl-1.5 pr-2 text-left shadow-[0_8px_28px_rgba(0,0,0,0.45)] backdrop-blur transition hover:border-tbc-400/60 hover:shadow-[0_8px_28px_rgba(212,160,40,0.25)]"
    >
      {/* Tiny sandboxed live-preview thumbnail. The whole thumbnail is a
          click-target for opening the URL — the promote button below is
          a sibling so its own click won't trigger the open. */}
      <button
        type="button"
        onClick={open}
        data-testid="preview-ready-open"
        className="relative grid h-9 w-9 shrink-0 cursor-pointer overflow-hidden rounded-full bg-ink-950 ring-1 ring-tbc-500/20"
      >
        <iframe
          src={url}
          title="preview thumbnail"
          aria-hidden="true"
          tabIndex={-1}
          sandbox="allow-scripts allow-same-origin"
          loading="lazy"
          className="pointer-events-none absolute left-1/2 top-1/2 h-[200px] w-[300px] -translate-x-1/2 -translate-y-1/2 origin-center scale-[0.12] rounded"
        />
        <span className="absolute inset-0 grid place-items-center bg-ink-950/40">
          <Eye className="h-3.5 w-3.5 text-tbc-200" />
        </span>
      </button>

      <button
        type="button"
        onClick={open}
        data-testid="preview-ready-text"
        className="flex flex-col leading-tight pr-2 text-left cursor-pointer"
      >
        <span className="text-xs font-bold text-tbc-50">
          {promoted ? 'Promoted to production' : 'Your Preview is ready'}
        </span>
        <span className="flex items-center gap-1 text-[10px] text-tbc-200/60">
          <span className="truncate">{host}</span>
          <ExternalLink className="h-2.5 w-2.5" />
        </span>
      </button>

      {/* Promote-to-prod gate — only shows when we know the project id. */}
      {projectId && !promoted && (
        <button
          type="button"
          onClick={promote}
          disabled={promoting}
          data-testid="preview-promote-btn"
          title="Promote this preview to production"
          className="ml-1 inline-flex items-center gap-1.5 rounded-full bg-tbc-500 px-3 py-1 text-[11px] font-bold text-ink-950 transition hover:bg-tbc-400 disabled:opacity-50"
        >
          {promoting
            ? <Loader2 className="h-3 w-3 animate-spin" />
            : <BadgeCheck className="h-3 w-3" />}
          {promoting ? 'Promoting…' : 'Promote to prod'}
        </button>
      )}
      {promoted && (
        <span
          data-testid="preview-promoted-badge"
          className="ml-1 inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2.5 py-1 text-[11px] font-bold text-emerald-300"
        >
          <BadgeCheck className="h-3 w-3" /> Live
        </span>
      )}

      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onDismiss?.(); }}
        data-testid="preview-ready-dismiss"
        aria-label="Dismiss preview pill"
        className="ml-1 grid h-5 w-5 shrink-0 place-items-center rounded-full text-tbc-200/50 transition-colors hover:bg-ink-950 hover:text-tbc-100"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

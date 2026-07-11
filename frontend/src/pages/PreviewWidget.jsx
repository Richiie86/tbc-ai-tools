import React, { useCallback, useEffect, useState } from 'react';
import api from '../lib/api';
import { Button } from '../components/ui/button';
import { toast } from 'sonner';
import ScreenshotThumb from '../components/ScreenshotThumb';
import {
  GitBranch, ExternalLink, Loader2, Rocket, RefreshCw, CheckCircle2,
  XCircle, Hammer, Camera,
} from 'lucide-react';

/**
 * GitHub PR Preview widget — shown on the Operator dashboard above the
 * tab bar.
 *
 * Closes the loop between Sandbox edits and production: every time the
 * operator pushes a branch (manually or via the Sandbox AI "Apply &
 * commit"), Vercel builds a preview. This widget lists every such
 * preview with branch name, commit message, status dot, and a one-click
 * "Promote to prod" button that reuses `POST /api/operator/deploy/{id}/promote`.
 *
 * Auto-refreshes every 30s — bounded enough that the Vercel rate-limit
 * isn't a worry, fast enough that "building → ready" transitions appear
 * within a normal attention span.
 */
export default function PreviewWidget() {
  const [previews, setPreviews] = useState([]);
  const [loading, setLoading] = useState(true);
  const [promoting, setPromoting] = useState(null); // deployment_id being promoted
  const [collapsed, setCollapsed] = useState(false);
  // Per-row promote options — `auto_tag` and `auto_changelog` are persisted
  // in localStorage so the operator's preference survives page reloads.
  const [autoTag, setAutoTag] = useState(() => {
    try { return JSON.parse(localStorage.getItem('promote_auto_tag') || 'true'); }
    catch { return true; }
  });
  const [autoChangelog, setAutoChangelog] = useState(() => {
    try { return JSON.parse(localStorage.getItem('promote_auto_changelog') || 'true'); }
    catch { return true; }
  });
  useEffect(() => { localStorage.setItem('promote_auto_tag', JSON.stringify(autoTag)); }, [autoTag]);
  useEffect(() => { localStorage.setItem('promote_auto_changelog', JSON.stringify(autoChangelog)); }, [autoChangelog]);

  const load = useCallback(async ({ silent } = {}) => {
    if (!silent) setLoading(true);
    try {
      const { data } = await api.get('/operator/deploy/previews');
      setPreviews(data.previews || []);
    } catch (e) {
      // 503 = no Vercel token; degrade silently — widget hides.
      if (!silent) console.warn('Preview widget load failed', e);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Background poll — 30s while the dashboard is foregrounded. Stops
  // when the document is hidden so a backgrounded tab doesn't burn
  // Vercel API quota.
  useEffect(() => {
    const id = setInterval(() => {
      if (!document.hidden) load({ silent: true });
    }, 30_000);
    return () => clearInterval(id);
  }, [load]);

  const promote = async (p) => {
    if (!window.confirm(`Promote ${p.branch} to production?\n\nThis ships the preview at ${p.preview_url} to prod immediately.`)) return;
    setPromoting(p.deployment_id);
    // Up to 3 attempts with exponential backoff — Vercel's promote
    // endpoint occasionally returns 502 mid-build when the deployment
    // is still being finalised. Retrying is safe (idempotent on
    // their side — the same deployment_id maps to the same prod alias).
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const { data } = await api.post(`/operator/deploy/${p.project_id}/promote`, {
          deployment_id: p.deployment_id,
          git_ref: p.branch,
          auto_tag: autoTag,
          auto_changelog: autoChangelog,
        });
        const tag = data?.release_tag?.tag;
        toast.success(
          tag
            ? `Promoted ${p.branch} → ${tag}`
            : data?.fallback_rebuilt
              ? `Production deploy started for ${p.branch}`
              : `Promoted ${p.branch} to production`,
          { description: tag ? data.release_tag.url : undefined },
        );
        setPreviews((cur) => cur.filter((x) => x.deployment_id !== p.deployment_id));
        setPromoting(null);
        return;
      } catch (e) {
        lastErr = e;
        // 4xx = permanent failure (auth, malformed payload). 5xx = retry.
        const status = e?.response?.status;
        if (status && status < 500) break;
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, 800 * attempt));
        }
      }
    }
    toast.error(lastErr?.response?.data?.detail || `Promote failed after 3 attempts`);
    setPromoting(null);
  };

  if (loading) return null;        // first load: silent
  if (previews.length === 0) return null;  // no previews: don't waste vertical space

  return (
    <div
      data-testid="preview-widget"
      className="mt-8 rounded-lg border border-emerald-500/30 bg-emerald-500/[0.04] p-3"
    >
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="flex w-full items-center justify-between gap-2 text-left"
      >
        <div className="flex items-center gap-2">
          <Rocket className="h-4 w-4 text-emerald-300" />
          <span className="text-sm font-bold text-tbc-100">
            Preview ready · {previews.length} branch{previews.length === 1 ? '' : 'es'}
          </span>
          <span className="hidden sm:inline text-[10px] text-tbc-200/50">
            — every push gets a Vercel preview; promote to prod with one click
          </span>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={(e) => { e.stopPropagation(); load(); }}
          data-testid="preview-widget-refresh"
          className="h-6 text-tbc-200/60 hover:text-tbc-100"
        >
          <RefreshCw className="h-3 w-3" />
        </Button>
      </button>

      {!collapsed && (
        <div className="mt-2 flex flex-wrap items-center gap-3 text-[10px] text-tbc-200/70">
          <label className="flex items-center gap-1.5" title="Annotated GitHub tag `prod-YYYY-MM-DD-N` on promote">
            <input
              type="checkbox"
              checked={autoTag}
              onChange={(e) => setAutoTag(e.target.checked)}
              data-testid="preview-toggle-auto-tag"
              onClick={(e) => e.stopPropagation()}
            />
            Auto-tag release
          </label>
          <label className="flex items-center gap-1.5" title="Prepends an entry to CHANGELOG.md on the default branch">
            <input
              type="checkbox"
              checked={autoChangelog}
              onChange={(e) => setAutoChangelog(e.target.checked)}
              data-testid="preview-toggle-auto-changelog"
              onClick={(e) => e.stopPropagation()}
            />
            Update CHANGELOG.md
          </label>
        </div>
      )}

      {!collapsed && (
        <ul className="mt-2.5 space-y-1.5">
          {previews.map((p) => (
            <PreviewRow
              key={p.deployment_id}
              p={p}
              busy={promoting === p.deployment_id}
              onPromote={() => promote(p)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function PreviewRow({ p, busy, onPromote }) {
  const [capturing, setCapturing] = useState(false);
  // Bump this to force ScreenshotThumb to re-fetch after a fresh capture.
  const [shotVersion, setShotVersion] = useState(0);
  const [hasShot, setHasShot] = useState(true); // optimistic; thumb hides itself if none

  const Icon =
    p.state === 'ready'    ? CheckCircle2 :
    p.state === 'failed'   ? XCircle :
    Hammer;
  const tone =
    p.state === 'ready'    ? 'text-emerald-300' :
    p.state === 'failed'   ? 'text-red-300' :
    'text-amber-300';

  const capture = async () => {
    if (!p.preview_url) return;
    setCapturing(true);
    try {
      await api.post(`/operator/ai-build/preview-screenshot/${p.deployment_id}`, {
        url: p.preview_url,
      });
      setHasShot(true);
      setShotVersion((v) => v + 1);
      toast.success('Screenshot captured');
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not capture screenshot');
    } finally {
      setCapturing(false);
    }
  };

  return (
    <li
      data-testid={`preview-row-${p.deployment_id}`}
      className="flex items-center gap-3 rounded border border-tbc-900/60 bg-ink-900/50 px-2.5 py-1.5"
    >
      <Icon className={`h-3.5 w-3.5 shrink-0 ${tone}`} />
      {hasShot && (
        <ScreenshotThumb
          key={shotVersion}
          src={`/operator/ai-build/preview-screenshot/${p.deployment_id}/screenshot`}
          alt={`Preview screenshot for ${p.branch}`}
        />
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 truncate">
          <GitBranch className="h-3 w-3 shrink-0 text-tbc-300" />
          <span className="font-mono text-[12px] text-tbc-100 truncate">{p.branch}</span>
          {p.commit_sha && (
            <code className="text-[10px] text-tbc-200/40">{p.commit_sha}</code>
          )}
        </div>
        {p.commit_message && (
          <div className="truncate text-[11px] text-tbc-200/50">{p.commit_message}</div>
        )}
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        {p.preview_url && (
          <button
            type="button"
            onClick={capture}
            disabled={capturing}
            title="Capture a screenshot of this preview"
            data-testid={`preview-capture-${p.deployment_id}`}
            className="inline-flex items-center gap-1 rounded border border-tbc-900/60 bg-ink-900 px-2 py-1 text-[10px] text-tbc-100 hover:bg-ink-950 disabled:opacity-50"
          >
            {capturing ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Camera className="h-2.5 w-2.5" />}
            Shot
          </button>
        )}
        {p.preview_url && (
          <a
            href={p.preview_url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded border border-tbc-900/60 bg-ink-900 px-2 py-1 text-[10px] text-tbc-100 hover:bg-ink-950"
            data-testid={`preview-open-${p.deployment_id}`}
            title={p.preview_url}
          >
            Open <ExternalLink className="h-2.5 w-2.5" />
          </a>
        )}
        <Button
          size="sm"
          onClick={onPromote}
          disabled={busy || p.state !== 'ready'}
          data-testid={`preview-promote-${p.deployment_id}`}
          className="h-7 bg-emerald-500 text-ink-950 hover:bg-emerald-400 font-bold text-[11px]"
          title={p.state !== 'ready' ? 'Preview must finish building first' : 'Ship this preview to production'}
        >
          {busy
            ? <Loader2 className="h-3 w-3 animate-spin" />
            : <><Rocket className="mr-1 h-3 w-3" />Promote</>}
        </Button>
      </div>
    </li>
  );
}

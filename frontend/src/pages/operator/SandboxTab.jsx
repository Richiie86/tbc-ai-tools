import React, { useCallback, useEffect, useState } from 'react';
import api from '../../lib/api';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Textarea } from '../../components/ui/textarea';
import { toast } from 'sonner';
import {
  FolderOpen, FileCode2, Loader2, Save, ChevronLeft, ExternalLink,
  Rocket, FlaskConical, AlertTriangle, Sparkles,
} from 'lucide-react';
import { PreviewReadyPill } from '../dashboard/PostAiDeploySuggestion';
import SandboxAIPanel from './SandboxAIPanel';

/**
 * Operator self-edit sandbox.
 *
 * Browses the configured "self" repo (via GitHub Contents API on the
 * backend), lets the operator edit a file in-place, and commits the
 * change — which triggers the GitHub webhook → auto-deploy.
 *
 * No Monaco for now — a syntax-friendly `<Textarea>` is enough for
 * landing-copy tweaks and small bug fixes the operator might do in
 * production. For bigger edits the operator still has the full IDE.
 */
export default function SandboxTab() {
  const [info, setInfo] = useState(null);
  const [cwd, setCwd] = useState('frontend/src');
  const [tree, setTree] = useState([]);
  const [loadingTree, setLoadingTree] = useState(false);
  const [openFile, setOpenFile] = useState(null);   // {path, sha, content, original}
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [commitMsg, setCommitMsg] = useState('');
  const [previewUrl, setPreviewUrl] = useState('');
  const [updating, setUpdating] = useState(null); // null | 'commit' | 'deploy' | 'promote'

  const loadInfo = useCallback(async () => {
    try {
      const { data } = await api.get('/operator/self/info');
      setInfo(data);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Failed to load sandbox config');
    }
  }, []);

  const loadTree = useCallback(async (path) => {
    setLoadingTree(true);
    try {
      const { data } = await api.get('/operator/self/tree', { params: { path } });
      setTree(data.entries || []);
      setCwd(data.path || '');
      if ((data.entries || []).length === 0) {
        // Surface this proactively so the operator knows whether their
        // `self_repo` / `self_git_ref` setting is wrong vs. the dir really
        // being empty.
        toast.message(`No files at /${data.path || ''} on this branch`, {
          description: 'Check Operator → Security → Self repo / branch.',
        });
      }
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Failed to load tree');
    } finally {
      setLoadingTree(false);
    }
  }, []);

  useEffect(() => { loadInfo(); loadTree('frontend/src'); }, [loadInfo, loadTree]);

  const openEntry = async (entry) => {
    if (entry.type === 'dir') {
      loadTree(entry.path);
      setOpenFile(null);
      return;
    }
    try {
      const { data } = await api.get('/operator/self/file', { params: { path: entry.path } });
      setOpenFile({ path: data.path, sha: data.sha, html_url: data.html_url });
      setDraft(data.content);
      setCommitMsg(`sandbox: edit ${entry.name}`);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Failed to open file');
    }
  };

  const goUp = () => {
    if (!cwd || cwd === 'frontend/src' || cwd === 'backend' || cwd === 'frontend/public') {
      loadTree('frontend/src');
      return;
    }
    const parent = cwd.split('/').slice(0, -1).join('/') || 'frontend/src';
    loadTree(parent);
  };

  const save = async () => {
    if (!openFile) return;
    if (!window.confirm(`Commit ${openFile.path} to ${info?.branch || 'main'}?\nThis triggers an auto-deploy via the GitHub webhook.`)) return;
    setSaving(true);
    try {
      const { data } = await api.put('/operator/self/file', {
        path: openFile.path,
        content: draft,
        sha: openFile.sha,
        message: commitMsg || `sandbox: edit ${openFile.path.split('/').pop()}`,
      });
      setOpenFile((cur) => (cur ? { ...cur, sha: data.new_sha } : cur));
      toast.success('Committed — auto-deploy in flight');
      // Show the in-flight preview pill so the operator can re-open the
      // deployed preview as soon as the watcher fires.
      try {
        const last = localStorage.getItem('tbc.inChat.lastPreviewUrl');
        if (last) setPreviewUrl(last);
      } catch { /* ignore */ }
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  /**
   * One-click "Update app" — commits the current draft AND immediately
   * fires Deploy + Promote against the operator's selected project, so
   * the change lands on prod without depending on the GitHub webhook.
   */
  const updateApp = async () => {
    if (!openFile) return;
    let projectId = '';
    try { projectId = localStorage.getItem('tbc.inChat.selectedProjectId') || ''; } catch { /* ignore */ }
    if (!projectId) {
      toast.error('Pick a deploy project first (use the dropdown in the chat header).');
      return;
    }
    if (!window.confirm(
      `Update the LIVE app?\n\n• Commits ${openFile.path} to ${info?.branch || 'main'}\n• Deploys the project\n• Promotes the preview to production\n\nThis ships changes to real users.`
    )) return;

    // 1) Commit the file ──────────────────────────────────────────
    setUpdating('commit');
    let newSha = openFile.sha;
    try {
      const { data } = await api.put('/operator/self/file', {
        path: openFile.path,
        content: draft,
        sha: openFile.sha,
        message: commitMsg || `update-app: ${openFile.path.split('/').pop()}`,
      });
      newSha = data.new_sha;
      setOpenFile((cur) => (cur ? { ...cur, sha: newSha } : cur));
      toast.success('Step 1/3 — committed to GitHub');
    } catch (e) {
      toast.error(`Commit failed: ${e?.response?.data?.detail || e.message}`);
      setUpdating(null);
      return;
    }

    // 2) Deploy ──────────────────────────────────────────────────
    setUpdating('deploy');
    let deploymentUrl = '';
    try {
      const { data } = await api.post(`/operator/deploy/${projectId}/deploy`, {
        target: 'production',
        bypass_review: true,
      });
      deploymentUrl = data?.url || data?.deployment_url || '';
      if (deploymentUrl) {
        const u = deploymentUrl.startsWith('http') ? deploymentUrl : `https://${deploymentUrl}`;
        setPreviewUrl(u);
        try { localStorage.setItem('tbc.inChat.lastPreviewUrl', u); } catch { /* ignore */ }
      }
      toast.success(`Step 2/3 — deploy queued${deploymentUrl ? ` · ${deploymentUrl}` : ''}`);
    } catch (e) {
      toast.error(`Deploy failed: ${e?.response?.data?.detail || e.message}`);
      setUpdating(null);
      return;
    }

    // 3) Promote ─────────────────────────────────────────────────
    setUpdating('promote');
    try {
      const { data } = await api.post(`/operator/deploy/${projectId}/promote`, {});
      const prodUrl = data?.production_url || data?.url || deploymentUrl;
      if (data?.already_production) {
        toast.success('Step 3/3 — already at production · update live');
      } else {
        toast.success(`Step 3/3 — promoted to production${prodUrl ? ` · ${prodUrl}` : ''}`);
      }
      if (prodUrl) {
        const u = prodUrl.startsWith('http') ? prodUrl : `https://${prodUrl}`;
        setPreviewUrl(u);
      }
    } catch (e) {
      toast.error(`Promote failed: ${e?.response?.data?.detail || e.message}`);
    } finally {
      setUpdating(null);
    }
  };

  const dirty = openFile && draft !== undefined && draft !== openFile.original && draft !== '';

  return (
    <div className="space-y-4" data-testid="sandbox-tab">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-base font-bold text-tbc-100">
            <FlaskConical className="h-4 w-4 text-tbc-300" />
            Live sandbox — edit &amp; deploy in one click
          </h3>
          <p className="mt-1 text-sm text-tbc-200/60">
            Browse the source on{' '}
            <code className="rounded bg-ink-950 px-1.5 py-0.5 text-tbc-100">{info?.repo || '…'}</code>
            {' '}@ <code className="rounded bg-ink-950 px-1.5 py-0.5 text-tbc-100">{info?.branch || 'main'}</code>.
            Saving commits to the branch — the GitHub webhook then redeploys automatically. Pair with{' '}
            <strong>Auto-promote</strong> for a true one-click ship.
          </p>
        </div>
        {previewUrl && (
          <PreviewReadyPill url={previewUrl} onDismiss={() => setPreviewUrl('')} />
        )}
      </div>

      <div className="rounded-md border border-amber-500/30 bg-amber-500/[0.05] p-2 text-[11px] text-amber-200">
        <AlertTriangle className="mr-1 inline h-3 w-3" />
        Saves go straight to production-tracked branches. Use a draft branch in <em>self_git_ref</em> if
        you want a staging-style workflow before shipping.
      </div>

      {/* AI panel — always visible so the affordance is discoverable
          even before the operator opens a file. Internally guards on
          `openFile` and shows a friendly banner until then. */}
      <SandboxAIPanel
        openFile={openFile}
        draft={draft}
        branch={info?.branch}
        onApplyToEditor={(content) => setDraft(content)}
      />

      <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
        {/* Tree */}
        <div className="rounded-lg border border-tbc-900/60 bg-ink-900/60 p-2" data-testid="sandbox-tree">
          <div className="flex items-center justify-between border-b border-tbc-900/60 px-1 pb-1.5">
            <button
              type="button"
              onClick={goUp}
              disabled={loadingTree || !cwd}
              className="inline-flex items-center gap-1 text-[11px] font-semibold text-tbc-300 hover:text-tbc-100 disabled:opacity-40"
              data-testid="sandbox-up"
            >
              <ChevronLeft className="h-3 w-3" /> Up
            </button>
            <span className="truncate font-mono text-[10px] text-tbc-200/60">/{cwd}</span>
          </div>
          {(info?.editable_paths || []).length > 0 && (
            <div className="border-b border-tbc-900/60 px-1 py-1.5">
              <div className="text-[9px] uppercase tracking-wider text-tbc-200/40">Roots</div>
              <div className="flex flex-wrap gap-1 pt-1">
                {info.editable_paths.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => loadTree(p.replace(/\/$/, ''))}
                    className="rounded bg-ink-950 px-1.5 py-0.5 font-mono text-[10px] text-tbc-200 hover:bg-tbc-500/15 hover:text-tbc-100"
                    data-testid={`sandbox-root-${p.replace(/\W/g, '-')}`}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
          )}
          {loadingTree ? (
            <div className="grid place-items-center py-10">
              <Loader2 className="h-4 w-4 animate-spin text-tbc-400" />
            </div>
          ) : (
            <ul className="max-h-[420px] overflow-y-auto py-1">
              {tree.length === 0 && (
                <li className="px-2 py-2 text-[11px] text-tbc-200/50">Empty.</li>
              )}
              {tree.map((e) => (
                <li key={e.path}>
                  <button
                    type="button"
                    onClick={() => openEntry(e)}
                    data-testid={`sandbox-entry-${e.path}`}
                    className={`flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11px] hover:bg-ink-950 ${
                      openFile?.path === e.path ? 'bg-tbc-500/15 text-tbc-100' : 'text-tbc-200'
                    }`}
                  >
                    {e.type === 'dir'
                      ? <FolderOpen className="h-3 w-3 text-tbc-300" />
                      : <FileCode2 className="h-3 w-3 text-tbc-200/60" />}
                    <span className="truncate">{e.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Editor */}
        <div className="space-y-2 rounded-lg border border-tbc-900/60 bg-ink-900/60 p-3">
          {!openFile ? (
            <div className="grid h-72 place-items-center text-center text-xs text-tbc-200/50">
              Pick a file in the tree to start editing.
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate font-mono text-[11px] text-tbc-100">{openFile.path}</div>
                  <div className="text-[10px] text-tbc-200/40">sha: <code>{openFile.sha?.slice(0, 8)}</code></div>
                </div>
                {openFile.html_url && (
                  <a
                    href={openFile.html_url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-[10px] text-tbc-300 hover:text-tbc-100"
                  >
                    GitHub <ExternalLink className="h-2.5 w-2.5" />
                  </a>
                )}
              </div>
              <Textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={20}
                data-testid="sandbox-editor"
                spellCheck={false}
                className="font-mono text-[11px] leading-snug bg-ink-950 border-tbc-900/60 text-tbc-100"
              />
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  placeholder="Commit message"
                  value={commitMsg}
                  onChange={(e) => setCommitMsg(e.target.value)}
                  data-testid="sandbox-commit-message"
                  className="min-w-[180px] flex-1 bg-ink-950 border-tbc-900/60 text-tbc-100"
                />
                <Button
                  variant="outline"
                  onClick={save}
                  disabled={saving || !!updating}
                  data-testid="sandbox-save-deploy"
                  className="border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950 shrink-0"
                >
                  {saving
                    ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    : <Save className="mr-1.5 h-4 w-4" />}
                  Save commit
                </Button>
                <Button
                  onClick={updateApp}
                  disabled={saving || !!updating}
                  data-testid="sandbox-update-app"
                  className="bg-emerald-500 text-ink-950 hover:bg-emerald-400 font-bold shrink-0"
                >
                  {updating
                    ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    : <Sparkles className="mr-1.5 h-4 w-4" />}
                  {updating === 'commit'  ? 'Committing…'
                    : updating === 'deploy'  ? 'Deploying…'
                    : updating === 'promote' ? 'Promoting…'
                    : 'Update app'}
                </Button>
              </div>
              <p className="text-[10px] text-tbc-200/40">
                <Rocket className="mr-0.5 inline h-2.5 w-2.5" />
                <strong className="text-tbc-200">Save commit</strong> writes to GitHub and lets your
                webhook + auto-promote do their job.{' '}
                <strong className="text-emerald-300">Update app</strong> commits, deploys, and promotes in one
                shot — the change is on prod in ~30 seconds. {dirty ? 'You have unsaved changes.' : null}
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

import React, { useCallback, useEffect, useState } from 'react';
import { Rocket, Loader2, ExternalLink, RefreshCw, Wand2 } from 'lucide-react';
import { toast } from 'sonner';
import api from '../../lib/api';

const withHttps = (u) => (u && !/^https?:\/\//i.test(u) ? `https://${u}` : u);

/**
 * Emergent-style, per-chat Deploy control.
 *
 * The first click turns THIS chat into a live app: the backend
 * (`POST /chat/sessions/:id/deploy`) auto-creates a private GitHub repo,
 * commits the app built from the conversation, creates a git-linked Vercel
 * project, deploys to production, and links the session ↔ deploy project.
 *
 * Once linked, the same button becomes:
 *   • "Live"        → opens the deployed URL
 *   • "Redeploy"    → re-ships the linked project
 *   • "Push edits"  → sends the last chat instruction to
 *                     `POST /chat/sessions/:id/apply`, which reads the repo,
 *                     lets the AI edit the files, commits, and redeploys —
 *                     overwriting the live app.
 *
 * Rendered for operators (the app owner). Regular users keep the existing
 * request-access flow in `InChatDeployControls`.
 */
export function ChatDeployButton({ user, sessionId, messages = [] }) {
  const [status, setStatus] = useState(null); // {linked, deploy_url, state, repo_url}
  const [busy, setBusy] = useState(null); // 'deploy' | 'apply' | null

  const isOperator = user?.role === 'operator';

  const loadStatus = useCallback(async () => {
    if (!sessionId) { setStatus(null); return; }
    try {
      const { data } = await api.get(`/chat/sessions/${sessionId}/deploy`);
      setStatus(data);
    } catch {
      setStatus(null);
    }
  }, [sessionId]);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  if (!isOperator || !sessionId) return null;

  const runDeploy = async (promptOverride) => {
    setBusy('deploy');
    const t = toast.loading(
      status?.linked ? 'Redeploying your live app…' : 'Building & deploying your app… (~30-60s)',
    );
    try {
      const body = promptOverride ? { prompt: promptOverride } : {};
      const { data } = await api.post(`/chat/sessions/${sessionId}/deploy`, body);
      toast.dismiss(t);
      toast.success(data?.message || 'Deployed', {
        description: data?.deploy_url ? withHttps(data.deploy_url) : undefined,
        action: data?.deploy_url
          ? { label: 'Open', onClick: () => window.open(withHttps(data.deploy_url), '_blank') }
          : undefined,
        duration: 10000,
      });
      await loadStatus();
    } catch (e) {
      toast.dismiss(t);
      const detail = e?.response?.data?.detail;
      // The conversation doesn't describe an app yet — collect a one-liner
      // and retry, instead of dead-ending the operator.
      const needSpec = e?.response?.status === 422
        && detail && typeof detail === 'object' && detail.error === 'no_build_spec';
      if (needSpec && !promptOverride) {
        const spec = window.prompt(
          'In one line, what should this app be?\n(e.g. "A booking page for my barbershop with a contact form")',
          '',
        );
        if (spec && spec.trim()) return runDeploy(spec.trim());
        return;
      }
      const msg = (detail && typeof detail === 'object' && detail.message) || detail || 'Deploy failed';
      toast.error(typeof msg === 'string' ? msg : 'Deploy failed');
    } finally {
      setBusy(null);
    }
  };

  const pushEdits = async () => {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    let instruction = (lastUser?.content || '').trim();
    if (!instruction) {
      instruction = (window.prompt('What change should I make to the live app?', '') || '').trim();
    }
    if (!instruction) return;
    setBusy('apply');
    const t = toast.loading('Applying your change to the live app…');
    try {
      const { data } = await api.post(`/chat/sessions/${sessionId}/apply`, { instruction });
      toast.dismiss(t);
      if (!data?.changed?.length) {
        toast.message(data?.notes || 'No changes were needed.');
      } else {
        toast.success(data?.message || `Updated ${data.changed.length} file(s)`, {
          description: data?.deploy_url ? withHttps(data.deploy_url) : undefined,
          duration: 9000,
        });
      }
      await loadStatus();
    } catch (e) {
      toast.dismiss(t);
      const detail = e?.response?.data?.detail;
      const msg = (detail && typeof detail === 'object' && detail.message) || detail || 'Update failed';
      toast.error(typeof msg === 'string' ? msg : 'Update failed');
    } finally {
      setBusy(null);
    }
  };

  // Not yet deployed → single primary "Deploy this app" button.
  if (!status?.linked) {
    return (
      <button
        type="button"
        data-testid="chat-deploy-btn"
        onClick={() => runDeploy()}
        disabled={busy === 'deploy'}
        className="inline-flex items-center gap-1.5 rounded-lg border border-tbc-500/50 bg-tbc-500/15 px-2.5 py-1.5 text-xs font-semibold text-tbc-100 hover:bg-tbc-500/25 disabled:opacity-60"
        title="Turn this chat into a live app"
      >
        {busy === 'deploy'
          ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
          : <Rocket className="h-3.5 w-3.5" />}
        {busy === 'deploy' ? 'Deploying…' : 'Deploy this app'}
      </button>
    );
  }

  // Deployed → Live link + Redeploy + Push edits.
  const liveUrl = withHttps(status.domain || status.deploy_url);
  return (
    <div className="inline-flex items-center gap-1.5" data-testid="chat-deploy-live">
      {liveUrl && (
        <a
          href={liveUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-700/60 bg-emerald-500/10 px-2.5 py-1.5 text-xs font-semibold text-emerald-200 hover:bg-emerald-500/20"
          title={liveUrl}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
          Live
          <ExternalLink className="h-3 w-3" />
        </a>
      )}
      <button
        type="button"
        data-testid="chat-redeploy-btn"
        onClick={() => runDeploy()}
        disabled={!!busy}
        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs font-semibold text-slate-100 hover:bg-slate-800 disabled:opacity-60"
        title="Re-ship the current code"
      >
        {busy === 'deploy'
          ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
          : <RefreshCw className="h-3.5 w-3.5" />}
        Redeploy
      </button>
      <button
        type="button"
        data-testid="chat-pushedits-btn"
        onClick={pushEdits}
        disabled={!!busy}
        className="inline-flex items-center gap-1.5 rounded-lg border border-tbc-500/50 bg-tbc-500/15 px-2.5 py-1.5 text-xs font-semibold text-tbc-100 hover:bg-tbc-500/25 disabled:opacity-60"
        title="Apply your latest chat instruction to the live app"
      >
        {busy === 'apply'
          ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
          : <Wand2 className="h-3.5 w-3.5" />}
        Push edits
      </button>
    </div>
  );
}

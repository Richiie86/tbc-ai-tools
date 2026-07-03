import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import api from '../../../../lib/api';

/**
 * Custom hook that owns every interactive handler for a single deploy
 * project row: deploy/preview/redeploy, health check, code review,
 * download, clone, promote-to-prod, auto-promote toggle, ship-gate
 * recovery, and copy-URL. Lifted out of ProjectRow.jsx (Feb 2026) so
 * the JSX file stays under 400 lines and the handlers are independently
 * testable.
 *
 * Returns the union of internal state + callbacks the row needs. Some
 * pieces (e.g. `promoteOpen`, `cloneOpen`) are pure UI state that the
 * caller passes straight back into shadcn dialogs — keeping them in the
 * hook avoids duplicating useState in the consumer.
 */
export function useProjectActions(project, onDeployed) {
  const navigate = useNavigate();

  // 'deploy'|'preview'|'redeploy'|'health'|'clone'|'review'|'download'|'promote'|'auto-promote'
  const [busy, setBusy] = useState(null);
  const [health, setHealth] = useState(null);
  const [copied, setCopied] = useState(false);
  const [review, setReview] = useState(project.last_code_review || null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [promoteOpen, setPromoteOpen] = useState(false);
  const [autopilotOpen, setAutopilotOpen] = useState(false);
  // When the backend ship-gate fires (HTTP 412), we stash the failing
  // review + seeded fix-chat id here so the dialog can offer
  // "Open fix chat" / "Bypass and ship anyway" without re-fetching.
  const [gateBlock, setGateBlock] = useState(null);

  // Normalise a raw host or full URL into a clickable `https://…` URL.
  // Replaces the previous nested ternary so the intent reads top-down.
  const ensureHttps = (raw) => {
    if (!raw) return null;
    return raw.startsWith('http') ? raw : `https://${raw}`;
  };

  const previewUrl = ensureHttps(project.last_deployment_url);
  const domainUrl = ensureHttps(project.domain);
  const copyableUrl = previewUrl || domainUrl;

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
      setGateBlock(null);
      // 503 "Vercel token not configured" → offer a one-click jump to
      // the Ops tab where the operator pastes the PAT, instead of just
      // toasting the bare error and leaving them to navigate.
      const errMsg = typeof detail === 'string'
        ? detail
        : `Deploy failed${status ? ` (HTTP ${status})` : ''}`;
      if (status === 503 && errMsg.toLowerCase().includes('vercel token not configured')) {
        toast.error(errMsg, {
          duration: 12000,
          action: {
            label: 'Configure now',
            onClick: () => navigate('/operator?tab=ops'),
          },
        });
      } else {
        toast.error(errMsg);
      }
    }
  };

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
        return;
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

  // --- one-click initial push (NEW) -----------------------------------
  // Sends the live /app/{backend,frontend} source to this project's
  // configured GitHub repo via /api/operator/deploy/{id}/initial-push.
  // Operator's primary use-case is unblocking a fresh empty repo without
  // having to go to github.com, but it's also useful for force-pushing
  // local changes that haven't been committed via "Save to GitHub" yet.
  const pushInitial = async () => {
    setBusy('push');
    try {
      const { data } = await api.post(`/operator/deploy/${project.id}/initial-push`, {});
      const errs = (data?.errors || []).length;
      if (data?.pushed > 0) {
        toast.success(
          `Pushed ${data.pushed} file${data.pushed === 1 ? '' : 's'} → ${data.repo}@${data.branch}`
          + (errs ? ` (${errs} error${errs === 1 ? '' : 's'})` : ''),
          { duration: 8000 },
        );
        onDeployed();
      } else {
        toast.error(`Push completed but 0 files uploaded · ${errs} error${errs === 1 ? '' : 's'}`);
      }
    } catch (e) {
      const detail = e?.response?.data?.detail;
      const status = e?.response?.status;
      const msg = typeof detail === 'string'
        ? detail
        : (detail?.message || `Push failed${status ? ` (HTTP ${status})` : ''}`);
      toast.error(msg, { duration: 10000 });
    } finally {
      setBusy(null);
    }
  };

  // --- promote-to-prod (separate from runDeploy to avoid the gate path) ---
  // Driven by an AlertDialog (no window.confirm). Caller opens the dialog
  // by flipping `promoteOpen`; this runs once the dialog's confirm is hit.
  const promote = async () => {
    if (!project.last_deployment_id) {
      toast.error('No preview deployment to promote — run a Preview first.');
      return;
    }
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
      setPromoteOpen(false);
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

  // --- manual rollback to last known-good deployment ------------------
  // Re-promotes the last deployment that was successfully promoted, so a
  // broken production deploy can be recovered in one click.
  const rollback = async () => {
    if (!project.last_good_deployment_id) {
      toast.error('No known-good deployment yet — promote a working deploy first.');
      return;
    }
    setBusy('rollback');
    try {
      const { data } = await api.post(`/operator/deploy/${project.id}/rollback`, {});
      toast.success(`Rolled back to last known-good deployment · ${data?.restored_deployment_id || ''}`);
      onDeployed();
    } catch (e) {
      const detail = e?.response?.data?.detail;
      toast.error(typeof detail === 'string' ? detail : 'Rollback failed');
    } finally {
      setBusy(null);
    }
  };

  // --- auto-rollback toggle (PATCH /api/operator/deploy/{id}) ----------
  // When ON, a deploy that fails (ERROR/CANCELED) auto-restores the last
  // known-good deployment so a broken build can't silently persist.
  const toggleAutoRollback = async (next) => {
    setBusy('auto-rollback');
    try {
      await api.patch(`/operator/deploy/${project.id}`, { auto_rollback: next });
      toast.success(
        next
          ? 'Auto-rollback ON · failed deploys auto-restore the last known-good version'
          : 'Auto-rollback OFF'
      );
      onDeployed();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not toggle auto-rollback');
    } finally {
      setBusy(null);
    }
  };

  // --- self-healing toggle (PATCH /api/operator/deploy/{id}) -----------
  // When ON, autopilot runs `auto_fix_max_iterations=3` by default for
  // this project so the AI silently fixes do_not_ship verdicts and reships.
  const toggleAutoHeal = async (next) => {
    setBusy('auto-heal');
    try {
      await api.patch(`/operator/deploy/${project.id}`, { auto_heal: next });
      toast.success(
        next
          ? 'Self-healing ON · AI will auto-fix failed reviews and reship (up to 3 iterations)'
          : 'Self-healing OFF'
      );
      onDeployed();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not toggle self-healing');
    } finally {
      setBusy(null);
    }
  };

  // --- ship-gate recovery ----------------------------------------------
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

  return {
    // state
    busy, health, copied, review, reviewOpen, cloneOpen, promoteOpen,
    autopilotOpen, gateBlock,
    // urls
    previewUrl, domainUrl, copyableUrl,
    // setters (for dialogs)
    setReviewOpen, setCloneOpen, setPromoteOpen, setAutopilotOpen, setGateBlock,
    // actions
    trigger, promote, toggleAutoPromote, toggleAutoHeal, pushInitial,
    rollback, toggleAutoRollback,
    openFixChat, bypassAndShip, submitClone, copyUrl,
  };
}

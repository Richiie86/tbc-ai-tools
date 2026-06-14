import { useCallback } from 'react';
import { toast } from 'sonner';
import api from '../../lib/api';

/**
 * Extracted from `Dashboard.jsx` to keep that file under control. Owns
 * all the in-chat quick-action wiring: Deploy, Code Review, Health Check,
 * Fix Errors. Returns a single `handleInlineAction(kind)` callback the
 * chat message bubbles + the End-of-Session bar both call.
 *
 * Why a hook (not a plain helper):
 *   - We need stable references via `useCallback` so the message bubbles
 *     don't re-render on every dashboard state change.
 *   - The handler uses `navigate` + `messages` + `currentId` from the
 *     parent component; keeping it next to those values in a hook makes
 *     the dependency surface explicit.
 *
 * The behaviour is byte-for-byte identical to the previous inline
 * version — no behaviour change, only a relocation.
 */
export function useInlineChatActions({ navigate, messages, currentId }) {
  return useCallback(async (kind) => {
    // `fix-errors` deep-links to AI Build (which has its own project
    // picker) — no need to enforce projectId here. The other actions
    // hit `/operator/deploy/{id}/*` and DO need a project selected.
    if (kind === 'fix-errors') {
      const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
      const body = (lastAssistant?.content || '').slice(0, 2_000);
      const prompt =
        'Fix the issue described by the assistant in this chat:\n\n'
        + body
        + '\n\nKeep the change minimal and behaviour-preserving.';
      const params = new URLSearchParams({
        tab: 'ai-build',
        prefill_prompt: prompt,
        prefill_error_id: `chat_${currentId || 'session'}`,
      });
      navigate(`/operator?${params.toString()}`);
      return;
    }
    let projectId = '';
    try { projectId = localStorage.getItem('tbc.inChat.selectedProjectId') || ''; } catch { /* ignore */ }
    if (!projectId) {
      toast.error('Pick a deploy project first (use the dropdown in the chat header).');
      return;
    }

    // Internal helper so we can re-run /deploy with bypass_review=true
    // when the operator overrides the AI code review gate without
    // duplicating the success/failure handling.
    const runDeploy = async (bypass) => {
      const { data } = await api.post(`/operator/deploy/${projectId}/deploy`, bypass ? { bypass_review: true } : {});
      toast.success(`Deploy queued — ${data?.url || data?.deployment_id || 'OK'}`);
    };

    // Auto cross-AI review before the deploy fires. Operator requested
    // "deploy auto-runs the testing agent for all AIs" — we surface the
    // review verdict in-chat first so they see it, then chain into the
    // actual deploy if green. The backend's own 412 gate is still in
    // place as a hard backstop; this just adds visibility + a chance to
    // open the fix chat without spending a deploy attempt.
    const previewReview = async () => {
      const t = toast.loading('Running cross-AI code review…');
      try {
        const { data } = await api.post(`/operator/deploy/${projectId}/code-review`, {});
        toast.dismiss(t);
        const v = data?.verdict;
        const second = data?.second_opinion;
        const promotedBy = data?.verdict_promoted_by;
        if (v === 'do_not_ship') {
          const msg = `Review blocked deploy.\n\n`
            + `Primary verdict: ${v}\n`
            + (data?.summary ? `Summary: ${data.summary}\n` : '')
            + (second && second.verdict !== 'review_skipped'
                ? `Second opinion (${second.reviewer_model || 'cross-AI'}): ${second.verdict}\n`
                + (second.summary ? `  ${second.summary}\n` : '')
                + (second.concerns?.length ? `  • ${second.concerns.slice(0,3).join('\n  • ')}\n` : '')
                : '')
            + (promotedBy === 'second_opinion' ? `⚠ Block escalated by the second reviewer.\n` : '')
            + `\nType one:\n  fix   → open the AI fix chat\n  force → deploy anyway\n  (blank) → cancel`;
          const choice = (window.prompt(msg, 'fix') || '').trim().toLowerCase();
          if (choice === 'force') {
            try { await runDeploy(true); } catch (e2) {
              toast.error(e2?.response?.data?.detail?.message || e2?.response?.data?.detail || 'Forced deploy failed');
            }
          }
          return false;
        }
        const note = v === 'ship_with_concerns' || v === 'ship_with_fixes'
          ? `Review: ${v}${second?.concerns?.length ? ` · ${second.concerns.length} cross-AI concern${second.concerns.length === 1 ? '' : 's'}` : ''}`
          : `Review: ${v || 'ok'}`;
        toast.success(note);
        return true;
      } catch (_e) {
        toast.dismiss(t);
        // Reviewer 503/502 — don't block the operator, let the backend's own
        // hard 412 gate fire if needed.
        toast.message('Review unavailable — running deploy directly');
        return true;
      }
    };

    try {
      if (kind === 'deploy') {
        // Auto-run the cross-AI review FIRST. If it blocks, previewReview
        // handles the fix/force prompt itself (and may have already fired
        // the deploy with bypass=true). If it passes, we proceed.
        const ok = await previewReview();
        if (!ok) return;
        await runDeploy(false);
      } else if (kind === 'review') {
        const t = toast.loading('Running cross-AI code review…');
        const { data } = await api.post(`/operator/deploy/${projectId}/code-review`, {});
        toast.dismiss(t);
        const v = data?.verdict || 'completed';
        const second = data?.second_opinion;
        const lines = [
          `Verdict: ${v}`,
          data?.summary ? `Summary: ${data.summary}` : '',
          second && second.verdict !== 'review_skipped'
            ? `Cross-AI (${second.reviewer_model || 'second'}): ${second.verdict}` : '',
          second?.summary ? `  ${second.summary}` : '',
          second?.concerns?.length ? `Concerns:\n  • ${second.concerns.join('\n  • ')}` : '',
          data?.verdict_promoted_by === 'second_opinion'
            ? '⚠ Block escalated by the second reviewer.' : '',
        ].filter(Boolean).join('\n');
        window.alert(lines || 'Review completed');
      } else if (kind === 'health') {
        const t = toast.loading('Running health check…');
        const { data } = await api.post(`/operator/deploy/${projectId}/healthcheck`, {});
        toast.dismiss(t);
        const okText = data?.ok ? 'OK' : 'FAILED';
        const lines = [
          `Health check: ${data?.status || okText}`,
          data?.url ? `URL: ${data.url}` : '',
          data?.http_status ? `HTTP: ${data.http_status}` : '',
          data?.latency_ms ? `Latency: ${data.latency_ms}ms` : '',
          data?.detail ? `Detail: ${data.detail}` : '',
        ].filter(Boolean).join('\n');
        window.alert(lines || `Health: ${okText}`);
      }
    } catch (e) {
      // Specialised handling for the AI code-review ship-gate (412).
      // The backend returns a structured body — surface it as actionable
      // choices instead of a raw red toast saying "pass bypass_review=true".
      const detail = e?.response?.data?.detail;
      const isReviewBlock = e?.response?.status === 412
        && detail && typeof detail === 'object'
        && detail.error === 'review_blocked';
      if (kind === 'deploy' && isReviewBlock) {
        const findings = detail.review?.findings || [];
        const summary = detail.review?.summary || '';
        const second = detail.review?.second_opinion;
        const promotedBy = detail.review?.verdict_promoted_by;
        const fixSession = detail.fix_chat_session_id;
        const choice = window.prompt(
          `AI code review blocked this production deploy.\n\n`
          + (summary ? `Summary: ${summary}\n` : '')
          + (findings.length ? `Findings: ${findings.length}\n` : '')
          + (second && second.verdict !== 'review_skipped'
            ? `Cross-AI second opinion (${second.reviewer_model || 'second model'}): ${second.verdict}`
              + (second.summary ? ` — ${second.summary}` : '') + '\n'
              + (second.concerns?.length ? `  • ${second.concerns.slice(0,3).join('\n  • ')}\n` : '')
            : '')
          + (promotedBy === 'second_opinion'
            ? `⚠ Block escalated by the second reviewer (primary said ship).\n` : '')
          + `\nType one and press OK:\n`
          + `  fix   → open the AI fix chat\n`
          + `  force → deploy anyway (override the gate)\n`
          + `  (blank) → cancel`,
          'fix',
        );
        const c = (choice || '').trim().toLowerCase();
        if (c === 'force') {
          try {
            await runDeploy(true);
          } catch (e2) {
            toast.error(e2?.response?.data?.detail?.message || e2?.response?.data?.detail || 'Forced deploy failed');
          }
        } else if (c === 'fix' && fixSession) {
          navigate(`/dashboard/${fixSession}`);
        }
        return;
      }
      // Generic path: detail may be a string OR a structured object.
      const msg = (detail && typeof detail === 'object' && detail.message) || detail || `Quick ${kind} failed`;
      toast.error(typeof msg === 'string' ? msg : `Quick ${kind} failed`);
    }
  }, [navigate, messages, currentId]);
}

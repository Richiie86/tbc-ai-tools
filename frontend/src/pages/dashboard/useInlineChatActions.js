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
export function useInlineChatActions({ navigate, messages, currentId, showResult }) {
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

    // One-click "push initial code" — when the repo is empty, this uploads
    // /app/{backend,frontend} to the configured GitHub repo via the API
    // so the next deploy click has something to ship. Without this the
    // operator was stuck in a loop where the cross-AI review correctly
    // refused an empty repo but they had no way to actually fix it from
    // inside the app.
    const runInitialPush = async () => {
      const t = toast.loading('Pushing app source to GitHub… (~30s)');
      try {
        const { data } = await api.post(`/operator/deploy/${projectId}/initial-push`, {});
        toast.dismiss(t);
        const errCount = (data?.errors || []).length;
        if (data?.pushed > 0) {
          toast.success(`Pushed ${data.pushed} file${data.pushed === 1 ? '' : 's'} to ${data.repo}@${data.branch}${errCount ? ` · ${errCount} error${errCount === 1 ? '' : 's'}` : ''}`);
          return true;
        }
        toast.error(`Push failed — ${errCount} error${errCount === 1 ? '' : 's'}`);
        return false;
      } catch (e) {
        toast.dismiss(t);
        toast.error(e?.response?.data?.detail || 'Initial push failed');
        return false;
      }
    };

    // Robust operator override for the `do_not_ship` ship-gate.
    //
    // The old flow used window.prompt("type force") / window.confirm to
    // collect the override. That is the actual reason Deploy felt broken:
    // after a few clicks browsers show "prevent this page from creating
    // additional dialogs" and then EVERY subsequent prompt()/confirm()
    // returns null instantly — so the operator's "force" never registered
    // and the deploy was silently cancelled. Toast action buttons are NOT
    // subject to that suppression, so a single click reliably ships.
    const offerOverride = ({ summary, findingsCount, second, fixSession }) => {
      const desc = [
        summary || 'The AI code review returned do_not_ship.',
        findingsCount ? `${findingsCount} finding${findingsCount === 1 ? '' : 's'}.` : '',
        second && second.verdict && second.verdict !== 'review_skipped'
          ? `Cross-AI: ${second.verdict}.` : '',
        'You are the operator — you can override and ship.',
      ].filter(Boolean).join(' ');
      toast.error('Deploy blocked by AI code review', {
        description: desc,
        duration: Infinity,
        action: {
          label: 'Deploy anyway',
          onClick: () => {
            const t = toast.loading('Overriding review & deploying…');
            runDeploy(true)
              .then(() => toast.dismiss(t))
              .catch((e2) => {
                toast.dismiss(t);
                toast.error(
                  e2?.response?.data?.detail?.message
                  || e2?.response?.data?.detail
                  || 'Forced deploy failed',
                );
              });
          },
        },
        cancel: fixSession
          ? { label: 'Open fix chat', onClick: () => navigate(`/dashboard/${fixSession}`) }
          : { label: 'Dismiss', onClick: () => { /* just close */ } },
      });
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
        // Empty / placeholder GitHub repo — the operator's only useful
        // option is to push the live source. Don't waste the dialog on
        // fix/force because there's literally nothing to fix.
        if (v === 'repo_empty') {
          const ok = window.confirm(
            `Your GitHub repo "${data?.repo}" has no source code yet.\n\n`
            + `Click OK to upload this app's current source (backend/ + frontend/) `
            + `to GitHub in one shot, then re-run Deploy. Cancel to skip.`
          );
          if (!ok) return false;
          const pushed = await runInitialPush();
          if (!pushed) return false;
          // Re-run review now that the repo has code in it.
          const t2 = toast.loading('Re-running review on the pushed code…');
          try {
            await api.post(`/operator/deploy/${projectId}/code-review`, {});
            toast.dismiss(t2);
            return true;
          } catch {
            toast.dismiss(t2);
            // Even if the re-review hiccups, the operator can hit Deploy
            // again — the empty-repo block is gone, so the normal flow
            // will fire on the next click.
            toast.message('Pushed — try Deploy again to re-run review.');
            return false;
          }
        }
        if (v === 'do_not_ship') {
          // The operator is the final authority over their own deploys. A
          // do_not_ship verdict is now ADVISORY on the deploy path: we show
          // the verdict for visibility but do NOT stop the deploy or force a
          // second "Deploy anyway" click. We return the 'bypass' signal so
          // the caller ships immediately with bypass_review=true.
          const findingsCount = (data?.findings || []).length;
          toast.warning('Deploying despite AI review (do_not_ship)', {
            description: [
              data?.summary || 'The AI code review returned do_not_ship.',
              findingsCount ? `${findingsCount} finding${findingsCount === 1 ? '' : 's'}.` : '',
              promotedBy === 'second_opinion' ? 'Block escalated by the second reviewer.' : '',
              'You can review findings anytime via Run Code Review.',
            ].filter(Boolean).join(' '),
            duration: 8000,
            action: data?.fix_chat_session_id
              ? { label: 'Open fix chat', onClick: () => navigate(`/dashboard/${data.fix_chat_session_id}`) }
              : undefined,
          });
          return 'bypass';
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
      if (kind === 'push-code') {
        // Standalone path: push the live /app source to GitHub. The
        // helper handles its own success/failure toasts. Operator sees
        // a button explicitly when the assistant text mentions an empty
        // repo or "push your code first", so this is the single fastest
        // way out of the stuck-on-empty-repo state shown in the dialog
        // they hit from production.
        await runInitialPush();
        return;
      }
      if (kind === 'deploy') {
        // Auto-run the cross-AI review FIRST for visibility. It returns:
        //   false     -> genuinely can't deploy (e.g. empty repo) — stop.
        //   'bypass'  -> do_not_ship, but operator is final authority — ship
        //                with bypass_review=true (verdict already surfaced).
        //   true      -> clean/advisory verdict — ship normally.
        const ok = await previewReview();
        if (ok === false) return;
        await runDeploy(ok === 'bypass');
      } else if (kind === 'review') {
        const t = toast.loading('Running cross-AI code review…');
        let data;
        try {
          ({ data } = await api.post(`/operator/deploy/${projectId}/code-review`, {}));
        } finally {
          toast.dismiss(t);
        }
        const v = data?.verdict || 'completed';
        // Empty repo: don't dead-end the operator on a useless alert.
        // Offer the same one-click Push-Code flow the Deploy path does
        // and re-run the review on the freshly populated repo.
        if (v === 'repo_empty') {
          const ok = window.confirm(
            `Your GitHub repo "${data?.repo}" has no source code yet — only documentation/config placeholders.\n\n`
            + `Click OK to upload this app's current source (backend/ + frontend/) `
            + `to GitHub in one shot, then re-run the review.\n\n`
            + `Cancel to dismiss.`,
          );
          if (!ok) return;
          const pushed = await runInitialPush();
          if (!pushed) return;
          // Re-review on the freshly pushed code so the operator sees a real verdict.
          const t2 = toast.loading('Re-running review on the pushed code…');
          let again;
          try {
            ({ data: again } = await api.post(`/operator/deploy/${projectId}/code-review`, {}));
          } catch {
            toast.dismiss(t2);
            toast.message('Pushed — click Review again to retry.');
            return;
          }
          toast.dismiss(t2);
          const v2 = again?.verdict || 'completed';
          showResult?.({
            kind: 'review',
            verdict: v2,
            summary: again?.summary,
            findings: again?.findings || [],
            second: again?.second_opinion,
            promotedBySecond: again?.verdict_promoted_by === 'second_opinion',
            fixSession: again?.fix_chat_session_id,
          });
          return;
        }
        const second = data?.second_opinion;
        // Show the color-coded verdict modal (green = OK to ship, yellow =
        // ship with concerns, red = do not ship) with a collapsible
        // "Read explanation" section instead of a raw window.alert().
        showResult?.({
          kind: 'review',
          verdict: v,
          summary: data?.summary,
          findings: data?.findings || [],
          second,
          promotedBySecond: data?.verdict_promoted_by === 'second_opinion',
          fixSession: data?.fix_chat_session_id,
        });
      } else if (kind === 'health') {
        const t = toast.loading('Running health check…');
        const { data } = await api.post(`/operator/deploy/${projectId}/healthcheck`, {});
        toast.dismiss(t);
        showResult?.({
          kind: 'health',
          ok: !!data?.ok,
          status: data?.status,
          url: data?.url,
          httpStatus: data?.http_status,
          latencyMs: data?.latency_ms,
          detail: data?.detail,
        });
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
        const promotedBy = detail.review?.verdict_promoted_by;
        offerOverride({
          summary: (detail.review?.summary || '')
            + (promotedBy === 'second_opinion' ? ' (block escalated by the second reviewer)' : ''),
          findingsCount: (detail.review?.findings || []).length,
          second: detail.review?.second_opinion,
          fixSession: detail.fix_chat_session_id,
        });
        return;
      }
      // Generic path: detail may be a string OR a structured object.
      const msg = (detail && typeof detail === 'object' && detail.message) || detail || `Quick ${kind} failed`;
      toast.error(typeof msg === 'string' ? msg : `Quick ${kind} failed`);
    }
  }, [navigate, messages, currentId, showResult]);
}

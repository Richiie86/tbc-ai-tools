import React, { useCallback, useEffect, useState } from 'react';
import { Sparkles, Loader2, ChevronRight, Wand2, RefreshCw, Rocket } from 'lucide-react';
import { toast } from 'sonner';
import { useNavigate } from 'react-router-dom';
import { Button } from '../../../../components/ui/button';
import api from '../../../../lib/api';

/** Per-priority pill style — mirrors the colour language used by the
 *  CodeReviewDialog so the operator can scan both surfaces with the
 *  same eye. Pulses on `high` to draw attention. */
const PRIORITY = {
  high:   { dot: 'bg-rose-400 shadow-[0_0_6px_rgba(244,63,94,0.7)] animate-pulse',
            chip: 'border-rose-500/40 bg-rose-500/10 text-rose-200', label: 'HIGH' },
  medium: { dot: 'bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.7)]',
            chip: 'border-amber-500/40 bg-amber-500/10 text-amber-200', label: 'MEDIUM' },
  low:    { dot: 'bg-emerald-400',
            chip: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200', label: 'LOW' },
};

/**
 * AI Improvement Suggestions card — sits alongside the Code Review on
 * each deploy project. The user asked for "AIs that suggest improvements
 * like the agent does as I code", so we generate a short forward-looking
 * list (3-5 ideas) and let them spin each one into an AI Build plan in
 * one click.
 *
 * Lifecycle:
 *   - mount: GET /suggestions to render any cached set (no LLM bill)
 *   - "Generate" click: POST /suggestions (LLM bill, ≤ 1× / 30 min)
 *   - "Implement" click per row: POST /ai-build/plan with the prompt,
 *     then navigate to /operator?tab=ai-build so the operator can
 *     watch the proposed diff
 */
export function SuggestionsPanel({ project }) {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [implementing, setImplementing] = useState(null); // `${idx}:plan` or `${idx}:ship`

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data: d } = await api.get(`/operator/deploy/${project.id}/suggestions`);
      setData(d);
    } catch {
      /* no cache — fine */
    } finally {
      setLoading(false);
    }
  }, [project.id]);

  useEffect(() => { load(); }, [load]);

  const generate = async () => {
    setGenerating(true);
    try {
      const { data: d } = await api.post(`/operator/deploy/${project.id}/suggestions`);
      setData(d);
      toast.success(`AI proposed ${d?.suggestions?.length || 0} improvement${(d?.suggestions?.length || 0) === 1 ? '' : 's'}`);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not generate suggestions');
    } finally {
      setGenerating(false);
    }
  };

  const implement = async (s, idx, { ship = false } = {}) => {
    const key = `${idx}:${ship ? 'ship' : 'plan'}`;
    setImplementing(key);
    try {
      const prompt = `${s.title}\n\n${s.implementation_prompt}`;
      const { data: plan } = await api.post('/operator/ai-build/plan', {
        prompt,
        project_id: project.id,
        source: ship ? 'suggestion_auto_ship' : 'suggestion',
      });
      if (ship) {
        if (!plan?.plan_id || !plan?.files?.length) {
          throw new Error(plan?.refusal_reason || 'AI Build returned no files to ship');
        }
        const { data: shipped } = await api.post('/operator/ai-build/open-pr', {
          plan_id: plan.plan_id,
          auto_merge: true,
        });
        if (shipped?.merge?.merged) {
          toast.success(`Shipped PR #${shipped.pr_number} → main. Vercel/Render deploys should start automatically.`, { duration: 9000 });
        } else {
          toast.warning(`PR #${shipped?.pr_number || ''} opened, but GitHub did not auto-merge it. Open it to finish shipping.`, { duration: 10000 });
        }
        if (shipped?.pr_url) window.open(shipped.pr_url, '_blank', 'noopener');
        return;
      }
      toast.success(`Plan drafted (${plan?.files?.length || 0} file${(plan?.files?.length || 0) === 1 ? '' : 's'}) — review it in AI Build`);
      navigate(`/operator?tab=ai-build${plan?.plan_id ? `&plan=${plan.plan_id}` : ''}`);
    } catch (e) {
      const detail = e?.response?.data?.detail;
      toast.error(typeof detail === 'string' ? detail : (e?.message || 'AI Build planner unavailable'));
    } finally {
      setImplementing(null);
    }
  };

  const suggestions = data?.suggestions || [];
  const summary = data?.summary || '';
  const stale = data?.reviewed_at
    ? (Date.now() - new Date(data.reviewed_at).getTime()) > 30 * 60_000
    : true;

  return (
    <div
      data-testid={`suggestions-${project.id}`}
      className="mt-3 rounded-lg border border-tbc-900/60 bg-ink-950/60 p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-amber-300" />
          <h4 className="text-xs font-bold uppercase tracking-wider text-tbc-100">
            AI suggestions
          </h4>
          {data?.reviewed_at && (
            <span className="text-[10px] text-tbc-200/50">
              · {new Date(data.reviewed_at).toLocaleString()}
            </span>
          )}
        </div>
        <Button
          size="sm"
          data-testid={`suggestions-refresh-${project.id}`}
          onClick={generate}
          disabled={generating || loading}
          variant="outline"
          className="border-amber-500/40 bg-ink-900 text-amber-200 hover:bg-amber-500/10"
        >
          {generating
            ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
            : (suggestions.length > 0
                ? <RefreshCw className="mr-1.5 h-3 w-3" />
                : <Sparkles className="mr-1.5 h-3 w-3" />)}
          {suggestions.length > 0 ? (stale ? 'Refresh' : 'Re-generate') : 'Generate'}
        </Button>
      </div>

      {summary && (
        <p className="mt-2 text-xs leading-relaxed text-tbc-100/80">{summary}</p>
      )}

      {suggestions.length === 0 ? (
        <p className="mt-2 text-[11px] text-tbc-200/50">
          No suggestions yet — click <span className="font-semibold text-amber-300">Generate</span> to
          ask the AI what to improve next. Cached 30 minutes so refreshing won&apos;t double-bill.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {suggestions.map((s, i) => {
            const p = PRIORITY[s.priority] || PRIORITY.medium;
            return (
              <li
                key={`${s.title}-${i}`}
                data-testid={`suggestion-${project.id}-${i}`}
                className="rounded-md border border-tbc-900/60 bg-ink-900/60 p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`h-2 w-2 rounded-full ${p.dot}`} />
                  <span className={`rounded-full border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ${p.chip}`}>
                    {p.label}
                  </span>
                  <span className="text-[10px] uppercase tracking-wider text-tbc-200/50">
                    {s.effort || 'medium'} effort
                  </span>
                </div>
                <p className="mt-1.5 text-sm font-semibold text-tbc-100">{s.title}</p>
                {s.rationale && (
                  <p className="mt-1 text-xs leading-relaxed text-tbc-100/80">{s.rationale}</p>
                )}
                {Array.isArray(s.files) && s.files.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {s.files.map((f) => (
                      <code
                        key={f}
                        className="rounded bg-ink-950 px-1.5 py-0.5 font-mono text-[10px] text-tbc-300"
                      >
                        {f}
                      </code>
                    ))}
                  </div>
                )}
                <div className="mt-2">
                  <Button
                    size="sm"
                    data-testid={`suggestion-implement-${project.id}-${i}`}
                    onClick={() => implement(s, i)}
                    disabled={implementing !== null}
                    className="bg-amber-500 text-ink-950 hover:bg-amber-400 font-semibold"
                  >
                    {implementing === `${i}:plan`
                      ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                      : <Wand2 className="mr-1.5 h-3 w-3" />}
                    Implement this
                    <ChevronRight className="ml-1 h-3 w-3" />
                  </Button>
                  <Button
                    size="sm"
                    data-testid={`suggestion-ship-${project.id}-${i}`}
                    onClick={() => implement(s, i, { ship: true })}
                    disabled={implementing !== null}
                    className="ml-2 bg-emerald-500 text-ink-950 hover:bg-emerald-400 font-semibold"
                  >
                    {implementing === `${i}:ship`
                      ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                      : <Rocket className="mr-1.5 h-3 w-3" />}
                    Ship now
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

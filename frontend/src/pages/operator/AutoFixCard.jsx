import React, { useCallback, useEffect, useState } from 'react';
import api from '../../lib/api';
import { Button } from '../../components/ui/button';
import { Switch } from '../../components/ui/switch';
import { Input } from '../../components/ui/input';
import { toast } from 'sonner';
import { Sparkles, Loader2, AlertTriangle, ExternalLink, Play } from 'lucide-react';

/**
 * Autonomous Auto-Fix Loop — operator opt-in. When enabled, the
 * scheduler picks up new critical runtime errors every 5 minutes and:
 *
 *  1. Calls AI Build /plan with the error + RCA.
 *  2. Cross-AI reviews; only opens a PR if BOTH reviewers say `ship`.
 *  3. (optional) Auto-merges the PR once GitHub checks come back clean.
 *
 * Hard caps live server-side (per_day_cap, per_tick_cap) so a runaway
 * loop can't flood the repo. Master kill-switch is the `enabled` toggle.
 */
export default function AutoFixCard() {
  const [cfg, setCfg] = useState(null);
  const [projects, setProjects] = useState([]);
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [c, s, p] = await Promise.all([
        api.get('/operator/auto-fix/config'),
        api.get('/operator/auto-fix/status'),
        api.get('/operator/deploy/projects'),
      ]);
      setCfg(c.data);
      setStatus(s.data);
      setProjects(p.data?.projects || p.data || []);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Failed to load auto-fix config');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const save = async (patch) => {
    if (!cfg) return;
    const next = { ...cfg, ...patch };
    if (next.enabled && !next.project_id) {
      toast.error('Pick a default project first');
      return;
    }
    setSaving(true);
    try {
      const { data } = await api.put('/operator/auto-fix/config', next);
      setCfg(data);
      toast.success('Auto-fix config saved');
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const runNow = async () => {
    setRunning(true);
    try {
      const { data } = await api.post('/operator/auto-fix/run-now');
      const msg = `Processed ${data.processed || 0} · PR opened ${data.opened || 0}${data.merged ? ` · Merged ${data.merged}` : ''}${data.skipped_capped ? ' · skipped (capped)' : ''}`;
      toast.success(msg);
      load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Run failed');
    } finally {
      setRunning(false);
    }
  };

  if (loading || !cfg) {
    return (
      <div className="grid place-items-center py-8" data-testid="auto-fix-loading">
        <Loader2 className="h-4 w-4 animate-spin text-tbc-300" />
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="auto-fix-card">
      <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/[0.04] p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h4 className="flex items-center gap-2 text-sm font-bold text-tbc-100">
              <Sparkles className="h-4 w-4 text-emerald-300" />
              Autonomous Auto-Fix Loop
            </h4>
            <p className="mt-0.5 text-[11px] text-tbc-200/60">
              Critical errors → AI Build /plan → cross-AI review → PR opened automatically.
              Runs every 5 minutes. Capped + kill-switched.
            </p>
          </div>
          <Switch
            checked={cfg.enabled}
            onCheckedChange={(v) => save({ enabled: v })}
            disabled={saving}
            data-testid="auto-fix-enabled-toggle"
          />
        </div>

        {/* Warning if no github_token (server-side check is more accurate
            but this gives early UX feedback). */}
        {cfg.enabled && (
          <p className="mt-2 text-[10px] text-amber-300/80">
            <AlertTriangle className="mr-1 inline h-3 w-3 -mt-0.5" />
            Requires <code>github_token</code> + <code>emergent_llm_key</code> in Security above.
          </p>
        )}

        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="text-[10px] uppercase tracking-wider text-tbc-300">Default project</label>
            <select
              value={cfg.project_id || ''}
              onChange={(e) => save({ project_id: e.target.value })}
              disabled={saving}
              data-testid="auto-fix-project"
              className="mt-1 block w-full rounded-md border border-tbc-900/60 bg-ink-950 px-3 py-2 text-sm text-tbc-100"
            >
              <option value="">— pick a project —</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{`${p.projectName} · ${p.repo}`}</option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] uppercase tracking-wider text-tbc-300">PRs / day cap</label>
              <Input
                type="number" min={0} max={50} value={cfg.per_day_cap}
                onChange={(e) => setCfg({ ...cfg, per_day_cap: Number(e.target.value) })}
                onBlur={() => save({ per_day_cap: cfg.per_day_cap })}
                data-testid="auto-fix-day-cap"
                className="mt-1 border-tbc-900/60 bg-ink-950 text-tbc-100 text-sm"
              />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider text-tbc-300">PRs / tick</label>
              <Input
                type="number" min={1} max={10} value={cfg.per_tick_cap}
                onChange={(e) => setCfg({ ...cfg, per_tick_cap: Number(e.target.value) })}
                onBlur={() => save({ per_tick_cap: cfg.per_tick_cap })}
                data-testid="auto-fix-tick-cap"
                className="mt-1 border-tbc-900/60 bg-ink-950 text-tbc-100 text-sm"
              />
            </div>
          </div>
        </div>

        <div className="mt-3 flex items-center justify-between rounded border border-rose-500/30 bg-rose-500/[0.04] px-3 py-2">
          <div>
            <div className="text-[12px] font-semibold text-rose-200">Auto-merge to production</div>
            <p className="text-[10px] text-rose-200/60">
              Once both reviewers say ship AND GH checks pass clean, merge the PR.
              <strong className="text-rose-200"> Deploys to prod automatically.</strong>
            </p>
          </div>
          <Switch
            checked={cfg.auto_merge}
            onCheckedChange={(v) => save({ auto_merge: v })}
            disabled={saving || !cfg.enabled}
            data-testid="auto-fix-automerge-toggle"
          />
        </div>

        <div className="mt-3 flex items-center justify-between rounded border border-amber-500/30 bg-amber-500/[0.04] px-3 py-2">
          <div>
            <div className="text-[12px] font-semibold text-amber-200">Include health-check sweep</div>
            <p className="text-[10px] text-amber-200/60">
              Probe each project's public URL every 5 min; if it fails,
              queue a fix PR with the failure logs pre-loaded.
            </p>
          </div>
          <Switch
            checked={cfg.include_health}
            onCheckedChange={(v) => save({ include_health: v })}
            disabled={saving || !cfg.enabled}
            data-testid="auto-fix-health-toggle"
          />
        </div>

        {/* New: auto-push the live /app source whenever a deploy project's
            configured GitHub repo is empty (verdict='repo_empty'). Opt-in
            because it WRITES to the operator's GitHub repo without
            human confirmation. */}
        <div className="mt-3 flex items-start justify-between gap-3 border-t border-emerald-500/20 pt-3">
          <div className="grow">
            <p className="text-xs font-semibold text-tbc-100">
              Auto-push to empty repos
            </p>
            <p className="mt-0.5 text-[11px] text-tbc-200/60">
              If a project&apos;s GitHub repo has no code, automatically push
              <code className="mx-1 rounded bg-ink-950 px-1 font-mono text-[10px] text-tbc-300">/app</code>
              source so the next deploy ships. Only fires when the project also has
              <span className="font-bold text-amber-300"> auto-heal</span> on.
            </p>
          </div>
          <Switch
            checked={cfg.auto_push_empty_repo || false}
            onCheckedChange={(v) => save({ auto_push_empty_repo: v })}
            disabled={saving}
            data-testid="auto-fix-push-empty-toggle"
          />
        </div>

        {/* New: run pytest against /app/backend/tests after every PR opens
            and gate auto-merge on a green run. Adds ~2 min per fix. */}
        <div className="mt-3 flex items-start justify-between gap-3 border-t border-emerald-500/20 pt-3">
          <div className="grow">
            <p className="text-xs font-semibold text-tbc-100">
              Run tests automatically
            </p>
            <p className="mt-0.5 text-[11px] text-tbc-200/60">
              Run the pytest suite after every AI-Build PR and block auto-merge
              if it fails. The AIs &quot;double-check their own code&quot; the
              same way the agent does while coding.
            </p>
          </div>
          <Switch
            checked={cfg.auto_run_tests || false}
            onCheckedChange={(v) => save({ auto_run_tests: v })}
            disabled={saving}
            data-testid="auto-fix-run-tests-toggle"
          />
        </div>

        <div className="mt-3 flex items-center justify-between border-t border-emerald-500/20 pt-3">
          <div className="text-[10px] text-tbc-200/60">
            Today: {status?.today_count || 0} / {cfg.per_day_cap} PRs · runs every 5 min
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={runNow}
            disabled={running || !cfg.enabled}
            data-testid="auto-fix-run-now"
            className="h-7 border-emerald-500/40 bg-emerald-500/[0.06] text-emerald-200 hover:bg-emerald-500/[0.12]"
          >
            {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <><Play className="mr-1 h-3 w-3" />Run now</>}
          </Button>
        </div>
      </div>

      {status?.recent?.length > 0 && (
        <div className="rounded-lg border border-tbc-900/60 bg-ink-900/40 p-3">
          <div className="text-[10px] uppercase tracking-wider text-tbc-300">Recent auto-fix activity</div>
          <ul className="mt-2 space-y-1" data-testid="auto-fix-recent">
            {status.recent.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-2 text-[11px]">
                <span className="flex min-w-0 items-center gap-1.5">
                  {r.kind === 'drift' && (
                    <span className="shrink-0 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[9px] uppercase text-amber-300">drift</span>
                  )}
                  <span className="truncate text-tbc-100">{(r.message || '').slice(0, 80)}</span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <span className={`rounded px-1.5 py-0.5 text-[9px] uppercase ${r.auto_fix_outcome === 'pr_opened' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300'}`}>
                    {r.auto_fix_outcome || '?'}
                  </span>
                  {r.auto_fix_pr_url && (
                    <a href={r.auto_fix_pr_url} target="_blank" rel="noreferrer" className="text-tbc-300 hover:text-tbc-100">
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

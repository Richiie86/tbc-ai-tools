import React, { useCallback, useEffect, useState } from 'react';
import api from '../../lib/api';
import { Button } from '../../components/ui/button';
import { toast } from 'sonner';
import {
  TestTube, Loader2, CheckCircle2, XCircle, Zap, RefreshCw, Play,
} from 'lucide-react';

/**
 * AI Test Bench — per-model health + regression checks.
 *
 * Each card shows a quick at-a-glance: pass/fail dot, avg latency, last
 * run time. Click "Run probes" to re-test that model; or use "Run all"
 * to test every model in parallel.
 *
 * The backend (`ai_test_bench_ext.py`) runs three probes per model:
 *   1. health      — non-empty reply to "say pong"
 *   2. arithmetic  — deterministic 17+25=42 check
 *   3. learnings   — verifies model still respects the operator's most
 *                    recent active learning (skipped if none exist)
 */
export default function AITestBenchTab() {
  const [models, setModels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(null); // model_id currently running, or 'all'

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/operator/ai-tests/models');
      setModels(data.models || []);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Failed to load models');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const _runOneInner = async (modelId) => {
    try {
      const { data } = await api.post(`/operator/ai-tests/run/${modelId}`);
      setModels((cur) => cur.map((m) => (m.id === modelId ? { ...m, last_test: data } : m)));
      // Distinguish "all green" from "core probes pass but regression
      // probe didn't echo the learning" — the latter is informational,
      // not an outage.
      const failed = (data.probes || []).filter((p) => !p.pass);
      const onlyLearningsFail = failed.length === 1 && failed[0].name === 'learnings';
      if (data.pass) {
        toast.success(`${modelId}: PASS · ${data.avg_latency_ms}ms`);
      } else if (onlyLearningsFail) {
        toast.info(`${modelId}: partial · regression probe didn't echo learning · ${data.avg_latency_ms}ms`);
      } else {
        toast.error(`${modelId}: FAIL · ${failed.map((p) => p.name).join(', ')}`);
      }
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Probe failed');
    } finally {
      setRunning(null);
    }
  };
  const runOne = (modelId) => {
    setRunning(modelId);
    _runOneInner(modelId);
  };

  const _runAllInner = async () => {
    try {
      const { data } = await api.post('/operator/ai-tests/run-all');
      setModels(data.models || []);
      const passed = (data.models || []).filter((m) => m.last_test?.pass).length;
      const total = (data.models || []).length;
      toast[passed === total ? 'success' : 'info'](
        `${passed}/${total} models passing`,
      );
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Batch run failed');
    } finally {
      setRunning(null);
    }
  };
  const runAll = () => {
    setRunning('all');
    _runAllInner();
  };

  if (loading) {
    return (
      <div className="grid place-items-center py-16" data-testid="ai-tests-loading">
        <Loader2 className="h-5 w-5 animate-spin text-tbc-400" />
      </div>
    );
  }

  const passing = models.filter((m) => m.last_test?.pass).length;
  const tested  = models.filter((m) => m.last_test).length;

  return (
    <div className="space-y-5" data-testid="ai-tests-tab">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-base font-bold text-tbc-100">
            <TestTube className="h-4 w-4 text-tbc-300" />
            AI Test Bench — automated health checks for every chat model
          </h3>
          <p className="mt-1 text-sm text-tbc-200/60">
            Runs three probes per model: a smoke ping, a deterministic
            arithmetic check, and a regression test against your most
            recent approved learning. Detects provider outages, latency
            drift, and learning-injection regressions in one click.
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {tested > 0 && (
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-wider text-tbc-200/40">Passing</div>
              <div className={`text-2xl font-bold ${passing === tested ? 'text-emerald-300' : 'text-amber-300'}`}>
                {passing}<span className="text-tbc-200/40">/{tested}</span>
              </div>
            </div>
          )}
          <Button
            onClick={runAll}
            disabled={running !== null}
            data-testid="ai-tests-run-all"
            className="bg-tbc-500 text-ink-950 hover:bg-tbc-400 font-bold"
          >
            {running === 'all'
              ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Running all…</>
              : <><Play className="mr-1.5 h-4 w-4" />Run all</>}
          </Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {models.map((m) => (
          <ModelCard
            key={m.id}
            model={m}
            running={running === m.id || running === 'all'}
            onRun={() => runOne(m.id)}
          />
        ))}
      </div>
    </div>
  );
}

function ModelCard({ model, running, onRun }) {
  const t = model.last_test;
  // Three states: clean pass, hard fail (something fundamental broke),
  // partial (only the learnings regression probe didn't echo the keyword).
  let status = 'idle';
  if (t) {
    if (t.pass) status = 'pass';
    else {
      const failed = (t.probes || []).filter((p) => !p.pass);
      const onlyLearningsFail = failed.length === 1 && failed[0].name === 'learnings';
      status = onlyLearningsFail ? 'partial' : 'fail';
    }
  }
  const StatusIcon = status === 'pass' ? CheckCircle2 : status === 'fail' ? XCircle : status === 'partial' ? Zap : TestTube;
  const colorRing =
    status === 'pass'    ? 'border-emerald-500/40' :
    status === 'fail'    ? 'border-red-500/50' :
    status === 'partial' ? 'border-amber-500/40' :
    'border-tbc-900/60';
  const colorAccent =
    status === 'pass'    ? 'text-emerald-300' :
    status === 'fail'    ? 'text-red-300' :
    status === 'partial' ? 'text-amber-300' :
    'text-tbc-200/50';
  return (
    <div
      data-testid={`ai-test-model-${model.id}`}
      className={`rounded-lg border bg-ink-900/50 p-3 transition-all ${colorRing}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-bold text-tbc-100">{model.display}</div>
          <div className="mt-0.5 text-[10px] text-tbc-200/40">
            {model.provider} · {model.id}
          </div>
        </div>
        <StatusIcon className={`h-4 w-4 shrink-0 ${colorAccent}`} />
      </div>

      <div className="mt-3 flex items-end justify-between">
        <div>
          {t ? (
            <>
              <div className="flex items-center gap-1 text-[11px] text-tbc-200/70">
                <Zap className="h-3 w-3" />
                {t.avg_latency_ms} ms avg
              </div>
              <div className="mt-0.5 text-[10px] text-tbc-200/40">
                {t.created_at ? new Date(t.created_at).toLocaleString() : '—'}
              </div>
            </>
          ) : (
            <div className="text-[11px] text-tbc-200/40">Not tested yet</div>
          )}
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={onRun}
          disabled={running}
          data-testid={`ai-test-run-${model.id}`}
          className="h-7 border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950 text-[11px]"
        >
          {running
            ? <Loader2 className="h-3 w-3 animate-spin" />
            : <><RefreshCw className="mr-1 h-3 w-3" />Run probes</>}
        </Button>
      </div>

      {t?.probes?.length > 0 && (
        <details className="mt-3 border-t border-tbc-900/40 pt-2">
          <summary className="cursor-pointer text-[10px] uppercase tracking-wider text-tbc-300 hover:text-tbc-100">
            Probes ({t.probes.length})
          </summary>
          <ul className="mt-1.5 space-y-1">
            {t.probes.map((p, i) => (
              <li
                key={`${p.name}-${i}`}
                data-testid={`ai-test-probe-${model.id}-${p.name}`}
                className="flex items-start gap-1.5 text-[10px]"
              >
                {p.pass
                  ? <CheckCircle2 className="h-3 w-3 mt-px shrink-0 text-emerald-300" />
                  : <XCircle className="h-3 w-3 mt-px shrink-0 text-red-300" />}
                <div className="flex-1 min-w-0">
                  <div className="text-tbc-100">{p.name} · {p.latency_ms}ms</div>
                  {p.error && (
                    <div className="text-red-300/80 truncate" title={p.error}>{p.error}</div>
                  )}
                  {p.response && !p.error && (
                    <div className="text-tbc-200/40 truncate" title={p.response}>
                      → {p.response}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

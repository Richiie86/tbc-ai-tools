import React, { useCallback, useEffect, useState } from 'react';
import api from '../../../lib/api';
import { Button } from '../../../components/ui/button';
import { toast } from 'sonner';
import { Repeat, Loader2, PlayCircle, Server } from 'lucide-react';

/**
 * HostingIncomePanel — recurring "keep it live" hosting revenue, shown in the
 * Income tab separately from one-off launches + plan revenue (it's credits,
 * not USD). Additive: mounted at the bottom of MoneyTab.
 */
export default function HostingIncomePanel() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/operator/money/hosting');
      setData(data);
    } catch {
      /* silent — this panel is supplementary */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const runNow = async () => {
    setRunning(true);
    try {
      const { data: res } = await api.post('/operator/money/hosting/run-now');
      const c = res?.counts || {};
      toast.message(`Billing sweep: ${c.charged || 0} charged · ${c.suspended || 0} suspended · ${c.free || 0} free`);
      load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Sweep failed');
    } finally {
      setRunning(false);
    }
  };

  if (!data) return null;

  const recent = data.recent || [];

  return (
    <section
      data-testid="income-hosting-panel"
      className="rounded-xl border border-cyan-500/25 bg-gradient-to-br from-cyan-500/[0.05] via-ink-900/60 to-ink-900/60 p-5"
    >
      <div className="mb-4 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-cyan-500/15 text-cyan-300">
            <Repeat className="h-4 w-4" />
          </span>
          <div>
            <h3 className="text-base font-bold text-tbc-100">Recurring hosting</h3>
            <p className="text-xs text-tbc-200/60">
              {data.fee_credits} credits every {data.period_days} days per live domain · charged from user credits.
            </p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={runNow}
          disabled={running || loading}
          data-testid="hosting-run-now"
          className="border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950"
        >
          {running
            ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            : <PlayCircle className="mr-1.5 h-3.5 w-3.5" />}
          Run billing now
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile value={data.active_subscriptions} label="Active domains" accent="text-emerald-300" />
        <Tile value={data.suspended_subscriptions} label="Suspended" accent="text-rose-300" />
        <Tile value={(data.credits_collected_total || 0).toLocaleString()} label="Credits collected" accent="text-cyan-300" />
        <Tile value={data.charge_count} label="Total charges" accent="text-tbc-50" />
      </div>

      {recent.length > 0 && (
        <div className="mt-4 space-y-1.5" data-testid="hosting-charges-list">
          {recent.slice(0, 8).map((r, idx) => (
            <div
              key={`${r.domain}-${idx}`}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-tbc-900/50 bg-ink-950/40 px-3 py-2 text-xs"
            >
              <span className="flex items-center gap-2 font-mono text-tbc-100">
                <Server className="h-3 w-3 text-cyan-300" />
                {r.domain}
              </span>
              <span className="flex items-center gap-3 text-tbc-200/60">
                {r.user_email && <span className="text-tbc-200/70">{r.user_email}</span>}
                <span className="text-cyan-300">{r.credits_charged} cr</span>
                {r.created_at && <span>{new Date(r.created_at).toLocaleDateString()}</span>}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function Tile({ value, label, accent }) {
  return (
    <div className="rounded-lg border border-tbc-900/60 bg-ink-950/50 px-4 py-3">
      <div className={`text-2xl font-bold ${accent}`}>{value}</div>
      <div className="text-xs text-tbc-200/60">{label}</div>
    </div>
  );
}

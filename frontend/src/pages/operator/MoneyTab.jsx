import React, { useCallback, useEffect, useState } from 'react';
import api from '../../lib/api';
import { Button } from '../../components/ui/button';
import { toast } from 'sonner';
import { Wallet, RefreshCw, Loader2, Globe } from 'lucide-react';

import { MoneyTiles } from './money/MoneyTiles';
import { ProviderBalances } from './money/ProviderBalances';
import { RevenueSparkline } from './money/RevenueSparkline';
import { RecentTransactions } from './money/RecentTransactions';
import { WithdrawSettings } from './money/WithdrawSettings';
import { WithdrawHistory } from './money/WithdrawHistory';
import HostingIncomePanel from './money/HostingIncomePanel';

export default function MoneyTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [withdrawSettings, setWithdrawSettings] = useState(null);
  const [withdrawHistory, setWithdrawHistory] = useState([]);
  const [savingWithdraw, setSavingWithdraw] = useState(false);
  const [runningCron, setRunningCron] = useState(false);
  const [domainsStat, setDomainsStat] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [r, s, h, d] = await Promise.all([
        api.get('/operator/money/dashboard'),
        api.get('/operator/withdraw/settings'),
        api.get('/operator/withdraw/history'),
        // Separate 'Domains' stat — kept out of revenue totals on purpose.
        api.get('/operator/money/domains').catch(() => ({ data: null })),
      ]);
      setData(r.data);
      setWithdrawSettings(s.data);
      setWithdrawHistory(h.data);
      setDomainsStat(d.data);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Failed to load money dashboard');
    } finally {
      setLoading(false);
    }
  }, []);

  const saveWithdrawSettings = async (patch) => {
    if (!withdrawSettings) return;
    const next = { ...withdrawSettings, ...patch };
    setWithdrawSettings(next);
    setSavingWithdraw(true);
    try {
      const payload = {
        autopay_stripe_enabled: !!next.autopay_stripe_enabled,
        autopay_stripe_threshold_usd: Number(next.autopay_stripe_threshold_usd || 0),
        autopay_stripe_daily_cap_usd: Number(next.autopay_stripe_daily_cap_usd || 0),
        autopay_nowpay_enabled: !!next.autopay_nowpay_enabled,
        autopay_nowpay_threshold_usd: Number(next.autopay_nowpay_threshold_usd || 0),
        autopay_nowpay_daily_cap: Number(next.autopay_nowpay_daily_cap || 0),
        autopay_nowpay_address: next.autopay_nowpay_address || null,
        autopay_nowpay_currency: next.autopay_nowpay_currency || null,
      };
      await api.put('/operator/withdraw/settings', payload);
      toast.success('Auto-withdraw settings saved');
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Save failed');
    } finally {
      setSavingWithdraw(false);
    }
  };

  const runWithdrawNow = async () => {
    setRunningCron(true);
    try {
      const { data: res } = await api.post('/operator/withdraw/cron');
      const summary =
        res.attempts
          .map((a) => `${a.provider}: ${a.status}${a.reason ? ` (${a.reason})` : ''}`)
          .join(' · ') || 'nothing to do';
      toast.message(`Auto-withdraw: ${summary}`);
      const h = await api.get('/operator/withdraw/history');
      setWithdrawHistory(h.data);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Cron failed');
    } finally {
      setRunningCron(false);
    }
  };

  useEffect(() => { load(); }, [load]);

  if (!data && loading) {
    return (
      <div className="grid place-items-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-tbc-400" />
      </div>
    );
  }
  if (!data) return null;

  const i = data.internal;
  const p = data.providers;

  return (
    <div className="grid gap-6" data-testid="money-tab">
      {/* HEADER */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-emerald-500/15 text-emerald-300">
            <Wallet className="h-4 w-4" />
          </span>
          <div>
            <h3 className="text-base font-bold text-tbc-100">Income</h3>
            <p className="text-xs text-tbc-200/60">
              Live balances across connected payment providers · internal revenue stats · domain launches.
            </p>
          </div>
        </div>
        <Button
          data-testid="money-refresh"
          onClick={load}
          disabled={loading}
          variant="outline"
          className="border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950"
        >
          {loading
            ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            : <RefreshCw className="mr-2 h-4 w-4" />}
          Refresh
        </Button>
      </div>

      <MoneyTiles internal={i} />
      <DomainsStat stat={domainsStat} />
      {/* NEW: recurring "keep it live" hosting revenue (credits), tracked
          separately from one-off launches + USD revenue. Additive. */}
      <HostingIncomePanel />
      <ProviderBalances providers={p} />
      <RevenueSparkline series={i.series_30d} />
      <RecentTransactions transactions={i.recent_transactions} />

      <section data-testid="money-withdrawals">
        <WithdrawSettings
          settings={withdrawSettings}
          onSave={saveWithdrawSettings}
          savingSettings={savingWithdraw}
          runningCron={runningCron}
          onRunNow={runWithdrawNow}
        />
        <WithdrawHistory history={withdrawHistory} />
      </section>
    </div>
  );
}

/**
 * Separate "Domains" stat — domain launches recorded when a user/operator
 * takes a project live on a custom domain. Deliberately shown apart from the
 * revenue tiles (it's credits, not USD) so it doesn't distort income totals.
 */
function DomainsStat({ stat }) {
  const count = stat?.count ?? 0;
  const credits = stat?.credits_total ?? 0;
  const perLaunch = stat?.cost_per_launch ?? 50;
  const launches = stat?.launches || [];

  return (
    <section
      data-testid="income-domains-stat"
      className="rounded-xl border border-sky-500/25 bg-gradient-to-br from-sky-500/[0.05] via-ink-900/60 to-ink-900/60 p-5"
    >
      <div className="mb-4 flex items-center gap-2">
        <span className="grid h-9 w-9 place-items-center rounded-lg bg-sky-500/15 text-sky-300">
          <Globe className="h-4 w-4" />
        </span>
        <div>
          <h3 className="text-base font-bold text-tbc-100">Domains</h3>
          <p className="text-xs text-tbc-200/60">
            Domain launches · {perLaunch} credits each · tracked separately from revenue.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-tbc-900/60 bg-ink-950/50 px-4 py-3">
          <div className="text-2xl font-bold text-tbc-50">{count}</div>
          <div className="text-xs text-tbc-200/60">Total launches</div>
        </div>
        <div className="rounded-lg border border-tbc-900/60 bg-ink-950/50 px-4 py-3">
          <div className="text-2xl font-bold text-sky-300">{credits.toLocaleString()}</div>
          <div className="text-xs text-tbc-200/60">Credits collected</div>
        </div>
        <div className="rounded-lg border border-tbc-900/60 bg-ink-950/50 px-4 py-3">
          <div className="text-2xl font-bold text-tbc-50">{perLaunch}</div>
          <div className="text-xs text-tbc-200/60">Credits / launch</div>
        </div>
      </div>

      {launches.length > 0 && (
        <div className="mt-4 space-y-1.5" data-testid="income-domains-list">
          {launches.slice(0, 8).map((l, idx) => (
            <div
              key={`${l.domain}-${idx}`}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-tbc-900/50 bg-ink-950/40 px-3 py-2 text-xs"
            >
              <span className="flex items-center gap-2 font-mono text-tbc-100">
                <Globe className="h-3 w-3 text-sky-300" />
                {l.domain}
              </span>
              <span className="flex items-center gap-3 text-tbc-200/60">
                {l.project_name && <span className="text-tbc-200/70">{l.project_name}</span>}
                <span className="text-sky-300">{l.credits_charged} cr</span>
                {l.created_at && (
                  <span>{new Date(l.created_at).toLocaleDateString()}</span>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

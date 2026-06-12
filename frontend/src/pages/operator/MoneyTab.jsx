import React, { useCallback, useEffect, useState } from 'react';
import api from '../../lib/api';
import { Button } from '../../components/ui/button';
import { toast } from 'sonner';
import { Wallet, RefreshCw, Loader2 } from 'lucide-react';

import { MoneyTiles } from './money/MoneyTiles';
import { ProviderBalances } from './money/ProviderBalances';
import { RevenueSparkline } from './money/RevenueSparkline';
import { RecentTransactions } from './money/RecentTransactions';
import { WithdrawSettings } from './money/WithdrawSettings';
import { WithdrawHistory } from './money/WithdrawHistory';

export default function MoneyTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [withdrawSettings, setWithdrawSettings] = useState(null);
  const [withdrawHistory, setWithdrawHistory] = useState([]);
  const [savingWithdraw, setSavingWithdraw] = useState(false);
  const [runningCron, setRunningCron] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [r, s, h] = await Promise.all([
        api.get('/operator/money/dashboard'),
        api.get('/operator/withdraw/settings'),
        api.get('/operator/withdraw/history'),
      ]);
      setData(r.data);
      setWithdrawSettings(s.data);
      setWithdrawHistory(h.data);
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
            <h3 className="text-base font-bold text-tbc-100">Money</h3>
            <p className="text-xs text-tbc-200/60">
              Live balances across connected payment providers · internal revenue stats.
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

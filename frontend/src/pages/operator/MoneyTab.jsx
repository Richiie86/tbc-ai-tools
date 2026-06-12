import React, { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../../lib/api';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Switch } from '../../components/ui/switch';
import { toast } from 'sonner';
import {
  Wallet, RefreshCw, Loader2, ArrowUpRight, AlertCircle,
  CheckCircle2, DollarSign, Coins, Activity, Clock, TrendingUp,
  Banknote, Power, Send,
} from 'lucide-react';

const fmt = (n, currency = 'USD') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(n ?? 0);

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
      const summary = res.attempts.map((a) => `${a.provider}: ${a.status}${a.reason ? ` (${a.reason})` : ''}`).join(' · ') || 'nothing to do';
      toast.message(`Auto-withdraw: ${summary}`);
      // Refresh history
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
            <p className="text-xs text-tbc-200/60">Live balances across connected payment providers · internal revenue stats.</p>
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

      {/* TOP TILES */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="money-tiles">
        <Tile icon={DollarSign} label="Total revenue" value={fmt(i.total_revenue_usd)} sub={`${i.total_paid_count} paid transactions`} tone="emerald" testid="money-tile-total" />
        <Tile icon={TrendingUp} label="Last 30 days" value={fmt(i.last_30d_revenue_usd)} sub={`${i.last_30d_count} payments`} tone="sky" testid="money-tile-30d" />
        <Tile icon={Clock} label="Pending manual" value={i.pending_manual_count} sub="awaiting review" tone="amber" testid="money-tile-pending" />
        <Tile icon={Activity} label="Methods (30d)" value={i.by_method_30d.length} sub={(i.by_method_30d[0]?.method || '—') + ' leads'} tone="violet" testid="money-tile-methods" />
      </div>

      {/* PROVIDER BALANCES */}
      <section>
        <h4 className="mb-2 text-xs font-bold uppercase tracking-wider text-tbc-200/60">Live provider balances</h4>
        <div className="grid gap-3 lg:grid-cols-3">
          <StripeCard data={p.stripe} />
          <PayPalCard data={p.paypal} />
          <CryptoCard data={p.nowpayments} />
        </div>
      </section>

      {/* CHART */}
      <section>
        <h4 className="mb-2 text-xs font-bold uppercase tracking-wider text-tbc-200/60">Revenue · last 30 days</h4>
        <RevenueSparkline series={i.series_30d} />
      </section>

      {/* RECENT TX */}
      <section>
        <h4 className="mb-2 text-xs font-bold uppercase tracking-wider text-tbc-200/60">Recent payments</h4>
        <div className="overflow-hidden rounded-xl border border-tbc-900/60 bg-ink-900/60">
          <table className="w-full text-sm" data-testid="money-recent-table">
            <thead className="bg-ink-950/60 text-[10px] uppercase tracking-wider text-tbc-200/50">
              <tr>
                <th className="px-4 py-2 text-left">When</th>
                <th className="px-4 py-2 text-left">Customer</th>
                <th className="px-4 py-2 text-left">Plan</th>
                <th className="px-4 py-2 text-left">Method</th>
                <th className="px-4 py-2 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {i.recent_transactions.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-xs text-tbc-200/50">No completed payments yet</td></tr>
              )}
              {i.recent_transactions.map((t) => (
                <tr key={t.id} className="border-t border-tbc-900/40">
                  <td className="px-4 py-2 text-xs text-tbc-200/70">{t.paid_at ? new Date(t.paid_at).toLocaleString() : '—'}</td>
                  <td className="px-4 py-2 text-tbc-100">{t.user_email}</td>
                  <td className="px-4 py-2"><span className="rounded bg-tbc-500/10 px-1.5 py-0.5 text-[10px] uppercase text-tbc-300">{t.plan_id}</span></td>
                  <td className="px-4 py-2 text-xs text-tbc-200/70">{t.method}</td>
                  <td className="px-4 py-2 text-right font-semibold text-emerald-300">{fmt(t.amount, (t.currency || 'usd').toUpperCase())}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* WITHDRAWALS */}
      <section data-testid="money-withdrawals">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h4 className="text-xs font-bold uppercase tracking-wider text-tbc-200/60">Auto-withdraw</h4>
            {savingWithdraw && <Loader2 className="h-3 w-3 animate-spin text-tbc-400" />}
          </div>
          <Button
            data-testid="withdraw-cron-run"
            onClick={runWithdrawNow}
            disabled={runningCron}
            variant="outline"
            className="border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950"
          >
            {runningCron
              ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              : <Send className="mr-2 h-4 w-4" />}
            Run sweep now
          </Button>
        </div>

        {withdrawSettings && (
          <div className="grid gap-3 lg:grid-cols-2">
            {/* Stripe row */}
            <div className="rounded-xl border border-tbc-900/60 bg-ink-900/60 p-4" data-testid="autopay-stripe">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="grid h-9 w-9 place-items-center rounded-lg bg-emerald-500/15 text-emerald-300">
                    <Banknote className="h-4 w-4" />
                  </span>
                  <div>
                    <div className="text-sm font-bold text-tbc-100">Stripe → Bank</div>
                    <div className="text-[11px] text-tbc-200/50">
                      {withdrawSettings.stripe_configured ? 'Pays out USD to your linked Stripe bank account' : 'Stripe key not configured'}
                    </div>
                  </div>
                </div>
                <Switch
                  data-testid="autopay-stripe-toggle"
                  disabled={!withdrawSettings.stripe_configured}
                  checked={!!withdrawSettings.autopay_stripe_enabled}
                  onCheckedChange={(v) => saveWithdrawSettings({ autopay_stripe_enabled: v })}
                />
              </div>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <Field label="Trigger threshold (USD)">
                  <Input
                    data-testid="autopay-stripe-threshold"
                    type="number" min="0" step="10"
                    className="bg-ink-950 border-tbc-900/60 text-tbc-100"
                    value={withdrawSettings.autopay_stripe_threshold_usd}
                    onChange={(e) => saveWithdrawSettings({ autopay_stripe_threshold_usd: e.target.value })}
                  />
                </Field>
                <Field label="Daily safety cap (USD)">
                  <Input
                    data-testid="autopay-stripe-cap"
                    type="number" min="0" step="50"
                    className="bg-ink-950 border-tbc-900/60 text-tbc-100"
                    value={withdrawSettings.autopay_stripe_daily_cap_usd}
                    onChange={(e) => saveWithdrawSettings({ autopay_stripe_daily_cap_usd: e.target.value })}
                  />
                </Field>
              </div>
              <CapProgress
                used={withdrawSettings.stripe_paid_24h_usd}
                cap={withdrawSettings.autopay_stripe_daily_cap_usd}
                format={(n) => `$${Number(n).toFixed(2)}`}
                testid="autopay-stripe-cap-bar"
              />
            </div>

            {/* NOWPayments row */}
            <div className="rounded-xl border border-tbc-900/60 bg-ink-900/60 p-4" data-testid="autopay-nowpay">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="grid h-9 w-9 place-items-center rounded-lg bg-violet-500/15 text-violet-300">
                    <Coins className="h-4 w-4" />
                  </span>
                  <div>
                    <div className="text-sm font-bold text-tbc-100">NOWPayments → Wallet</div>
                    <div className="text-[11px] text-tbc-200/50">
                      {withdrawSettings.nowpay_configured ? 'Auto-payout crypto to a single configured address' : 'NOWPayments key not configured'}
                    </div>
                  </div>
                </div>
                <Switch
                  data-testid="autopay-nowpay-toggle"
                  disabled={!withdrawSettings.nowpay_configured}
                  checked={!!withdrawSettings.autopay_nowpay_enabled}
                  onCheckedChange={(v) => saveWithdrawSettings({ autopay_nowpay_enabled: v })}
                />
              </div>
              <div className="mt-3 grid grid-cols-4 gap-3">
                <Field label="Currency">
                  <Input
                    data-testid="autopay-nowpay-currency"
                    className="bg-ink-950 border-tbc-900/60 text-tbc-100"
                    value={withdrawSettings.autopay_nowpay_currency || ''}
                    placeholder="btc / eth / usdttrc20"
                    onChange={(e) => saveWithdrawSettings({ autopay_nowpay_currency: e.target.value })}
                  />
                </Field>
                <Field label="Destination address">
                  <Input
                    data-testid="autopay-nowpay-address"
                    className="bg-ink-950 border-tbc-900/60 text-tbc-100 font-mono text-xs"
                    value={withdrawSettings.autopay_nowpay_address || ''}
                    placeholder="bc1q..."
                    onChange={(e) => saveWithdrawSettings({ autopay_nowpay_address: e.target.value })}
                  />
                </Field>
                <Field label="Threshold (asset)">
                  <Input
                    data-testid="autopay-nowpay-threshold"
                    type="number" min="0" step="0.001"
                    className="bg-ink-950 border-tbc-900/60 text-tbc-100"
                    value={withdrawSettings.autopay_nowpay_threshold_usd}
                    onChange={(e) => saveWithdrawSettings({ autopay_nowpay_threshold_usd: e.target.value })}
                  />
                </Field>
                <Field label="Daily cap (asset)">
                  <Input
                    data-testid="autopay-nowpay-cap"
                    type="number" min="0" step="0.001"
                    className="bg-ink-950 border-tbc-900/60 text-tbc-100"
                    value={withdrawSettings.autopay_nowpay_daily_cap}
                    onChange={(e) => saveWithdrawSettings({ autopay_nowpay_daily_cap: e.target.value })}
                  />
                </Field>
              </div>
              <CapProgress
                used={withdrawSettings.nowpay_paid_24h}
                cap={withdrawSettings.autopay_nowpay_daily_cap}
                format={(n) => `${Number(n).toFixed(4)} ${(withdrawSettings.autopay_nowpay_currency || '').toUpperCase()}`}
                testid="autopay-nowpay-cap-bar"
              />
            </div>
          </div>
        )}

        {/* History */}
        <div className="mt-4 overflow-hidden rounded-xl border border-tbc-900/60 bg-ink-900/60">
          <div className="border-b border-tbc-900/40 bg-ink-950/60 px-4 py-2 text-[10px] uppercase tracking-wider text-tbc-200/50">
            Withdrawal history
          </div>
          <table className="w-full text-sm" data-testid="withdraw-history-table">
            <thead className="text-[10px] uppercase tracking-wider text-tbc-200/50">
              <tr>
                <th className="px-4 py-2 text-left">When</th>
                <th className="px-4 py-2 text-left">Provider</th>
                <th className="px-4 py-2 text-left">Kind</th>
                <th className="px-4 py-2 text-left">Status</th>
                <th className="px-4 py-2 text-right">Amount</th>
                <th className="px-4 py-2 text-left">Detail</th>
              </tr>
            </thead>
            <tbody>
              {withdrawHistory.length === 0 && (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-xs text-tbc-200/50">No withdrawals yet</td></tr>
              )}
              {withdrawHistory.map((w) => (
                <tr key={w.id} className="border-t border-tbc-900/40">
                  <td className="px-4 py-2 text-xs text-tbc-200/70">{new Date(w.created_at).toLocaleString()}</td>
                  <td className="px-4 py-2 capitalize text-tbc-100">{w.provider}</td>
                  <td className="px-4 py-2 text-xs">
                    <span className={`rounded-full border px-2 py-0.5 text-[10px] uppercase ${w.kind === 'auto' ? 'border-violet-500/30 bg-violet-500/10 text-violet-300' : 'border-sky-500/30 bg-sky-500/10 text-sky-300'}`}>{w.kind}</span>
                  </td>
                  <td className="px-4 py-2 text-xs">
                    <span className={`rounded-full border px-2 py-0.5 text-[10px] uppercase ${
                      w.status === 'success' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                      : w.status === 'failed' ? 'border-rose-500/40 bg-rose-500/10 text-rose-300'
                      : 'border-amber-500/30 bg-amber-500/10 text-amber-300'}`}>{w.status}</span>
                  </td>
                  <td className="px-4 py-2 text-right font-semibold text-tbc-100">${Number(w.amount_usd || 0).toFixed(2)}</td>
                  <td className="px-4 py-2 text-[11px] text-tbc-200/70">{w.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <label className="text-[10px] font-semibold uppercase tracking-wider text-tbc-200/60">{label}</label>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function CapProgress({ used, cap, format, testid }) {
  const u = Math.max(0, Number(used || 0));
  const c = Math.max(0.0001, Number(cap || 0));
  const pct = Math.min(100, (u / c) * 100);
  const danger = pct >= 90;
  const warn = pct >= 60 && !danger;
  const bar = danger ? 'bg-rose-500' : warn ? 'bg-amber-400' : 'bg-emerald-500';
  return (
    <div className="mt-3" data-testid={testid}>
      <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-tbc-200/60">
        <span>24h auto-payouts</span>
        <span className={danger ? 'text-rose-300' : warn ? 'text-amber-300' : 'text-tbc-200/70'}>
          {format(u)} / {format(c)} · {pct.toFixed(0)}%
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-ink-950">
        <div className={`h-full transition-all ${bar}`} style={{ width: `${pct}%` }} />
      </div>
      {danger && (
        <div className="mt-1 text-[10px] text-rose-300">Cap reached — auto payouts paused until the 24h window rolls forward.</div>
      )}
    </div>
  );
}

// ============== TILES ==============
function Tile({ icon: Icon, label, value, sub, tone = 'emerald', testid }) {
  const tones = {
    emerald: 'border-emerald-500/30 bg-emerald-500/5 text-emerald-300',
    sky:     'border-sky-500/30 bg-sky-500/5 text-sky-300',
    amber:   'border-amber-500/30 bg-amber-500/5 text-amber-300',
    violet:  'border-violet-500/30 bg-violet-500/5 text-violet-300',
  };
  return (
    <div data-testid={testid} className={`rounded-xl border p-4 ${tones[tone]}`}>
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider opacity-80">{label}</span>
        <Icon className="h-4 w-4 opacity-70" />
      </div>
      <div className="mt-2 text-2xl font-extrabold text-tbc-50">{value}</div>
      <div className="mt-1 text-[11px] opacity-60">{sub}</div>
    </div>
  );
}

// ============== PROVIDER CARDS ==============
function ProviderShell({ name, icon: Icon, children, status, statusText, mode, footer }) {
  return (
    <div className="rounded-xl border border-tbc-900/60 bg-ink-900/60 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-tbc-500/15 text-tbc-300">
            <Icon className="h-4 w-4" />
          </span>
          <div>
            <div className="text-sm font-bold text-tbc-100">{name}</div>
            {mode && <div className="text-[10px] uppercase tracking-wider text-tbc-200/50">{mode}</div>}
          </div>
        </div>
        {status === 'ok' && <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-300"><CheckCircle2 className="h-3 w-3" /> Connected</span>}
        {status === 'warn' && <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-300"><AlertCircle className="h-3 w-3" /> Limited</span>}
        {status === 'off' && <span className="inline-flex items-center gap-1 rounded-full border border-tbc-900/60 bg-ink-950 px-2 py-0.5 text-[10px] text-tbc-200/60">Not connected</span>}
      </div>
      <div className="mt-3">{children}</div>
      {statusText && <div className="mt-2 text-[11px] text-tbc-200/50">{statusText}</div>}
      {footer}
    </div>
  );
}

function StripeCard({ data }) {
  if (!data?.connected) {
    return (
      <ProviderShell name="Stripe" icon={DollarSign} status="off" statusText={data?.reason}>
        <div className="text-xs text-tbc-200/60">Configure your Stripe secret key in <span className="text-tbc-100">Security</span> to see live balance.</div>
      </ProviderShell>
    );
  }
  return (
    <ProviderShell
      name="Stripe"
      icon={DollarSign}
      status="ok"
      mode={data.livemode ? 'Live mode' : 'Test mode'}
    >
      <div className="grid grid-cols-2 gap-3">
        <Balance label="Available" amount={data.available_usd} accent="emerald" testid="stripe-available" />
        <Balance label="Pending" amount={data.pending_usd} accent="amber" testid="stripe-pending" />
      </div>
      {data.instant_available_usd > 0 && (
        <div className="mt-2 text-[11px] text-tbc-200/70">
          Instant available: <span className="font-semibold text-tbc-100">{fmt(data.instant_available_usd)}</span>
        </div>
      )}
    </ProviderShell>
  );
}

function PayPalCard({ data }) {
  if (!data?.connected) {
    return (
      <ProviderShell name="PayPal" icon={ArrowUpRight} status="off" statusText={data?.reason}>
        <div className="text-xs text-tbc-200/60">Configure PayPal credentials in <span className="text-tbc-100">Security</span> to see balance.</div>
      </ProviderShell>
    );
  }
  if (data.balance_unavailable) {
    return (
      <ProviderShell name="PayPal" icon={ArrowUpRight} status="warn" mode={data.mode} statusText={data.reason}>
        <div className="text-xs text-tbc-200/70">PayPal connected. The Reporting/Balances API isn't enabled on this account, so we can't pull a live balance — but checkout works.</div>
      </ProviderShell>
    );
  }
  return (
    <ProviderShell name="PayPal" icon={ArrowUpRight} status="ok" mode={data.mode}>
      <Balance label="Available" amount={data.available_usd} accent="emerald" testid="paypal-available" />
      {data.as_of && (
        <div className="mt-2 text-[11px] text-tbc-200/50">As of {new Date(data.as_of).toLocaleString()}</div>
      )}
    </ProviderShell>
  );
}

function CryptoCard({ data }) {
  if (!data?.connected) {
    return (
      <ProviderShell name="NOWPayments" icon={Coins} status="off" statusText={data?.reason}>
        <div className="text-xs text-tbc-200/60">Configure NOWPayments key in <span className="text-tbc-100">Security</span> to see balances.</div>
      </ProviderShell>
    );
  }
  const assets = (data.assets || []).filter((a) => a.amount > 0 || a.pending > 0).slice(0, 6);
  return (
    <ProviderShell name="NOWPayments" icon={Coins} status="ok">
      {assets.length === 0 ? (
        <div className="text-xs text-tbc-200/60">No non-zero balances yet.</div>
      ) : (
        <div className="space-y-1">
          {assets.map((a) => (
            <div key={a.asset} className="flex items-center justify-between rounded-md bg-ink-950 px-2 py-1.5 text-xs">
              <span className="font-semibold text-tbc-100">{a.asset}</span>
              <span className="text-tbc-300">{a.amount.toFixed(6)}</span>
            </div>
          ))}
        </div>
      )}
    </ProviderShell>
  );
}

function Balance({ label, amount, accent = 'emerald', testid }) {
  const colour = accent === 'amber' ? 'text-amber-300' : 'text-emerald-300';
  return (
    <div data-testid={testid}>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-tbc-200/50">{label}</div>
      <div className={`mt-0.5 text-xl font-extrabold ${colour}`}>{fmt(amount)}</div>
    </div>
  );
}

// ============== SPARKLINE ==============
function RevenueSparkline({ series }) {
  const max = useMemo(() => Math.max(1, ...series.map((s) => s.revenue)), [series]);
  return (
    <div className="rounded-xl border border-tbc-900/60 bg-ink-900/60 p-4" data-testid="money-sparkline">
      <div className="flex h-32 items-end gap-1">
        {series.map((s) => {
          const pct = (s.revenue / max) * 100;
          return (
            <div
              key={s.date}
              className="group relative flex flex-1 flex-col items-center justify-end"
              title={`${s.date} · ${fmt(s.revenue)}`}
            >
              <div
                className="w-full rounded-t bg-gradient-to-t from-tbc-700/60 to-tbc-400 transition-all"
                style={{ height: `${Math.max(2, pct)}%` }}
              />
              <div className="pointer-events-none absolute -top-7 whitespace-nowrap rounded bg-ink-950 px-1.5 py-0.5 text-[10px] text-tbc-100 opacity-0 transition group-hover:opacity-100">
                {fmt(s.revenue)}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex justify-between text-[10px] text-tbc-200/50">
        <span>{series[0]?.date}</span>
        <span>{series[series.length - 1]?.date}</span>
      </div>
    </div>
  );
}

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../../lib/api';
import { Button } from '../../components/ui/button';
import { toast } from 'sonner';
import {
  Wallet, RefreshCw, Loader2, ArrowUpRight, AlertCircle,
  CheckCircle2, DollarSign, Coins, Activity, Clock, TrendingUp,
} from 'lucide-react';

const fmt = (n, currency = 'USD') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(n ?? 0);

export default function MoneyTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get('/operator/money/dashboard');
      setData(r.data);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Failed to load money dashboard');
    } finally {
      setLoading(false);
    }
  }, []);

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

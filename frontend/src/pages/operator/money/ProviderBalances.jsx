import React from 'react';
import {
  DollarSign, Coins, ArrowUpRight, CheckCircle2, AlertCircle,
} from 'lucide-react';
import { fmt } from './format';

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
        {status === 'ok' && (
          <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-300">
            <CheckCircle2 className="h-3 w-3" /> Connected
          </span>
        )}
        {status === 'warn' && (
          <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-300">
            <AlertCircle className="h-3 w-3" /> Limited
          </span>
        )}
        {status === 'off' && (
          <span className="inline-flex items-center gap-1 rounded-full border border-tbc-900/60 bg-ink-950 px-2 py-0.5 text-[10px] text-tbc-200/60">
            Not connected
          </span>
        )}
      </div>
      <div className="mt-3">{children}</div>
      {statusText && <div className="mt-2 text-[11px] text-tbc-200/50">{statusText}</div>}
      {footer}
    </div>
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

function StripeCard({ data }) {
  if (!data?.connected) {
    return (
      <ProviderShell name="Stripe" icon={DollarSign} status="off" statusText={data?.reason}>
        <div className="text-xs text-tbc-200/60">
          Configure your Stripe secret key in <span className="text-tbc-100">Security</span> to see live balance.
        </div>
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
        <Balance label="Pending"   amount={data.pending_usd}   accent="amber"   testid="stripe-pending" />
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
        <div className="text-xs text-tbc-200/60">
          Configure PayPal credentials in <span className="text-tbc-100">Security</span> to see balance.
        </div>
      </ProviderShell>
    );
  }
  if (data.balance_unavailable) {
    return (
      <ProviderShell name="PayPal" icon={ArrowUpRight} status="warn" mode={data.mode} statusText={data.reason}>
        <div className="text-xs text-tbc-200/70">
          PayPal connected. The Reporting/Balances API isn&apos;t enabled on this account, so we can&apos;t pull
          a live balance — but checkout works.
        </div>
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
        <div className="text-xs text-tbc-200/60">
          Configure NOWPayments key in <span className="text-tbc-100">Security</span> to see balances.
        </div>
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

export function ProviderBalances({ providers }) {
  return (
    <section>
      <h4 className="mb-2 text-xs font-bold uppercase tracking-wider text-tbc-200/60">Live provider balances</h4>
      <div className="grid gap-3 lg:grid-cols-3">
        <StripeCard data={providers.stripe} />
        <PayPalCard data={providers.paypal} />
        <CryptoCard data={providers.nowpayments} />
      </div>
    </section>
  );
}

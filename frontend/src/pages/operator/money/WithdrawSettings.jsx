import React from 'react';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Switch } from '../../../components/ui/switch';
import { Loader2, Send, Banknote, Coins } from 'lucide-react';

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
        <div className="mt-1 text-[10px] text-rose-300">
          Cap reached — auto payouts paused until the 24h window rolls forward.
        </div>
      )}
    </div>
  );
}

function StripeAutoRow({ settings, onSave }) {
  return (
    <div className="rounded-xl border border-tbc-900/60 bg-ink-900/60 p-4" data-testid="autopay-stripe">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-emerald-500/15 text-emerald-300">
            <Banknote className="h-4 w-4" />
          </span>
          <div>
            <div className="text-sm font-bold text-tbc-100">Stripe → Bank</div>
            <div className="text-[11px] text-tbc-200/50">
              {settings.stripe_configured
                ? 'Pays out USD to your linked Stripe bank account'
                : 'Stripe key not configured'}
            </div>
          </div>
        </div>
        <Switch
          data-testid="autopay-stripe-toggle"
          disabled={!settings.stripe_configured}
          checked={!!settings.autopay_stripe_enabled}
          onCheckedChange={(v) => onSave({ autopay_stripe_enabled: v })}
        />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <Field label="Trigger threshold (USD)">
          <Input
            data-testid="autopay-stripe-threshold"
            type="number" min="0" step="10"
            className="bg-ink-950 border-tbc-900/60 text-tbc-100"
            value={settings.autopay_stripe_threshold_usd}
            onChange={(e) => onSave({ autopay_stripe_threshold_usd: e.target.value })}
          />
        </Field>
        <Field label="Daily safety cap (USD)">
          <Input
            data-testid="autopay-stripe-cap"
            type="number" min="0" step="50"
            className="bg-ink-950 border-tbc-900/60 text-tbc-100"
            value={settings.autopay_stripe_daily_cap_usd}
            onChange={(e) => onSave({ autopay_stripe_daily_cap_usd: e.target.value })}
          />
        </Field>
      </div>
      <CapProgress
        used={settings.stripe_paid_24h_usd}
        cap={settings.autopay_stripe_daily_cap_usd}
        format={(n) => `$${Number(n).toFixed(2)}`}
        testid="autopay-stripe-cap-bar"
      />
    </div>
  );
}

function NowPaymentsAutoRow({ settings, onSave }) {
  return (
    <div className="rounded-xl border border-tbc-900/60 bg-ink-900/60 p-4" data-testid="autopay-nowpay">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-violet-500/15 text-violet-300">
            <Coins className="h-4 w-4" />
          </span>
          <div>
            <div className="text-sm font-bold text-tbc-100">NOWPayments → Wallet</div>
            <div className="text-[11px] text-tbc-200/50">
              {settings.nowpay_configured
                ? 'Auto-payout crypto to a single configured address'
                : 'NOWPayments key not configured'}
            </div>
          </div>
        </div>
        <Switch
          data-testid="autopay-nowpay-toggle"
          disabled={!settings.nowpay_configured}
          checked={!!settings.autopay_nowpay_enabled}
          onCheckedChange={(v) => onSave({ autopay_nowpay_enabled: v })}
        />
      </div>
      <div className="mt-3 grid grid-cols-4 gap-3">
        <Field label="Currency">
          <Input
            data-testid="autopay-nowpay-currency"
            className="bg-ink-950 border-tbc-900/60 text-tbc-100"
            value={settings.autopay_nowpay_currency || ''}
            placeholder="btc / eth / usdttrc20"
            onChange={(e) => onSave({ autopay_nowpay_currency: e.target.value })}
          />
        </Field>
        <Field label="Destination address">
          <Input
            data-testid="autopay-nowpay-address"
            className="bg-ink-950 border-tbc-900/60 text-tbc-100 font-mono text-xs"
            value={settings.autopay_nowpay_address || ''}
            placeholder="bc1q..."
            onChange={(e) => onSave({ autopay_nowpay_address: e.target.value })}
          />
        </Field>
        <Field label="Threshold (asset)">
          <Input
            data-testid="autopay-nowpay-threshold"
            type="number" min="0" step="0.001"
            className="bg-ink-950 border-tbc-900/60 text-tbc-100"
            value={settings.autopay_nowpay_threshold_usd}
            onChange={(e) => onSave({ autopay_nowpay_threshold_usd: e.target.value })}
          />
        </Field>
        <Field label="Daily cap (asset)">
          <Input
            data-testid="autopay-nowpay-cap"
            type="number" min="0" step="0.001"
            className="bg-ink-950 border-tbc-900/60 text-tbc-100"
            value={settings.autopay_nowpay_daily_cap}
            onChange={(e) => onSave({ autopay_nowpay_daily_cap: e.target.value })}
          />
        </Field>
      </div>
      <CapProgress
        used={settings.nowpay_paid_24h}
        cap={settings.autopay_nowpay_daily_cap}
        format={(n) =>
          `${Number(n).toFixed(4)} ${(settings.autopay_nowpay_currency || '').toUpperCase()}`}
        testid="autopay-nowpay-cap-bar"
      />
    </div>
  );
}

/** Header + Stripe row + NOWPayments row for the auto-withdraw section. */
export function WithdrawSettings({
  settings, onSave, savingSettings, runningCron, onRunNow,
}) {
  return (
    <>
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h4 className="text-xs font-bold uppercase tracking-wider text-tbc-200/60">Auto-withdraw</h4>
          {savingSettings && <Loader2 className="h-3 w-3 animate-spin text-tbc-400" />}
        </div>
        <Button
          data-testid="withdraw-cron-run"
          onClick={onRunNow}
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
      {settings && (
        <div className="grid gap-3 lg:grid-cols-2">
          <StripeAutoRow settings={settings} onSave={onSave} />
          <NowPaymentsAutoRow settings={settings} onSave={onSave} />
        </div>
      )}
    </>
  );
}

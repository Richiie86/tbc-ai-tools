import React, { useEffect, useState } from 'react';
import api from '../../../lib/api';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '../../../components/ui/dialog';
import { Loader2, MessageCircle, Calendar, Layers, DollarSign, ShieldOff, ShieldCheck, ExternalLink, KeyRound } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { toast } from 'sonner';

/**
 * Per-user analytics drill-down modal. Fetches `/api/operator/users/{id}/analytics`
 * on open. Read-only — the existing UsersTable already has the Pause / Adjust-
 * credits actions we just need to surface alongside the stats.
 */
export default function UserAnalyticsModal({ user, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    setLoading(true); setErr(null); setData(null);
    api.get(`/operator/users/${user.id}/analytics`)
      .then((r) => { if (!cancelled) setData(r.data); })
      .catch((e) => { if (!cancelled) setErr(e?.response?.data?.detail || 'Failed to load analytics'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [user]);

  if (!user) return null;
  return (
    <Dialog open={!!user} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent
        data-testid="user-analytics-modal"
        className="max-w-2xl border-tbc-900/60 bg-ink-900 text-tbc-100"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {user.email}
            {data?.user?.banned && (
              <span className="rounded-full bg-rose-500/20 px-2 py-0.5 text-[10px] uppercase tracking-wider text-rose-300">
                <ShieldOff className="mr-0.5 inline h-3 w-3" />Paused
              </span>
            )}
            {data?.user && !data.user.banned && (
              <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] uppercase tracking-wider text-emerald-300">
                <ShieldCheck className="mr-0.5 inline h-3 w-3" />Active
              </span>
            )}
          </DialogTitle>
          <DialogDescription className="text-tbc-200/60 text-xs">
            Per-user usage analytics. Pause / credit-adjust actions remain in the table row.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="grid place-items-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-tbc-300" />
          </div>
        ) : err ? (
          <div className="rounded border border-rose-500/40 bg-rose-500/[0.06] px-3 py-2 text-xs text-rose-200">
            {err}
          </div>
        ) : data && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat icon={MessageCircle} label="Messages" value={data.messages.total} hint={`${data.messages.last_7d} last 7d`} />
              <Stat icon={Calendar} label="Active days" value={data.active_days.total_distinct} hint={`${data.active_days.last_30d} in last 30d`} />
              <Stat icon={Layers} label="Sessions" value={data.sessions.total} hint={`${data.sessions.last_30d} last 30d`} />
              <Stat icon={DollarSign} label="Paid" value={`$${data.payments.total_usd.toFixed(2)}`} hint={`${data.payments.completed_count} tx`} />
            </div>

            <div>
              <div className="text-[10px] uppercase tracking-wider text-tbc-300">Activity (last 30 days)</div>
              <Sparkline data={data.active_days.recent} />
            </div>

            <div className="grid grid-cols-2 gap-2 text-[11px]">
              <KV label="Plan" value={data.user.plan} />
              <KV label="Credits balance" value={(data.user.credits ?? 0).toLocaleString()} />
              <KV label="Created" value={data.user.created_at ? new Date(data.user.created_at).toLocaleDateString() : '—'} />
              <KV label="Last seen" value={data.user.last_seen_at ? new Date(data.user.last_seen_at).toLocaleString() : '—'} />
              <KV label="Last payment" value={data.payments.last_payment_at ? new Date(data.payments.last_payment_at).toLocaleDateString() : '—'} />
              <KV label="2FA" value={data.user.totp_enabled ? 'On' : 'Off'} />
            </div>

            <ByokControl user={data.user} />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Operator control for the company-only Bring Your Own Keys feature.
 * BYOK is gated: an account can only switch it on after the operator approves
 * it here and records the negotiated monthly price (in credits). Pricing is
 * agreed per company out-of-band, so it's never shown to users publicly.
 */
function ByokControl({ user }) {
  const [approved, setApproved] = useState(!!user.byok_approved);
  const [price, setPrice] = useState(
    user.byok_monthly_credits != null ? String(user.byok_monthly_credits) : '',
  );
  const [busy, setBusy] = useState(false);
  const enabled = !!user.byok_enabled;

  const save = async (nextApproved) => {
    const body = { approved: nextApproved };
    if (nextApproved) {
      const n = parseInt(price, 10);
      if (!Number.isFinite(n) || n <= 0) {
        toast.error('Set the agreed monthly price (in credits) before approving.');
        return;
      }
      body.monthly_credits = n;
    }
    setBusy(true);
    try {
      await api.patch(`/operator/users/${user.id}/byok`, body);
      setApproved(nextApproved);
      toast.success(nextApproved
        ? `BYOK approved at ${body.monthly_credits} credits/month.`
        : 'BYOK access revoked.');
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not update BYOK access');
    } finally { setBusy(false); }
  };

  return (
    <div className="rounded-lg border border-tbc-900/60 bg-ink-950 p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs font-semibold text-tbc-100">
          <KeyRound className="h-3.5 w-3.5 text-tbc-300" />
          Bring Your Own Keys
          <span className="text-[10px] font-normal uppercase tracking-wider text-tbc-200/50">company add-on</span>
        </div>
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider">
          {approved ? (
            <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-emerald-300">Approved</span>
          ) : (
            <span className="rounded-full bg-tbc-900/60 px-2 py-0.5 text-tbc-200/60">Not approved</span>
          )}
          {enabled && <span className="rounded-full bg-tbc-500/15 px-2 py-0.5 text-tbc-300">On</span>}
        </div>
      </div>

      <p className="mt-2 text-[11px] leading-relaxed text-tbc-200/60">
        Approve this account only after agreeing a price. Enter the negotiated monthly cost in credits — the account
        is charged this on activation and every 30 days.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-[11px] text-tbc-200/70">
          <span>Price</span>
          <input
            type="number"
            min="1"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="e.g. 500"
            className="w-24 rounded border border-tbc-900/60 bg-ink-900 px-2 py-1 text-xs text-tbc-100 focus:border-tbc-500/60 focus:outline-none"
          />
          <span className="text-tbc-200/50">credits/mo</span>
        </label>
        {approved ? (
          <>
            <Button size="sm" disabled={busy} onClick={() => save(true)}
              className="bg-tbc-500 text-ink-950 hover:bg-tbc-400 font-semibold">
              {busy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null} Update price
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => save(false)}
              className="border-rose-500/40 text-rose-300 hover:bg-rose-500/10">
              Revoke access
            </Button>
          </>
        ) : (
          <Button size="sm" disabled={busy} onClick={() => save(true)}
            className="bg-tbc-500 text-ink-950 hover:bg-tbc-400 font-semibold">
            {busy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null} Approve access
          </Button>
        )}
      </div>
    </div>
  );
}

function Stat({ icon: Icon, label, value, hint }) {
  return (
    <div className="rounded-lg border border-tbc-900/60 bg-ink-950 px-3 py-2">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-tbc-300">
        <Icon className="h-3 w-3" />{label}
      </div>
      <div className="mt-1 text-lg font-bold text-tbc-100" data-testid={`user-analytics-stat-${label.toLowerCase().replace(/\s+/g, '-')}`}>
        {value}
      </div>
      {hint && <div className="text-[10px] text-tbc-200/50">{hint}</div>}
    </div>
  );
}

function KV({ label, value }) {
  return (
    <div className="flex items-center justify-between rounded border border-tbc-900/60 bg-ink-950 px-2 py-1">
      <span className="text-tbc-200/60">{label}</span>
      <span className="font-mono text-tbc-100">{value}</span>
    </div>
  );
}

/** Tiny 30-bar sparkline — no charting lib needed. Each bar height is
 *  proportional to the max msg_count in the window. */
function Sparkline({ data }) {
  if (!data?.length) return <div className="mt-1 text-[11px] text-tbc-200/40">No activity in the last 30 days</div>;
  const max = Math.max(1, ...data.map((d) => d.msg_count));
  return (
    <div className="mt-1 flex h-12 items-end gap-1" data-testid="user-analytics-sparkline">
      {data.map((d) => (
        <div
          key={d.date}
          title={`${d.date}: ${d.msg_count} msg`}
          style={{ height: `${Math.max(6, (d.msg_count / max) * 100)}%` }}
          className="flex-1 rounded-sm bg-tbc-500/60 hover:bg-tbc-400"
        />
      ))}
    </div>
  );
}

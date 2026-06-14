import React, { useEffect, useState } from 'react';
import api from '../../../lib/api';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '../../../components/ui/dialog';
import { Loader2, MessageCircle, Calendar, Layers, DollarSign, ShieldOff, ShieldCheck, ExternalLink } from 'lucide-react';

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
          </div>
        )}
      </DialogContent>
    </Dialog>
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

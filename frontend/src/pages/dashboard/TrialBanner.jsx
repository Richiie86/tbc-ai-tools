import React from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, Clock } from 'lucide-react';

/**
 * Free-trial countdown banner shown at the top of the dashboard chat area.
 * Hides automatically for users without a plan-expiry date.
 */
export function TrialBanner({ user }) {
  if (!user) return null;
  const expires = user.plan_expires_at;
  if (!expires) return null;
  const isExpired = !!user.plan_is_expired;
  const days = user.plan_days_remaining ?? 0;
  const tone = isExpired
    ? 'border-rose-500/40 bg-rose-500/10 text-rose-200'
    : days <= 3
      ? 'border-amber-500/40 bg-amber-500/10 text-amber-100'
      : 'border-sky-500/30 bg-sky-500/10 text-sky-100';
  const Icon = isExpired ? AlertCircle : Clock;
  return (
    <div
      className={`flex items-center justify-between gap-3 border-b px-5 py-2 text-xs ${tone}`}
      data-testid="trial-banner"
    >
      <div className="flex items-center gap-2">
        <Icon className="h-3.5 w-3.5" />
        {isExpired ? (
          <span>
            Your <strong>{user.plan}</strong> trial has expired. Upgrade to keep building without interruption.
          </span>
        ) : (
          <span>
            <strong>{days}</strong> day{days === 1 ? '' : 's'} left on your <strong>{user.plan}</strong> trial · auto-downgrades when it ends.
          </span>
        )}
      </div>
      <Link
        to="/pricing"
        data-testid="trial-banner-upgrade"
        className="rounded-md bg-tbc-500 px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-ink-950 hover:bg-tbc-400"
      >
        Upgrade now
      </Link>
    </div>
  );
}

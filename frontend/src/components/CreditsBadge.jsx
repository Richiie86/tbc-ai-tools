import React from 'react';
import { Link } from 'react-router-dom';
import { Coins, Infinity as InfinityIcon } from 'lucide-react';

/**
 * Inline credits chip. Renders the user's remaining credits with a clear
 * "low / out" tone so customers always know how much budget they have left.
 *
 * Operators are shown an infinity glyph since their usage is uncapped.
 *
 * - Tap target links to /pricing so a user low on credits can upgrade in one
 *   click. Pass `linkTo={null}` to render a non-interactive pill instead.
 * - `compact` shrinks the label for tight spots like the Dashboard header.
 */
export default function CreditsBadge({ user, linkTo = '/pricing', compact = false, testid = 'credits-badge' }) {
  if (!user) return null;
  const isOperator = user.role === 'operator';
  const credits = user.credits ?? 0;
  const low = !isOperator && credits > 0 && credits <= 25;
  const out = !isOperator && credits <= 0;

  const tone = out
    ? 'border-rose-500/40 bg-rose-500/10 text-rose-200 hover:bg-rose-500/15'
    : low
      ? 'border-amber-500/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/15'
      : 'border-tbc-500/40 bg-tbc-500/10 text-tbc-100 hover:bg-tbc-500/15';

  const body = (
    <span
      data-testid={testid}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors ${tone}`}
      title={
        isOperator
          ? 'Operator — unlimited credits'
          : out
            ? 'You are out of credits. Upgrade to keep building.'
            : low
              ? 'Low on credits — consider upgrading'
              : `${credits.toLocaleString()} credits remaining`
      }
    >
      {isOperator ? <InfinityIcon className="h-3 w-3" /> : <Coins className="h-3 w-3" />}
      {isOperator
        ? '∞ credits'
        : compact
          ? credits.toLocaleString()
          : `${credits.toLocaleString()} ${credits === 1 ? 'credit' : 'credits'}`}
      {out && !compact && <span className="rounded bg-rose-500/30 px-1 text-[9px] uppercase tracking-wider">out</span>}
      {low && !compact && <span className="rounded bg-amber-500/30 px-1 text-[9px] uppercase tracking-wider">low</span>}
    </span>
  );

  if (linkTo && !isOperator) {
    return <Link to={linkTo} className="inline-flex">{body}</Link>;
  }
  return body;
}

import React, { useEffect, useState } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '../components/ui/dialog';
import { Button } from '../components/ui/button';
import {
  Users, FolderKanban, Sparkles, CreditCard, Wallet, DollarSign, KeyRound,
  Coins, Settings as SettingsIcon, Activity, ScrollText, Mail, Code2,
  ChevronLeft, ChevronRight, BookOpen, X,
} from 'lucide-react';

/**
 * Operator console first-time tour.
 *
 * Renders a centered modal that walks through every tab once. Each step is
 * a self-contained card (we deliberately don't anchor to specific DOM
 * elements because the tabs wrap onto multiple rows and DOM-anchored tours
 * break the moment the layout changes). On the last step we auto-mark the
 * tour as "seen" so it never reopens for this browser.
 *
 * Re-launchable any time via the "Guide" button in Operator.jsx — pass
 * `forceOpen={true}` and the parent state machine handles re-show.
 */
const STORAGE_KEY = 'tbc_operator_tour_seen_v1';

// Order MUST match the order tabs are rendered in Operator.jsx so the tour
// reads top-to-bottom for the user.
const STEPS = [
  {
    tab: 'users', icon: Users, title: 'Users',
    body: 'Search every account, change plans, grant credits, and reset 2FA. The header chips at the top of this page (Total Users / Paid Customers / Revenue) are summary stats for everything that happens in this tab.',
    tip: 'Click a row to drill into a user — their sessions, billing history, and credit ledger live there.',
  },
  {
    tab: 'projects', icon: FolderKanban, title: 'Projects',
    body: 'Credit packs and subscription plans sold on the public Pricing page. Each project ties a Stripe price (or a manual checkout) to a credit grant.',
    tip: 'Need a one-off promo? Duplicate an existing plan, change the price, save. The Pricing page picks it up immediately.',
  },
  {
    tab: 'plans', icon: Sparkles, title: 'Plans',
    body: 'Long-running subscription plans (Pro / Enterprise / etc). Set the per-month price and how many credits are recharged at each renewal.',
  },
  {
    tab: 'payments', icon: CreditCard, title: 'Payments',
    body: 'Every payment that ever hit your account: Stripe cards, NOWPayments crypto, PayPal, and manual bank transfers. Use the filters to reconcile a specific window.',
  },
  {
    tab: 'treasury', icon: Wallet, title: 'Treasury',
    body: 'Where the money actually sits — your Stripe balance, your crypto wallet balances, and your pending payouts. The "Sweep" button moves available funds to the configured bank account.',
  },
  {
    tab: 'money', icon: DollarSign, title: 'Money',
    body: 'Profit-and-loss view: gross revenue minus refunds, royalties, and operating costs. Lets you see margin at a glance.',
  },
  {
    tab: 'licenses', icon: KeyRound, title: 'Licenses',
    body: 'Issue / revoke license keys for the desktop app. Each license is bound to one machine and can be transferred up to N times before it locks.',
  },
  {
    tab: 'royalties', icon: Coins, title: 'Royalties',
    body: 'Track every revenue-share payout you owe to partners or affiliates. Automatic sweeps run hourly; this tab shows the queue + history.',
  },
  {
    tab: 'settings', icon: SettingsIcon, title: 'Security',
    body: 'All third-party API keys live here: Stripe, NOWPayments, PayPal, Resend (email), your universal AI / LLM key for model calls, your Vercel PAT, and a GitHub PAT for autopilot.',
    tip: 'IMPORTANT: pasting a key here will NOT change your operator password — we explicitly told the browser to leave these fields alone.',
  },
  {
    tab: 'ops', icon: Activity, title: 'Ops',
    body: 'The pulse of your platform — supervisor health, autonomous deploy projects (with one-click Deploy, Clone, Code Review, and the full Autopilot loop), and self-source code download.',
    tip: 'Try the "Autopilot" button on a project: it reviews the repo with AI, blocks ship if the verdict is `do_not_ship`, and (with auto-fix iterations > 0) commits patches and retries until it ships.',
  },
  {
    tab: 'audit', icon: ScrollText, title: 'Audit',
    body: 'Tamper-evident log of every operator action: plan changes, refunds, key rotations, ship overrides. Filter by user, action, or time window.',
  },
  {
    tab: 'contacts', icon: Mail, title: 'Contacts',
    body: 'Inbox for the public Contact form on the marketing site. Reply directly from here and the response goes out via Resend.',
  },
  {
    tab: 'codes', icon: Code2, title: 'Codes',
    body: 'One-time discount codes & gift cards. Generate in bulk, set expiry, restrict to specific plans.',
  },
];

/**
 * Convert an external "open me" trigger + first-visit autostart into the
 * single source of truth (`open`). Closing fires onClose so the parent can
 * stop forcing it open.
 */
export function OperatorGuideTour({ forceOpen, onClose, onJumpToTab }) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);

  // Auto-open on first visit OR when the parent flips forceOpen on. The
  // localStorage flag is set on FINISH (or Skip) so we don't keep nagging.
  useEffect(() => {
    if (forceOpen) {
      setStep(0);
      setOpen(true);
      return;
    }
    try {
      if (!localStorage.getItem(STORAGE_KEY)) {
        setStep(0);
        setOpen(true);
      }
    } catch (e) {
      // Incognito or strict-mode browsers throw on localStorage access; the
      // tour just won't auto-open then, which is a graceful degradation.
      // Log so we can still see it in dev tools if needed.
      console.debug('[OperatorGuideTour] localStorage read failed:', e?.message);
    }
  }, [forceOpen]);

  const close = (markSeen = true) => {
    if (markSeen) {
      try {
        localStorage.setItem(STORAGE_KEY, '1');
      } catch (e) {
        console.debug('[OperatorGuideTour] localStorage write failed:', e?.message);
      }
    }
    setOpen(false);
    onClose?.();
  };

  const next = () => {
    if (step === STEPS.length - 1) {
      close(true);
      return;
    }
    const ns = step + 1;
    setStep(ns);
    onJumpToTab?.(STEPS[ns].tab);
  };

  const prev = () => {
    if (step === 0) return;
    const ns = step - 1;
    setStep(ns);
    onJumpToTab?.(STEPS[ns].tab);
  };

  const current = STEPS[step];
  if (!current) return null;
  const Icon = current.icon;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) close(true); }}>
      <DialogContent
        data-testid="operator-guide-tour"
        className="max-w-lg border-tbc-500/40 bg-ink-950 text-tbc-100"
      >
        <DialogHeader>
          <div className="flex items-center gap-2">
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-tbc-500/15 text-tbc-300">
              <Icon className="h-5 w-5" />
            </span>
            <div className="flex-1">
              <DialogTitle className="text-tbc-100">{current.title}</DialogTitle>
              <DialogDescription className="text-[11px] uppercase tracking-wider text-tbc-200/60">
                Operator quick guide · Step {step + 1} / {STEPS.length}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-3">
          <p className="text-sm leading-relaxed text-tbc-100/90">{current.body}</p>
          {current.tip && (
            <p className="rounded-lg border border-tbc-500/30 bg-tbc-500/5 p-2 text-xs text-tbc-200">
              <span className="font-semibold text-tbc-300">Tip · </span>{current.tip}
            </p>
          )}
          {/* Progress bar */}
          <div className="h-1 w-full overflow-hidden rounded-full bg-ink-900">
            <div
              className="h-full bg-tbc-500 transition-all"
              style={{ width: `${((step + 1) / STEPS.length) * 100}%` }}
            />
          </div>
        </div>

        <DialogFooter className="flex w-full flex-row items-center justify-between gap-2 sm:justify-between">
          <Button
            variant="ghost"
            data-testid="guide-skip"
            onClick={() => close(true)}
            className="text-tbc-200/60 hover:text-tbc-200 hover:bg-ink-900"
          >
            <X className="mr-1 h-3 w-3" /> Skip tour
          </Button>
          <div className="flex gap-2">
            <Button
              variant="outline"
              data-testid="guide-prev"
              onClick={prev}
              disabled={step === 0}
              className="border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950"
            >
              <ChevronLeft className="mr-1 h-3 w-3" /> Back
            </Button>
            <Button
              data-testid="guide-next"
              onClick={next}
              className="bg-tbc-500 text-ink-950 hover:bg-tbc-400 font-semibold"
            >
              {step === STEPS.length - 1 ? 'Done' : (<>Next <ChevronRight className="ml-1 h-3 w-3" /></>)}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Tiny header button — pair with `<OperatorGuideTour forceOpen={...}/>` in
 * the parent. Lives in its own export so we can render it next to the
 * Console title without bringing the whole tour into scope.
 */
export function OperatorGuideButton({ onOpen }) {
  return (
    <Button
      size="sm"
      variant="outline"
      data-testid="open-operator-guide"
      onClick={onOpen}
      title="Restart the tab-by-tab guide"
      className="border-tbc-500/40 bg-ink-900 text-tbc-100 hover:bg-tbc-500/10"
    >
      <BookOpen className="mr-1.5 h-3 w-3" />
      Guide
    </Button>
  );
}

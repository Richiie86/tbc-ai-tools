import React, { useEffect, useState } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '../components/ui/dialog';
import { Button } from '../components/ui/button';
import {
  Users, FolderKanban, Sparkles, CreditCard, Wallet, DollarSign, KeyRound,
  Coins, Settings as SettingsIcon, Activity, ScrollText, Mail, Code2,
  ChevronLeft, ChevronRight, BookOpen, X,
  TrendingUp, Archive, BrainCircuit, Wrench, Link2, Calculator, Gauge,
  Megaphone, MessageCircle, FlaskConical, Brain, Network, TestTube,
  AlertOctagon, Wand2,
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
// Bumped to v2 when the guide expanded from 13 tabs to full coverage of all
// 29 tabs (incl. amAI + AI Tools) — so anyone who saw the old tour gets the
// richer one once.
const STORAGE_KEY = 'tbc_operator_tour_seen_v3';

// Order MUST match the order tabs are rendered in Operator.jsx so the tour
// reads top-to-bottom for the user.
const STEPS = [
  {
    tab: 'users', icon: Users, title: 'Users',
    body: 'This is your member list — every person who has signed up. From here you can search any account, change someone\'s plan, hand out free credits, or reset their two-factor login if they get locked out. The chips at the very top of the page (Total Users / Paid Customers / Revenue) are live totals for your whole business.',
    tip: 'Click any row to open that person\'s full profile — their chat sessions, billing history, and credit ledger all live inside.',
  },
  {
    tab: 'analytics', icon: TrendingUp, title: 'Analytics',
    body: 'Your growth dashboard. Charts here show sign-ups over time, revenue trends, active users, and which plans are selling. Use it to spot what\'s working and when your busiest days are.',
    tip: 'If a chart looks empty, widen the date range at the top — new accounts may not have enough history yet.',
  },
  {
    tab: 'projects', icon: FolderKanban, title: 'Projects',
    body: 'These are the credit packs and one-off products shown on your public Pricing page. Each "project" links a price (Stripe card checkout or a manual bank transfer) to a number of credits the buyer receives.',
    tip: 'Want a quick promo? Duplicate an existing pack, lower the price, and save — the Pricing page updates instantly.',
  },
  {
    tab: 'user-projects', icon: Archive, title: 'User Projects',
    body: 'A read-only view of the apps and workspaces your members have created inside the builder. Handy for support ("what did this customer build?") and for spotting power users.',
  },
  {
    tab: 'plans', icon: Sparkles, title: 'Plans',
    body: 'Your recurring subscriptions (like Pro or Enterprise). Set the monthly price and how many credits are topped up automatically at each renewal. This is your steady, repeating income.',
  },
  {
    tab: 'payments', icon: CreditCard, title: 'Payments',
    body: 'A complete history of every payment you\'ve ever received — card (Stripe), crypto (NOWPayments), PayPal, and manual bank transfers, all in one list. Use the filters to check a specific week or customer when balancing your books.',
  },
  {
    tab: 'treasury', icon: Wallet, title: 'Treasury',
    body: 'Where your money is sitting right now: your Stripe balance, crypto wallet balances, and any payouts still pending. The "Sweep" button moves available cash to your connected bank account.',
    tip: 'Sweeping is safe to do any time — it only moves funds that have already cleared.',
  },
  {
    tab: 'money', icon: DollarSign, title: 'Money',
    body: 'Your simple profit view. It takes everything you earned and subtracts refunds, partner royalties, and running costs so you can see your real margin at a glance — no spreadsheet needed.',
  },
  {
    tab: 'keys', icon: KeyRound, title: 'My Keys',
    body: 'Your own provider keys, so the platform runs entirely on your accounts — no shared or third-party dependency. Add Anthropic, OpenAI, Google Gemini, or OpenRouter (a single key that unlocks 300+ models). Use "Add a specific key", pick the provider, paste, Test, and Save. Each key also has Rotate and Clear.',
    tip: 'OpenRouter is the easiest way to offer lots of models at once — one key covers 300+ of them. Company accounts can also run on their own keys via Bring Your Own Keys — but only after you approve them and set a price in the Users tab.',
  },
  {
    tab: 'amai', icon: BrainCircuit, title: 'amAI (smart model routing)',
    body: 'amAI is the brain that picks the best AI model for each message automatically — a cheap fast model for quick questions, a powerful one for real coding. This tab lets you turn "Automatic" mode on, map which model handles which kind of task, and see this month\'s estimated AI spend broken down by model AND by user.',
    tip: 'The "by user" spend list shows exactly who is costing you the most this month — great for fair-use decisions.',
  },
  {
    tab: 'tools', icon: Wrench, title: 'AI Tools',
    body: 'Optional superpowers you can switch on for the AI. "Web Search" lets it pull live results from the internet for up-to-date answers (needs a search key you paste here). "Sequential Thinking" makes it plan complex tasks step-by-step. Context7 (up-to-date coding docs) also lives on the amAI tab.',
    tip: 'Everything here is a safe on/off switch — if a tool has no key or fails, chat keeps working normally.',
  },
  {
    tab: 'licenses', icon: KeyRound, title: 'Licenses',
    body: 'Issue or revoke license keys for the desktop app. Each key is tied to one computer and can be moved a limited number of times before it locks, which stops sharing.',
  },
  {
    tab: 'royalties', icon: Coins, title: 'Royalties',
    body: 'If you share revenue with partners or affiliates, this tracks what you owe and what\'s been paid. Automatic payouts run on a schedule; this tab shows both the upcoming queue and the full history.',
  },
  {
    tab: 'settings', icon: SettingsIcon, title: 'Security & Keys',
    body: 'The control room for all your third-party keys: Stripe, NOWPayments, PayPal, Resend (email), your shared AI/LLM key that powers model calls, your Vercel token, and a GitHub token for autopilot deploys.',
    tip: 'IMPORTANT: typing a key here will NOT change your operator password — these fields are deliberately kept separate.',
  },
  {
    tab: 'ops', icon: Activity, title: 'Ops',
    body: 'The health and deployment hub. See if your servers are running, manage auto-deploy projects with one-click Deploy, Clone, Code Review, and the full Autopilot loop, and download your own source code. The quick actions row also has a "Clear cache & reload" button — tap it if you just deployed but still see an old version; it wipes this browser\'s cached files and reloads the freshest build (you stay signed in).',
    tip: 'Try Autopilot on a project: it reviews the code with AI, refuses to ship if it finds a blocker, and can auto-fix and retry until it passes.',
  },
  {
    tab: 'links', icon: Link2, title: 'Links',
    body: 'Manage the short links and shareable URLs your platform hands out — referral links, marketing links, and custom redirects. Edit where each one points without touching code.',
  },
  {
    tab: 'taxcalc', icon: Calculator, title: 'Tax Calc',
    body: 'A quick calculator for working out tax on a sale or payout. Enter an amount and rate and it does the maths for you — useful for one-off estimates.',
  },
  {
    tab: 'taxameter', icon: Gauge, title: 'Taxameter',
    body: 'A running tally of tax you\'ve likely accrued across all sales in a period, so there are no surprises at tax time. Think of it as an always-on odometer for what you may owe.',
  },
  {
    tab: 'audit', icon: ScrollText, title: 'Audit',
    body: 'A tamper-evident diary of every important action taken in the console — plan changes, refunds, key rotations, ship approvals. Filter by person, action, or date if you ever need to investigate something.',
  },
  {
    tab: 'contacts', icon: Mail, title: 'Contacts',
    body: 'The inbox for your public "Contact us" form. Messages from visitors land here and you can reply straight from this tab — the email goes out automatically through Resend.',
  },
  {
    tab: 'codes', icon: Code2, title: 'Codes',
    body: 'Create discount codes and gift cards. Generate them in bulk, set an expiry date, and restrict them to certain plans — perfect for launches, promos, and refunds-as-credit.',
  },
  {
    tab: 'marketing', icon: Megaphone, title: 'Marketing',
    body: 'Tools to promote your platform: announcement banners, campaigns, and promotional copy shown to visitors and members. Update what\'s being advertised without editing the site itself.',
  },
  {
    tab: 'messaging', icon: MessageCircle, title: 'Messaging',
    body: 'Send announcements or direct messages to your members — like a new-feature note or a maintenance heads-up. Reach everyone at once or target specific people.',
  },
  {
    tab: 'sandbox', icon: FlaskConical, title: 'Sandbox',
    body: 'A safe playground to test AI prompts, settings, and new features before they go live to real users. Nothing you do here affects customers.',
  },
  {
    tab: 'learnings', icon: Brain, title: 'AI Learnings',
    body: 'Facts and instructions you teach the AI once so it applies them to every conversation — your tone of voice, house rules, things it should always or never do. One shared memory that improves every model.',
    tip: 'Keep learnings short and clear, like bullet points — the AI follows them best that way.',
  },
  {
    tab: 'brain', icon: Network, title: 'AI Brain',
    body: 'A bigger-picture view of the AI\'s knowledge and connections — how learnings, models, and tools fit together. Use it to understand and fine-tune the overall behaviour of your assistant.',
  },
  {
    tab: 'ai-tests', icon: TestTube, title: 'AI Tests',
    body: 'Run test prompts against your models to check quality and catch regressions after you change settings. A quick way to make sure an update didn\'t make answers worse.',
  },
  {
    tab: 'errors', icon: AlertOctagon, title: 'Errors',
    body: 'A live feed of problems the app has run into — failed requests, crashes, and warnings. Check here first when something isn\'t working; each entry shows what happened and when.',
  },
  {
    tab: 'ai-build', icon: Wand2, title: 'AI Build',
    body: 'Let the AI help build and improve this very platform — generate features, fixes, and code changes with assistance. An advanced, developer-focused workspace.',
    tip: 'Great for power users; if you\'re just getting started, explore the other tabs first.',
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

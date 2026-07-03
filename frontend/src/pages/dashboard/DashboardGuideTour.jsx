import React, { useEffect, useState } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
import {
  MessageSquare, Cpu, ListOrdered, CreditCard,
  ChevronLeft, ChevronRight, BookOpen, X,
  BrainCircuit, Globe, BookOpenCheck, Settings as SettingsIcon, Gift,
} from 'lucide-react';

/**
 * Dashboard first-time tour (regular users, not the operator console).
 *
 * Four short steps that explain the chat surface so a brand-new account
 * doesn't have to guess where things live. Auto-opens on first dashboard
 * visit (`tbc_dashboard_tour_seen_v1` in localStorage) and is re-launchable
 * any time via the `DashboardGuideButton` exported below.
 */
// Bumped to v2 when the guide grew from 4 steps to full beginner coverage
// (Automatic mode, web search, live docs, referrals, security) — so returning
// users get the richer walkthrough once.
const STORAGE_KEY = 'tbc_dashboard_tour_seen_v2';

const STEPS = [
  {
    icon: MessageSquare, title: 'The chat',
    body: 'This is your workspace. Type anything into the box at the bottom — a question, or "build me a...". The AI writes its answer live, word by word, in the space above. If you scroll up to re-read something, the answer won\'t yank you back down; just click "Jump to latest" to follow along again.',
    tip: 'Be specific. "Build a login page with email and password" works better than "make a login".',
  },
  {
    icon: Cpu, title: 'Pick your model',
    body: 'Top-left is the model picker — the different "brains" you can chat with: Claude Sonnet (balanced, the default), Opus (deepest thinking for hard problems), Haiku (fastest for quick lookups), plus GPT and Gemini. Each message spends a few credits; stronger models cost a little more.',
    tip: 'Not sure which to pick? Choose "Automatic" (next step) and let the app decide for you.',
  },
  {
    icon: BrainCircuit, title: 'Automatic mode (amAI)',
    body: 'See the "Automatic" option in the model picker? Turn it on and you never have to choose a model again. amAI reads each message and quietly routes it to the right brain — a cheap fast one for simple questions, a powerful one for real coding — so you get good answers without wasting credits.',
    tip: 'When it picks for you, a small note tells you which model it chose and why.',
  },
  {
    icon: Globe, title: 'Live web search',
    body: 'When your question needs current, real-world information, the AI can search the live web and fold the results into its answer — so it isn\'t limited to what it learned during training. When this happens you\'ll see a small "Used Web Search" note appear.',
    tip: 'Great for "what\'s the latest version of...", recent news, or up-to-date prices.',
  },
  {
    icon: BookOpenCheck, title: 'Always-current code docs',
    body: 'Ask a coding question about a library like React, Next.js, or Tailwind and the app automatically pulls the newest official documentation into the answer (via Context7). That means fewer outdated examples and code that actually works with today\'s versions.',
    tip: 'You can even name a version — "Next.js 14 routing" — and it fetches docs for that exact version.',
  },
  {
    icon: ListOrdered, title: 'Your sessions',
    body: 'Every conversation is saved as a "session" in the left sidebar. Click any one to jump back in — the AI remembers everything you discussed inside it, so you can pick up right where you left off. Hit "New session" to start a clean slate.',
    tip: 'Your chats are private to your account. The operator can see basic stats, never what you typed.',
  },
  {
    icon: CreditCard, title: 'Credits & billing',
    body: 'The chip in the top-right shows how many credits you have left — credits are what each message spends. When they run low, buy a top-up pack or upgrade to a monthly plan from the Pricing page. Click the chip any time to see your usage history.',
  },
  {
    icon: Gift, title: 'Refer a friend',
    body: 'Down in the sidebar you\'ll find your personal referral link. Share it, and when a friend signs up you both get rewarded. It\'s the easiest way to earn extra credits.',
  },
  {
    icon: SettingsIcon, title: 'Settings & security',
    body: 'The Settings link (sidebar) is where you update your profile, change your password, and turn on two-factor authentication (2FA) for an extra layer of protection. We strongly recommend enabling 2FA.',
    tip: 'You can always replay this guide from the "Guide" button in the sidebar.',
  },
];

export function DashboardGuideTour({ forceOpen, onClose }) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);

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
      // Incognito / strict-mode browsers throw on localStorage access — the
      // tour just won't auto-open then. Log for dev visibility.
      console.debug('[DashboardGuideTour] localStorage read failed:', e?.message);
    }
  }, [forceOpen]);

  const close = (markSeen = true) => {
    if (markSeen) {
      try {
        localStorage.setItem(STORAGE_KEY, '1');
      } catch (e) {
        console.debug('[DashboardGuideTour] localStorage write failed:', e?.message);
      }
    }
    setOpen(false);
    onClose?.();
  };

  const next = () => {
    if (step === STEPS.length - 1) { close(true); return; }
    setStep(step + 1);
  };

  const current = STEPS[step];
  if (!current) return null;
  const Icon = current.icon;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) close(true); }}>
      <DialogContent
        data-testid="dashboard-guide-tour"
        className="max-w-md border-tbc-500/40 bg-ink-950 text-tbc-100"
      >
        <DialogHeader>
          <div className="flex items-center gap-2">
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-tbc-500/15 text-tbc-300">
              <Icon className="h-5 w-5" />
            </span>
            <div>
              <DialogTitle className="text-tbc-100">{current.title}</DialogTitle>
              <DialogDescription className="text-[11px] uppercase tracking-wider text-tbc-200/60">
                Quick guide · Step {step + 1} / {STEPS.length}
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
            data-testid="dashboard-guide-skip"
            onClick={() => close(true)}
            className="text-tbc-200/60 hover:text-tbc-200 hover:bg-ink-900"
          >
            <X className="mr-1 h-3 w-3" /> Skip
          </Button>
          <div className="flex gap-2">
            <Button
              variant="outline"
              data-testid="dashboard-guide-prev"
              onClick={() => step > 0 && setStep(step - 1)}
              disabled={step === 0}
              className="border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950"
            >
              <ChevronLeft className="mr-1 h-3 w-3" /> Back
            </Button>
            <Button
              data-testid="dashboard-guide-next"
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

export function DashboardGuideButton({ onOpen }) {
  return (
    <Button
      size="sm"
      variant="outline"
      data-testid="open-dashboard-guide"
      onClick={onOpen}
      title="Replay the quick guide"
      className="border-tbc-500/40 bg-ink-900 text-tbc-100 hover:bg-tbc-500/10"
    >
      <BookOpen className="mr-1.5 h-3 w-3" />
      Guide
    </Button>
  );
}

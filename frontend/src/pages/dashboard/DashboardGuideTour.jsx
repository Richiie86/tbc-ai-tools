import React, { useEffect, useState } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
import {
  MessageSquare, Cpu, ListOrdered, CreditCard,
  ChevronLeft, ChevronRight, BookOpen, X,
} from 'lucide-react';

/**
 * Dashboard first-time tour (regular users, not the operator console).
 *
 * Four short steps that explain the chat surface so a brand-new account
 * doesn't have to guess where things live. Auto-opens on first dashboard
 * visit (`tbc_dashboard_tour_seen_v1` in localStorage) and is re-launchable
 * any time via the `DashboardGuideButton` exported below.
 */
const STORAGE_KEY = 'tbc_dashboard_tour_seen_v1';

const STEPS = [
  {
    icon: MessageSquare, title: 'The chat',
    body: 'Type a question in the box at the bottom; the AI streams its answer in real-time above. New messages now pin to the bottom only when you ARE at the bottom — scroll up to read older replies without the stream yanking you back, then click "Jump to latest" to follow the stream again.',
  },
  {
    icon: Cpu, title: 'Pick the model',
    body: 'The top-left model picker switches between Claude Sonnet 4.5 (default, balanced), Opus (deep reasoning), Haiku (fastest), GPT-4o, Gemini, and more. Credits are consumed per message — heavier models cost more.',
    tip: 'Stick with the default for chat; switch to Opus when you have a hard problem; switch to Haiku when you just need a quick lookup.',
  },
  {
    icon: ListOrdered, title: 'Your sessions',
    body: 'Every conversation is a session, listed on the left. Click any session to resume it; the AI remembers everything you said inside that session. Click "New chat" to start fresh.',
    tip: 'Sessions are private to your account — only the operator can see metadata, never the contents.',
  },
  {
    icon: CreditCard, title: 'Credits & billing',
    body: 'The chip in the top-right shows how many credits you have left. When you run out you can buy a credit pack from the Pricing page or upgrade to a subscription plan. Open the same chip later to see your usage history.',
    tip: 'You can always re-run this guide from the "Guide" button in the sidebar.',
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

import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
import { Coins, Sparkles, Loader2, Rocket } from 'lucide-react';
import { toast } from 'sonner';
import api from '../../lib/api';

const TOP_UP_PACKS = [
  { credits: 100,  price: 9,  label: 'Quick top-up',  blurb: 'Roughly an evening of coding' },
  { credits: 500,  price: 39, label: 'Best value',    blurb: 'Most builders pick this',     featured: true },
  { credits: 1000, price: 69, label: 'Power pack',    blurb: 'For longer-running projects' },
];

/**
 * Out-of-credits modal. Surfaces the moment a user with ≤0 credits tries to
 * send a message — converts the dead-end into a top-up CTA without losing the
 * draft message they were about to send.
 */
export function OutOfCreditsDialog({ open, onOpenChange, user }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(null); // pack id while we're loading checkout

  const startCheckout = async (pack) => {
    setBusy(pack.credits);
    try {
      // Re-use the existing plan checkout flow — the backend already mints
      // a Stripe session and stores a pending transaction. We pass a small
      // marker so the receipt shows "Credit pack" instead of "Plan".
      const origin = window.location.origin;
      const { data } = await api.post('/payments/checkout', {
        plan_id: `credits_${pack.credits}`,
        origin_url: origin,
      });
      window.location.href = data.url;
    } catch (e) {
      // Plan id may not exist yet — fall back to the pricing page so the user
      // can still pick a paid plan that comes with bundled credits.
      toast.message('Opening pricing — pick a plan to top up credits');
      console.warn('Credit pack checkout not configured, falling back to /pricing', e?.response?.data);
      navigate('/pricing');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="out-of-credits-dialog"
        className="border-tbc-900/60 bg-ink-950 text-tbc-100 sm:max-w-lg"
      >
        <DialogHeader>
          <div className="mx-auto mb-2 grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br from-amber-400 to-tbc-500 shadow-lg shadow-tbc-500/30">
            <Coins className="h-6 w-6 text-slate-950" strokeWidth={2.4} />
          </div>
          <DialogTitle className="text-center text-2xl font-bold text-white">
            You&apos;re out of credits
          </DialogTitle>
          <DialogDescription className="text-center text-sm text-slate-400">
            Top up to keep chatting with{' '}
            <span className="text-tbc-300">TBC AI Tools</span>. Credits never
            expire and apply across every model.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-3 space-y-2" data-testid="out-of-credits-packs">
          {TOP_UP_PACKS.map((pack) => (
            <button
              key={pack.credits}
              data-testid={`out-of-credits-pack-${pack.credits}`}
              disabled={busy !== null}
              onClick={() => startCheckout(pack)}
              className={`group flex w-full items-center justify-between rounded-xl border px-4 py-3 text-left transition disabled:opacity-50 ${
                pack.featured
                  ? 'border-tbc-500/60 bg-tbc-500/10 hover:bg-tbc-500/15'
                  : 'border-slate-800 bg-slate-900/40 hover:border-tbc-500/40 hover:bg-slate-900'
              }`}
            >
              <div className="flex items-center gap-3">
                <span className={`grid h-9 w-9 place-items-center rounded-lg ${
                  pack.featured ? 'bg-tbc-500/30 text-tbc-100' : 'bg-slate-800 text-tbc-300'
                }`}>
                  {pack.featured ? <Sparkles className="h-4 w-4" /> : <Coins className="h-4 w-4" />}
                </span>
                <div>
                  <div className="flex items-center gap-2 text-sm font-bold text-white">
                    {pack.credits.toLocaleString()} credits
                    {pack.featured && (
                      <span className="rounded-full bg-tbc-500 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-slate-950">
                        Popular
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-slate-400">{pack.blurb}</div>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="text-right">
                  <div className="text-base font-bold text-white">${pack.price}</div>
                  <div className="text-[10px] text-slate-500">
                    ${(pack.price / pack.credits).toFixed(3)} / credit
                  </div>
                </div>
                {busy === pack.credits ? <Loader2 className="h-4 w-4 animate-spin text-tbc-300" /> : null}
              </div>
            </button>
          ))}
        </div>

        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <button
            onClick={() => { onOpenChange(false); navigate('/pricing'); }}
            data-testid="out-of-credits-see-plans"
            className="inline-flex items-center justify-center gap-1.5 rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-800"
          >
            <Rocket className="h-3.5 w-3.5" /> See full plans
          </button>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            data-testid="out-of-credits-cancel"
            className="text-slate-400 hover:bg-slate-800 hover:text-white"
          >
            Maybe later
          </Button>
        </div>

        {user?.plan && (
          <div className="mt-2 border-t border-slate-800 pt-2 text-center text-[11px] text-slate-500">
            You&apos;re currently on the{' '}
            <span className="font-semibold text-slate-300 uppercase tracking-wider">{user.plan}</span>{' '}
            plan
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

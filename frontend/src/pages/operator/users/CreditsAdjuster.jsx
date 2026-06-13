import React, { useState } from 'react';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import {
  Popover, PopoverContent, PopoverTrigger,
} from '../../../components/ui/popover';
import { CoinsIcon, Plus, Minus, Loader2 } from 'lucide-react';

const QUICK_AMOUNTS = [100, 250, 500, 1000];

/**
 * Per-user credits adjuster. Lets the operator hand out + or − credits in
 * one or two clicks. Replaces the old hard-coded `+100` button.
 *
 * Calls `onGrant(userId, signedAmount)` where signedAmount is negative for
 * deductions.
 */
export function CreditsAdjuster({ userId, currentCredits, onGrant }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState('add');     // 'add' | 'deduct'
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);

  const apply = async (raw) => {
    const n = Math.abs(parseInt(raw, 10));
    if (!Number.isFinite(n) || n <= 0) return;
    const signed = mode === 'deduct' ? -n : n;
    setBusy(true);
    try {
      await onGrant(userId, signed);
      setOpen(false);
      setCustom('');
    } finally {
      setBusy(false);
    }
  };

  const Icon = mode === 'deduct' ? Minus : Plus;
  const accent = mode === 'deduct'
    ? 'border-rose-900/60 text-rose-300 hover:bg-rose-500/10'
    : 'border-tbc-900/60 text-tbc-100 hover:bg-ink-900/40';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          data-testid={`op-credits-adjuster-${userId}`}
          className={`bg-ink-900 ${accent}`}
          title="Adjust credits"
        >
          <CoinsIcon className="mr-1 h-3 w-3" /> Credits
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-64 border-tbc-900/60 bg-ink-900 p-3 text-tbc-100"
        data-testid={`op-credits-popover-${userId}`}
      >
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-tbc-200/60">
            Adjust credits
          </span>
          <span className="text-[10px] text-tbc-200/40">
            now: {(currentCredits || 0).toLocaleString()}
          </span>
        </div>

        {/* +/- toggle */}
        <div className="mb-3 grid grid-cols-2 gap-1 rounded-md border border-tbc-900/60 p-0.5">
          <button
            type="button"
            onClick={() => setMode('add')}
            data-testid={`op-credits-mode-add-${userId}`}
            className={`flex items-center justify-center gap-1 rounded px-2 py-1 text-xs font-semibold transition ${
              mode === 'add' ? 'bg-tbc-500 text-ink-950' : 'text-tbc-200 hover:bg-ink-950'
            }`}
          >
            <Plus className="h-3 w-3" /> Add
          </button>
          <button
            type="button"
            onClick={() => setMode('deduct')}
            data-testid={`op-credits-mode-deduct-${userId}`}
            className={`flex items-center justify-center gap-1 rounded px-2 py-1 text-xs font-semibold transition ${
              mode === 'deduct' ? 'bg-rose-500 text-ink-950' : 'text-tbc-200 hover:bg-ink-950'
            }`}
          >
            <Minus className="h-3 w-3" /> Deduct
          </button>
        </div>

        {/* Quick amounts */}
        <div className="mb-3 grid grid-cols-4 gap-1.5">
          {QUICK_AMOUNTS.map((amt) => (
            <button
              key={amt}
              type="button"
              disabled={busy}
              onClick={() => apply(amt)}
              data-testid={`op-credits-quick-${mode}-${amt}-${userId}`}
              className="rounded-md border border-tbc-900/60 bg-ink-950 px-1 py-1.5 text-xs font-semibold text-tbc-100 transition hover:border-tbc-500/60 hover:bg-ink-900 disabled:opacity-40"
            >
              <Icon className="mx-auto h-3 w-3" />
              <span className="block leading-tight">{amt}</span>
            </button>
          ))}
        </div>

        {/* Custom */}
        <div className="flex items-center gap-1.5">
          <Input
            type="number"
            min="1"
            inputMode="numeric"
            placeholder="Custom"
            value={custom}
            onChange={(e) => setCustom(e.target.value.replace(/[^0-9]/g, ''))}
            data-testid={`op-credits-custom-input-${userId}`}
            className="h-8 bg-ink-950 border-tbc-900/60 text-xs text-tbc-100"
          />
          <Button
            size="sm"
            disabled={busy || !custom}
            onClick={() => apply(custom)}
            data-testid={`op-credits-custom-apply-${userId}`}
            className={`h-8 px-3 font-semibold ${
              mode === 'deduct'
                ? 'bg-rose-500 text-ink-950 hover:bg-rose-400'
                : 'bg-tbc-500 text-ink-950 hover:bg-tbc-400'
            }`}
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Icon className="h-3 w-3" />}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

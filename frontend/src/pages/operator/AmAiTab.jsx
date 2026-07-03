import React, { useCallback, useEffect, useState } from 'react';
import api from '../../lib/api';
import { Button } from '../../components/ui/button';
import { toast } from 'sonner';
import { Switch } from '../../components/ui/switch';
import {
  BrainCircuit, Loader2, Gauge, Sparkles, Zap, Leaf,
  CheckCircle2, AlertTriangle, CreditCard, Info, Wand2, TrendingUp,
} from 'lucide-react';

/**
 * amAI — one dial to trade AI quality vs. cost.
 *
 * The dial defaults to "Max" (the app's original model), so nothing gets worse
 * unless the operator lowers it on purpose. Each tier shows a live estimated
 * cost per request and per 100 requests, and the card up top makes it clear
 * which bill each request lands on.
 */

const TIER_ICON = { max: Sparkles, balanced: Zap, economy: Leaf };
const TIER_ACCENT = {
  max: 'text-tbc-300',
  balanced: 'text-amber-300',
  economy: 'text-emerald-300',
};

const money = (n) =>
  n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(n < 0.01 ? 4 : 3)}`;

export default function AmAiTab() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(null); // tier id being saved
  const [autoSaving, setAutoSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/operator/amai/status');
      setStatus(data);
    } catch {
      toast.error('Failed to load amAI settings');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const setTier = async (tierId) => {
    setSaving(tierId);
    try {
      const { data } = await api.put('/operator/amai/tier', { tier: tierId });
      setStatus((s) => ({ ...s, current_tier: data.current_tier, current_model: data.current_model }));
      toast.success(`AI quality set to ${tierId} · ${data.current_model}`);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not update AI quality');
    } finally {
      setSaving(null);
    }
  };

  const toggleAuto = async (next) => {
    setAutoSaving(true);
    try {
      const { data } = await api.put('/operator/amai/auto', { enabled: next });
      setStatus((s) => ({ ...s, auto_mode: data.auto_mode }));
      toast.success(
        next
          ? 'Automatic mode ON · new chats default to smart routing'
          : 'Automatic mode OFF · new chats use the quality dial below'
      );
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not toggle Automatic mode');
    } finally {
      setAutoSaving(false);
    }
  };

  if (loading || !status) {
    return (
      <div className="grid place-items-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-tbc-400" />
      </div>
    );
  }

  const { tiers, current_tier, billing, estimate_basis, auto_routing, spend } = status;
  const billingOk = billing.path !== 'emergent_fallback';

  return (
    <div className="space-y-6" data-testid="amai-tab">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="grid h-10 w-10 place-items-center rounded-xl bg-tbc-500/15 text-tbc-300">
          <BrainCircuit className="h-5 w-5" />
        </div>
        <div>
          <h2 className="text-xl font-bold text-tbc-100">amAI</h2>
          <p className="text-sm text-tbc-200/60">
            One dial for how smart (and how expensive) your AI is. Applies to new
            chats — your existing chats keep their current model.
          </p>
        </div>
      </div>

      {/* Billing path */}
      <div
        className={`rounded-xl border p-4 ${
          billingOk
            ? 'border-emerald-500/30 bg-emerald-500/[0.06]'
            : 'border-amber-500/40 bg-amber-500/[0.08]'
        }`}
        data-testid="amai-billing"
      >
        <div className="flex items-start gap-3">
          {billingOk
            ? <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-300" />
            : <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" />}
          <div className="text-sm">
            <div className="flex items-center gap-2 font-semibold text-tbc-100">
              <CreditCard className="h-4 w-4" /> Who pays for AI requests
            </div>
            <p className={`mt-1 ${billingOk ? 'text-emerald-100/80' : 'text-amber-100/80'}`}>
              {billing.detail}
            </p>
            {!billingOk && (
              <p className="mt-1 text-xs text-amber-200/70">
                Tip: open the “My Keys” tab and add your Anthropic key so all
                requests below are billed to your own account.
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Automatic mode */}
      <div
        className="rounded-xl border border-tbc-500/30 bg-gradient-to-br from-tbc-500/[0.06] via-ink-900/60 to-ink-900/60 p-5"
        data-testid="amai-auto"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-tbc-500/15 text-tbc-300">
              <Wand2 className="h-5 w-5" />
            </div>
            <div>
              <h3 className="flex items-center gap-2 text-base font-bold text-tbc-100">
                Automatic mode
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                  status.auto_mode ? 'bg-emerald-500/20 text-emerald-300' : 'bg-tbc-900/70 text-tbc-300'
                }`}>
                  {status.auto_mode ? 'ON' : 'OFF'}
                </span>
              </h3>
              <p className="mt-1 max-w-xl text-sm text-tbc-200/60">
                Picks the best model for the job automatically: coding, debugging,
                review &amp; planning go to the <b className="text-tbc-100">best</b> model,
                while plain questions use the <b className="text-tbc-100">cheapest</b> —
                so everyone gets top quality and low cost at once. When ON, new chats
                default to “Automatic”; anyone can still pick a specific model themselves.
              </p>
            </div>
          </div>
          <Switch
            data-testid="amai-auto-toggle"
            checked={!!status.auto_mode}
            onCheckedChange={toggleAuto}
            disabled={autoSaving}
          />
        </div>

        {auto_routing && (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-tbc-400/30 bg-tbc-500/[0.06] p-3">
              <div className="flex items-center gap-1.5 text-sm font-semibold text-tbc-100">
                <Sparkles className="h-4 w-4 text-tbc-300" /> Best — for real work
              </div>
              <p className="mt-0.5 text-xs text-tbc-200/50">{auto_routing.best_for.join(', ')}</p>
              <div className="mt-2 flex items-center justify-between text-xs">
                <span className="font-mono text-tbc-200/40">{auto_routing.best_model}</span>
                <span className="font-mono font-semibold text-tbc-100">
                  ~{money(auto_routing.best_cost.per_request)}/req
                </span>
              </div>
            </div>
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/[0.06] p-3">
              <div className="flex items-center gap-1.5 text-sm font-semibold text-tbc-100">
                <Leaf className="h-4 w-4 text-emerald-300" /> Cheapest — for questions
              </div>
              <p className="mt-0.5 text-xs text-tbc-200/50">{auto_routing.cheap_for.join(', ')}</p>
              <div className="mt-2 flex items-center justify-between text-xs">
                <span className="font-mono text-tbc-200/40">{auto_routing.cheap_model}</span>
                <span className="font-mono font-semibold text-tbc-100">
                  ~{money(auto_routing.cheap_cost.per_request)}/req
                </span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Monthly spend */}
      {spend && (
        <div
          className="rounded-xl border border-tbc-900/60 bg-ink-900/50 p-5"
          data-testid="amai-spend"
        >
          <div className="mb-3 flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-tbc-300" />
            <h3 className="text-base font-bold text-tbc-100">Spend this month</h3>
            <span className="ml-auto text-2xl font-bold text-tbc-100">
              ~{money(spend.total_est_cost)}
            </span>
          </div>
          <p className="mb-3 text-xs text-tbc-200/50">
            {spend.total_requests.toLocaleString()} request{spend.total_requests === 1 ? '' : 's'} so far · {spend.note}
          </p>
          {spend.by_model.length === 0 ? (
            <p className="text-sm text-tbc-200/40">No AI requests recorded yet this month.</p>
          ) : (
            <div className="space-y-1.5">
              {spend.by_model.map((row) => (
                <div key={row.model} className="flex items-center justify-between rounded-lg bg-ink-950/50 px-3 py-2 text-xs">
                  <span className="truncate font-mono text-tbc-200/70" title={row.model}>{row.model}</span>
                  <span className="ml-3 shrink-0 text-tbc-200/50">
                    {row.requests.toLocaleString()} req · <span className="font-semibold text-tbc-100">~{money(row.est_cost)}</span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Quality dial — tier cards */}
      <div className="rounded-xl border border-tbc-500/30 bg-gradient-to-br from-tbc-500/[0.04] via-ink-900/60 to-ink-900/60 p-5">
        <div className="mb-4 flex items-center gap-2">
          <Gauge className="h-4 w-4 text-tbc-300" />
          <h3 className="text-base font-bold text-tbc-100">Quality dial</h3>
          <span className="ml-auto rounded-full bg-tbc-500/15 px-2 py-0.5 text-xs font-semibold text-tbc-200">
            Now: {current_tier}
          </span>
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          {tiers.map((tier) => {
            const Icon = TIER_ICON[tier.id] || Sparkles;
            const active = tier.id === current_tier;
            const isDefault = tier.id === status.default_tier;
            return (
              <div
                key={tier.id}
                data-testid={`amai-tier-${tier.id}`}
                className={`flex flex-col rounded-xl border p-4 transition ${
                  active
                    ? 'border-tbc-400 bg-tbc-500/10 ring-1 ring-tbc-400/50'
                    : 'border-tbc-900/60 bg-ink-900/50 hover:border-tbc-500/40'
                }`}
              >
                <div className="mb-1 flex items-center justify-between">
                  <span className={`flex items-center gap-1.5 font-bold ${TIER_ACCENT[tier.id] || 'text-tbc-100'}`}>
                    <Icon className="h-4 w-4" /> {tier.label}
                  </span>
                  {isDefault && (
                    <span className="rounded-full bg-tbc-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-tbc-200">
                      default
                    </span>
                  )}
                </div>
                <p className="mb-3 text-xs leading-relaxed text-tbc-200/60">{tier.blurb}</p>

                <div className="mb-3 space-y-1 rounded-lg bg-ink-950/50 p-2.5 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="text-tbc-200/50">Per request</span>
                    <span className="font-mono font-semibold text-tbc-100">
                      ~{money(tier.estimated_cost.per_request)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-tbc-200/50">Per 100</span>
                    <span className="font-mono font-semibold text-tbc-100">
                      ~{money(tier.estimated_cost.per_100_requests)}
                    </span>
                  </div>
                  <div className="truncate pt-1 font-mono text-[10px] text-tbc-200/40" title={tier.model}>
                    {tier.model}
                  </div>
                </div>

                <Button
                  onClick={() => setTier(tier.id)}
                  disabled={active || saving !== null}
                  data-testid={`amai-select-${tier.id}`}
                  className={`mt-auto w-full font-semibold ${
                    active
                      ? 'bg-tbc-500/20 text-tbc-200'
                      : 'bg-tbc-500 text-ink-950 hover:bg-tbc-400'
                  }`}
                >
                  {saving === tier.id
                    ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                    : active
                      ? <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
                      : null}
                  {active ? 'Selected' : 'Use this'}
                </Button>
              </div>
            );
          })}
        </div>

        <p className="mt-4 flex items-start gap-1.5 text-xs text-tbc-200/50">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Estimates assume ~{estimate_basis.input_tokens.toLocaleString()} input +
          {' '}~{estimate_basis.output_tokens.toLocaleString()} output tokens per request.
          {' '}{estimate_basis.note}
        </p>
      </div>
    </div>
  );
}

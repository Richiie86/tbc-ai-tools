import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import Navbar from '../components/Navbar';
import api from '../lib/api';
import { Button } from '../components/ui/button';
import { toast } from 'sonner';
import {
  CreditCard, Wallet, Building2, Bitcoin, Loader2, ChevronRight, ArrowLeft, ShieldCheck,
} from 'lucide-react';

const icons = { card: CreditCard, paypal: Wallet, crypto_auto: Bitcoin, crypto_manual: Bitcoin, bank: Building2 };

export default function PayMethod() {
  const [search] = useSearchParams();
  const planId = search.get('plan');
  const [plan, setPlan] = useState(null);
  const [methods, setMethods] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!planId) { navigate('/pricing'); return; }
    (async () => {
      try {
        const [plans, ms] = await Promise.all([
          api.get('/payments/plans'),
          api.get('/payments/methods'),
        ]);
        const p = plans.data.find((x) => x.id === planId);
        if (!p) { toast.error('Plan not found'); navigate('/pricing'); return; }
        setPlan(p);
        setMethods(ms.data);
      } catch { toast.error('Failed to load payment options'); }
      finally { setLoading(false); }
    })();
  // eslint-disable-next-line
  }, [planId]);

  const choose = async (m) => {
    setBusy(m.id);
    try {
      if (m.id === 'card') {
        const { data } = await api.post('/payments/checkout', { plan_id: planId, origin_url: window.location.origin });
        window.location.href = data.url;
        return;
      }
      if (m.id === 'crypto_manual') { navigate(`/pay/manual?plan=${planId}&method=crypto_manual`); return; }
      if (m.id === 'bank') { navigate(`/pay/manual?plan=${planId}&method=bank`); return; }
      if (m.id === 'paypal') {
        const { data } = await api.post('/payments/paypal/create', { plan_id: planId, origin_url: window.location.origin });
        window.location.href = data.approval_url;
        return;
      }
      if (m.id === 'crypto_auto') { toast.info('NOWPayments is not fully configured yet — the operator must add an API key.'); }
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not start payment');
    } finally {
      setBusy(null);
    }
  };

  if (loading) return <div className="grid min-h-screen place-items-center bg-ink-950"><Loader2 className="h-7 w-7 animate-spin text-tbc-400" /></div>;

  return (
    <div className="min-h-screen bg-ink-950">
      <Navbar />
      <section className="mx-auto max-w-3xl px-5 py-12">
        <Link to="/pricing" className="mb-6 inline-flex items-center gap-1.5 text-sm text-tbc-200/70 hover:text-tbc-100">
          <ArrowLeft className="h-4 w-4" /> Back to plans
        </Link>
        <div className="rounded-2xl border border-tbc-900/60 bg-ink-900/60 p-7">
          <div className="text-xs font-semibold uppercase tracking-[0.2em] text-tbc-400">Checkout</div>
          <h1 className="mt-2 text-3xl font-bold text-tbc-50">Choose how to pay</h1>
          <div className="mt-3 flex items-baseline gap-2 text-tbc-200">
            <span className="text-2xl font-bold text-tbc-100">{plan.name}</span>
            <span className="text-xl text-tbc-300">• ${plan.price} {plan.intro && plan.regular_price > plan.price ? <span className="text-xs text-tbc-200/60">first month, then ${plan.regular_price}/mo</span> : null}</span>
          </div>
          <p className="mt-1 text-xs text-tbc-200/60">{plan.credits?.toLocaleString()} AI messages included</p>

          <div className="mt-6 space-y-2">
            {methods.map((m) => {
              const Icon = icons[m.id] || CreditCard;
              return (
                <button
                  key={m.id}
                  disabled={busy === m.id}
                  onClick={() => choose(m)}
                  className="group flex w-full items-center gap-3 rounded-xl border border-tbc-900/60 bg-ink-950 p-4 text-left transition-colors hover:border-tbc-500/40"
                >
                  <div className="grid h-10 w-10 place-items-center rounded-lg bg-tbc-500/15 text-tbc-300"><Icon className="h-5 w-5" /></div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-tbc-100">{m.label}</span>
                      {m.instant && <span className="rounded-full bg-tbc-500/15 px-1.5 py-0.5 text-[10px] uppercase text-tbc-300">instant</span>}
                    </div>
                    <div className="mt-0.5 text-xs text-tbc-200/60">{m.description}</div>
                  </div>
                  {busy === m.id ? <Loader2 className="h-4 w-4 animate-spin text-tbc-300" /> : <ChevronRight className="h-4 w-4 text-tbc-300" />}
                </button>
              );
            })}
          </div>

          <div className="mt-6 flex items-center justify-center gap-2 text-[11px] text-tbc-200/50">
            <ShieldCheck className="h-3.5 w-3.5 text-tbc-300" />
            All payments are encrypted in transit. Card details never touch our servers.
          </div>
        </div>
      </section>
    </div>
  );
}

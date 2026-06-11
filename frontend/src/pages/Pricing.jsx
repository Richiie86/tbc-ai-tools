import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Navbar from '../components/Navbar';
import Footer from '../components/Footer';
import { Button } from '../components/ui/button';
import { Check, Sparkles, Zap, Crown, Loader2 } from 'lucide-react';
import api from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { toast } from 'sonner';

const icons = { starter: Sparkles, pro: Zap, enterprise: Crown };

export default function Pricing() {
  const [plans, setPlans] = useState([]);
  const [loadingPlan, setLoadingPlan] = useState(null);
  const { user } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    api.get('/payments/plans').then((r)=>setPlans(r.data)).catch(()=>{});
  }, []);

  const checkout = async (planId) => {
    if (!user) { navigate('/login'); return; }
    setLoadingPlan(planId);
    try {
      const origin_url = window.location.origin;
      const { data } = await api.post('/payments/checkout', { plan_id: planId, origin_url });
      window.location.href = data.url;
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Checkout failed');
      setLoadingPlan(null);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950">
      <Navbar />
      <section className="mx-auto max-w-7xl px-5 py-20">
        <div className="text-center">
          <div className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-400">Pricing</div>
          <h1 className="mt-3 text-5xl font-bold tracking-tight text-white md:text-6xl">Plans for every operator.</h1>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-slate-400">
            Start free with 50 messages. Upgrade anytime — your conversations come with you.
          </p>
        </div>

        <div className="mt-14 grid gap-6 lg:grid-cols-3">
          {plans.map((p, idx) => {
            const Icon = icons[p.id] || Sparkles;
            const featured = p.id === 'pro';
            return (
              <div key={p.id} className={`relative rounded-2xl border p-7 ${featured ? 'border-emerald-500/60 bg-slate-900/80 shadow-2xl shadow-emerald-500/10 scale-[1.02]' : 'border-slate-800 bg-slate-900/50'}`}>
                {featured && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-emerald-500 px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-950">Most popular</div>
                )}
                <div className="flex items-center gap-3">
                  <div className={`grid h-11 w-11 place-items-center rounded-lg ${featured ? 'bg-emerald-500 text-slate-950' : 'bg-emerald-500/15 text-emerald-300'}`}>
                    <Icon className="h-5 w-5" />
                  </div>
                  <div>
                    <div className="text-xl font-bold text-white">{p.name}</div>
                    <div className="text-xs uppercase tracking-wider text-slate-500">Monthly</div>
                  </div>
                </div>
                <div className="mt-6 flex items-baseline gap-1">
                  <div className="text-5xl font-bold text-white">${p.price}</div>
                  <div className="text-sm text-slate-400">/mo</div>
                </div>
                <div className="mt-1 text-sm text-emerald-300">{p.credits.toLocaleString()} AI messages included</div>
                <ul className="mt-6 space-y-3">
                  {p.features.map((f) => (
                    <li key={f} className="flex items-start gap-2.5 text-sm text-slate-200">
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" /> {f}
                    </li>
                  ))}
                </ul>
                <Button onClick={()=>checkout(p.id)} disabled={loadingPlan === p.id} className={`mt-8 w-full font-semibold ${featured ? 'bg-emerald-500 text-slate-950 hover:bg-emerald-400' : 'bg-slate-800 text-white hover:bg-slate-700 border border-slate-700'}`}>
                  {loadingPlan === p.id ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  {user?.plan === p.id ? 'Current plan' : 'Get ' + p.name}
                </Button>
              </div>
            );
          })}
        </div>

        <div className="mt-12 rounded-xl border border-slate-800 bg-slate-900/40 p-5 text-center text-sm text-slate-400">
          All plans include unlimited chat sessions, exportable history, and access to all supported AI models.
          Cancel anytime in your dashboard.
        </div>
      </section>
      <Footer />
    </div>
  );
}

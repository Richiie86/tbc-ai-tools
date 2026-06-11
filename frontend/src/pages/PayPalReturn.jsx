import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { Loader2, CheckCircle2, XCircle } from 'lucide-react';
import api from '../lib/api';
import Navbar from '../components/Navbar';

export default function PayPalReturn() {
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const [state, setState] = useState({ phase: 'capturing', message: 'Finalising your PayPal payment…' });

  useEffect(() => {
    const orderId = search.get('token'); // PayPal returns ?token=ORDER_ID&PayerID=...
    if (!orderId) {
      setState({ phase: 'error', message: 'Missing PayPal order id.' });
      return;
    }
    let cancelled = false;
    const run = async () => {
      try {
        const { data } = await api.post(`/payments/paypal/capture/${orderId}`);
        if (cancelled) return;
        setState({ phase: 'done', message: `Payment confirmed. Your ${data.plan_id} plan is active.` });
        setTimeout(() => { if (!cancelled) navigate('/dashboard'); }, 2200);
      } catch (e) {
        if (cancelled) return;
        setState({ phase: 'error', message: e?.response?.data?.detail || 'Could not confirm PayPal payment.' });
      }
    };
    run();
    return () => { cancelled = true; };
  }, [search, navigate]);

  return (
    <div className="min-h-screen bg-ink-950">
      <Navbar minimal />
      <section className="mx-auto max-w-md px-5 py-20" data-testid="paypal-return-page">
        <div className="rounded-2xl border border-tbc-900/60 bg-ink-900/60 p-10 text-center">
          {state.phase === 'capturing' && (
            <>
              <Loader2 className="mx-auto h-10 w-10 animate-spin text-tbc-400" />
              <h1 className="mt-5 text-xl font-bold text-tbc-50">Confirming with PayPal</h1>
            </>
          )}
          {state.phase === 'done' && (
            <>
              <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-400" />
              <h1 className="mt-5 text-xl font-bold text-tbc-50">Payment successful</h1>
            </>
          )}
          {state.phase === 'error' && (
            <>
              <XCircle className="mx-auto h-10 w-10 text-rose-400" />
              <h1 className="mt-5 text-xl font-bold text-tbc-50">Payment not confirmed</h1>
            </>
          )}
          <p className="mt-3 text-sm text-tbc-200/70" data-testid="paypal-return-message">{state.message}</p>
          {state.phase !== 'capturing' && (
            <div className="mt-6">
              <Link to="/pricing" className="text-sm text-tbc-300 hover:text-tbc-100" data-testid="paypal-return-back">
                ← Back to pricing
              </Link>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

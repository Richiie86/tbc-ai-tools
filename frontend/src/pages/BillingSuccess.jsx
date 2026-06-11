import React, { useEffect, useState } from 'react';
import { useSearchParams, useNavigate, Link } from 'react-router-dom';
import Navbar from '../components/Navbar';
import api from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { Button } from '../components/ui/button';
import { Check, Loader2, Sparkles, XCircle } from 'lucide-react';

export default function BillingSuccess() {
  const [params] = useSearchParams();
  const sessionId = params.get('session_id');
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const [status, setStatus] = useState('checking'); // checking | paid | failed | expired | pending
  const [info, setInfo] = useState(null);

  useEffect(() => {
    if (!sessionId) { navigate('/pricing'); return; }
    let attempts = 0;
    let cancelled = false;

    const poll = async () => {
      attempts++;
      try {
        const { data } = await api.get(`/payments/status/${sessionId}`);
        setInfo(data);
        if (data.payment_status === 'paid') {
          if (!cancelled) { setStatus('paid'); refresh(); }
          return;
        }
        if (data.status === 'expired') {
          if (!cancelled) setStatus('expired');
          return;
        }
        if (attempts >= 10) {
          if (!cancelled) setStatus('pending');
          return;
        }
        setTimeout(poll, 2000);
      } catch (e) {
        if (!cancelled) setStatus('failed');
      }
    };
    poll();
    return () => { cancelled = true; };
  // eslint-disable-next-line
  }, [sessionId]);

  return (
    <div className="min-h-screen bg-ink-950">
      <Navbar />
      <div className="mx-auto max-w-xl px-5 py-20">
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-10 text-center">
          {status === 'checking' && (
            <>
              <Loader2 className="mx-auto h-10 w-10 animate-spin text-tbc-400" />
              <h1 className="mt-5 text-2xl font-bold text-white">Confirming your payment…</h1>
              <p className="mt-2 text-sm text-slate-400">This usually takes a few seconds.</p>
            </>
          )}
          {status === 'paid' && (
            <>
              <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-tbc-500/20 text-tbc-300">
                <Check className="h-7 w-7" />
              </div>
              <h1 className="mt-5 text-3xl font-bold text-white">You’re upgraded!</h1>
              <p className="mt-2 text-sm text-slate-400">
                Welcome to the <span className="font-semibold text-tbc-300">{info?.plan_id?.toUpperCase()}</span> plan. Credits have been added to your account.
              </p>
              <div className="mt-7 flex justify-center gap-3">
                <Link to="/dashboard">
                  <Button className="bg-tbc-500 text-slate-950 hover:bg-tbc-400 font-semibold">
                    <Sparkles className="mr-2 h-4 w-4" /> Open dashboard
                  </Button>
                </Link>
              </div>
            </>
          )}
          {(status === 'failed' || status === 'expired' || status === 'pending') && (
            <>
              <XCircle className="mx-auto h-10 w-10 text-rose-400" />
              <h1 className="mt-5 text-2xl font-bold text-white">
                {status === 'expired' ? 'Checkout expired' : status === 'pending' ? 'Still processing' : 'Payment failed'}
              </h1>
              <p className="mt-2 text-sm text-slate-400">Please try again or contact support.</p>
              <div className="mt-6 flex justify-center gap-3">
                <Link to="/pricing">
                  <Button className="bg-tbc-500 text-slate-950 hover:bg-tbc-400 font-semibold">Back to pricing</Button>
                </Link>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

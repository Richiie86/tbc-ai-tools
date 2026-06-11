import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import Navbar from '../components/Navbar';
import api from '../lib/api';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { toast } from 'sonner';
import {
  ArrowLeft, Copy, Check, Loader2, ShieldCheck, Wallet, Building2,
} from 'lucide-react';

export default function PayManual() {
  const [search] = useSearchParams();
  const planId = search.get('plan');
  const method = search.get('method');
  const [plan, setPlan] = useState(null);
  const [dest, setDest] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [proof, setProof] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [copied, setCopied] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    if (!planId || !method) { navigate('/pricing'); return; }
    (async () => {
      try {
        const [plans, dr] = await Promise.all([
          api.get('/payments/plans'),
          api.get('/payments/treasury/active', { params: { method } }),
        ]);
        const p = plans.data.find((x) => x.id === planId);
        if (!p) throw new Error('Plan not found');
        setPlan(p);
        setDest(dr.data);
      } catch (e) {
        setError(e?.response?.data?.detail || e.message);
      } finally { setLoading(false); }
    })();
  // eslint-disable-next-line
  }, []);

  const copy = (label, value) => {
    navigator.clipboard.writeText(value || '');
    setCopied(label);
    setTimeout(() => setCopied(''), 1500);
  };

  const submit = async () => {
    if (!proof.trim()) return toast.error('Please paste your transaction hash or bank reference');
    setSubmitting(true);
    try {
      await api.post('/payments/manual', {
        plan_id: planId,
        method,
        treasury_id: dest.id,
        proof: proof.trim(),
        note,
      });
      setSubmitted(true);
      toast.success('Submitted! The operator will confirm shortly.');
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Submission failed');
    } finally { setSubmitting(false); }
  };

  if (loading) return <div className="grid min-h-screen place-items-center bg-ink-950"><Loader2 className="h-7 w-7 animate-spin text-tbc-400" /></div>;

  if (error) {
    return (
      <div className="min-h-screen bg-ink-950">
        <Navbar />
        <div className="mx-auto max-w-xl px-5 py-16 text-center">
          <div className="rounded-2xl border border-rose-900/60 bg-rose-500/[0.05] p-8">
            <h2 className="text-xl font-bold text-tbc-50">{error}</h2>
            <p className="mt-2 text-sm text-tbc-200/60">Please try a different payment method or contact support.</p>
            <Link to={`/pay?plan=${planId}`}><Button className="mt-6 bg-tbc-500 text-ink-950 hover:bg-tbc-400 font-semibold">Back to payment methods</Button></Link>
          </div>
        </div>
      </div>
    );
  }

  const isCrypto = method === 'crypto_manual';

  if (submitted) {
    return (
      <div className="min-h-screen bg-ink-950">
        <Navbar />
        <div className="mx-auto max-w-xl px-5 py-16 text-center">
          <div className="rounded-2xl border border-tbc-500/30 bg-tbc-500/[0.05] p-8">
            <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-tbc-500/20 text-tbc-300"><Check className="h-7 w-7" /></div>
            <h2 className="mt-5 text-2xl font-bold text-tbc-50">Proof submitted</h2>
            <p className="mt-2 text-sm text-tbc-200/70">Your payment is queued for operator review. You’ll be upgraded as soon as it’s confirmed.</p>
            <Link to="/dashboard"><Button className="mt-6 bg-tbc-500 text-ink-950 hover:bg-tbc-400 font-semibold">Go to dashboard</Button></Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-ink-950">
      <Navbar />
      <section className="mx-auto max-w-3xl px-5 py-12">
        <Link to={`/pay?plan=${planId}`} className="mb-6 inline-flex items-center gap-1.5 text-sm text-tbc-200/70 hover:text-tbc-100">
          <ArrowLeft className="h-4 w-4" /> Back to methods
        </Link>
        <div className="rounded-2xl border border-tbc-900/60 bg-ink-900/60 p-7">
          <div className="flex items-center gap-2">
            <div className="grid h-9 w-9 place-items-center rounded-lg bg-tbc-500/15 text-tbc-300">
              {isCrypto ? <Wallet className="h-4 w-4" /> : <Building2 className="h-4 w-4" />}
            </div>
            <div>
              <h1 className="text-xl font-bold text-tbc-50">{isCrypto ? 'Pay with crypto' : 'Pay by bank transfer'}</h1>
              <p className="text-xs text-tbc-200/60">{plan.name} • ${plan.price}</p>
            </div>
          </div>

          <div className="mt-6 rounded-xl border border-tbc-900/60 bg-ink-950 p-5">
            <div className="text-xs font-semibold uppercase tracking-wider text-tbc-300">Send payment to</div>
            <div className="mt-1 text-sm text-tbc-100">{dest.label}</div>

            {isCrypto ? (
              <div className="mt-4 grid gap-5 sm:grid-cols-[180px_1fr] sm:items-start">
                {dest.qr_data_url && (
                  <div className="rounded-lg border border-tbc-900/60 bg-ink-900 p-2">
                    <img src={dest.qr_data_url} alt="Wallet QR" className="h-44 w-44" />
                    <div className="mt-1 text-center text-[10px] uppercase tracking-wider text-tbc-300">{dest.network}</div>
                  </div>
                )}
                <div className="space-y-3">
                  <Row label="Network" value={dest.network} />
                  <CopyRow label="Wallet address" value={dest.wallet_address} onCopy={() => copy('addr', dest.wallet_address)} copied={copied === 'addr'} mono />
                  {dest.memo && <Row label="Memo / tag" value={dest.memo} />}
                  <CopyRow label="Amount" value={`$${plan.price.toFixed(2)}`} onCopy={() => copy('amt', String(plan.price))} copied={copied === 'amt'} />
                  <p className="pt-1 text-[11px] text-tbc-200/50">Send the equivalent value of the listed amount in the network above. After sending, paste your transaction hash below.</p>
                </div>
              </div>
            ) : (
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <CopyRow label="Holder name" value={dest.holder_name} onCopy={() => copy('holder', dest.holder_name)} copied={copied === 'holder'} />
                <CopyRow label="Bank" value={dest.bank_name} onCopy={() => copy('bank', dest.bank_name)} copied={copied === 'bank'} />
                <CopyRow label="IBAN" value={dest.iban} onCopy={() => copy('iban', dest.iban)} copied={copied === 'iban'} mono />
                <CopyRow label="BIC / SWIFT" value={dest.bic} onCopy={() => copy('bic', dest.bic)} copied={copied === 'bic'} mono />
                {dest.bank_address && <CopyRow label="Bank address" value={dest.bank_address} onCopy={() => copy('bad', dest.bank_address)} copied={copied === 'bad'} />}
                <CopyRow label="Amount" value={`$${plan.price.toFixed(2)}`} onCopy={() => copy('amt', String(plan.price))} copied={copied === 'amt'} />
                <CopyRow label="Reference" value={dest.reference || `TBC-${planId.toUpperCase()}`} onCopy={() => copy('ref', dest.reference || `TBC-${planId.toUpperCase()}`)} copied={copied === 'ref'} />
              </div>
            )}
          </div>

          <div className="mt-6 space-y-3">
            <div>
              <label className="text-xs font-semibold uppercase tracking-wider text-tbc-200/60">{isCrypto ? 'Transaction hash' : 'Bank reference / transfer ID'}</label>
              <Input className="mt-1.5 bg-ink-950 border-tbc-900/60 text-tbc-100 font-mono text-xs" value={proof} onChange={(e) => setProof(e.target.value)} placeholder={isCrypto ? '0x... or txid' : 'Your bank transfer reference'} />
            </div>
            <div>
              <label className="text-xs font-semibold uppercase tracking-wider text-tbc-200/60">Note to operator (optional)</label>
              <Textarea rows={2} className="mt-1.5 bg-ink-950 border-tbc-900/60 text-tbc-100" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anything we should know…" />
            </div>
            <Button onClick={submit} disabled={submitting} className="w-full bg-tbc-500 text-ink-950 hover:bg-tbc-400 font-semibold">
              {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Submit proof for review
            </Button>
          </div>

          <div className="mt-5 flex items-center justify-center gap-2 text-[11px] text-tbc-200/50">
            <ShieldCheck className="h-3.5 w-3.5 text-tbc-300" />
            Your plan is activated as soon as the operator confirms receipt (usually within a few hours).
          </div>
        </div>
      </section>
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-tbc-200/50">{label}</div>
      <div className="text-sm text-tbc-100">{value || '—'}</div>
    </div>
  );
}
function CopyRow({ label, value, onCopy, copied, mono }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-tbc-200/50">{label}</div>
      <div className="mt-0.5 flex items-center gap-2">
        <div className={`flex-1 truncate text-sm text-tbc-100 ${mono ? 'font-mono text-xs' : ''}`}>{value || '—'}</div>
        <button onClick={onCopy} className="rounded-md border border-tbc-900/60 bg-ink-900 p-1.5 text-tbc-200 hover:bg-ink-950">
          {copied ? <Check className="h-3.5 w-3.5 text-tbc-300" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      </div>
    </div>
  );
}

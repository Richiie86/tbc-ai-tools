import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import Navbar from '../components/Navbar';
import api from '../lib/api';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { toast } from 'sonner';
import { Loader2, KeyRound, MailCheck, ArrowLeft } from 'lucide-react';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!email) return toast.error('Enter your email');
    setLoading(true);
    try {
      await api.post('/auth/forgot-password', { email });
      setSent(true);
    } catch (err) {
      // Backend always returns 200 to prevent enumeration — this branch is only network errors.
      toast.error(err?.response?.data?.detail || 'Could not send reset email');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-ink-950">
      <Navbar minimal />
      <div className="mx-auto grid max-w-md px-5 py-16">
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-8 shadow-2xl shadow-tbc-500/5" data-testid="forgot-password-card">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-lg bg-tbc-500/15 text-tbc-300">
              {sent ? <MailCheck className="h-5 w-5" /> : <KeyRound className="h-5 w-5" />}
            </div>
            <div>
              <h1 className="text-2xl font-bold text-white">{sent ? 'Check your inbox' : 'Reset your password'}</h1>
              <p className="text-xs text-slate-400">
                {sent ? "We've sent you a magic link" : "We'll email you a reset link"}
              </p>
            </div>
          </div>

          {sent ? (
            <div className="mt-7 space-y-4 text-sm text-slate-300" data-testid="forgot-password-sent">
              <p>
                If <span className="font-semibold text-tbc-200">{email}</span> is registered, a reset link is on its way.
                The link expires in 30 minutes.
              </p>
              <p className="text-xs text-slate-500">
                Don&apos;t see it? Check spam, or wait a minute and try again.
              </p>
              <Button
                onClick={() => { setSent(false); setEmail(''); }}
                variant="outline"
                className="w-full border-slate-700 bg-ink-950 text-slate-200 hover:bg-slate-800"
                data-testid="forgot-password-resend"
              >
                Send to a different email
              </Button>
            </div>
          ) : (
            <form onSubmit={submit} className="mt-7 space-y-4">
              <div>
                <label className="text-xs font-semibold uppercase tracking-wider text-slate-400">Email</label>
                <Input
                  data-testid="forgot-password-email"
                  className="mt-1.5 border-slate-700 bg-ink-950 text-slate-100"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  autoFocus
                />
              </div>
              <Button
                disabled={loading}
                type="submit"
                data-testid="forgot-password-submit"
                className="w-full bg-tbc-500 font-semibold text-slate-950 hover:bg-tbc-400"
              >
                {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Send reset link
              </Button>
            </form>
          )}

          <div className="mt-7 border-t border-slate-800 pt-5 text-center text-sm">
            <Link to="/login" className="inline-flex items-center gap-1.5 text-slate-400 hover:text-tbc-300" data-testid="forgot-password-back">
              <ArrowLeft className="h-3.5 w-3.5" /> Back to sign in
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

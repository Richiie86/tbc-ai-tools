import React, { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import Navbar from '../components/Navbar';
import api from '../lib/api';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { useAuth } from '../context/AuthContext';
import { toast } from 'sonner';
import { Loader2, KeyRound, CheckCircle2 } from 'lucide-react';
import PasswordStrengthMeter from '../components/PasswordStrengthMeter';
import PasswordInput from '../components/PasswordInput';
import { evaluatePassword } from '../lib/passwordStrength';

export default function ResetPassword() {
  const [search] = useSearchParams();
  const token = search.get('token') || '';
  const navigate = useNavigate();
  const { saveToken, refresh } = useAuth();
  const [pwd, setPwd] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);

  const ev = evaluatePassword(pwd);

  const submit = async (e) => {
    e.preventDefault();
    if (!token) return toast.error('Missing reset token in URL.');
    if (!ev.meetsMinimum) return toast.error('Password does not meet requirements yet.');
    if (pwd !== confirm) return toast.error('Passwords do not match.');
    setLoading(true);
    try {
      const { data } = await api.post('/auth/reset-password', { token, new_password: pwd });
      saveToken(data.token);
      await refresh();
      toast.success('Password updated — you are signed in.');
      navigate(data.requires_2fa_setup ? '/setup-2fa' : '/dashboard');
    } catch (err) {
      toast.error(err?.response?.data?.detail || 'Could not reset password');
    } finally {
      setLoading(false);
    }
  };

  if (!token) {
    return (
      <div className="min-h-screen bg-ink-950">
        <Navbar minimal />
        <div className="mx-auto max-w-md px-5 py-16">
          <div className="rounded-2xl border border-rose-900/60 bg-slate-900/60 p-8 text-center" data-testid="reset-no-token">
            <h1 className="text-xl font-bold text-rose-300">Invalid reset link</h1>
            <p className="mt-2 text-sm text-slate-400">This URL is missing the reset token.</p>
            <Link to="/forgot-password" className="mt-5 inline-block text-sm text-tbc-300 hover:text-tbc-200">Request a new link →</Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-ink-950">
      <Navbar minimal />
      <div className="mx-auto grid max-w-md px-5 py-16">
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-8 shadow-2xl shadow-tbc-500/5" data-testid="reset-password-card">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-lg bg-tbc-500/15 text-tbc-300">
              <KeyRound className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-white">Choose a new password</h1>
              <p className="text-xs text-slate-400">Min 10 chars · 3+ character classes</p>
            </div>
          </div>

          <form onSubmit={submit} className="mt-7 space-y-4">
            <div>
              <label className="text-xs font-semibold uppercase tracking-wider text-slate-400">New password</label>
              <PasswordInput
                className="mt-1.5 border-slate-700 bg-ink-950 text-slate-100"
                value={pwd}
                onChange={(e) => setPwd(e.target.value)}
                placeholder="••••••••••"
                testId="reset-new-password"
                autoFocus
                autoComplete="new-password"
              />
              <PasswordStrengthMeter password={pwd} />
            </div>
            <div>
              <label className="text-xs font-semibold uppercase tracking-wider text-slate-400">Confirm new password</label>
              <PasswordInput
                className="mt-1.5 border-slate-700 bg-ink-950 text-slate-100"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="••••••••••"
                testId="reset-confirm-password"
                autoComplete="new-password"
              />
              {confirm && pwd && confirm !== pwd && (
                <p className="mt-1 text-[11px] text-rose-400">Passwords do not match</p>
              )}
              {confirm && pwd && confirm === pwd && ev.meetsMinimum && (
                <p className="mt-1 flex items-center gap-1 text-[11px] text-emerald-400">
                  <CheckCircle2 className="h-3 w-3" /> Match
                </p>
              )}
            </div>
            <Button
              disabled={loading || !ev.meetsMinimum || pwd !== confirm}
              type="submit"
              data-testid="reset-submit"
              className="w-full bg-tbc-500 font-semibold text-slate-950 hover:bg-tbc-400"
            >
              {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Update password & sign in
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}

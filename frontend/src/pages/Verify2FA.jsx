import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Navbar from '../components/Navbar';
import api from '../lib/api';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { toast } from 'sonner';
import { Loader2, ShieldCheck } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

export default function Verify2FA() {
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const { saveToken, refresh } = useAuth();

  const submit = async (e) => {
    e.preventDefault();
    if (code.length < 6) return toast.error('Enter the 6-digit code');
    setLoading(true);
    try {
      // The pending_2fa JWT lives in the httpOnly `tbc_session` cookie set at
      // login time. `api` ships cookies via `withCredentials`, so we don't need
      // to (and must not) mirror the token in sessionStorage.
      const { data } = await api.post('/auth/2fa/verify', { code });
      saveToken(data.token);
      await refresh();
      navigate('/dashboard');
    } catch (err) {
      const msg = err?.response?.data?.detail || err?.message || 'Verification failed';
      if (err?.response?.status === 401) {
        // No / expired pending token — push back to login cleanly.
        toast.error('Session expired. Please sign in again.');
        navigate('/login');
        return;
      }
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-ink-950">
      <Navbar minimal />
      <div className="mx-auto max-w-md px-5 py-16">
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-8">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-lg bg-tbc-500/15 text-tbc-300">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-white">Two-factor verification</h1>
              <p className="text-xs text-slate-400">Enter the 6-digit code from your authenticator app</p>
            </div>
          </div>
          <form onSubmit={submit} className="mt-7 space-y-4">
            <Input
              data-testid="verify-2fa-code"
              maxLength={6}
              className="border-slate-700 bg-ink-950 text-center text-3xl tracking-[0.4em] text-tbc-200"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              placeholder="••••••"
              autoFocus
            />
            <Button
              data-testid="verify-2fa-submit"
              disabled={loading}
              className="w-full bg-tbc-500 text-slate-950 hover:bg-tbc-400 font-semibold"
            >
              {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Verify & continue
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}

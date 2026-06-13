import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Navbar from '../components/Navbar';
import api from '../lib/api';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { toast } from 'sonner';
import { Loader2, ShieldCheck, Copy, Check, SkipForward } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

export default function Setup2FA() {
  const [data, setData] = useState(null);
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(true);
  const [verifying, setVerifying] = useState(false);
  const [copied, setCopied] = useState(false);
  const navigate = useNavigate();
  const { refresh, user } = useAuth();

  useEffect(() => {
    (async () => {
      try {
        if (user?.totp_enabled) { navigate('/dashboard'); return; }
        const { data } = await api.post('/auth/2fa/setup');
        setData(data);
      } catch (e) {
        toast.error('Failed to start 2FA setup');
      } finally {
        setLoading(false);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const enable = async (e) => {
    e.preventDefault();
    if (!code || code.length < 6) return toast.error('Enter the 6-digit code');
    setVerifying(true);
    try {
      await api.post('/auth/2fa/enable', { code });
      toast.success('2FA enabled. Your account is now secured.');
      await refresh();
      navigate('/dashboard');
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Invalid code');
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div className="min-h-screen bg-ink-950">
      <Navbar minimal />
      <div className="mx-auto max-w-2xl px-5 py-12">
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-8">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-lg bg-tbc-500/15 text-tbc-300">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-white">Enable two-factor authentication</h1>
              <p className="text-xs text-slate-400">Scan the QR code with Google Authenticator, 1Password, Authy, or any TOTP app.</p>
            </div>
          </div>

          {loading ? (
            <div className="mt-10 grid place-items-center py-10">
              <Loader2 className="h-7 w-7 animate-spin text-tbc-400" />
            </div>
          ) : data ? (
            <div className="mt-7 grid gap-7 md:grid-cols-[auto_1fr]">
              <div className="rounded-xl border border-slate-700 bg-white p-3">
                <img src={data.qr_data_url} alt="2FA QR" className="h-44 w-44" />
              </div>
              <div className="min-w-0">
                <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">Or enter this secret manually</div>
                <div className="mt-2 flex items-center gap-2">
                  <code className="truncate rounded-md border border-slate-700 bg-ink-950 px-3 py-2 text-sm text-tbc-300 flex-1">{data.secret}</code>
                  <Button type="button" variant="outline" className="border-slate-700 bg-slate-900 hover:bg-slate-800" onClick={() => { navigator.clipboard.writeText(data.secret); setCopied(true); setTimeout(()=>setCopied(false), 1800); }}>
                    {copied ? <Check className="h-4 w-4 text-tbc-400" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>

                <form onSubmit={enable} className="mt-6 space-y-3">
                  <label className="text-xs font-semibold uppercase tracking-wider text-slate-400">Enter the 6-digit code from your app</label>
                  <Input maxLength={6} className="border-slate-700 bg-ink-950 text-center text-2xl tracking-[0.4em] text-tbc-200" value={code} onChange={(e)=>setCode(e.target.value.replace(/\D/g,''))} placeholder="••••••" />
                  <Button disabled={verifying} className="w-full bg-tbc-500 text-slate-950 hover:bg-tbc-400 font-semibold">
                    {verifying ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                    Enable 2FA
                  </Button>
                </form>

                {/* Escape hatch — purely client-side navigation, NO API
                    call. The operator's existing session token stays valid;
                    we simply hop straight to the console instead of forcing
                    enrolment on every boot (useful while
                    RESET_OPERATOR_PASSWORD=true clears TOTP at startup). */}
                <button
                  type="button"
                  data-testid="skip-2fa-setup"
                  disabled={!user}
                  onClick={() => navigate(user?.role === 'operator' ? '/operator' : '/dashboard')}
                  className="mt-3 inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-tbc-300 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <SkipForward className="h-3 w-3" />
                  Skip for now — open {user?.role === 'operator' ? 'Operator Console' : 'Dashboard'}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Navbar from '../components/Navbar';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { toast } from 'sonner';
import { Loader2, ShieldCheck } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { API } from '../lib/api';

export default function Verify2FA() {
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const { saveToken, refresh } = useAuth();

  const submit = async (e) => {
    e.preventDefault();
    if (code.length < 6) return toast.error('Enter the 6-digit code');
    const pending = sessionStorage.getItem('tbc_pending_token');
    if (!pending) { navigate('/login'); return; }
    setLoading(true);
    try {
      const res = await fetch(`${API}/auth/2fa/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pending}` },
        body: JSON.stringify({ code }),
      });
      if (!res.ok) { const j = await res.json().catch(()=>({})); throw new Error(j.detail || 'Verification failed'); }
      const data = await res.json();
      sessionStorage.removeItem('tbc_pending_token');
      saveToken(data.token);
      await refresh();
      navigate('/dashboard');
    } catch (e) {
      toast.error(e.message || 'Verification failed');
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
            <Input maxLength={6} className="border-slate-700 bg-ink-950 text-center text-3xl tracking-[0.4em] text-tbc-200" value={code} onChange={(e)=>setCode(e.target.value.replace(/\D/g,''))} placeholder="••••••" autoFocus />
            <Button disabled={loading} className="w-full bg-tbc-500 text-slate-950 hover:bg-tbc-400 font-semibold">
              {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Verify & continue
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}

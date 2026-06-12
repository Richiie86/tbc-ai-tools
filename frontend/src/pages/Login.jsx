import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import Navbar from '../components/Navbar';
import api from '../lib/api';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { useAuth } from '../context/AuthContext';
import { toast } from 'sonner';
import { Loader2, LogIn, ShieldCheck } from 'lucide-react';
import PasswordInput from '../components/PasswordInput';

export default function Login() {
  const [form, setForm] = useState({ email: '', password: '' });
  const [loading, setLoading] = useState(false);
  const { saveToken, refresh } = useAuth();
  const navigate = useNavigate();

  const submit = async (e) => {
    e.preventDefault();
    if (!form.email || !form.password) return toast.error('Enter email and password');
    setLoading(true);
    try {
      const { data } = await api.post('/auth/login', form);
      if (data.pending_2fa) {
        sessionStorage.setItem('tbc_pending_token', data.token);
        navigate('/verify-2fa');
      } else {
        saveToken(data.token);
        await refresh();
        if (data.requires_2fa_setup) {
          toast.info('Enable 2FA to secure your account');
          navigate('/setup-2fa');
        } else {
          navigate('/dashboard');
        }
      }
    } catch (err) {
      toast.error(err?.response?.data?.detail || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-ink-950">
      <Navbar minimal />
      <div className="mx-auto grid max-w-md px-5 py-16">
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-8 shadow-2xl shadow-tbc-500/5">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-lg bg-tbc-500/15 text-tbc-300">
              <LogIn className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-white">Welcome back</h1>
              <p className="text-xs text-slate-400">Sign in to TBC AI Tools</p>
            </div>
          </div>

          <form onSubmit={submit} className="mt-7 space-y-4">
            <div>
              <label className="text-xs font-semibold uppercase tracking-wider text-slate-400">Email</label>
              <Input className="mt-1.5 border-slate-700 bg-ink-950 text-slate-100" type="email" value={form.email} onChange={(e)=>setForm({...form,email:e.target.value})} placeholder="you@example.com" />
            </div>
            <div>
              <label className="text-xs font-semibold uppercase tracking-wider text-slate-400">Password</label>
              <PasswordInput
                className="mt-1.5 border-slate-700 bg-ink-950 text-slate-100"
                value={form.password}
                onChange={(e)=>setForm({...form,password:e.target.value})}
                placeholder="••••••••••"
                testId="login-password"
                autoComplete="current-password"
              />
            </div>
            <Button disabled={loading} type="submit" className="w-full bg-tbc-500 text-slate-950 hover:bg-tbc-400 font-semibold">
              {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Sign in
            </Button>
            <div className="text-right">
              <Link to="/forgot-password" className="text-xs font-medium text-tbc-300 hover:text-tbc-200" data-testid="login-forgot-password">
                Forgot password?
              </Link>
            </div>
          </form>

          <div className="mt-5 flex items-center justify-center gap-2 text-xs text-slate-500">
            <ShieldCheck className="h-3.5 w-3.5 text-tbc-400" /> Protected by TOTP two-factor authentication
          </div>

          <div className="mt-7 border-t border-slate-800 pt-5 text-center text-sm text-slate-400">
            New to TBC AI Tools? <Link to="/register" className="font-semibold text-tbc-400 hover:text-tbc-300">Create an account</Link>
          </div>
        </div>
      </div>
    </div>
  );
}

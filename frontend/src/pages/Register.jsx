import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import Navbar from '../components/Navbar';
import api from '../lib/api';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { useAuth } from '../context/AuthContext';
import { toast } from 'sonner';
import { Loader2, UserPlus } from 'lucide-react';

export default function Register() {
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [loading, setLoading] = useState(false);
  const { saveToken, refresh } = useAuth();
  const navigate = useNavigate();

  const submit = async (e) => {
    e.preventDefault();
    if (!form.email || form.password.length < 8) return toast.error('Email and 8+ char password required');
    setLoading(true);
    try {
      const { data } = await api.post('/auth/register', form);
      saveToken(data.token);
      await refresh();
      toast.success('Welcome! Now secure your account with 2FA.');
      navigate('/setup-2fa');
    } catch (err) {
      toast.error(err?.response?.data?.detail || 'Registration failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-ink-950">
      <Navbar minimal />
      <div className="mx-auto grid max-w-md px-5 py-16">
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-8">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-lg bg-tbc-500/15 text-tbc-300">
              <UserPlus className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-white">Create your account</h1>
              <p className="text-xs text-slate-400">Free • 50 credits to start • No credit card</p>
            </div>
          </div>

          <form onSubmit={submit} className="mt-7 space-y-4">
            <div>
              <label className="text-xs font-semibold uppercase tracking-wider text-slate-400">Name</label>
              <Input className="mt-1.5 border-slate-700 bg-ink-950 text-slate-100" value={form.name} onChange={(e)=>setForm({...form,name:e.target.value})} placeholder="Your name" />
            </div>
            <div>
              <label className="text-xs font-semibold uppercase tracking-wider text-slate-400">Email</label>
              <Input className="mt-1.5 border-slate-700 bg-ink-950 text-slate-100" type="email" value={form.email} onChange={(e)=>setForm({...form,email:e.target.value})} placeholder="you@example.com" />
            </div>
            <div>
              <label className="text-xs font-semibold uppercase tracking-wider text-slate-400">Password <span className="text-slate-500 normal-case">(min 8 chars)</span></label>
              <Input className="mt-1.5 border-slate-700 bg-ink-950 text-slate-100" type="password" value={form.password} onChange={(e)=>setForm({...form,password:e.target.value})} placeholder="••••••••" />
            </div>
            <Button disabled={loading} type="submit" className="w-full bg-tbc-500 text-slate-950 hover:bg-tbc-400 font-semibold">
              {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Create account
            </Button>
          </form>

          <div className="mt-7 border-t border-slate-800 pt-5 text-center text-sm text-slate-400">
            Already have an account? <Link to="/login" className="font-semibold text-tbc-400 hover:text-tbc-300">Sign in</Link>
          </div>
        </div>
      </div>
    </div>
  );
}

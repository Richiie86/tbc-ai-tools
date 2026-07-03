import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import api from '../lib/api';
import { toast } from 'sonner';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import {
  User as UserIcon, Lock, ShieldCheck, Share2, Sparkles, Calculator,
  LogOut, Loader2, Cpu, ChevronLeft, Check, Copy, Coins, Users, MousePointerClick,
  BadgeDollarSign, Crown, Zap, KeyRound, Trash2, Plug,
} from 'lucide-react';

/**
 * Unified account menu for every logged-in user (and the operator).
 * One sorted place to manage: Account (email), Password, Security (2FA),
 * Referrals & Rewards, Plan & Pricing, and a Credits calculator — with
 * sign-out actions pinned to the bottom of the menu.
 */
const SECTIONS = [
  { id: 'account', label: 'Account', icon: UserIcon },
  { id: 'password', label: 'Password', icon: Lock },
  { id: 'security', label: 'Security', icon: ShieldCheck },
  { id: 'referrals', label: 'Referrals & Rewards', icon: Share2 },
  { id: 'plan', label: 'Plan & Pricing', icon: Sparkles },
  { id: 'byok', label: 'Bring your own keys', icon: KeyRound },
  { id: 'calculator', label: 'Credits calculator', icon: Calculator },
];

export default function Settings() {
  const { user, loading, refresh, logout } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const active = SECTIONS.find((s) => s.id === params.get('section'))?.id || 'account';
  const setActive = (id) => setParams({ section: id }, { replace: true });

  if (loading) {
    return <div className="grid min-h-screen place-items-center bg-ink-950"><Loader2 className="h-7 w-7 animate-spin text-tbc-400" /></div>;
  }
  if (!user) { navigate('/login'); return null; }

  return (
    <div className="min-h-screen bg-ink-950 text-tbc-50">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-tbc-900/60 bg-ink-950/80 px-4 py-3 backdrop-blur sm:px-6">
        <Link to="/dashboard" className="flex items-center gap-2">
          <div className="grid h-8 w-8 place-items-center rounded-md bg-gradient-to-br from-tbc-300 to-tbc-500">
            <Cpu className="h-4 w-4 text-ink-950" strokeWidth={2.4} />
          </div>
          <span className="text-sm font-bold">TBC AI Tools</span>
        </Link>
        <Link to="/dashboard" className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-tbc-200/70 hover:bg-ink-900 hover:text-tbc-100">
          <ChevronLeft className="h-3.5 w-3.5" /> Back to app
        </Link>
      </header>

      <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-10">
        <div className="mb-6">
          <h1 className="text-2xl font-bold sm:text-3xl">Settings</h1>
          <p className="mt-1 text-sm text-tbc-200/60">Manage your account, security, rewards, and plan — all in one place.</p>
        </div>

        <div className="flex flex-col gap-6 md:flex-row">
          {/* Nav: horizontal scroll strip on mobile, vertical sidebar on desktop */}
          <nav className="md:w-60 md:shrink-0">
            <div className="flex flex-nowrap gap-1 overflow-x-auto scrollbar-none md:flex-col md:overflow-visible">
              {SECTIONS.map((s) => {
                const Icon = s.icon;
                const on = active === s.id;
                return (
                  <button
                    key={s.id}
                    onClick={() => setActive(s.id)}
                    className={`flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                      on ? 'bg-tbc-500/15 text-tbc-200' : 'text-tbc-200/60 hover:bg-ink-900 hover:text-tbc-100'
                    }`}
                  >
                    <Icon className="h-4 w-4 shrink-0" /> {s.label}
                  </button>
                );
              })}
            </div>

            {/* Sign out — pinned at the bottom of the menu */}
            <div className="mt-3 hidden border-t border-tbc-900/60 pt-3 md:block">
              <SignOutButtons logout={logout} navigate={navigate} />
            </div>
          </nav>

          {/* Section content */}
          <main className="min-w-0 flex-1">
            {active === 'account' && <AccountSection user={user} refresh={refresh} />}
            {active === 'password' && <PasswordSection />}
            {active === 'security' && <SecuritySection user={user} refresh={refresh} />}
            {active === 'referrals' && <ReferralsSection />}
            {active === 'plan' && <PlanSection user={user} />}
            {active === 'byok' && <ByokSection refresh={refresh} />}
            {active === 'calculator' && <CalculatorSection user={user} />}

            {/* Sign out on mobile (nav bottom is hidden on small screens) */}
            <div className="mt-8 border-t border-tbc-900/60 pt-4 md:hidden">
              <SignOutButtons logout={logout} navigate={navigate} />
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Shared bits                                                         */
/* ------------------------------------------------------------------ */
function Card({ title, desc, children }) {
  return (
    <section className="rounded-2xl border border-tbc-900/60 bg-ink-900/50 p-5 sm:p-6">
      {title && <h2 className="text-lg font-bold text-tbc-50">{title}</h2>}
      {desc && <p className="mt-1 text-sm text-tbc-200/60">{desc}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function SignOutButtons({ logout, navigate }) {
  return (
    <div className="space-y-1">
      <button
        onClick={() => { logout(); navigate('/'); }}
        className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium text-tbc-200/80 hover:bg-ink-900 hover:text-tbc-100"
        data-testid="settings-sign-out"
      >
        <LogOut className="h-4 w-4" /> Sign out
      </button>
      <button
        onClick={async () => {
          if (!window.confirm('Sign out of every device including this one?\n\nAny active session elsewhere will stop working immediately.')) return;
          try { await api.post('/auth/sign-out-everywhere'); } catch (e) { /* idempotent */ }
          logout();
          navigate('/');
        }}
        className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-[13px] font-medium text-rose-300/80 hover:bg-rose-500/10 hover:text-rose-200"
      >
        <ShieldCheck className="h-4 w-4" /> Sign out everywhere
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Account (email)                                                     */
/* ------------------------------------------------------------------ */
function AccountSection({ user, refresh }) {
  const [email, setEmail] = useState(user.email || '');
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (email.trim().toLowerCase() === (user.email || '').toLowerCase()) {
      toast.error('That is already your email address'); return;
    }
    setSaving(true);
    try {
      await api.post('/auth/change-email', { new_email: email.trim(), current_password: password });
      toast.success('Email updated');
      setPassword('');
      await refresh();
    } catch (err) {
      toast.error(err?.response?.data?.detail || 'Could not update email');
    } finally { setSaving(false); }
  };

  return (
    <Card title="Account" desc="Your profile and sign-in email.">
      <div className="mb-5 flex items-center gap-3 rounded-xl border border-tbc-900/60 bg-ink-950/60 p-4">
        <div className="grid h-11 w-11 place-items-center rounded-full bg-tbc-500/15 text-tbc-300">
          <UserIcon className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-tbc-50">{user.email}</div>
          <div className="text-xs capitalize text-tbc-200/60">{user.role} · {user.plan} plan</div>
        </div>
      </div>
      <form onSubmit={submit} className="space-y-4">
        <div>
          <Label htmlFor="new-email" className="text-tbc-200/80">Email address</Label>
          <Input id="new-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)}
            className="mt-1.5 border-tbc-900/60 bg-ink-950 text-tbc-100" required />
        </div>
        <div>
          <Label htmlFor="email-pw" className="text-tbc-200/80">Confirm current password</Label>
          <Input id="email-pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            className="mt-1.5 border-tbc-900/60 bg-ink-950 text-tbc-100" placeholder="Required to change email" required />
        </div>
        <Button type="submit" disabled={saving} className="bg-tbc-500 font-semibold text-ink-950 hover:bg-tbc-400">
          {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null} Update email
        </Button>
      </form>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Password                                                            */
/* ------------------------------------------------------------------ */
function PasswordSection() {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (next !== confirm) { toast.error('New passwords do not match'); return; }
    if (next.length < 10) { toast.error('New password must be at least 10 characters'); return; }
    setSaving(true);
    try {
      await api.post('/auth/change-password', { current_password: cur, new_password: next });
      toast.success('Password changed');
      setCur(''); setNext(''); setConfirm('');
    } catch (err) {
      toast.error(err?.response?.data?.detail || 'Could not change password');
    } finally { setSaving(false); }
  };

  return (
    <Card title="Password" desc="Use at least 10 characters. You will stay signed in on this device.">
      <form onSubmit={submit} className="space-y-4">
        <div>
          <Label htmlFor="cur-pw" className="text-tbc-200/80">Current password</Label>
          <Input id="cur-pw" type="password" value={cur} onChange={(e) => setCur(e.target.value)}
            className="mt-1.5 border-tbc-900/60 bg-ink-950 text-tbc-100" required />
        </div>
        <div>
          <Label htmlFor="new-pw" className="text-tbc-200/80">New password</Label>
          <Input id="new-pw" type="password" value={next} onChange={(e) => setNext(e.target.value)}
            className="mt-1.5 border-tbc-900/60 bg-ink-950 text-tbc-100" required />
        </div>
        <div>
          <Label htmlFor="confirm-pw" className="text-tbc-200/80">Confirm new password</Label>
          <Input id="confirm-pw" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)}
            className="mt-1.5 border-tbc-900/60 bg-ink-950 text-tbc-100" required />
        </div>
        <Button type="submit" disabled={saving} className="bg-tbc-500 font-semibold text-ink-950 hover:bg-tbc-400">
          {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null} Change password
        </Button>
      </form>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Security (2FA)                                                      */
/* ------------------------------------------------------------------ */
function SecuritySection({ user, refresh }) {
  const enabled = !!user.totp_enabled;
  const [setupData, setSetupData] = useState(null); // {secret, qr_data_url}
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  const startSetup = async () => {
    setBusy(true);
    try {
      const { data } = await api.post('/auth/2fa/setup');
      setSetupData(data);
    } catch { toast.error('Could not start 2FA setup'); }
    finally { setBusy(false); }
  };

  const confirmEnable = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post('/auth/2fa/enable', { code });
      toast.success('Two-factor authentication enabled');
      setSetupData(null); setCode('');
      await refresh();
    } catch (err) { toast.error(err?.response?.data?.detail || 'Invalid code'); }
    finally { setBusy(false); }
  };

  const disable = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post('/auth/2fa/disable', { code });
      toast.success('Two-factor authentication disabled');
      setCode('');
      await refresh();
    } catch (err) { toast.error(err?.response?.data?.detail || 'Invalid code'); }
    finally { setBusy(false); }
  };

  return (
    <Card title="Security" desc="Protect your account with two-factor authentication (2FA).">
      <div className="mb-4 flex items-center justify-between rounded-xl border border-tbc-900/60 bg-ink-950/60 p-4">
        <div className="flex items-center gap-3">
          <div className={`grid h-10 w-10 place-items-center rounded-full ${enabled ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300'}`}>
            <ShieldCheck className="h-5 w-5" />
          </div>
          <div>
            <div className="text-sm font-semibold text-tbc-50">Two-factor authentication</div>
            <div className="text-xs text-tbc-200/60">{enabled ? 'Enabled — your account is protected.' : 'Not enabled.'}</div>
          </div>
        </div>
        <span className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ${enabled ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/20 text-amber-300'}`}>
          {enabled ? 'On' : 'Off'}
        </span>
      </div>

      {/* Enable flow */}
      {!enabled && !setupData && (
        <Button onClick={startSetup} disabled={busy} className="bg-tbc-500 font-semibold text-ink-950 hover:bg-tbc-400">
          {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null} Enable 2FA
        </Button>
      )}
      {!enabled && setupData && (
        <form onSubmit={confirmEnable} className="space-y-4">
          <p className="text-sm text-tbc-200/70">Scan this QR code with your authenticator app (Google Authenticator, 1Password, Authy), then enter the 6-digit code.</p>
          <img src={setupData.qr_data_url} alt="2FA QR code" className="h-44 w-44 rounded-lg border border-tbc-900/60 bg-white p-2" />
          <p className="text-xs text-tbc-200/50">Can&apos;t scan? Enter this key manually: <span className="font-mono text-tbc-200">{setupData.secret}</span></p>
          <div>
            <Label htmlFor="enable-code" className="text-tbc-200/80">6-digit code</Label>
            <Input id="enable-code" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)}
              className="mt-1.5 w-40 border-tbc-900/60 bg-ink-950 text-center font-mono text-lg tracking-widest text-tbc-100" maxLength={6} required />
          </div>
          <div className="flex gap-2">
            <Button type="submit" disabled={busy} className="bg-tbc-500 font-semibold text-ink-950 hover:bg-tbc-400">
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null} Confirm &amp; enable
            </Button>
            <Button type="button" variant="ghost" onClick={() => { setSetupData(null); setCode(''); }} className="text-tbc-200/70 hover:bg-ink-900">Cancel</Button>
          </div>
        </form>
      )}

      {/* Disable flow */}
      {enabled && (
        <form onSubmit={disable} className="space-y-4">
          <p className="text-sm text-tbc-200/70">Enter a current 6-digit code from your authenticator to turn 2FA off.</p>
          <div>
            <Label htmlFor="disable-code" className="text-tbc-200/80">6-digit code</Label>
            <Input id="disable-code" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)}
              className="mt-1.5 w-40 border-tbc-900/60 bg-ink-950 text-center font-mono text-lg tracking-widest text-tbc-100" maxLength={6} required />
          </div>
          <Button type="submit" disabled={busy} variant="outline" className="border-rose-500/40 text-rose-300 hover:bg-rose-500/10">
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null} Disable 2FA
          </Button>
        </form>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Referrals & Rewards                                                 */
/* ------------------------------------------------------------------ */
function ReferralsSection() {
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api.get('/referral/me').then((r) => setInfo(r.data)).catch(() => toast.error('Could not load referral info')).finally(() => setLoading(false));
  }, []);

  const url = info?.share_url_org || info?.share_url_com || '';
  const copy = () => { if (!url) return; navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1500); };

  if (loading) return <Card title="Referrals & Rewards"><Loader2 className="h-6 w-6 animate-spin text-tbc-400" /></Card>;
  if (!info) return <Card title="Referrals & Rewards" desc="Could not load your referral info right now." />;

  return (
    <Card title="Referrals & Rewards" desc={`Earn ${info.commission_pct}% of every referral's purchase, paid straight to your credits.`}>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MiniStat icon={MousePointerClick} label="Clicks" value={info.stats?.clicks ?? 0} />
        <MiniStat icon={Users} label="Signups" value={info.stats?.signups ?? 0} />
        <MiniStat icon={Coins} label="Credits earned" value={(info.stats?.credits_awarded || 0).toLocaleString()} />
        <MiniStat icon={BadgeDollarSign} label="Gross referred" value={`$${(((info.stats?.accrued_usd || 0) + (info.stats?.paid_usd || 0))).toFixed(2)}`} />
      </div>
      <div className="mt-5">
        <Label className="text-tbc-200/80">Your referral link</Label>
        <div className="mt-1.5 flex items-center gap-2">
          <Input readOnly value={url} className="border-tbc-900/60 bg-ink-950 font-mono text-xs text-tbc-100" />
          <Button onClick={copy} className="shrink-0 bg-tbc-500 font-semibold text-ink-950 hover:bg-tbc-400">
            {copied ? <Check className="mr-1.5 h-4 w-4" /> : <Copy className="mr-1.5 h-4 w-4" />} Copy
          </Button>
        </div>
      </div>
      <Link to="/refer" className="mt-4 inline-block text-sm font-medium text-tbc-300 hover:text-tbc-200">View full earnings history →</Link>
    </Card>
  );
}

function MiniStat({ icon: Icon, label, value }) {
  return (
    <div className="rounded-xl border border-tbc-900/60 bg-ink-950/60 p-3">
      <div className="flex items-center justify-between">
        <div className="text-[10px] uppercase tracking-wider text-tbc-200/60">{label}</div>
        <Icon className="h-3.5 w-3.5 text-tbc-300" />
      </div>
      <div className="mt-1 text-lg font-bold text-tbc-100">{value}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Bring Your Own Keys (BYOK)                                          */
/* ------------------------------------------------------------------ */
const BYOK_PROVIDER_META = {
  anthropic:  { label: 'Anthropic (Claude)', placeholder: 'sk-ant-...', hint: 'console.anthropic.com' },
  openai:     { label: 'OpenAI (GPT)',        placeholder: 'sk-...',     hint: 'platform.openai.com' },
  gemini:     { label: 'Google Gemini',       placeholder: 'AIza...',    hint: 'aistudio.google.com' },
  openrouter: { label: 'OpenRouter (300+ models)', placeholder: 'sk-or-...', hint: 'openrouter.ai/keys' },
};

function ByokSection({ refresh }) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try { const { data } = await api.get('/byok/status'); setStatus(data); }
    catch { toast.error('Could not load your key settings'); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const activate = async () => {
    setBusy(true);
    try {
      const { data } = await api.post('/byok/activate');
      setStatus(data);
      toast.success('Bring Your Own Keys is on — add your provider keys below.');
      refresh?.();
    } catch (err) {
      toast.error(err?.response?.data?.detail || 'Could not activate');
    } finally { setBusy(false); }
  };

  const deactivate = async () => {
    if (!window.confirm('Turn off Bring Your Own Keys?\n\nYour chat will go back to costing 1 credit per message. Your saved keys are kept so you can switch it back on any time.')) return;
    setBusy(true);
    try {
      const { data } = await api.post('/byok/deactivate');
      setStatus(data);
      toast.success('Bring Your Own Keys turned off.');
      refresh?.();
    } catch { toast.error('Could not turn it off'); }
    finally { setBusy(false); }
  };

  if (loading) return <Card title="Bring your own keys"><Loader2 className="h-6 w-6 animate-spin text-tbc-400" /></Card>;
  if (!status) return <Card title="Bring your own keys" desc="Could not load your key settings right now." />;

  const enabled = status.enabled;
  const nextCharge = status.next_charge_at ? new Date(status.next_charge_at).toLocaleDateString() : null;

  return (
    <Card
      title="Bring your own keys"
      desc={`Run the AI on your own provider accounts. ${status.monthly_cost} credits/month — then every message you send is free, billed straight to your own API key instead of your credits.`}
    >
      {/* Status banner */}
      <div className="mb-5 flex flex-col gap-3 rounded-xl border border-tbc-900/60 bg-ink-950/60 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div className={`grid h-11 w-11 place-items-center rounded-full ${enabled ? 'bg-emerald-500/15 text-emerald-300' : 'bg-tbc-500/15 text-tbc-300'}`}>
            <Plug className="h-5 w-5" />
          </div>
          <div>
            <div className="text-sm font-semibold text-tbc-50">
              {enabled ? 'Active' : 'Not active'}
              <span className="ml-2 rounded-full bg-tbc-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-tbc-300">
                {status.monthly_cost} credits/mo
              </span>
            </div>
            <div className="text-xs text-tbc-200/60">
              {enabled
                ? (nextCharge ? `Renews on ${nextCharge}. You have ${status.credits} credits.` : `You have ${status.credits} credits.`)
                : `Costs ${status.monthly_cost} credits to switch on. You have ${status.credits} credits.`}
            </div>
          </div>
        </div>
        {enabled ? (
          <Button onClick={deactivate} disabled={busy} variant="outline"
            className="border-rose-500/40 text-rose-300 hover:bg-rose-500/10">
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null} Turn off
          </Button>
        ) : (
          <Button onClick={activate} disabled={busy || status.credits < status.monthly_cost}
            className="bg-tbc-500 font-semibold text-ink-950 hover:bg-tbc-400">
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {status.credits < status.monthly_cost ? 'Not enough credits' : `Activate for ${status.monthly_cost} credits`}
          </Button>
        )}
      </div>

      {!enabled && (
        <p className="mb-4 rounded-lg border border-tbc-900/60 bg-ink-950/40 px-3 py-2 text-xs text-tbc-200/60">
          Add and manage your keys after you activate. Keys are stored securely and never shown in full again.
        </p>
      )}

      {/* Provider key rows */}
      <div className={`space-y-3 ${enabled ? '' : 'pointer-events-none opacity-50'}`} aria-disabled={!enabled}>
        {status.providers.map((p) => (
          <ByokKeyRow key={p.id} provider={p} onChanged={load} />
        ))}
      </div>
    </Card>
  );
}

function ByokKeyRow({ provider, onChanged }) {
  const meta = BYOK_PROVIDER_META[provider.id] || { label: provider.id, placeholder: '', hint: '' };
  const [value, setValue] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);

  const test = async () => {
    if (!value.trim()) { toast.error('Paste a key first'); return; }
    setTesting(true);
    try {
      const { data } = await api.post('/byok/keys/test', { provider: provider.id, value: value.trim() });
      if (data.ok) toast.success(`Key looks good${data.identity ? ` — ${data.identity}` : ''}`);
      else toast.error(data.error || 'Key failed validation');
    } catch (err) { toast.error(err?.response?.data?.detail || 'Could not test the key'); }
    finally { setTesting(false); }
  };

  const save = async () => {
    if (!value.trim()) { toast.error('Paste a key first'); return; }
    setBusy(true);
    try {
      await api.put('/byok/keys', { provider: provider.id, value: value.trim() });
      toast.success(`${meta.label} key saved`);
      setValue(''); setEditing(false);
      onChanged?.();
    } catch (err) { toast.error(err?.response?.data?.detail || 'Could not save the key'); }
    finally { setBusy(false); }
  };

  const clear = async () => {
    setBusy(true);
    try {
      await api.delete(`/byok/keys/${provider.id}`);
      toast.success(`${meta.label} key removed`);
      onChanged?.();
    } catch { toast.error('Could not remove the key'); }
    finally { setBusy(false); }
  };

  return (
    <div className="rounded-xl border border-tbc-900/60 bg-ink-950/60 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-tbc-50">
            {meta.label}
            {provider.set && (
              <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-300">Set</span>
            )}
          </div>
          <div className="truncate text-xs text-tbc-200/50">
            {provider.set ? `Saved: ${provider.masked}` : `Get one at ${meta.hint}`}
          </div>
        </div>
        {provider.set && !editing && (
          <div className="flex shrink-0 gap-2">
            <Button type="button" variant="ghost" onClick={() => setEditing(true)}
              className="h-8 px-2 text-xs text-tbc-200/70 hover:bg-ink-900">Replace</Button>
            <Button type="button" variant="ghost" onClick={clear} disabled={busy}
              className="h-8 px-2 text-xs text-rose-300/80 hover:bg-rose-500/10">
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      </div>

      {(!provider.set || editing) && (
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <Input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={meta.placeholder}
            className="border-tbc-900/60 bg-ink-950 font-mono text-xs text-tbc-100"
            autoComplete="off"
          />
          <div className="flex shrink-0 gap-2">
            <Button type="button" onClick={test} disabled={testing || busy} variant="outline"
              className="border-tbc-900/60 text-tbc-200 hover:bg-ink-900">
              {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Test'}
            </Button>
            <Button type="button" onClick={save} disabled={busy || testing}
              className="bg-tbc-500 font-semibold text-ink-950 hover:bg-tbc-400">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save'}
            </Button>
            {editing && (
              <Button type="button" variant="ghost" onClick={() => { setEditing(false); setValue(''); }}
                className="text-tbc-200/70 hover:bg-ink-900">Cancel</Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Plan & Pricing                                                      */
/* ------------------------------------------------------------------ */
const PLAN_ICONS = { starter: Sparkles, pro: Zap, enterprise: Crown };

function PlanSection({ user }) {
  const [plans, setPlans] = useState([]);
  const navigate = useNavigate();
  useEffect(() => { api.get('/payments/plans').then((r) => setPlans(r.data)).catch(() => {}); }, []);

  return (
    <Card title="Plan & Pricing" desc={`You are on the ${user.plan} plan.`}>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {plans.map((p) => {
          const Icon = PLAN_ICONS[p.id] || Sparkles;
          const current = user.plan === p.id;
          return (
            <div key={p.id} className={`rounded-xl border p-4 ${current ? 'border-tbc-500/60 bg-tbc-500/5' : 'border-tbc-900/60 bg-ink-950/60'}`}>
              <div className="flex items-center gap-2">
                <div className={`grid h-9 w-9 place-items-center rounded-lg ${current ? 'bg-tbc-500 text-ink-950' : 'bg-tbc-500/15 text-tbc-300'}`}>
                  <Icon className="h-4 w-4" />
                </div>
                <div className="text-sm font-bold text-tbc-50">{p.name}</div>
              </div>
              <div className="mt-3 flex items-baseline gap-1">
                <div className="text-2xl font-bold text-tbc-50">${p.price}</div>
                <div className="text-xs text-tbc-200/50">/mo</div>
              </div>
              <div className="mt-1 text-xs text-tbc-300">{(p.credits || 0).toLocaleString()} AI messages</div>
              <Button
                onClick={() => (user ? navigate(`/pay?plan=${p.id}`) : navigate('/login'))}
                disabled={current}
                className={`mt-4 w-full font-semibold ${current ? 'bg-ink-800 text-tbc-200/60' : 'bg-tbc-500 text-ink-950 hover:bg-tbc-400'}`}
              >
                {current ? 'Current plan' : `Switch to ${p.name}`}
              </Button>
            </div>
          );
        })}
      </div>
      <Link to="/pricing" className="mt-4 inline-block text-sm font-medium text-tbc-300 hover:text-tbc-200">See full pricing details →</Link>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Credits calculator                                                  */
/* ------------------------------------------------------------------ */
function CalculatorSection({ user }) {
  const isOperator = user.role === 'operator';
  const credits = user.credits ?? 0;
  const [perDay, setPerDay] = useState(20);

  const daysLeft = useMemo(() => {
    if (isOperator) return Infinity;
    if (!perDay || perDay <= 0) return null;
    return Math.floor(credits / perDay);
  }, [credits, perDay, isOperator]);

  return (
    <Card title="Credits calculator" desc="Estimate how long your remaining message credits will last.">
      <div className="mb-5 grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-tbc-900/60 bg-ink-950/60 p-4">
          <div className="text-[10px] uppercase tracking-wider text-tbc-200/60">Credits remaining</div>
          <div className="mt-1 text-2xl font-bold text-tbc-100">{isOperator ? '∞' : credits.toLocaleString()}</div>
        </div>
        <div className="rounded-xl border border-tbc-900/60 bg-ink-950/60 p-4">
          <div className="text-[10px] uppercase tracking-wider text-tbc-200/60">Estimated days left</div>
          <div className="mt-1 text-2xl font-bold text-tbc-100">
            {isOperator ? '∞' : daysLeft === null ? '—' : daysLeft.toLocaleString()}
          </div>
        </div>
      </div>
      <div className="max-w-xs">
        <Label htmlFor="per-day" className="text-tbc-200/80">Messages you send per day</Label>
        <Input id="per-day" type="number" min={1} value={perDay}
          onChange={(e) => setPerDay(Number(e.target.value))}
          className="mt-1.5 border-tbc-900/60 bg-ink-950 text-tbc-100" />
      </div>
      {!isOperator && daysLeft !== null && (
        <p className="mt-4 text-sm text-tbc-200/70">
          At {perDay} message{perDay === 1 ? '' : 's'} per day, your {credits.toLocaleString()} credits last about{' '}
          <span className="font-bold text-tbc-100">{daysLeft.toLocaleString()} day{daysLeft === 1 ? '' : 's'}</span>.
          {daysLeft < 7 && <span className="text-amber-300"> Consider upgrading soon.</span>}
        </p>
      )}
      {isOperator && <p className="mt-4 text-sm text-tbc-200/70">As the operator you have unlimited credits.</p>}
      <Link to="/pricing" className="mt-4 inline-block text-sm font-medium text-tbc-300 hover:text-tbc-200">Need more? See plans →</Link>
    </Card>
  );
}

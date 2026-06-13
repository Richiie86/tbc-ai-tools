import React, { useCallback, useEffect, useState } from 'react';
import Navbar from '../components/Navbar';
import api from '../lib/api';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { toast } from 'sonner';
import { useSearchParams } from 'react-router-dom';
import {
  Users, CreditCard, MessageSquare, DollarSign, Loader2, ShieldCheck, Mail,
  Code2, Sparkles, Wallet, KeyRound, Settings as SettingsIcon, Coins,
  FolderKanban, Activity, ScrollText, Megaphone, MessageCircle, FlaskConical,
  TrendingUp, Lock, Brain,
} from 'lucide-react';

import PlansTab     from './operator/PlansTab';
import TreasuryTab  from './operator/TreasuryTab';
import SettingsTab  from './operator/SettingsTab';
import PaymentsTab  from './operator/PaymentsTab';
import LicensesTab  from './operator/LicensesTab';
import RoyaltiesTab from './operator/RoyaltiesTab';
import ProjectsTab  from './operator/ProjectsTab';
import OpsTab       from './operator/OpsTab';
import MoneyTab     from './operator/MoneyTab';
import AuditTab     from './operator/AuditTab';
import MarketingTab from './operator/MarketingTab';
import MessagingTab from './operator/MessagingTab';
import SandboxTab   from './operator/SandboxTab';
import AILearningsTab from './operator/AILearningsTab';
import AnalyticsTab from './operator/AnalyticsTab';
import { StatCard }      from './operator/StatCard';
import { StatsToolbar }  from './operator/StatsToolbar';
import { UsersTab }      from './operator/UsersTab';
import TestUserBanner    from './operator/TestUserBanner';

import { OperatorGuideTour, OperatorGuideButton } from './OperatorGuideTour';
import CodesBrowser from './operator/CodesBrowser';
import { ContactsList } from './operator/ContactsList';

function TabTrigger({ value, icon: Icon, children }) {
  return (
    <TabsTrigger value={value} className="data-[state=active]:bg-tbc-500 data-[state=active]:text-ink-950">
      <Icon className="mr-1.5 h-3.5 w-3.5" /> {children}
    </TabsTrigger>
  );
}

export default function Operator() {
  const [stats, setStats] = useState(null);
  const [users, setUsers] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [loading, setLoading] = useState(true);
  // Controlled tab so the first-time tour can drive the view AND so a
  // deep-link from elsewhere (e.g. /operator?tab=ops from the
  // "Configure Vercel token now" toast) lands the operator straight
  // on the right tab.
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = searchParams.get('tab') || 'users';
  const [activeTab, setActiveTab] = useState(initialTab);
  // Sync `?tab=` → state when the URL changes externally (e.g.
  // operator hits back/forward).
  useEffect(() => {
    const next = searchParams.get('tab');
    if (next && next !== activeTab) setActiveTab(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);
  // And state → URL so the operator can deep-link the current tab.
  const onTabChange = useCallback((next) => {
    setActiveTab(next);
    setSearchParams((prev) => {
      const p = new URLSearchParams(prev);
      p.set('tab', next);
      return p;
    }, { replace: true });
  }, [setSearchParams]);
  // Re-launch handle for the guide. Bumping the counter forces the tour to
  // open even if `tbc_operator_tour_seen_v1` is already set in localStorage.
  const [guideKey, setGuideKey] = useState(0);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [s, u, c] = await Promise.all([
        api.get('/operator/stats'),
        api.get('/operator/users'),
        api.get('/operator/contacts'),
      ]);
      setStats(s.data); setUsers(u.data); setContacts(c.data);
    } catch { toast.error('Failed to load operator data'); }
    finally { setLoading(false); }
  }, []);

  // Refresh stats AND the user list — the user list carries `last_seen_at`
  // which the OnlinePulse uses to render the live online/offline dot.
  // Both calls are cheap projections; doing them on the same tick keeps
  // the operator dashboard consistent without separate timers.
  const refreshStats = useCallback(async () => {
    try {
      const [s, u] = await Promise.all([
        api.get('/operator/stats'),
        api.get('/operator/users'),
      ]);
      setStats(s.data);
      setUsers(u.data);
    } catch { /* silent — surface only on the manual refresh button */ }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  // Real-time-ish: poll stats every 8s while the tab is foregrounded.
  // We pause when the document is hidden so background tabs don't burn
  // requests (and unblock immediately on visibility-change). Drop from
  // 25s → 8s so the cards feel live — operators saw "247 messages, $9
  // revenue" pinned for ages because the refresh was too lazy.
  useEffect(() => {
    let id = setInterval(() => {
      if (!document.hidden) refreshStats();
    }, 8_000);
    const onVis = () => { if (!document.hidden) refreshStats(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVis); };
  }, [refreshStats]);

  return (
    <div className="min-h-screen bg-ink-950">
      <Navbar />
      <section className="mx-auto max-w-7xl px-5 py-10">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="grid h-11 w-11 place-items-center rounded-xl bg-tbc-500/15 text-tbc-300">
              <ShieldCheck className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-3xl font-bold text-tbc-100">Operator Console</h1>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <p className="text-sm text-tbc-200/60">Manage members, payments, plans, treasury, licenses, and source code.</p>
                <span
                  data-testid="founder-royalty-badge"
                  title="10% of every paid transaction in this codebase is owed to the original operator. Baked into founder_royalty.py — cannot be disabled from the UI."
                  onClick={() => setActiveTab('royalties')}
                  className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-tbc-500/40 bg-tbc-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-tbc-300 hover:bg-tbc-500/20"
                >
                  <Lock className="h-2.5 w-2.5" />
                  Founder royalty · 10% active
                </span>
              </div>
            </div>
          </div>
          <OperatorGuideButton onOpen={() => setGuideKey((k) => k + 1)} />
        </div>

        {/* Test-user banner lives OUTSIDE the loading guard so QA can
            still grab preview-user creds when /operator/stats is degraded.
            Its own internal call to /operator/test-user is independent. */}
        <div className="mt-8">
          <TestUserBanner />
        </div>

        {loading ? (
          <div className="mt-16 grid place-items-center">
            <Loader2 className="h-7 w-7 animate-spin text-tbc-400" />
          </div>
        ) : (
          <>
            <div className="mt-8 mb-2 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-emerald-300/80" data-testid="live-stats-pulse">
              <span className="relative flex h-2 w-2">
                <span className="absolute inset-0 inline-flex h-2 w-2 animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
              </span>
              Live · refreshed every 8s
            </div>
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard icon={Users}        label="Total Users"     value={stats?.total_users ?? '–'}
                onClick={() => setActiveTab('users')} hint="View user list" />
              <StatCard icon={CreditCard}   label="Paid Customers"  value={stats?.paid_users ?? '–'}
                onClick={() => setActiveTab('payments')} hint="See payments" />
              <StatCard icon={MessageSquare} label="Total Messages" value={stats?.total_messages?.toLocaleString() ?? '–'}
                onClick={() => setActiveTab('contacts')} hint="Read messages" />
              <StatCard icon={DollarSign}   label="Revenue (USD)"   value={`$${(stats?.revenue_usd ?? 0).toLocaleString()}`}
                onClick={() => setActiveTab('money')} hint="Open Money tab" />
            </div>

            <StatsToolbar stats={stats} onRefresh={loadAll} />

            <Tabs value={activeTab} onValueChange={setActiveTab} className="mt-10">
              <TabsList className="bg-ink-900 border border-tbc-900/60 flex flex-wrap h-auto">
                <TabTrigger value="users"     icon={Users}>Users ({users.length})</TabTrigger>
                <TabTrigger value="analytics" icon={TrendingUp}>Analytics</TabTrigger>
                <TabTrigger value="projects"  icon={FolderKanban}>Projects</TabTrigger>
                <TabTrigger value="plans"     icon={Sparkles}>Plans</TabTrigger>
                <TabTrigger value="payments"  icon={CreditCard}>Payments</TabTrigger>
                <TabTrigger value="treasury"  icon={Wallet}>Treasury</TabTrigger>
                <TabTrigger value="money"     icon={DollarSign}>Money</TabTrigger>
                <TabTrigger value="licenses"  icon={KeyRound}>Licenses</TabTrigger>
                <TabTrigger value="royalties" icon={Coins}>Royalties</TabTrigger>
                <TabTrigger value="settings"  icon={SettingsIcon}>Security</TabTrigger>
                <TabTrigger value="ops"       icon={Activity}>Ops</TabTrigger>
                <TabTrigger value="audit"     icon={ScrollText}>Audit</TabTrigger>
                <TabTrigger value="contacts"  icon={Mail}>Contacts</TabTrigger>
                <TabTrigger value="codes"     icon={Code2}>Codes</TabTrigger>
                <TabTrigger value="marketing" icon={Megaphone}>Marketing</TabTrigger>
                <TabTrigger value="messaging" icon={MessageCircle}>Messaging</TabTrigger>
                <TabTrigger value="sandbox"   icon={FlaskConical}>Sandbox</TabTrigger>
                <TabTrigger value="learnings" icon={Brain}>AI Learnings</TabTrigger>
              </TabsList>

              <TabsContent value="users" className="mt-5">
                <UsersTab users={users} onChanged={loadAll} />
              </TabsContent>

              <TabsContent value="analytics" className="mt-5"><AnalyticsTab /></TabsContent>

              <TabsContent value="plans"     className="mt-5"><PlansTab /></TabsContent>
              <TabsContent value="projects"  className="mt-5"><ProjectsTab /></TabsContent>
              <TabsContent value="payments"  className="mt-5"><PaymentsTab /></TabsContent>
              <TabsContent value="treasury"  className="mt-5"><TreasuryTab /></TabsContent>
              <TabsContent value="money"     className="mt-5"><MoneyTab /></TabsContent>
              <TabsContent value="licenses"  className="mt-5"><LicensesTab /></TabsContent>
              <TabsContent value="royalties" className="mt-5"><RoyaltiesTab /></TabsContent>
              <TabsContent value="settings"  className="mt-5"><SettingsTab /></TabsContent>
              <TabsContent value="ops"       className="mt-5"><OpsTab /></TabsContent>
              <TabsContent value="audit"     className="mt-5"><AuditTab /></TabsContent>
              <TabsContent value="contacts"  className="mt-5"><ContactsList contacts={contacts} onChanged={loadAll} /></TabsContent>
              <TabsContent value="codes"     className="mt-5"><CodesBrowser /></TabsContent>
              <TabsContent value="marketing" className="mt-5"><MarketingTab /></TabsContent>
              <TabsContent value="messaging" className="mt-5"><MessagingTab users={users} /></TabsContent>
              <TabsContent value="sandbox"   className="mt-5"><SandboxTab /></TabsContent>
              <TabsContent value="learnings" className="mt-5"><AILearningsTab /></TabsContent>
            </Tabs>
          </>
        )}
      </section>

      {/* First-time tour & re-launchable guide. `key={guideKey}` forces the
          tour to re-mount when the Guide button is clicked, even after the
          user has already dismissed it once. */}
      <OperatorGuideTour
        key={guideKey}
        forceOpen={guideKey > 0}
        onJumpToTab={setActiveTab}
        onClose={() => { /* leave guideKey as-is so re-clicking still bumps */ }}
      />
    </div>
  );
}

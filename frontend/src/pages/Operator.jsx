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
  TrendingUp, Lock, Brain, Network, TestTube, AlertOctagon, Wand2, Link2,
  Calculator, Gauge, Archive, BrainCircuit, Wrench, Server,
} from 'lucide-react';

import PlansTab     from './operator/PlansTab';
import TreasuryTab  from './operator/TreasuryTab';
import SettingsTab  from './operator/SettingsTab';
import BuildBadge from '../components/BuildBadge';
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
import AIBrainTab from './operator/AIBrainTab';
import AITestBenchTab from './operator/AITestBenchTab';
import ErrorsTab from './operator/ErrorsTab';
import AIBuildTab from './operator/AIBuildTab';
import MyKeysTab from './operator/MyKeysTab';
import ServerTab from './operator/ServerTab';
import AmAiTab from './operator/AmAiTab';
import ToolsTab from './operator/ToolsTab';
import LinksTab from './operator/LinksTab';
import TaxCalculatorTab from './operator/TaxCalculatorTab';
import TaxameterTab from './operator/TaxameterTab';
import UserProjectsTab from './operator/UserProjectsTab';
import PreviewWidget from './PreviewWidget';
import EmergencyLockdownPill from '../components/EmergencyLockdownPill';
import AnalyticsTab from './operator/AnalyticsTab';
import { StatCard }      from './operator/StatCard';
import { StatsToolbar }  from './operator/StatsToolbar';
import { UsersTab }      from './operator/UsersTab';
import TestUserBanner    from './operator/TestUserBanner';

import { OperatorGuideTour, OperatorGuideButton } from './OperatorGuideTour';
import ViewModeToggle from '../components/ViewModeToggle';
import CodesBrowser from './operator/CodesBrowser';
import { ContactsList } from './operator/ContactsList';

function TabTrigger({ value, icon: Icon, children }) {
  return (
    <TabsTrigger
      value={value}
      className="shrink-0 whitespace-nowrap min-h-9 data-[state=active]:bg-tbc-500 data-[state=active]:text-ink-950"
    >
      <Icon className="mr-1.5 h-3.5 w-3.5 shrink-0" /> {children}
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
  // Single source of truth — derive the active tab from the URL rather
  // than mirroring it in local state. Eliminates the previously-flaky
  // race where the 8s stats poll could re-render between an external
  // ?tab change and the syncing useEffect, causing the first tab click
  // after a fresh load to "miss".
  const activeTab = searchParams.get('tab') || 'users';
  const onTabChange = useCallback((next) => {
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
      <section className="mx-auto max-w-7xl px-4 py-6 sm:px-5 sm:py-10">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-tbc-500/15 text-tbc-300">
              <ShieldCheck className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-tbc-100 sm:text-3xl">Operator Console</h1>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <p className="text-sm text-tbc-200/60">Manage members, payments, plans, treasury, licenses, and source code.</p>
                <span
                  data-testid="founder-royalty-badge"
                  title="10% of every paid transaction in this codebase is owed to the original operator. Baked into founder_royalty.py — cannot be disabled from the UI."
                  onClick={() => onTabChange('royalties')}
                  className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-tbc-500/40 bg-tbc-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-tbc-300 hover:bg-tbc-500/20"
                >
                  <Lock className="h-2.5 w-2.5" />
                  Founder royalty · 10% active
                </span>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
            <ViewModeToggle />
            <EmergencyLockdownPill />
            <OperatorGuideButton onOpen={() => setGuideKey((k) => k + 1)} />
          </div>
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
            <div className="grid grid-cols-2 gap-3 sm:gap-5 lg:grid-cols-4">
              <StatCard icon={Users}        label="Total Users"     value={stats?.total_users ?? '–'}
                onClick={() => onTabChange('users')} hint="View user list" />
              <StatCard icon={CreditCard}   label="Paid Customers"  value={stats?.paid_users ?? '–'}
                onClick={() => onTabChange('payments')} hint="See payments" />
              <StatCard icon={MessageSquare} label="Total Messages" value={stats?.total_messages?.toLocaleString() ?? '–'}
                onClick={() => onTabChange('contacts')} hint="Read messages" />
              <StatCard icon={DollarSign}   label="Revenue (USD)"   value={`$${(stats?.revenue_usd ?? 0).toLocaleString()}`}
                onClick={() => onTabChange('money')} hint="Open Money tab" />
            </div>

            <StatsToolbar stats={stats} onRefresh={loadAll} />

            {/* Build badge — a clearly visible marker that proves this
                bundle reached production. If you can see this pill on
                tbctools.org, the latest deploy worked. Tap to see what
                shipped in this build. (The operator search lives in
                the navbar now, between Contact and the credits pill.) */}
            <div className="mt-4 flex justify-start">
              <BuildBadge />
            </div>

            <PreviewWidget />

            <Tabs value={activeTab} onValueChange={onTabChange} className="mt-8 sm:mt-10">
              {/* Mobile: a single swipeable row (flex-nowrap + horizontal
                  scroll) so 20+ tabs stay usable on a phone instead of
                  wrapping into a giant block. Desktop: wraps as before. */}
              <TabsList className="bg-ink-900 border border-tbc-900/60 flex h-auto w-full flex-nowrap justify-start gap-1 overflow-x-auto scrollbar-none md:flex-wrap md:overflow-visible">
                <TabTrigger value="users"     icon={Users}>Users ({users.length})</TabTrigger>
                <TabTrigger value="analytics" icon={TrendingUp}>Analytics</TabTrigger>
                <TabTrigger value="projects"  icon={FolderKanban}>Projects</TabTrigger>
                <TabTrigger value="user-projects" icon={Archive}>User Projects</TabTrigger>
                <TabTrigger value="plans"     icon={Sparkles}>Plans</TabTrigger>
                <TabTrigger value="payments"  icon={CreditCard}>Payments</TabTrigger>
                <TabTrigger value="treasury"  icon={Wallet}>Treasury</TabTrigger>
                <TabTrigger value="money"     icon={DollarSign}>Money</TabTrigger>
                <TabTrigger value="keys"      icon={KeyRound}>My Keys</TabTrigger>
                <TabTrigger value="amai"      icon={BrainCircuit}>amAI</TabTrigger>
                <TabTrigger value="tools"     icon={Wrench}>AI Tools</TabTrigger>
                <TabTrigger value="licenses"  icon={KeyRound}>Licenses</TabTrigger>
                <TabTrigger value="royalties" icon={Coins}>Royalties</TabTrigger>
                <TabTrigger value="settings"  icon={SettingsIcon}>Security</TabTrigger>
                <TabTrigger value="server"    icon={Server}>Server</TabTrigger>
                <TabTrigger value="ops"       icon={Activity}>Ops</TabTrigger>
                <TabTrigger value="links"     icon={Link2}>Links</TabTrigger>
                <TabTrigger value="taxcalc"   icon={Calculator}>Tax Calc</TabTrigger>
                <TabTrigger value="taxameter" icon={Gauge}>Taxameter</TabTrigger>
                <TabTrigger value="audit"     icon={ScrollText}>Audit</TabTrigger>
                <TabTrigger value="contacts"  icon={Mail}>Contacts</TabTrigger>
                <TabTrigger value="codes"     icon={Code2}>Codes</TabTrigger>
                <TabTrigger value="marketing" icon={Megaphone}>Marketing</TabTrigger>
                <TabTrigger value="messaging" icon={MessageCircle}>Messaging</TabTrigger>
                <TabTrigger value="sandbox"   icon={FlaskConical}>Sandbox</TabTrigger>
                <TabTrigger value="learnings" icon={Brain}>AI Learnings</TabTrigger>
                <TabTrigger value="brain"     icon={Network}>AI Brain</TabTrigger>
                <TabTrigger value="ai-tests"  icon={TestTube}>AI Tests</TabTrigger>
                <TabTrigger value="errors"    icon={AlertOctagon}>Errors</TabTrigger>
                <TabTrigger value="ai-build"  icon={Wand2}>AI Build</TabTrigger>
              </TabsList>

              <TabsContent value="users" className="mt-5">
                <UsersTab users={users} onChanged={loadAll} />
              </TabsContent>

              <TabsContent value="analytics" className="mt-5"><AnalyticsTab /></TabsContent>

              <TabsContent value="plans"     className="mt-5"><PlansTab /></TabsContent>
              <TabsContent value="projects"  className="mt-5"><ProjectsTab /></TabsContent>
              <TabsContent value="user-projects" className="mt-5"><UserProjectsTab /></TabsContent>
              <TabsContent value="payments"  className="mt-5"><PaymentsTab /></TabsContent>
              <TabsContent value="treasury"  className="mt-5"><TreasuryTab /></TabsContent>
              <TabsContent value="money"     className="mt-5"><MoneyTab /></TabsContent>
              <TabsContent value="keys"      className="mt-5"><MyKeysTab /></TabsContent>
              <TabsContent value="amai"      className="mt-5"><AmAiTab /></TabsContent>
              <TabsContent value="tools"     className="mt-5"><ToolsTab /></TabsContent>
              <TabsContent value="licenses"  className="mt-5"><LicensesTab /></TabsContent>
              <TabsContent value="royalties" className="mt-5"><RoyaltiesTab /></TabsContent>
              <TabsContent value="settings"  className="mt-5"><SettingsTab /></TabsContent>
              <TabsContent value="server"    className="mt-5"><ServerTab /></TabsContent>
              <TabsContent value="ops"       className="mt-5"><OpsTab /></TabsContent>
              <TabsContent value="links"     className="mt-5"><LinksTab /></TabsContent>
              <TabsContent value="taxcalc"   className="mt-5"><TaxCalculatorTab /></TabsContent>
              <TabsContent value="taxameter" className="mt-5"><TaxameterTab /></TabsContent>
              <TabsContent value="audit"     className="mt-5"><AuditTab /></TabsContent>
              <TabsContent value="contacts"  className="mt-5"><ContactsList contacts={contacts} onChanged={loadAll} /></TabsContent>
              <TabsContent value="codes"     className="mt-5"><CodesBrowser /></TabsContent>
              <TabsContent value="marketing" className="mt-5"><MarketingTab /></TabsContent>
              <TabsContent value="messaging" className="mt-5"><MessagingTab users={users} /></TabsContent>
              <TabsContent value="sandbox"   className="mt-5"><SandboxTab /></TabsContent>
              <TabsContent value="learnings" className="mt-5"><AILearningsTab /></TabsContent>
              <TabsContent value="brain"     className="mt-5"><AIBrainTab /></TabsContent>
              <TabsContent value="ai-tests"  className="mt-5"><AITestBenchTab /></TabsContent>
              <TabsContent value="errors"    className="mt-5"><ErrorsTab /></TabsContent>
              <TabsContent value="ai-build"  className="mt-5"><AIBuildTab /></TabsContent>
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
        onJumpToTab={onTabChange}
        onClose={() => { /* leave guideKey as-is so re-clicking still bumps */ }}
      />
    </div>
  );
}

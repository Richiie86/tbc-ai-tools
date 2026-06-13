import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Navbar from '../components/Navbar';
import api from '../lib/api';
import { Card } from '../components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { Input } from '../components/ui/input';
import { toast } from 'sonner';
import {
  Users, CreditCard, MessageSquare, DollarSign, Loader2, ShieldCheck, Mail,
  Code2, Search, Sparkles, Wallet, KeyRound, Settings as SettingsIcon, Coins,
  FolderKanban, Activity, ScrollText,
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

import { OperatorGuideTour, OperatorGuideButton } from './OperatorGuideTour';

import { UsersBulkToolbar } from './operator/users/UsersBulkToolbar';
import { UsersTable } from './operator/users/UsersTable';
import CodesBrowser from './operator/CodesBrowser';
import { ContactsList } from './operator/ContactsList';

function StatCard({ icon: Icon, label, value }) {
  return (
    <Card className="border-tbc-900/60 bg-ink-900/80 p-5">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs uppercase tracking-wider text-tbc-200/60">{label}</div>
          <div className="mt-1 text-2xl font-bold text-tbc-100">{value}</div>
        </div>
        <div className="grid h-10 w-10 place-items-center rounded-lg bg-tbc-500/15 text-tbc-300">
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </Card>
  );
}

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
  const [userSearch, setUserSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  // Controlled tab so the first-time tour can drive the view. Defaults to
  // 'users' (the historical default) so the existing UX is unchanged.
  const [activeTab, setActiveTab] = useState('users');
  // Re-launch handle for the guide. Bumping the counter forces the tour to
  // open even if `tbc_operator_tour_seen_v1` is already set in localStorage.
  const [guideKey, setGuideKey] = useState(0);

  const clearSelection = () => setSelectedIds(new Set());
  const toggleSelect = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleSelectAll = (visible) => {
    setSelectedIds((prev) => {
      const allSelected = visible.every((u) => prev.has(u.id));
      if (allSelected) return new Set();
      const next = new Set(prev);
      visible.forEach((u) => next.add(u.id));
      return next;
    });
  };

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
  useEffect(() => { loadAll(); }, [loadAll]);

  const runBulk = async (action, extra = {}) => {
    if (selectedIds.size === 0) return;
    let confirmMsg = `${action.replace('_', ' ')} ${selectedIds.size} user${selectedIds.size === 1 ? '' : 's'}?`;
    if (action === 'delete') confirmMsg += '\n\nSoft-delete keeps history but blocks login.';
    if (!window.confirm(confirmMsg)) return;
    setBulkBusy(true);
    try {
      const { data } = await api.post('/operator/users/bulk', {
        user_ids: Array.from(selectedIds), action, ...extra,
      });
      const okCount = (data.ok || []).length;
      const skippedCount = (data.skipped || []).length;
      toast.success(`${okCount} updated${skippedCount ? ` · ${skippedCount} skipped` : ''}`);
      clearSelection();
      loadAll();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Bulk action failed');
    } finally {
      setBulkBusy(false);
    }
  };

  const exportSelectedCsv = () => {
    if (selectedIds.size === 0) return;
    const rows = users.filter((u) => selectedIds.has(u.id));
    const escape = (v) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ['email', 'name', 'plan', 'credits', 'status', 'role', 'totp_enabled', 'joined'];
    const lines = [header.join(',')];
    for (const u of rows) {
      lines.push([
        escape(u.email),
        escape(u.name || ''),
        escape(u.plan || ''),
        escape(u.credits ?? 0),
        escape(u.deleted_at ? 'deleted' : (u.status || 'active')),
        escape(u.role || 'user'),
        escape(u.totp_enabled ? 'yes' : 'no'),
        escape(u.created_at ? new Date(u.created_at).toISOString() : ''),
      ].join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tbc-users-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success(`Exported ${rows.length} user${rows.length === 1 ? '' : 's'} to CSV`);
  };

  const grantCredits = async (userId, amount) => {
    try {
      await api.post(`/operator/users/${userId}/credits?amount=${amount}`);
      toast.success(`Granted ${amount} credits`);
      loadAll();
    } catch { toast.error('Could not grant credits'); }
  };
  const setPlan = async (userId, plan) => {
    try {
      const { data } = await api.post(`/operator/users/${userId}/plan?plan=${plan}`);
      toast.success(`Plan set to ${plan}` + (data.credits_added ? ` (+${data.credits_added} credits)` : ''));
      loadAll();
    } catch { toast.error('Could not change plan'); }
  };
  const reset2FA = async (userId, email) => {
    if (!window.confirm(`Reset 2FA for ${email}?\n\nThe user will be asked to re-enrol on next login.`)) return;
    try {
      await api.post(`/operator/users/${userId}/reset-2fa`);
      toast.success(`2FA reset for ${email}`);
      loadAll();
    } catch (e) { toast.error(e?.response?.data?.detail || 'Could not reset 2FA'); }
  };
  const togglePause = async (userId, email, currentStatus) => {
    const action = currentStatus === 'paused' ? 'resume' : 'pause';
    if (!window.confirm(`${action === 'pause' ? 'Pause' : 'Resume'} ${email}?\n\n${
      action === 'pause' ? 'They will be blocked from logging in until resumed.' : 'They will be able to log in again.'
    }`)) return;
    try {
      const { data } = await api.post(`/operator/users/${userId}/pause`);
      toast.success(`${email} is now ${data.status}`);
      loadAll();
    } catch (e) { toast.error(e?.response?.data?.detail || `Could not ${action} user`); }
  };
  const deleteUser = async (userId, email) => {
    if (!window.confirm(`Delete ${email}?\n\nThis soft-deletes the account (keeps transaction history, blocks login). The action cannot be undone from the UI.`)) return;
    try {
      await api.post(`/operator/users/${userId}/delete`);
      toast.success(`${email} deleted`);
      loadAll();
    } catch (e) { toast.error(e?.response?.data?.detail || 'Could not delete user'); }
  };

  const filteredUsers = useMemo(() => {
    const q = userSearch.trim().toLowerCase();
    if (!q) return users;
    return users.filter(
      (u) => u.email.toLowerCase().includes(q) || (u.name || '').toLowerCase().includes(q),
    );
  }, [users, userSearch]);

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
              <p className="text-sm text-tbc-200/60">Manage members, payments, plans, treasury, licenses, and source code.</p>
            </div>
          </div>
          <OperatorGuideButton onOpen={() => setGuideKey((k) => k + 1)} />
        </div>

        {loading ? (
          <div className="mt-16 grid place-items-center">
            <Loader2 className="h-7 w-7 animate-spin text-tbc-400" />
          </div>
        ) : (
          <>
            <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard icon={Users}        label="Total Users"     value={stats?.total_users ?? '–'} />
              <StatCard icon={CreditCard}   label="Paid Customers"  value={stats?.paid_users ?? '–'} />
              <StatCard icon={MessageSquare} label="Total Messages" value={stats?.total_messages?.toLocaleString() ?? '–'} />
              <StatCard icon={DollarSign}   label="Revenue (USD)"   value={`$${(stats?.revenue_usd ?? 0).toLocaleString()}`} />
            </div>

            <Tabs value={activeTab} onValueChange={setActiveTab} className="mt-10">
              <TabsList className="bg-ink-900 border border-tbc-900/60 flex flex-wrap h-auto">
                <TabTrigger value="users"     icon={Users}>Users ({users.length})</TabTrigger>
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
              </TabsList>

              <TabsContent value="users" className="mt-5">
                <div className="mb-3 flex items-center gap-3">
                  <div className="relative w-72">
                    <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-tbc-200/40" />
                    <Input
                      value={userSearch}
                      onChange={(e) => setUserSearch(e.target.value)}
                      placeholder="Search by email or name..."
                      className="border-tbc-900/60 bg-ink-900 pl-9 text-tbc-100"
                    />
                  </div>
                  <div className="text-xs text-tbc-200/60">
                    {filteredUsers.length} of {users.length} users
                  </div>
                  {selectedIds.size > 0 && (
                    <button
                      data-testid="bulk-clear"
                      onClick={clearSelection}
                      className="ml-auto rounded border border-tbc-900/60 bg-ink-900 px-2 py-1 text-[11px] text-tbc-200 hover:bg-ink-950"
                    >
                      Clear selection
                    </button>
                  )}
                </div>

                <UsersBulkToolbar
                  selectedCount={selectedIds.size}
                  bulkBusy={bulkBusy}
                  onExportCsv={exportSelectedCsv}
                  onPause={() => runBulk('pause')}
                  onResume={() => runBulk('resume')}
                  onGrantCredits={(credits) => runBulk('grant_credits', { credits })}
                  onSetPlan={(plan) => runBulk('set_plan', { plan })}
                  onDelete={() => runBulk('delete')}
                />

                <UsersTable
                  users={filteredUsers}
                  selectedIds={selectedIds}
                  onToggleSelect={toggleSelect}
                  onToggleSelectAll={toggleSelectAll}
                  onGrantCredits={grantCredits}
                  onSetPlan={setPlan}
                  onReset2FA={reset2FA}
                  onTogglePause={togglePause}
                  onDelete={deleteUser}
                />
              </TabsContent>

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
              <TabsContent value="contacts"  className="mt-5"><ContactsList contacts={contacts} /></TabsContent>
              <TabsContent value="codes"     className="mt-5"><CodesBrowser /></TabsContent>
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

import React, { useEffect, useMemo, useState } from 'react';
import Navbar from '../components/Navbar';
import api from '../lib/api';
import { Card } from '../components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { ScrollArea } from '../components/ui/scroll-area';
import { toast } from 'sonner';
import {
  Users, CreditCard, MessageSquare, DollarSign, Loader2, ShieldCheck, Mail,
  Code2, ChevronRight, ChevronDown, FileCode, Folder, FolderOpen, Search,
  Download, Copy, Check, Sparkles, Wallet, KeyRound, Settings as SettingsIcon, Coins, FolderKanban,
} from 'lucide-react';

import PlansTab from './operator/PlansTab';
import TreasuryTab from './operator/TreasuryTab';
import SettingsTab from './operator/SettingsTab';
import PaymentsTab from './operator/PaymentsTab';
import LicensesTab from './operator/LicensesTab';
import RoyaltiesTab from './operator/RoyaltiesTab';
import ProjectsTab from './operator/ProjectsTab';

const PLANS = ['free', 'starter', 'pro', 'enterprise'];

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

export default function Operator() {
  const [stats, setStats] = useState(null);
  const [users, setUsers] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [userSearch, setUserSearch] = useState('');

  const loadAll = async () => {
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
  };
  useEffect(() => { loadAll(); }, []);

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
    if (!window.confirm(`${action === 'pause' ? 'Pause' : 'Resume'} ${email}?\n\n${action === 'pause' ? 'They will be blocked from logging in until resumed.' : 'They will be able to log in again.'}`)) return;
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
    return users.filter((u) => u.email.toLowerCase().includes(q) || (u.name || '').toLowerCase().includes(q));
  }, [users, userSearch]);

  return (
    <div className="min-h-screen bg-ink-950">
      <Navbar />
      <section className="mx-auto max-w-7xl px-5 py-10">
        <div className="flex items-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-xl bg-tbc-500/15 text-tbc-300">
            <ShieldCheck className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-3xl font-bold text-tbc-100">Operator Console</h1>
            <p className="text-sm text-tbc-200/60">Manage members, payments, plans, treasury, licenses, and source code.</p>
          </div>
        </div>

        {loading ? (
          <div className="mt-16 grid place-items-center"><Loader2 className="h-7 w-7 animate-spin text-tbc-400" /></div>
        ) : (
          <>
            <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard icon={Users} label="Total Users" value={stats?.total_users ?? '–'} />
              <StatCard icon={CreditCard} label="Paid Customers" value={stats?.paid_users ?? '–'} />
              <StatCard icon={MessageSquare} label="Total Messages" value={stats?.total_messages?.toLocaleString() ?? '–'} />
              <StatCard icon={DollarSign} label="Revenue (USD)" value={`$${(stats?.revenue_usd ?? 0).toLocaleString()}`} />
            </div>

            <Tabs defaultValue="users" className="mt-10">
              <TabsList className="bg-ink-900 border border-tbc-900/60 flex flex-wrap h-auto">
                <TabTrigger value="users" icon={Users}>Users ({users.length})</TabTrigger>
                <TabTrigger value="projects" icon={FolderKanban}>Projects</TabTrigger>
                <TabTrigger value="plans" icon={Sparkles}>Plans</TabTrigger>
                <TabTrigger value="payments" icon={CreditCard}>Payments</TabTrigger>
                <TabTrigger value="treasury" icon={Wallet}>Treasury</TabTrigger>
                <TabTrigger value="licenses" icon={KeyRound}>Licenses</TabTrigger>
                <TabTrigger value="royalties" icon={Coins}>Royalties</TabTrigger>
                <TabTrigger value="settings" icon={SettingsIcon}>Settings</TabTrigger>
                <TabTrigger value="contacts" icon={Mail}>Contacts</TabTrigger>
                <TabTrigger value="codes" icon={Code2}>Codes</TabTrigger>
              </TabsList>

              <TabsContent value="users" className="mt-5">
                <div className="mb-3 flex items-center gap-3">
                  <div className="relative w-72">
                    <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-tbc-200/40" />
                    <Input value={userSearch} onChange={(e) => setUserSearch(e.target.value)} placeholder="Search by email or name..." className="border-tbc-900/60 bg-ink-900 pl-9 text-tbc-100" />
                  </div>
                  <div className="text-xs text-tbc-200/60">{filteredUsers.length} of {users.length} users</div>
                </div>
                <div className="rounded-xl border border-tbc-900/60 bg-ink-900/40">
                  <Table>
                    <TableHeader>
                      <TableRow className="border-tbc-900/60 hover:bg-transparent">
                        <TableHead>Email</TableHead>
                        <TableHead>Name</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Role</TableHead>
                        <TableHead>Plan</TableHead>
                        <TableHead>Credits</TableHead>
                        <TableHead>2FA</TableHead>
                        <TableHead>Joined</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredUsers.map((u) => (
                        <TableRow key={u.id} className="border-tbc-900/60 hover:bg-ink-900/60">
                          <TableCell className="font-medium text-tbc-100">{u.email}</TableCell>
                          <TableCell className="text-tbc-200/80">{u.name || '—'}</TableCell>
                          <TableCell>
                            {u.deleted_at ? (
                              <span className="rounded-full bg-rose-500/15 px-2 py-0.5 text-[10px] uppercase tracking-wider text-rose-300">Deleted</span>
                            ) : u.status === 'paused' ? (
                              <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] uppercase tracking-wider text-amber-300">Paused</span>
                            ) : (
                              <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] uppercase tracking-wider text-emerald-300">Active</span>
                            )}
                          </TableCell>
                          <TableCell>
                            <span className={`rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider ${u.role === 'operator' ? 'bg-tbc-500/20 text-tbc-300' : 'bg-ink-900 text-tbc-200/70'}`}>{u.role}</span>
                          </TableCell>
                          <TableCell>
                            <Select value={u.plan} onValueChange={(v) => setPlan(u.id, v)} disabled={u.role === 'operator'}>
                              <SelectTrigger className="h-8 w-32 border-tbc-900/60 bg-ink-900 text-tbc-100"><SelectValue /></SelectTrigger>
                              <SelectContent className="border-tbc-900/60 bg-ink-900 text-tbc-100">
                                {PLANS.map((p) => <SelectItem key={p} value={p} className="capitalize focus:bg-ink-950">{p}</SelectItem>)}
                              </SelectContent>
                            </Select>
                          </TableCell>
                          <TableCell className="text-tbc-200">{u.credits?.toLocaleString()}</TableCell>
                          <TableCell>{u.totp_enabled ? <span className="text-tbc-300">On</span> : <span className="text-tbc-200/40">Off</span>}</TableCell>
                          <TableCell className="text-xs text-tbc-200/60">{u.created_at ? new Date(u.created_at).toLocaleDateString() : '—'}</TableCell>
                          <TableCell className="text-right">
                            <div className="flex justify-end gap-1.5">
                              <Button
                                size="sm"
                                variant="outline"
                                data-testid={`op-grant-credits-${u.id}`}
                                className="border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-900/40"
                                onClick={() => grantCredits(u.id, 100)}
                              >
                                +100
                              </Button>
                              {u.totp_enabled && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  data-testid={`op-reset-2fa-${u.id}`}
                                  title="Reset 2FA — user will re-enrol on next login"
                                  className="border-rose-900/60 bg-ink-900 text-rose-300 hover:bg-rose-500/10"
                                  onClick={() => reset2FA(u.id, u.email)}
                                >
                                  Reset 2FA
                                </Button>
                              )}
                              {u.role !== 'operator' && !u.deleted_at && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  data-testid={`op-pause-${u.id}`}
                                  title={u.status === 'paused' ? 'Resume — allow login' : 'Pause — block login'}
                                  className={u.status === 'paused'
                                    ? 'border-emerald-900/60 bg-ink-900 text-emerald-300 hover:bg-emerald-500/10'
                                    : 'border-amber-900/60 bg-ink-900 text-amber-300 hover:bg-amber-500/10'}
                                  onClick={() => togglePause(u.id, u.email, u.status)}
                                >
                                  {u.status === 'paused' ? 'Resume' : 'Pause'}
                                </Button>
                              )}
                              {u.role !== 'operator' && !u.deleted_at && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  data-testid={`op-delete-${u.id}`}
                                  title="Soft-delete — blocks login, keeps audit trail"
                                  className="border-rose-900/60 bg-ink-900 text-rose-300 hover:bg-rose-500/20"
                                  onClick={() => deleteUser(u.id, u.email)}
                                >
                                  Delete
                                </Button>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </TabsContent>

              <TabsContent value="plans" className="mt-5"><PlansTab /></TabsContent>
              <TabsContent value="projects" className="mt-5"><ProjectsTab /></TabsContent>
              <TabsContent value="payments" className="mt-5"><PaymentsTab /></TabsContent>
              <TabsContent value="treasury" className="mt-5"><TreasuryTab /></TabsContent>
              <TabsContent value="licenses" className="mt-5"><LicensesTab /></TabsContent>
              <TabsContent value="royalties" className="mt-5"><RoyaltiesTab /></TabsContent>
              <TabsContent value="settings" className="mt-5"><SettingsTab /></TabsContent>

              <TabsContent value="contacts" className="mt-5">
                <div className="space-y-3">
                  {contacts.length === 0 && (
                    <div className="rounded-xl border border-tbc-900/60 bg-ink-900/40 p-8 text-center text-tbc-200/50">No contact submissions yet</div>
                  )}
                  {contacts.map((c) => (
                    <div key={c.id} className="rounded-xl border border-tbc-900/60 bg-ink-900/40 p-5">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 text-sm">
                          <Mail className="h-4 w-4 text-tbc-400" />
                          <span className="font-semibold text-tbc-100">{c.name}</span>
                          <span className="text-tbc-200/60">&lt;{c.email}&gt;</span>
                        </div>
                        <span className="text-xs text-tbc-200/50">{new Date(c.created_at).toLocaleString()}</span>
                      </div>
                      {c.subject && <div className="mt-2 text-sm font-medium text-tbc-100">{c.subject}</div>}
                      <p className="mt-2 whitespace-pre-wrap text-sm text-tbc-200/80">{c.message}</p>
                    </div>
                  ))}
                </div>
              </TabsContent>

              <TabsContent value="codes" className="mt-5"><CodesBrowser /></TabsContent>
            </Tabs>
          </>
        )}
      </section>
    </div>
  );
}

function TabTrigger({ value, icon: Icon, children }) {
  return (
    <TabsTrigger value={value} className="data-[state=active]:bg-tbc-500 data-[state=active]:text-ink-950">
      <Icon className="mr-1.5 h-3.5 w-3.5" /> {children}
    </TabsTrigger>
  );
}

function CodesBrowser() {
  const [tree, setTree] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [content, setContent] = useState('');
  const [contentLoading, setContentLoading] = useState(false);
  const [expanded, setExpanded] = useState(new Set(['/app/backend', '/app/frontend/src']));
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api.get('/operator/codes/tree').then((r) => setTree(r.data)).catch(() => toast.error('Failed to load file tree')).finally(() => setLoading(false));
  }, []);

  const openFile = async (path) => {
    setSelected(path);
    setContentLoading(true);
    try {
      const { data } = await api.get('/operator/codes/file', { params: { path } });
      setContent(data.content);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Failed to read file');
      setContent('');
    } finally { setContentLoading(false); }
  };
  const toggle = (path) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  };
  const copyContent = () => { navigator.clipboard.writeText(content); setCopied(true); setTimeout(() => setCopied(false), 1500); };
  const downloadFile = () => {
    if (!selected) return;
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = selected.split('/').pop(); a.click();
    URL.revokeObjectURL(url);
  };

  if (loading) return <div className="grid place-items-center py-16"><Loader2 className="h-6 w-6 animate-spin text-tbc-400" /></div>;

  return (
    <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
      <div className="rounded-xl border border-tbc-900/60 bg-ink-900/40">
        <div className="border-b border-tbc-900/60 px-3 py-2 text-xs font-semibold uppercase tracking-wider text-tbc-300">Source files</div>
        <ScrollArea className="h-[640px] p-2">
          <CodeTree tree={tree} expanded={expanded} toggle={toggle} onFile={openFile} selected={selected} />
        </ScrollArea>
      </div>
      <div className="rounded-xl border border-tbc-900/60 bg-ink-900/40">
        <div className="flex items-center justify-between border-b border-tbc-900/60 px-3 py-2">
          <div className="flex items-center gap-2 text-xs">
            <FileCode className="h-3.5 w-3.5 text-tbc-300" />
            <span className="font-mono text-tbc-200">{selected ? selected.replace('/app/', '') : 'Select a file'}</span>
          </div>
          {selected && (
            <div className="flex items-center gap-1">
              <Button size="sm" variant="outline" className="border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950" onClick={copyContent}>
                {copied ? <Check className="h-3.5 w-3.5 text-tbc-300" /> : <Copy className="h-3.5 w-3.5" />}
              </Button>
              <Button size="sm" variant="outline" className="border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950" onClick={downloadFile}>
                <Download className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}
        </div>
        <div className="relative h-[640px] overflow-auto">
          {contentLoading ? (
            <div className="grid h-full place-items-center"><Loader2 className="h-6 w-6 animate-spin text-tbc-400" /></div>
          ) : selected ? (
            <pre className="m-0 p-4 text-xs leading-relaxed text-tbc-100"><code>{content}</code></pre>
          ) : (
            <div className="grid h-full place-items-center text-sm text-tbc-200/40">Pick a file on the left to view its source code</div>
          )}
        </div>
      </div>
    </div>
  );
}

function flattenTree(nodes, depth, expanded, acc) {
  for (const n of nodes) {
    acc.push({ ...n, depth });
    if (n.type === 'dir' && expanded.has(n.path) && n.children) {
      flattenTree(n.children, depth + 1, expanded, acc);
    }
  }
  return acc;
}
function CodeTree({ tree, expanded, toggle, onFile, selected }) {
  const flat = []; flattenTree(tree, 0, expanded, flat);
  return (
    <div>
      {flat.map((n) => {
        const padding = { paddingLeft: 6 + n.depth * 14 };
        if (n.type === 'dir') {
          const isOpen = expanded.has(n.path);
          return (
            <button key={n.path} onClick={() => toggle(n.path)} className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs text-tbc-200 hover:bg-ink-900/80" style={padding}>
              {isOpen ? <ChevronDown className="h-3 w-3 text-tbc-400" /> : <ChevronRight className="h-3 w-3 text-tbc-400" />}
              {isOpen ? <FolderOpen className="h-3.5 w-3.5 text-tbc-300" /> : <Folder className="h-3.5 w-3.5 text-tbc-400" />}
              <span className="truncate">{n.name}</span>
            </button>
          );
        }
        const isSelected = selected === n.path;
        return (
          <button key={n.path} onClick={() => onFile(n.path)} className={`flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs hover:bg-ink-900/80 ${isSelected ? 'bg-tbc-500/15 text-tbc-200' : 'text-tbc-200/80'}`} style={padding}>
            <span className="w-3" />
            <FileCode className="h-3.5 w-3.5 shrink-0 text-tbc-200/60" />
            <span className="truncate">{n.name}</span>
          </button>
        );
      })}
    </div>
  );
}

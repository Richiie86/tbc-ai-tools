import React, { useEffect, useState } from 'react';
import Navbar from '../components/Navbar';
import api from '../lib/api';
import { Card } from '../components/ui/card';
import {
  Tabs, TabsContent, TabsList, TabsTrigger,
} from '../components/ui/tabs';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '../components/ui/table';
import { Button } from '../components/ui/button';
import { toast } from 'sonner';
import { Users, CreditCard, MessageSquare, DollarSign, Loader2, ShieldCheck, Mail } from 'lucide-react';

function StatCard({ icon: Icon, label, value, tone = 'emerald' }) {
  const toneClass = tone === 'emerald' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-cyan-500/15 text-cyan-300';
  return (
    <Card className="border-slate-800 bg-slate-900/60 p-5">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs uppercase tracking-wider text-slate-400">{label}</div>
          <div className="mt-1 text-2xl font-bold text-white">{value}</div>
        </div>
        <div className={`grid h-10 w-10 place-items-center rounded-lg ${toneClass}`}>
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </Card>
  );
}

export default function Operator() {
  const [stats, setStats] = useState(null);
  const [users, setUsers] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [loading, setLoading] = useState(true);

  const loadAll = async () => {
    setLoading(true);
    try {
      const [s, u, t, c] = await Promise.all([
        api.get('/operator/stats'),
        api.get('/operator/users'),
        api.get('/operator/transactions'),
        api.get('/operator/contacts'),
      ]);
      setStats(s.data); setUsers(u.data); setTransactions(t.data); setContacts(c.data);
    } catch (e) {
      toast.error('Failed to load operator data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadAll(); }, []);

  const grantCredits = async (userId, amount) => {
    try {
      await api.post(`/operator/users/${userId}/credits?amount=${amount}`);
      toast.success(`Granted ${amount} credits`);
      loadAll();
    } catch { toast.error('Could not grant credits'); }
  };

  return (
    <div className="min-h-screen bg-slate-950">
      <Navbar />
      <section className="mx-auto max-w-7xl px-5 py-10">
        <div className="flex items-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-xl bg-emerald-500/15 text-emerald-300">
            <ShieldCheck className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-3xl font-bold text-white">Operator Console</h1>
            <p className="text-sm text-slate-400">Manage TBC AI Control members, payments, and inbound contacts.</p>
          </div>
        </div>

        {loading ? (
          <div className="mt-16 grid place-items-center"><Loader2 className="h-7 w-7 animate-spin text-emerald-400" /></div>
        ) : (
          <>
            <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard icon={Users} label="Total Users" value={stats?.total_users ?? '–'} />
              <StatCard icon={CreditCard} label="Paid Customers" value={stats?.paid_users ?? '–'} tone="cyan" />
              <StatCard icon={MessageSquare} label="Total Messages" value={stats?.total_messages?.toLocaleString() ?? '–'} />
              <StatCard icon={DollarSign} label="Revenue (USD)" value={`$${(stats?.revenue_usd ?? 0).toLocaleString()}`} tone="cyan" />
            </div>

            <Tabs defaultValue="users" className="mt-10">
              <TabsList className="bg-slate-900 border border-slate-800">
                <TabsTrigger value="users" className="data-[state=active]:bg-emerald-500 data-[state=active]:text-slate-950">Users</TabsTrigger>
                <TabsTrigger value="payments" className="data-[state=active]:bg-emerald-500 data-[state=active]:text-slate-950">Payments</TabsTrigger>
                <TabsTrigger value="contacts" className="data-[state=active]:bg-emerald-500 data-[state=active]:text-slate-950">Contacts</TabsTrigger>
              </TabsList>

              <TabsContent value="users" className="mt-5">
                <div className="rounded-xl border border-slate-800 bg-slate-900/40">
                  <Table>
                    <TableHeader>
                      <TableRow className="border-slate-800 hover:bg-transparent">
                        <TableHead>Email</TableHead>
                        <TableHead>Role</TableHead>
                        <TableHead>Plan</TableHead>
                        <TableHead>Credits</TableHead>
                        <TableHead>2FA</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {users.map((u) => (
                        <TableRow key={u.id} className="border-slate-800 hover:bg-slate-900">
                          <TableCell className="font-medium">{u.email}</TableCell>
                          <TableCell>
                            <span className={`rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider ${u.role === 'operator' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-slate-800 text-slate-300'}`}>{u.role}</span>
                          </TableCell>
                          <TableCell><span className="capitalize">{u.plan}</span></TableCell>
                          <TableCell>{u.credits?.toLocaleString()}</TableCell>
                          <TableCell>{u.totp_enabled ? <span className="text-emerald-400">On</span> : <span className="text-slate-500">Off</span>}</TableCell>
                          <TableCell className="text-right">
                            <Button size="sm" variant="outline" className="border-slate-700 bg-slate-900 hover:bg-slate-800" onClick={()=>grantCredits(u.id, 100)}>+100 credits</Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </TabsContent>

              <TabsContent value="payments" className="mt-5">
                <div className="rounded-xl border border-slate-800 bg-slate-900/40">
                  <Table>
                    <TableHeader>
                      <TableRow className="border-slate-800 hover:bg-transparent">
                        <TableHead>User</TableHead>
                        <TableHead>Plan</TableHead>
                        <TableHead>Amount</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Date</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {transactions.length === 0 && (
                        <TableRow><TableCell colSpan={5} className="py-8 text-center text-slate-500">No transactions yet</TableCell></TableRow>
                      )}
                      {transactions.map((t) => (
                        <TableRow key={t.id} className="border-slate-800 hover:bg-slate-900">
                          <TableCell>{t.user_email}</TableCell>
                          <TableCell className="capitalize">{t.plan_id}</TableCell>
                          <TableCell>${t.amount?.toFixed(2)} {t.currency?.toUpperCase()}</TableCell>
                          <TableCell>
                            <span className={`rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider ${t.payment_status === 'paid' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-amber-500/20 text-amber-300'}`}>{t.payment_status}</span>
                          </TableCell>
                          <TableCell className="text-slate-400">{new Date(t.created_at).toLocaleString()}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </TabsContent>

              <TabsContent value="contacts" className="mt-5">
                <div className="space-y-3">
                  {contacts.length === 0 && (
                    <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-8 text-center text-slate-500">No contact submissions yet</div>
                  )}
                  {contacts.map((c) => (
                    <div key={c.id} className="rounded-xl border border-slate-800 bg-slate-900/40 p-5">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 text-sm">
                          <Mail className="h-4 w-4 text-emerald-400" />
                          <span className="font-semibold text-white">{c.name}</span>
                          <span className="text-slate-400">&lt;{c.email}&gt;</span>
                        </div>
                        <span className="text-xs text-slate-500">{new Date(c.created_at).toLocaleString()}</span>
                      </div>
                      {c.subject && <div className="mt-2 text-sm font-medium text-slate-200">{c.subject}</div>}
                      <p className="mt-2 whitespace-pre-wrap text-sm text-slate-300">{c.message}</p>
                    </div>
                  ))}
                </div>
              </TabsContent>
            </Tabs>
          </>
        )}
      </section>
    </div>
  );
}

import React, { useEffect, useState } from 'react';
import api, { API } from '../../lib/api';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '../../components/ui/table';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { toast } from 'sonner';
import {
  CheckCircle2, XCircle, Download, Loader2, FileText, Receipt, Calendar,
} from 'lucide-react';

export default function PaymentsTab() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [exporting, setExporting] = useState(false);

  const load = async () => {
    setLoading(true);
    try { const { data } = await api.get('/operator/transactions'); setItems(data); }
    catch { toast.error('Failed to load transactions'); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const confirm = async (id) => {
    try { await api.post(`/operator/transactions/${id}/confirm`); toast.success('Marked as paid'); load(); }
    catch { toast.error('Could not confirm'); }
  };
  const reject = async (id) => {
    if (!window.confirm('Reject this transaction?')) return;
    try { await api.post(`/operator/transactions/${id}/reject`); toast.success('Rejected'); load(); }
    catch { toast.error('Could not reject'); }
  };
  const downloadReceipt = async (id) => {
    try {
      const token = localStorage.getItem('tbc_token');
      const res = await fetch(`${API}/operator/transactions/${id}/receipt`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error('Download failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `receipt_${id.slice(0,8)}.pdf`; a.click();
      URL.revokeObjectURL(url);
    } catch { toast.error('Could not download receipt'); }
  };
  const exportRange = async () => {
    setExporting(true);
    try {
      const token = localStorage.getItem('tbc_token');
      const params = new URLSearchParams();
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      const res = await fetch(`${API}/operator/transactions/export?${params}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || 'Export failed');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `tbc_transactions_${from || 'all'}_${to || 'all'}.pdf`; a.click();
      URL.revokeObjectURL(url);
      toast.success('Report downloaded');
    } catch (e) { toast.error(e.message); }
    finally { setExporting(false); }
  };

  if (loading) return <div className="grid place-items-center py-12"><Loader2 className="h-6 w-6 animate-spin text-tbc-400" /></div>;

  return (
    <div>
      {/* Export bar */}
      <div className="mb-4 flex flex-wrap items-end gap-3 rounded-xl border border-tbc-900/60 bg-ink-900/40 p-4">
        <div>
          <label className="text-[10px] uppercase tracking-wider text-tbc-200/60">From</label>
          <div className="mt-1 flex items-center gap-2">
            <Calendar className="h-4 w-4 text-tbc-400" />
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-9 w-44 bg-ink-950 border-tbc-900/60 text-tbc-100" />
          </div>
        </div>
        <div>
          <label className="text-[10px] uppercase tracking-wider text-tbc-200/60">To</label>
          <div className="mt-1 flex items-center gap-2">
            <Calendar className="h-4 w-4 text-tbc-400" />
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-9 w-44 bg-ink-950 border-tbc-900/60 text-tbc-100" />
          </div>
        </div>
        <Button onClick={exportRange} disabled={exporting} className="bg-tbc-500 text-ink-950 hover:bg-tbc-400 font-semibold">
          {exporting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileText className="mr-2 h-4 w-4" />}
          Download PDF report
        </Button>
        <div className="ml-auto text-xs text-tbc-200/60">Leave dates blank to include all time. Only paid transactions are included.</div>
      </div>

      <div className="rounded-xl border border-tbc-900/60 bg-ink-900/40">
        <Table>
          <TableHeader>
            <TableRow className="border-tbc-900/60 hover:bg-transparent">
              <TableHead>Date</TableHead>
              <TableHead>User</TableHead>
              <TableHead>Plan</TableHead>
              <TableHead>Amount</TableHead>
              <TableHead>Method</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.length === 0 && (
              <TableRow><TableCell colSpan={7} className="py-8 text-center text-tbc-200/50">No transactions yet</TableCell></TableRow>
            )}
            {items.map((t) => {
              const method = (t.metadata && t.metadata.method) || 'card';
              const isPending = t.payment_status === 'pending';
              const isPaid = t.payment_status === 'paid';
              return (
                <TableRow key={t.id} className="border-tbc-900/60 hover:bg-ink-900/60">
                  <TableCell className="text-xs text-tbc-200">{new Date(t.created_at).toLocaleString()}</TableCell>
                  <TableCell className="text-tbc-100">{t.user_email}</TableCell>
                  <TableCell className="capitalize text-tbc-200">{t.plan_id}</TableCell>
                  <TableCell className="text-tbc-200">${t.amount?.toFixed(2)} {t.currency?.toUpperCase()}</TableCell>
                  <TableCell className="capitalize text-tbc-200/80">{method.replace('_', ' ')}</TableCell>
                  <TableCell>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider ${isPaid ? 'bg-tbc-500/20 text-tbc-300' : isPending ? 'bg-amber-500/20 text-amber-300' : 'bg-rose-500/20 text-rose-300'}`}>{t.payment_status}</span>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      {isPending && (method === 'crypto_manual' || method === 'bank') && (
                        <>
                          <Button size="sm" variant="outline" className="border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950" onClick={() => confirm(t.id)}><CheckCircle2 className="h-3.5 w-3.5" /></Button>
                          <Button size="sm" variant="outline" className="border-rose-900/60 bg-ink-900 text-rose-300 hover:bg-rose-500/10" onClick={() => reject(t.id)}><XCircle className="h-3.5 w-3.5" /></Button>
                        </>
                      )}
                      <Button size="sm" variant="outline" className="border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950" onClick={() => downloadReceipt(t.id)} title="Download receipt"><Receipt className="h-3.5 w-3.5" /></Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

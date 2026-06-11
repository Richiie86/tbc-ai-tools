import React, { useEffect, useMemo, useState } from 'react';
import api from '../../lib/api';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Textarea } from '../../components/ui/textarea';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '../../components/ui/select';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '../../components/ui/dialog';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '../../components/ui/table';
import { toast } from 'sonner';
import { DollarSign, Loader2, CheckCircle2, Filter, Coins } from 'lucide-react';

export default function RoyaltiesTab() {
  const [licenses, setLicenses] = useState([]);
  const [rows, setRows] = useState([]);
  const [summary, setSummary] = useState(null);
  const [filterLic, setFilterLic] = useState('all');
  const [filterStatus, setFilterStatus] = useState('all');
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState({});
  const [remitOpen, setRemitOpen] = useState(false);
  const [remitForm, setRemitForm] = useState({ amount: 0, method: 'other', reference: '', note: '' });
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [l, s, r] = await Promise.all([
        api.get('/operator/licenses'),
        api.get('/operator/royalties/summary'),
        api.get('/operator/royalties', { params: filterLic !== 'all' ? { license_id: filterLic } : {} }),
      ]);
      setLicenses(l.data); setSummary(s.data); setRows(r.data);
    } catch { toast.error('Failed to load royalties'); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [filterLic]);

  const filteredRows = useMemo(() => filterStatus === 'all' ? rows : rows.filter((r) => r.status === filterStatus), [rows, filterStatus]);
  const owedRows = filteredRows.filter((r) => r.status === 'owed');
  const allSelected = owedRows.length > 0 && owedRows.every((r) => selected[r.id]);
  const selectedIds = Object.entries(selected).filter(([, v]) => v).map(([k]) => k);
  const selectedSum = owedRows.filter((r) => selected[r.id]).reduce((s, r) => s + (r.royalty_amount || 0), 0);

  const toggleAll = () => {
    if (allSelected) setSelected({});
    else setSelected(Object.fromEntries(owedRows.map((r) => [r.id, true])));
  };

  const openRemit = () => {
    if (filterLic === 'all') return toast.error('Pick a single license to record a remittance');
    if (selectedIds.length === 0) return toast.error('Select at least one owed royalty');
    setRemitForm({ amount: Number(selectedSum.toFixed(2)), method: 'other', reference: '', note: '' });
    setRemitOpen(true);
  };
  const saveRemit = async () => {
    setBusy(true);
    try {
      await api.post('/operator/royalties/remit', {
        license_id: filterLic,
        amount: Number(remitForm.amount),
        currency: 'usd',
        method: remitForm.method,
        reference: remitForm.reference,
        note: remitForm.note,
        royalty_ids: selectedIds,
      });
      toast.success('Marked as remitted');
      setRemitOpen(false);
      setSelected({});
      load();
    } catch (e) { toast.error(e?.response?.data?.detail || 'Save failed'); }
    finally { setBusy(false); }
  };

  if (loading) return <div className="grid place-items-center py-12"><Loader2 className="h-6 w-6 animate-spin text-tbc-400" /></div>;

  return (
    <div>
      {/* Summary */}
      <div className="mb-4 grid gap-3 sm:grid-cols-4">
        <Stat icon={Coins} label="Royalties owed" value={`$${(summary?.owed_total || 0).toLocaleString()}`} sub={`${summary?.owed_count || 0} records`} />
        <Stat icon={CheckCircle2} label="Remitted to date" value={`$${(summary?.remitted_total || 0).toLocaleString()}`} sub={`${summary?.remitted_count || 0} records`} />
        <Stat icon={DollarSign} label="Active licenses" value={summary?.licenses_active ?? 0} sub={`${summary?.licenses_total || 0} total`} />
        <Stat icon={Filter} label="Filtered selection" value={`$${selectedSum.toFixed(2)}`} sub={`${selectedIds.length} selected`} />
      </div>

      {/* Filter bar */}
      <div className="mb-3 flex flex-wrap items-end gap-3 rounded-xl border border-tbc-900/60 bg-ink-900/40 p-3">
        <div>
          <label className="text-[10px] uppercase tracking-wider text-tbc-200/60">License</label>
          <Select value={filterLic} onValueChange={setFilterLic}>
            <SelectTrigger className="h-9 w-64 bg-ink-950 border-tbc-900/60 text-tbc-100"><SelectValue placeholder="All licenses" /></SelectTrigger>
            <SelectContent className="bg-ink-900 border-tbc-900/60 text-tbc-100">
              <SelectItem value="all">All licenses</SelectItem>
              {licenses.map((l) => <SelectItem key={l.id} value={l.id}>{l.holder_name} ({l.holder_email})</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="text-[10px] uppercase tracking-wider text-tbc-200/60">Status</label>
          <Select value={filterStatus} onValueChange={setFilterStatus}>
            <SelectTrigger className="h-9 w-44 bg-ink-950 border-tbc-900/60 text-tbc-100"><SelectValue /></SelectTrigger>
            <SelectContent className="bg-ink-900 border-tbc-900/60 text-tbc-100">
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="owed">Owed</SelectItem>
              <SelectItem value="remitted">Remitted</SelectItem>
              <SelectItem value="disputed">Disputed</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="ml-auto">
          <Dialog open={remitOpen} onOpenChange={setRemitOpen}>
            <DialogTrigger asChild>
              <Button onClick={openRemit} disabled={filterLic === 'all' || selectedIds.length === 0} className="bg-tbc-500 text-ink-950 hover:bg-tbc-400 font-semibold">
                <CheckCircle2 className="mr-1.5 h-4 w-4" /> Mark selected as remitted
              </Button>
            </DialogTrigger>
            <DialogContent className="border-tbc-900/60 bg-ink-900 text-tbc-100">
              <DialogHeader><DialogTitle>Record remittance</DialogTitle></DialogHeader>
              <div className="grid gap-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs uppercase tracking-wider text-tbc-200/60">Amount (USD)</label>
                    <Input type="number" step="0.01" className="mt-1.5 bg-ink-950 border-tbc-900/60 text-tbc-100" value={remitForm.amount} onChange={(e) => setRemitForm({ ...remitForm, amount: e.target.value })} />
                  </div>
                  <div>
                    <label className="text-xs uppercase tracking-wider text-tbc-200/60">Method</label>
                    <Select value={remitForm.method} onValueChange={(v) => setRemitForm({ ...remitForm, method: v })}>
                      <SelectTrigger className="mt-1.5 h-9 bg-ink-950 border-tbc-900/60 text-tbc-100"><SelectValue /></SelectTrigger>
                      <SelectContent className="bg-ink-900 border-tbc-900/60 text-tbc-100">
                        <SelectItem value="stripe">Stripe</SelectItem>
                        <SelectItem value="crypto_manual">Crypto</SelectItem>
                        <SelectItem value="bank">Bank transfer</SelectItem>
                        <SelectItem value="paypal">PayPal</SelectItem>
                        <SelectItem value="other">Other</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div>
                  <label className="text-xs uppercase tracking-wider text-tbc-200/60">Reference</label>
                  <Input className="mt-1.5 bg-ink-950 border-tbc-900/60 text-tbc-100" value={remitForm.reference} onChange={(e) => setRemitForm({ ...remitForm, reference: e.target.value })} placeholder="tx hash, bank ref, Stripe pi_..." />
                </div>
                <div>
                  <label className="text-xs uppercase tracking-wider text-tbc-200/60">Note</label>
                  <Textarea rows={2} className="mt-1.5 bg-ink-950 border-tbc-900/60 text-tbc-100" value={remitForm.note} onChange={(e) => setRemitForm({ ...remitForm, note: e.target.value })} />
                </div>
                <div className="rounded-md bg-ink-950 p-3 text-xs text-tbc-200/70">{selectedIds.length} royalty record(s) will be marked as remitted.</div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setRemitOpen(false)} className="border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950">Cancel</Button>
                <Button onClick={saveRemit} disabled={busy} className="bg-tbc-500 text-ink-950 hover:bg-tbc-400 font-semibold">{busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}Confirm</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Table */}
      <div className="rounded-xl border border-tbc-900/60 bg-ink-900/40">
        <Table>
          <TableHeader>
            <TableRow className="border-tbc-900/60 hover:bg-transparent">
              <TableHead className="w-8">
                <input type="checkbox" checked={allSelected} onChange={toggleAll} className="accent-tbc-500" />
              </TableHead>
              <TableHead>Date</TableHead>
              <TableHead>License</TableHead>
              <TableHead>Child tx</TableHead>
              <TableHead>Gross</TableHead>
              <TableHead>Royalty</TableHead>
              <TableHead>Method</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredRows.length === 0 && (
              <TableRow><TableCell colSpan={8} className="py-8 text-center text-tbc-200/50">No royalty records yet</TableCell></TableRow>
            )}
            {filteredRows.map((r) => {
              const lic = licenses.find((l) => l.id === r.license_id);
              const isOwed = r.status === 'owed';
              return (
                <TableRow key={r.id} className="border-tbc-900/60 hover:bg-ink-900/60">
                  <TableCell>
                    <input type="checkbox" disabled={!isOwed} checked={!!selected[r.id]} onChange={(e) => setSelected({ ...selected, [r.id]: e.target.checked })} className="accent-tbc-500" />
                  </TableCell>
                  <TableCell className="text-xs text-tbc-200">{new Date(r.occurred_at).toLocaleString()}</TableCell>
                  <TableCell className="text-tbc-100">{lic ? lic.holder_name : r.license_id.slice(0, 8)}</TableCell>
                  <TableCell className="font-mono text-xs text-tbc-200/80">{r.child_transaction_id.slice(0, 16)}</TableCell>
                  <TableCell className="text-tbc-200">${r.gross_amount?.toFixed(2)}</TableCell>
                  <TableCell className="font-bold text-tbc-100">${r.royalty_amount?.toFixed(2)}</TableCell>
                  <TableCell className="capitalize text-tbc-200/80">{(r.payment_method || '—').replace('_', ' ')}</TableCell>
                  <TableCell>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider ${r.status === 'remitted' ? 'bg-tbc-500/15 text-tbc-300' : r.status === 'owed' ? 'bg-amber-500/20 text-amber-300' : 'bg-rose-500/20 text-rose-300'}`}>{r.status}</span>
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

function Stat({ icon: Icon, label, value, sub }) {
  return (
    <div className="rounded-xl border border-tbc-900/60 bg-ink-900/60 p-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-tbc-200/60">{label}</div>
          <div className="mt-1 text-xl font-bold text-tbc-100">{value}</div>
          {sub && <div className="text-[10px] text-tbc-200/50">{sub}</div>}
        </div>
        <div className="grid h-8 w-8 place-items-center rounded-lg bg-tbc-500/15 text-tbc-300"><Icon className="h-4 w-4" /></div>
      </div>
    </div>
  );
}

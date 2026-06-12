import React, { useEffect, useState, useCallback } from 'react';
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
import { toast } from 'sonner';
import {
  Plus, Pencil, Trash2, Loader2, CheckCircle2, Building2, Wallet,
} from 'lucide-react';

const EMPTY = {
  label: '', type: 'bank',
  holder_name: '', iban: '', bic: '', bank_name: '', bank_address: '', reference: '',
  network: 'BTC', wallet_address: '', memo: '', notes: '',
};

const NETWORKS = ['BTC', 'ETH', 'SOL', 'TRC20-USDT', 'ERC20-USDT', 'POLYGON-USDC', 'BNB-BSC', 'LTC'];

export default function TreasuryTab() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try { const { data } = await api.get('/operator/treasury'); setItems(data); }
    catch { toast.error('Failed to load treasury'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const openCreate = () => { setEditing(null); setForm(EMPTY); setOpen(true); };
  const openEdit = (d) => { setEditing(d.id); setForm({ ...EMPTY, ...d }); setOpen(true); };

  const save = async () => {
    if (!form.label) return toast.error('Label is required');
    if (form.type === 'bank' && (!form.holder_name || !form.iban)) return toast.error('Holder name and IBAN required');
    if (form.type === 'crypto' && (!form.network || !form.wallet_address)) return toast.error('Network and wallet address required');
    setSaving(true);
    try {
      if (editing) await api.put(`/operator/treasury/${editing}`, form);
      else await api.post('/operator/treasury', form);
      toast.success('Saved');
      setOpen(false);
      load();
    } catch (e) { toast.error(e?.response?.data?.detail || 'Save failed'); }
    finally { setSaving(false); }
  };
  const del = async (id) => {
    if (!window.confirm('Delete this destination?')) return;
    try { await api.delete(`/operator/treasury/${id}`); toast.success('Deleted'); load(); }
    catch { toast.error('Delete failed'); }
  };
  const activate = async (id) => {
    try { await api.post(`/operator/treasury/${id}/activate`); toast.success('Activated'); load(); }
    catch { toast.error('Could not activate'); }
  };

  if (loading) return <div className="grid place-items-center py-12"><Loader2 className="h-6 w-6 animate-spin text-tbc-400" /></div>;

  return (
    <div>
      <div className="mb-4 rounded-lg border border-tbc-500/20 bg-tbc-500/5 p-3 text-xs text-tbc-200/80 leading-relaxed">
        <div className="font-semibold text-tbc-200 mb-1">💡 Treasury covers MANUAL payments only</div>
        <p>Manual bank transfers and crypto deposits land <strong>directly in the accounts/wallets you list below</strong>.
        Automated payments (Stripe / PayPal / NOWPayments) keep funds in their own dashboards until you withdraw —
        configure payout rules in <em>their</em> dashboards (Stripe Settings → Payouts, PayPal Wallet, NOWPayments Balance).</p>
      </div>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm text-tbc-200/60">Configure where incoming payments are sent. Activate one bank and one crypto destination at a time.</p>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button onClick={openCreate} className="bg-tbc-500 text-ink-950 hover:bg-tbc-400 font-semibold"><Plus className="mr-1.5 h-4 w-4" /> Add destination</Button>
          </DialogTrigger>
          <DialogContent className="border-tbc-900/60 bg-ink-900 text-tbc-100 max-w-xl">
            <DialogHeader><DialogTitle>{editing ? 'Edit destination' : 'New destination'}</DialogTitle></DialogHeader>
            <div className="grid gap-3">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Label"><Input className="bg-ink-950 border-tbc-900/60 text-tbc-100" value={form.label} onChange={(e)=>setForm({...form, label:e.target.value})} placeholder="e.g. Main bank, USDT Tron wallet" /></Field>
                <Field label="Type">
                  <Select value={form.type} onValueChange={(v)=>setForm({...form, type:v})}>
                    <SelectTrigger className="bg-ink-950 border-tbc-900/60 text-tbc-100"><SelectValue /></SelectTrigger>
                    <SelectContent className="bg-ink-900 border-tbc-900/60 text-tbc-100">
                      <SelectItem value="bank">Bank account</SelectItem>
                      <SelectItem value="crypto">Crypto wallet</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              </div>
              {form.type === 'bank' ? (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Holder name"><Input className="bg-ink-950 border-tbc-900/60 text-tbc-100" value={form.holder_name} onChange={(e)=>setForm({...form, holder_name:e.target.value})} /></Field>
                    <Field label="Bank name"><Input className="bg-ink-950 border-tbc-900/60 text-tbc-100" value={form.bank_name} onChange={(e)=>setForm({...form, bank_name:e.target.value})} /></Field>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="IBAN"><Input className="bg-ink-950 border-tbc-900/60 text-tbc-100" value={form.iban} onChange={(e)=>setForm({...form, iban:e.target.value})} /></Field>
                    <Field label="BIC / SWIFT"><Input className="bg-ink-950 border-tbc-900/60 text-tbc-100" value={form.bic} onChange={(e)=>setForm({...form, bic:e.target.value})} /></Field>
                  </div>
                  <Field label="Bank address"><Input className="bg-ink-950 border-tbc-900/60 text-tbc-100" value={form.bank_address} onChange={(e)=>setForm({...form, bank_address:e.target.value})} /></Field>
                  <Field label="Payment reference"><Input className="bg-ink-950 border-tbc-900/60 text-tbc-100" value={form.reference} onChange={(e)=>setForm({...form, reference:e.target.value})} placeholder="e.g. TBC-MEMBERSHIP" /></Field>
                </>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Network">
                      <Select value={form.network} onValueChange={(v)=>setForm({...form, network:v})}>
                        <SelectTrigger className="bg-ink-950 border-tbc-900/60 text-tbc-100"><SelectValue /></SelectTrigger>
                        <SelectContent className="bg-ink-900 border-tbc-900/60 text-tbc-100">
                          {NETWORKS.map((n) => <SelectItem key={n} value={n}>{n}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field label="Memo / tag (optional)"><Input className="bg-ink-950 border-tbc-900/60 text-tbc-100" value={form.memo} onChange={(e)=>setForm({...form, memo:e.target.value})} /></Field>
                  </div>
                  <Field label="Wallet address"><Input className="bg-ink-950 border-tbc-900/60 text-tbc-100 font-mono text-xs" value={form.wallet_address} onChange={(e)=>setForm({...form, wallet_address:e.target.value})} /></Field>
                </>
              )}
              <Field label="Internal notes"><Textarea rows={2} className="bg-ink-950 border-tbc-900/60 text-tbc-100" value={form.notes} onChange={(e)=>setForm({...form, notes:e.target.value})} /></Field>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={()=>setOpen(false)} className="border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950">Cancel</Button>
              <Button onClick={save} disabled={saving} className="bg-tbc-500 text-ink-950 hover:bg-tbc-400 font-semibold">{saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}Save</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {items.length === 0 && (
          <div className="col-span-2 rounded-xl border border-dashed border-tbc-900/60 p-10 text-center text-tbc-200/50">
            No destinations yet. Add a bank or crypto wallet to start receiving payments.
          </div>
        )}
        {items.map((d) => (
          <div key={d.id} className={`rounded-xl border p-5 ${d.is_active ? 'border-tbc-500/40 bg-tbc-500/[0.04]' : 'border-tbc-900/60 bg-ink-900/60'}`}>
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-2">
                <div className="grid h-9 w-9 place-items-center rounded-lg bg-tbc-500/15 text-tbc-300">
                  {d.type === 'bank' ? <Building2 className="h-4 w-4" /> : <Wallet className="h-4 w-4" />}
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-base font-bold text-tbc-100">{d.label}</span>
                    {d.is_active && <span className="flex items-center gap-1 rounded-full bg-tbc-500/15 px-2 py-0.5 text-[10px] uppercase text-tbc-300"><CheckCircle2 className="h-3 w-3" /> active</span>}
                  </div>
                  <div className="text-[10px] uppercase tracking-wider text-tbc-200/50">{d.type === 'bank' ? d.bank_name : d.network}</div>
                </div>
              </div>
              <div className="flex gap-1">
                {!d.is_active && <Button size="sm" variant="outline" className="border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950" onClick={() => activate(d.id)}>Activate</Button>}
                <Button size="icon" variant="outline" className="h-8 w-8 border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950" onClick={() => openEdit(d)}><Pencil className="h-3.5 w-3.5" /></Button>
                <Button size="icon" variant="outline" className="h-8 w-8 border-rose-900/60 bg-ink-900 text-rose-300 hover:bg-rose-500/10" onClick={() => del(d.id)}><Trash2 className="h-3.5 w-3.5" /></Button>
              </div>
            </div>
            <div className="mt-3 space-y-1 text-xs">
              {d.type === 'bank' ? (
                <>
                  <Row k="Holder" v={d.holder_name} />
                  <Row k="IBAN" v={d.iban} />
                  <Row k="BIC" v={d.bic} />
                  {d.reference && <Row k="Reference" v={d.reference} />}
                </>
              ) : (
                <>
                  <Row k="Address" v={d.wallet_address} mono />
                  {d.memo && <Row k="Memo" v={d.memo} />}
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Row({ k, v, mono }) {
  return (
    <div className="flex gap-2">
      <span className="w-20 shrink-0 text-tbc-200/50">{k}</span>
      <span className={`flex-1 truncate text-tbc-200 ${mono ? 'font-mono' : ''}`}>{v || '—'}</span>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <label className="text-xs font-semibold uppercase tracking-wider text-tbc-200/60">{label}</label>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

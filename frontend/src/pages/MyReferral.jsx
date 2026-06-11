import React, { useEffect, useState } from 'react';
import Navbar from '../components/Navbar';
import api from '../lib/api';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import ShareButtons from '../components/ShareButtons';
import { toast } from 'sonner';
import {
  Share2, Loader2, Copy, Check, Users, MousePointerClick, Coins, BadgeDollarSign,
} from 'lucide-react';

export default function MyReferral() {
  const [info, setInfo] = useState(null);
  const [earnings, setEarnings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [domain, setDomain] = useState('org'); // org | com
  const [copied, setCopied] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [a, b] = await Promise.all([
        api.get('/referral/me'),
        api.get('/referral/my-earnings'),
      ]);
      setInfo(a.data); setEarnings(b.data);
    } catch { toast.error('Failed to load referral info'); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const activeUrl = info ? (domain === 'org' ? info.share_url_org : info.share_url_com) : '';
  const copy = () => {
    if (!activeUrl) return;
    navigator.clipboard.writeText(activeUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  if (loading || !info) return <div className="grid min-h-screen place-items-center bg-ink-950"><Loader2 className="h-7 w-7 animate-spin text-tbc-400" /></div>;

  return (
    <div className="min-h-screen bg-ink-950">
      <Navbar />
      <section className="mx-auto max-w-5xl px-5 py-10">
        <div className="flex items-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-xl bg-tbc-500/15 text-tbc-300"><Share2 className="h-5 w-5" /></div>
          <div>
            <h1 className="text-3xl font-bold text-tbc-50">Refer & earn {info.commission_pct}%</h1>
            <p className="text-sm text-tbc-200/60">Every paid subscription from your referrals pays you {info.commission_pct}% of the amount.</p>
          </div>
        </div>

        {/* Stats */}
        <div className="mt-8 grid gap-3 sm:grid-cols-4">
          <Stat icon={MousePointerClick} label="Clicks" value={info.stats.clicks} />
          <Stat icon={Users} label="Signups" value={info.stats.signups} />
          <Stat icon={Coins} label="Accrued" value={`$${(info.stats.accrued_usd || 0).toFixed(2)}`} sub={`${info.stats.accrued_count} payments`} />
          <Stat icon={BadgeDollarSign} label="Paid out" value={`$${(info.stats.paid_usd || 0).toFixed(2)}`} sub={`${info.stats.paid_count} payments`} />
        </div>

        {/* Link */}
        <div className="mt-8 rounded-2xl border border-tbc-900/60 bg-ink-900/60 p-6">
          <div className="mb-3 flex items-center gap-2">
            <span className="text-xs uppercase tracking-wider text-tbc-200/60">Your referral link</span>
            <div className="ml-auto flex gap-1">
              <button onClick={() => setDomain('org')} className={`rounded-md px-2.5 py-1 text-xs ${domain === 'org' ? 'bg-tbc-500 text-ink-950 font-semibold' : 'border border-tbc-900/60 text-tbc-200 hover:bg-ink-950'}`}>tbctools.org</button>
              <button onClick={() => setDomain('com')} className={`rounded-md px-2.5 py-1 text-xs ${domain === 'com' ? 'bg-tbc-500 text-ink-950 font-semibold' : 'border border-tbc-900/60 text-tbc-200 hover:bg-ink-950'}`}>tbctools.com</button>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Input readOnly value={activeUrl} className="bg-ink-950 border-tbc-900/60 text-tbc-100 font-mono text-xs" />
            <Button onClick={copy} className="bg-tbc-500 text-ink-950 hover:bg-tbc-400 font-semibold">
              {copied ? <Check className="mr-1.5 h-4 w-4" /> : <Copy className="mr-1.5 h-4 w-4" />} Copy
            </Button>
          </div>
          <div className="mt-4">
            <div className="mb-1 text-xs uppercase tracking-wider text-tbc-200/60">Share on social</div>
            <ShareButtons url={activeUrl} text={`Build apps faster with TBC AI Control \u2014 join via my link to support me with ${info.commission_pct}% commission:`} compact />
          </div>
        </div>

        {/* Earnings table */}
        <div className="mt-8">
          <h2 className="text-lg font-bold text-tbc-50">Earnings</h2>
          <div className="mt-3 overflow-hidden rounded-xl border border-tbc-900/60 bg-ink-900/40">
            {earnings.length === 0 ? (
              <div className="p-8 text-center text-sm text-tbc-200/50">No earnings yet. Share your link to start earning.</div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-tbc-900/60 text-left text-xs uppercase tracking-wider text-tbc-200/60">
                    <th className="px-4 py-2">Date</th>
                    <th className="px-4 py-2">Referred user</th>
                    <th className="px-4 py-2">Plan</th>
                    <th className="px-4 py-2">Gross</th>
                    <th className="px-4 py-2">Commission</th>
                    <th className="px-4 py-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {earnings.map((e) => (
                    <tr key={e.id} className="border-b border-tbc-900/40 last:border-0">
                      <td className="px-4 py-2 text-xs text-tbc-200">{new Date(e.created_at).toLocaleString()}</td>
                      <td className="px-4 py-2 text-tbc-100">{e.referred_user_email}</td>
                      <td className="px-4 py-2 capitalize text-tbc-200">{e.plan_id}</td>
                      <td className="px-4 py-2 text-tbc-200">${e.gross_amount?.toFixed(2)}</td>
                      <td className="px-4 py-2 font-bold text-tbc-100">${e.commission_amount?.toFixed(2)}</td>
                      <td className="px-4 py-2">
                        <span className={`rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider ${e.status === 'paid' ? 'bg-tbc-500/15 text-tbc-300' : 'bg-amber-500/20 text-amber-300'}`}>{e.status}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </section>
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

import React, { useCallback, useEffect, useState } from 'react';
import api from '../../lib/api';
import { toast } from 'sonner';
import {
  Share2, Facebook, Youtube, Instagram, Music2, Globe, Twitter, Linkedin,
  Plus, Trash2, Save, Loader2, Link2, ShieldCheck, Lock, Check, X, Unplug,
} from 'lucide-react';
import { Input } from '../../components/ui/input';
import { Button } from '../../components/ui/button';
import { Switch } from '../../components/ui/switch';

const PLATFORM_META = {
  facebook:  { label: 'Facebook',  icon: Facebook,  color: 'text-[#1877F2]' },
  youtube:   { label: 'YouTube',   icon: Youtube,   color: 'text-[#FF0000]' },
  instagram: { label: 'Instagram', icon: Instagram, color: 'text-[#E4405F]' },
  tiktok:    { label: 'TikTok',    icon: Music2,    color: 'text-tbc-100' },
  twitter:   { label: 'X / Twitter', icon: Twitter, color: 'text-tbc-100' },
  linkedin:  { label: 'LinkedIn',  icon: Linkedin,  color: 'text-[#0A66C2]' },
  website:   { label: 'Website',   icon: Globe,     color: 'text-tbc-300' },
};

const LINK_PLATFORMS = Object.keys(PLATFORM_META);

export default function SocialTab() {
  return (
    <div className="space-y-8" data-testid="social-tab">
      <header className="flex items-start gap-3">
        <span className="grid h-9 w-9 place-items-center rounded-lg bg-tbc-500/15 text-tbc-300">
          <Share2 className="h-4 w-4" />
        </span>
        <div>
          <h2 className="text-lg font-bold text-tbc-100">Social media</h2>
          <p className="text-sm text-tbc-200/60">
            Add the social links shown across your app, and securely connect accounts for direct posting.
          </p>
        </div>
      </header>

      <PublicLinks />
      <ConnectedAccounts />
    </div>
  );
}

/* ─── Public links ─────────────────────────────────────────────────────── */
function PublicLinks() {
  const [links, setLinks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/operator/social/links');
      setLinks(data.links || []);
    } catch {
      toast.error('Could not load links.');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const add = () => setLinks((l) => [...l, { platform: 'website', label: '', url: '', enabled: true }]);
  const update = (i, patch) => setLinks((l) => l.map((x, idx) => (idx === i ? { ...x, ...patch } : x)));
  const remove = (i) => setLinks((l) => l.filter((_, idx) => idx !== i));

  const save = async () => {
    setSaving(true);
    try {
      const { data } = await api.put('/operator/social/links', { links });
      setLinks(data.links || []);
      toast.success('Social links saved.');
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not save links.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="flex items-center gap-2 py-8 text-tbc-200/60"><Loader2 className="h-4 w-4 animate-spin" /> Loading links…</div>;
  }

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-tbc-300">
            <Link2 className="h-4 w-4" /> Public links
          </h3>
          <p className="text-xs text-tbc-200/50">Shown in your footer / profile. Safe to share — no secrets here.</p>
        </div>
        <Button onClick={save} disabled={saving} className="bg-tbc-500 font-semibold text-ink-950 hover:bg-tbc-400">
          {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Save className="mr-1.5 h-4 w-4" />} Save links
        </Button>
      </div>

      <div className="space-y-2">
        {links.length === 0 && <p className="text-sm text-tbc-200/40">No links yet — add your first below.</p>}
        {links.map((l, i) => {
          const meta = PLATFORM_META[l.platform] || PLATFORM_META.website;
          const Icon = meta.icon;
          return (
            <div key={i} className="flex flex-wrap items-center gap-2 rounded-lg border border-tbc-900/60 bg-ink-900 p-3">
              <Icon className={`h-5 w-5 shrink-0 ${meta.color}`} />
              <select value={l.platform} onChange={(e) => update(i, { platform: e.target.value })}
                className="rounded-md border border-tbc-900/60 bg-ink-950 px-2 py-2 text-sm text-tbc-100">
                {LINK_PLATFORMS.map((p) => <option key={p} value={p}>{PLATFORM_META[p].label}</option>)}
              </select>
              <Input value={l.url} onChange={(e) => update(i, { url: e.target.value })}
                placeholder="https://…" className="min-w-[200px] flex-1 bg-ink-950 border-tbc-900/60 text-tbc-100" />
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] uppercase tracking-wider text-tbc-200/50">{l.enabled ? 'Live' : 'Hidden'}</span>
                <Switch checked={!!l.enabled} onCheckedChange={(v) => update(i, { enabled: v })} />
              </div>
              <button type="button" onClick={() => remove(i)}
                className="rounded-md p-1.5 text-tbc-200/40 hover:bg-rose-500/10 hover:text-rose-300" aria-label="Remove link">
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          );
        })}
      </div>
      <Button variant="outline" onClick={add} className="mt-3 border-tbc-900/60 text-tbc-100 hover:bg-ink-800">
        <Plus className="mr-1.5 h-4 w-4" /> Add link
      </Button>
    </section>
  );
}

/* ─── Connected accounts (secure) ──────────────────────────────────────── */
function ConnectedAccounts() {
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/operator/social/accounts');
      setAccounts(data.accounts || []);
    } catch {
      toast.error('Could not load connected accounts.');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (loading) {
    return <div className="flex items-center gap-2 py-8 text-tbc-200/60"><Loader2 className="h-4 w-4 animate-spin" /> Loading accounts…</div>;
  }

  return (
    <section>
      <div className="mb-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-tbc-300">
          <ShieldCheck className="h-4 w-4" /> Connected accounts
        </h3>
        <p className="text-xs text-tbc-200/50">
          For direct posting. Tokens are <span className="text-tbc-100">encrypted at rest</span> and never shown again —
          only a masked hint. Operator-only.
        </p>
      </div>

      <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200/90">
        <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <p>
          Direct posting requires each platform&apos;s approved developer app + OAuth. Paste the access token from your
          approved app here to enable it; until then, use the share buttons in the Marketing tab.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {accounts.map((a) => <AccountCard key={a.platform} account={a} onChanged={load} />)}
      </div>
    </section>
  );
}

function AccountCard({ account, onChanged }) {
  const meta = PLATFORM_META[account.platform] || PLATFORM_META.website;
  const Icon = meta.icon;
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);

  const connect = async () => {
    if (!token.trim()) { toast.error('Paste an access token.'); return; }
    setBusy(true);
    try {
      await api.put(`/operator/social/accounts/${account.platform}`, {
        account_name: name, access_token: token,
      });
      toast.success(`${meta.label} connected securely.`);
      setToken(''); setName(''); setOpen(false);
      onChanged();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not connect.');
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      await api.delete(`/operator/social/accounts/${account.platform}`);
      toast.success(`${meta.label} disconnected.`);
      onChanged();
    } catch {
      toast.error('Could not disconnect.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-tbc-900/60 bg-ink-900 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <Icon className={`h-6 w-6 ${meta.color}`} />
          <div>
            <p className="font-semibold text-tbc-100">{meta.label}</p>
            {account.connected ? (
              <p className="flex items-center gap-1 text-xs text-emerald-300">
                <Check className="h-3 w-3" /> {account.account_name || 'Connected'} · {account.token_hint}
              </p>
            ) : (
              <p className="flex items-center gap-1 text-xs text-tbc-200/40"><X className="h-3 w-3" /> Not connected</p>
            )}
          </div>
        </div>
        {account.connected ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={disconnect}
            className="border-rose-500/40 text-rose-300 hover:bg-rose-500/10">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Unplug className="mr-1 h-3.5 w-3.5" /> Disconnect</>}
          </Button>
        ) : (
          <Button size="sm" onClick={() => setOpen((o) => !o)}
            className="bg-tbc-500 font-semibold text-ink-950 hover:bg-tbc-400">
            {open ? 'Cancel' : 'Connect'}
          </Button>
        )}
      </div>

      {open && !account.connected && (
        <div className="mt-3 space-y-2 border-t border-tbc-900/60 pt-3">
          <Input value={name} onChange={(e) => setName(e.target.value)}
            placeholder="Account / page name" className="bg-ink-950 border-tbc-900/60 text-tbc-100" />
          <Input type="password" value={token} onChange={(e) => setToken(e.target.value)}
            placeholder="Access token (from your approved app)" className="bg-ink-950 border-tbc-900/60 text-tbc-100" />
          <Button size="sm" disabled={busy} onClick={connect}
            className="w-full bg-emerald-500 font-semibold text-ink-950 hover:bg-emerald-400">
            {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-1.5 h-4 w-4" />}
            Store securely
          </Button>
        </div>
      )}
    </div>
  );
}

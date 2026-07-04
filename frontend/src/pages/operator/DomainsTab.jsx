import React, { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../../lib/api';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { toast } from 'sonner';
import {
  Globe, Loader2, RefreshCw, ShieldCheck, ShieldAlert, Search,
  CheckCircle2, XCircle, ExternalLink, KeyRound,
} from 'lucide-react';

/**
 * Operator → Domains
 *
 * Manage the domains registered with Porkbun straight from the app. Uses the
 * Porkbun API key + secret key the operator saves in My Keys (single source of
 * truth — this tab never asks for the keys itself).
 *
 *   • Connection banner  — live "ping" verification of the saved key pair.
 *   • Your domains        — every domain in the Porkbun account with status,
 *                           expiry, and auto-renew flags.
 *   • Availability check  — is a domain free, and what does it cost?
 */
export default function DomainsTab() {
  const [connected, setConnected] = useState(null); // null = loading
  const [pinging, setPinging] = useState(false);
  const [pingResult, setPingResult] = useState(null);

  const [domains, setDomains] = useState(null); // null = not loaded yet
  const [loadingDomains, setLoadingDomains] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      const { data } = await api.get('/operator/porkbun/status');
      setConnected(!!data.connected);
      return !!data.connected;
    } catch {
      setConnected(false);
      return false;
    }
  }, []);

  const loadDomains = useCallback(async () => {
    setLoadingDomains(true);
    try {
      const { data } = await api.get('/operator/porkbun/domains');
      setDomains(data.domains || []);
    } catch (e) {
      const msg = e?.response?.data?.detail || 'Failed to load domains';
      toast.error(msg);
      setDomains([]);
    } finally {
      setLoadingDomains(false);
    }
  }, []);

  useEffect(() => {
    (async () => {
      const ok = await loadStatus();
      if (ok) loadDomains();
    })();
  }, [loadStatus, loadDomains]);

  const ping = async () => {
    setPinging(true);
    setPingResult(null);
    try {
      const { data } = await api.post('/operator/porkbun/ping');
      setPingResult({ ok: true, message: data.message, ip: data.your_ip });
      toast.success('Porkbun keys valid');
      loadDomains();
    } catch (e) {
      const msg = e?.response?.data?.detail || 'Ping failed';
      setPingResult({ ok: false, message: msg });
      toast.error(msg);
    } finally {
      setPinging(false);
    }
  };

  return (
    <div className="space-y-6" data-testid="domains-tab">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="grid h-10 w-10 place-items-center rounded-xl bg-tbc-500/15 text-tbc-300">
          <Globe className="h-5 w-5" />
        </div>
        <div>
          <h2 className="text-xl font-bold text-tbc-100">Domains</h2>
          <p className="text-sm text-tbc-200/60">
            Manage the domains in your Porkbun account, check availability, and
            verify your connection — all from here.
          </p>
        </div>
      </div>

      {connected === null ? (
        <div className="grid place-items-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-tbc-400" />
        </div>
      ) : connected ? (
        <>
          <ConnectionBanner
            pinging={pinging}
            pingResult={pingResult}
            onPing={ping}
          />
          <DomainsList
            domains={domains}
            loading={loadingDomains}
            onRefresh={loadDomains}
          />
          <AvailabilityCheck />
        </>
      ) : (
        <NotConnected />
      )}
    </div>
  );
}

function NotConnected() {
  return (
    <div
      className="rounded-xl border border-amber-500/30 bg-amber-500/[0.06] p-6 text-center"
      data-testid="porkbun-not-connected"
    >
      <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-full bg-amber-500/15 text-amber-300">
        <ShieldAlert className="h-6 w-6" />
      </div>
      <h3 className="text-base font-bold text-tbc-100">Porkbun isn&apos;t connected yet</h3>
      <p className="mx-auto mt-1 max-w-md text-sm text-tbc-200/70">
        Add both your Porkbun <span className="font-semibold text-tbc-100">API key</span>{' '}
        (<span className="font-mono">pk1_…</span>) and{' '}
        <span className="font-semibold text-tbc-100">secret key</span>{' '}
        (<span className="font-mono">sk1_…</span>) in the My Keys tab. Once both
        are saved, your domains show up here automatically.
      </p>
      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        <a
          href="/operator?tab=keys"
          className="inline-flex items-center gap-1.5 rounded-md bg-tbc-500 px-3 py-2 text-sm font-semibold text-ink-950 hover:bg-tbc-400"
          data-testid="go-to-keys"
        >
          <KeyRound className="h-4 w-4" /> Add Porkbun keys
        </a>
        <a
          href="https://porkbun.com/account/api"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 rounded-md border border-tbc-900/60 bg-ink-900 px-3 py-2 text-sm text-tbc-100 hover:bg-ink-950"
        >
          Get keys from Porkbun <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>
    </div>
  );
}

function ConnectionBanner({ pinging, pingResult, onPing }) {
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/[0.06] p-4"
      data-testid="porkbun-connection"
    >
      <div className="flex items-center gap-2 text-sm">
        <ShieldCheck className="h-5 w-5 text-emerald-300" />
        <span className="font-semibold text-tbc-100">Porkbun connected</span>
        <span className="text-tbc-200/60">— keys are saved and encrypted.</span>
        {pingResult?.ok && pingResult.ip && (
          <span className="hidden font-mono text-xs text-emerald-300/80 sm:inline">
            IP {pingResult.ip}
          </span>
        )}
        {pingResult && !pingResult.ok && (
          <span className="text-xs text-rose-300">{pingResult.message}</span>
        )}
      </div>
      <Button
        variant="outline"
        onClick={onPing}
        disabled={pinging}
        data-testid="porkbun-ping"
        className="border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950"
      >
        {pinging
          ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          : <ShieldCheck className="mr-1.5 h-3.5 w-3.5" />}
        Verify keys
      </Button>
    </div>
  );
}

function DomainsList({ domains, loading, onRefresh }) {
  return (
    <div className="rounded-xl border border-tbc-500/30 bg-gradient-to-br from-tbc-500/[0.04] via-ink-900/60 to-ink-900/60 p-5">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Globe className="h-4 w-4 text-tbc-300" />
          <h3 className="text-base font-bold text-tbc-100">Your domains</h3>
          {Array.isArray(domains) && (
            <span className="rounded-full bg-tbc-500/15 px-2 py-0.5 text-xs font-semibold text-tbc-200">
              {domains.length}
            </span>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={onRefresh}
          disabled={loading}
          data-testid="refresh-domains"
          className="border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950"
        >
          {loading
            ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
          Refresh
        </Button>
      </div>

      {loading && domains == null ? (
        <div className="grid place-items-center py-10">
          <Loader2 className="h-5 w-5 animate-spin text-tbc-400" />
        </div>
      ) : domains && domains.length > 0 ? (
        <div className="space-y-2" data-testid="domains-list">
          {domains.map((d) => <DomainRow key={d.domain} d={d} />)}
        </div>
      ) : (
        <p className="rounded-md border border-dashed border-tbc-500/25 bg-ink-900/40 px-3 py-4 text-center text-sm text-tbc-200/60">
          No domains found in this Porkbun account yet.
        </p>
      )}
    </div>
  );
}

function DomainRow({ d }) {
  const active = String(d.status || '').toUpperCase() === 'ACTIVE';
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-tbc-900/60 bg-ink-950/50 px-3 py-2.5"
      data-testid={`domain-row-${d.domain}`}
    >
      <div className="flex items-center gap-2">
        <Globe className="h-4 w-4 text-tbc-300" />
        <span className="text-sm font-bold text-tbc-100">{d.domain}</span>
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
            active ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300'
          }`}
        >
          {d.status || 'unknown'}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-xs text-tbc-200/60">
        {d.expire_date && <span>Expires {String(d.expire_date).slice(0, 10)}</span>}
        <span className={d.auto_renew ? 'text-emerald-300' : 'text-tbc-200/50'}>
          {d.auto_renew ? 'Auto-renew on' : 'Auto-renew off'}
        </span>
        {d.whois_privacy && <span className="text-tbc-300">WHOIS private</span>}
        <a
          href={`https://porkbun.com/account/domainsSpeedy/${d.domain}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-tbc-300 hover:text-tbc-200"
        >
          Manage <ExternalLink className="h-3 w-3" />
        </a>
      </div>
    </div>
  );
}

function AvailabilityCheck() {
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const canCheck = useMemo(() => query.trim().includes('.'), [query]);

  const check = async () => {
    const d = query.trim().toLowerCase();
    if (!d.includes('.')) {
      toast.error('Enter a full domain, e.g. example.com');
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      const { data } = await api.get('/operator/porkbun/check', { params: { domain: d } });
      setResult(data);
    } catch (e) {
      const msg = e?.response?.data?.detail || 'Check failed';
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-tbc-500/20 bg-ink-900/40 p-5">
      <div className="mb-3 flex items-center gap-2">
        <Search className="h-4 w-4 text-tbc-300" />
        <h3 className="text-base font-bold text-tbc-100">Check availability</h3>
      </div>

      <div className="flex items-center gap-2">
        <Input
          value={query}
          onChange={(e) => { setQuery(e.target.value); setResult(null); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) check();
          }}
          placeholder="example.com"
          data-testid="domain-check-input"
          spellCheck={false}
          className="bg-ink-900 border-tbc-900/60 text-tbc-100"
        />
        <Button
          disabled={!canCheck || busy}
          onClick={check}
          data-testid="domain-check-submit"
          className="bg-tbc-500 text-ink-950 font-semibold hover:bg-tbc-400"
        >
          {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Search className="mr-1 h-3.5 w-3.5" />}
          Check
        </Button>
      </div>

      {result && (
        <div
          data-testid="domain-check-result"
          className={`mt-3 flex flex-wrap items-center gap-2 rounded-md px-3 py-2 text-sm ${
            result.available
              ? 'border border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
              : 'border border-rose-500/30 bg-rose-500/10 text-rose-200'
          }`}
        >
          {result.available
            ? <CheckCircle2 className="h-4 w-4 shrink-0" />
            : <XCircle className="h-4 w-4 shrink-0" />}
          <span className="font-bold">{result.domain}</span>
          <span>
            {result.available ? 'is available' : 'is taken'}
            {result.premium ? ' · premium' : ''}
          </span>
          {result.available && result.price && (
            <span className="font-mono text-emerald-300">
              ${result.price}/yr
              {result.first_year_promo ? ' (first-year promo)' : ''}
            </span>
          )}
          {result.available && (
            <a
              href={`https://porkbun.com/checkout/search?q=${encodeURIComponent(result.domain)}`}
              target="_blank"
              rel="noreferrer"
              className="ml-auto inline-flex items-center gap-1 rounded-md bg-tbc-500 px-2 py-1 text-xs font-semibold text-ink-950 hover:bg-tbc-400"
            >
              Register <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      )}
    </div>
  );
}

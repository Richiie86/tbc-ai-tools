import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api from '../../lib/api';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { toast } from 'sonner';
import {
  Globe, Loader2, RefreshCw, ShieldCheck, ShieldAlert, Search,
  CheckCircle2, XCircle, ExternalLink, KeyRound, Rocket, AlertTriangle,
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

  // Domains that come from deployed operator projects (Vercel URLs / custom
  // domains attached in db.deploy_projects) — independent of Porkbun.
  const [deployed, setDeployed] = useState(null);
  const [loadingDeployed, setLoadingDeployed] = useState(false);

  // Lets "Use this domain" in the availability/owned lists prefill + scroll to
  // the Launch panel. {value, nonce} — nonce forces re-apply of the same value.
  const [prefill, setPrefill] = useState({ value: '', nonce: 0 });
  const launchRef = useRef(null);
  const useDomain = useCallback((d) => {
    setPrefill((p) => ({ value: d, nonce: p.nonce + 1 }));
    launchRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, []);

  const loadDeployed = useCallback(async () => {
    setLoadingDeployed(true);
    try {
      const { data } = await api.get('/operator/deploy/projects');
      const list = data?.projects || data || [];
      const rows = list
        .map((p) => {
          const raw = p.domain || p.url || p.last_deployment_url || '';
          if (!raw) return null;
          const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
          let host = url;
          try { host = new URL(url).host; } catch { /* keep raw */ }
          return {
            id: p.id,
            name: p.projectName || p.name || host,
            host,
            url,
            isSelf: p.id === 'tbctools-self',
          };
        })
        .filter(Boolean);
      setDeployed(rows);
    } catch {
      setDeployed([]);
    } finally {
      setLoadingDeployed(false);
    }
  }, []);

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
    // Deployed-project domains don't depend on Porkbun — always load them.
    loadDeployed();
  }, [loadStatus, loadDomains, loadDeployed]);

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
            Launch a domain onto a project, manage the domains in your Porkbun
            account, check availability, and verify your connection — all here.
          </p>
        </div>
      </div>

      {/* The headline feature: point a real domain at one of your projects in a
          single click. Reuses PATCH /operator/deploy/{id}/domain which attaches
          the domain on Vercel AND (when Porkbun is connected) repoints its DNS
          straight at Vercel so it goes live. */}
      <div ref={launchRef}>
        <LaunchDomainPanel
          porkbunConnected={!!connected}
          onLaunched={loadDeployed}
          prefill={prefill}
        />
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
            onUseDomain={useDomain}
          />
          <AvailabilityCheck onUseDomain={useDomain} />
        </>
      ) : (
        <NotConnected />
      )}

      {/* Live domains from deployed operator projects — shown regardless of
          the Porkbun connection, since these come from Vercel/db.deploy_projects. */}
      <DeployedDomains
        rows={deployed}
        loading={loadingDeployed}
        onRefresh={loadDeployed}
      />
    </div>
  );
}

function LaunchDomainPanel({ porkbunConnected, onLaunched, prefill }) {
  const [projects, setProjects] = useState(null); // null = loading
  const [projectId, setProjectId] = useState('');
  const [domain, setDomain] = useState('');
  const [launching, setLaunching] = useState(false);
  const [result, setResult] = useState(null);

  // When "Use this domain" is clicked elsewhere, drop that domain into the box.
  useEffect(() => {
    if (prefill?.value) {
      setDomain(prefill.value);
      setResult(null);
    }
  }, [prefill?.value, prefill?.nonce]);

  const loadProjects = useCallback(async () => {
    try {
      const { data } = await api.get('/operator/deploy/projects');
      const list = Array.isArray(data) ? data : (data?.projects || []);
      setProjects(list);
      // Default to "this app" if present, else the first project.
      setProjectId((prev) => {
        if (prev) return prev;
        const self = list.find((p) => p.id === 'tbctools-self');
        return self?.id || list[0]?.id || '';
      });
    } catch {
      setProjects([]);
    }
  }, []);

  useEffect(() => { loadProjects(); }, [loadProjects]);

  const canLaunch = domain.trim().includes('.') && projectId && !launching;

  const launch = async () => {
    const d = domain.trim().toLowerCase();
    if (!d.includes('.')) {
      toast.error('Enter a full domain, e.g. www.tbcdomain.com');
      return;
    }
    if (!projectId) {
      toast.error('Pick which project to launch this domain on');
      return;
    }
    setLaunching(true);
    setResult(null);
    try {
      const { data } = await api.patch(
        `/operator/deploy/${projectId}/domain`,
        { domain: d },
      );
      setResult({
        domain: data?.domain || d,
        vercelAttached: !!data?.vercel_attached,
        vercelError: data?.vercel_error || null,
        dnsConfigured: !!data?.dns_configured,
        dnsError: data?.dns_error || null,
      });
      if (data?.vercel_attached && data?.dns_configured) {
        toast.success('Domain launched — DNS pointed at Vercel');
      } else if (data?.vercel_attached || data?.dns_configured) {
        toast.success('Domain saved — see the status below');
      } else {
        toast.message('Domain saved — a step needs your attention below');
      }
      loadProjects();
      onLaunched?.();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Launch failed');
    } finally {
      setLaunching(false);
    }
  };

  return (
    <div
      className="rounded-xl border border-tbc-500/30 bg-gradient-to-br from-tbc-500/[0.08] via-ink-900/60 to-ink-900/60 p-5"
      data-testid="launch-domain-panel"
    >
      <div className="mb-1 flex items-center gap-2">
        <Rocket className="h-4 w-4 text-tbc-300" />
        <h3 className="text-base font-bold text-tbc-100">Launch a domain</h3>
      </div>
      <p className="mb-4 text-sm text-tbc-200/60">
        Point your domain at a project. We attach it on Vercel and
        {porkbunConnected
          ? ' repoint its DNS through your connected Porkbun account so it goes live automatically.'
          : ' show you the DNS records to set (connect Porkbun in My Keys to automate this).'}
      </p>

      <div className="grid gap-3 sm:grid-cols-[1fr,minmax(180px,240px),auto] sm:items-end">
        <div>
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-tbc-200/60">
            Domain
          </label>
          <Input
            value={domain}
            onChange={(e) => { setDomain(e.target.value); setResult(null); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229 && canLaunch) launch();
            }}
            placeholder="www.tbcdomain.com"
            data-testid="launch-domain-input"
            spellCheck={false}
            className="bg-ink-900 border-tbc-900/60 text-tbc-100"
          />
        </div>

        <div>
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-tbc-200/60">
            Project
          </label>
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            data-testid="launch-domain-project"
            disabled={projects == null || projects.length === 0}
            className="h-10 w-full rounded-md border border-tbc-900/60 bg-ink-900 px-3 text-sm text-tbc-100 disabled:opacity-60"
          >
            {projects == null ? (
              <option>Loading…</option>
            ) : projects.length === 0 ? (
              <option value="">No projects yet</option>
            ) : (
              projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {(p.id === 'tbctools-self' ? 'This app' : (p.projectName || p.repo || p.id))}
                  {p.domain ? ` (now: ${p.domain})` : ''}
                </option>
              ))
            )}
          </select>
        </div>

        <Button
          onClick={launch}
          disabled={!canLaunch}
          data-testid="launch-domain-submit"
          className="h-10 bg-tbc-500 font-semibold text-ink-950 hover:bg-tbc-400"
        >
          {launching
            ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            : <Rocket className="mr-1.5 h-4 w-4" />}
          Launch domain
        </Button>
      </div>

      {result && (
        <div className="mt-4 space-y-2" data-testid="launch-domain-result">
          <StatusLine
            ok={result.vercelAttached}
            okText={`Attached ${result.domain} on Vercel`}
            badText={result.vercelError || 'Not attached on Vercel yet'}
          />
          <StatusLine
            ok={result.dnsConfigured}
            okText="DNS pointed at Vercel (Porkbun)"
            badText={
              result.dnsError ||
              (porkbunConnected
                ? 'DNS not configured'
                : 'Connect Porkbun in My Keys to auto-configure DNS')
            }
          />
          {result.vercelAttached && !result.dnsConfigured && (
            <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-200">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                Final step: in your registrar, point{' '}
                <span className="font-mono text-amber-100">{result.domain}</span>{' '}
                to Vercel — a CNAME to{' '}
                <span className="font-mono text-amber-100">cname.vercel-dns.com</span>{' '}
                (or the nameservers Vercel shows). It goes live once DNS
                propagates (a few minutes, up to an hour).
              </span>
            </div>
          )}
          {result.vercelAttached && result.dnsConfigured && (
            <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/[0.06] px-3 py-2 text-xs text-emerald-200">
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
              <span>
                All set — {result.domain} will be live once DNS propagates
                (usually a few minutes).
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatusLine({ ok, okText, badText }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      {ok
        ? <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-300" />
        : <XCircle className="h-4 w-4 shrink-0 text-rose-300" />}
      <span className={ok ? 'text-emerald-200' : 'text-rose-200'}>
        {ok ? okText : badText}
      </span>
    </div>
  );
}

function DeployedDomains({ rows, loading, onRefresh }) {
  return (
    <div className="rounded-xl border border-sky-500/25 bg-gradient-to-br from-sky-500/[0.04] via-ink-900/60 to-ink-900/60 p-5">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Globe className="h-4 w-4 text-sky-300" />
          <h3 className="text-base font-bold text-tbc-100">Deployed project domains</h3>
          {Array.isArray(rows) && (
            <span className="rounded-full bg-sky-500/15 px-2 py-0.5 text-xs font-semibold text-sky-200">
              {rows.length}
            </span>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={onRefresh}
          disabled={loading}
          data-testid="refresh-deployed-domains"
          className="border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950"
        >
          {loading
            ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
          Refresh
        </Button>
      </div>

      {loading && rows == null ? (
        <div className="grid place-items-center py-10">
          <Loader2 className="h-5 w-5 animate-spin text-tbc-400" />
        </div>
      ) : rows && rows.length > 0 ? (
        <div className="space-y-2" data-testid="deployed-domains-list">
          {rows.map((r) => (
            <div
              key={r.id}
              data-testid={`deployed-domain-row-${r.id}`}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-tbc-900/60 bg-ink-950/50 px-3 py-2.5"
            >
              <div className="flex items-center gap-2">
                <Globe className="h-4 w-4 text-sky-300" />
                <span className="text-sm font-bold text-tbc-100">{r.name}</span>
                {r.isSelf && (
                  <span className="rounded-full bg-tbc-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-tbc-300">
                    This app
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-3 text-xs text-tbc-200/60">
                <span className="font-mono text-tbc-200/70">{r.host}</span>
                <a
                  href={r.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-sky-300 hover:text-sky-200"
                >
                  Open <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="rounded-md border border-dashed border-sky-500/25 bg-ink-900/40 px-3 py-4 text-center text-sm text-tbc-200/60">
          No deployed project domains yet — deploy a project to see its live URL here.
        </p>
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

function DomainsList({ domains, loading, onRefresh, onUseDomain }) {
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
          {domains.map((d) => (
            <DomainRow key={d.domain} d={d} onUseDomain={onUseDomain} />
          ))}
        </div>
      ) : (
        <p className="rounded-md border border-dashed border-tbc-500/25 bg-ink-900/40 px-3 py-4 text-center text-sm text-tbc-200/60">
          No domains found in this Porkbun account yet.
        </p>
      )}
    </div>
  );
}

function DomainRow({ d, onUseDomain }) {
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
        {onUseDomain && (
          <button
            type="button"
            onClick={() => onUseDomain(d.domain)}
            data-testid={`use-domain-${d.domain}`}
            className="inline-flex items-center gap-1 rounded-md bg-tbc-500 px-2 py-1 text-xs font-semibold text-ink-950 hover:bg-tbc-400"
          >
            <Rocket className="h-3 w-3" /> Use this domain
          </button>
        )}
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

// Session-lived cache of availability results so re-checking a domain you just
// looked at is instant (Porkbun's live checkDomain call is rate-limited ~10s).
const _availCache = new Map();

function AvailabilityCheck({ onUseDomain }) {
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
    // Instant if we've already resolved this domain this session.
    if (_availCache.has(d)) {
      setResult(_availCache.get(d));
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      const { data } = await api.get('/operator/porkbun/check', { params: { domain: d } });
      _availCache.set(d, data);
      setResult(data);
    } catch (e) {
      const msg = e?.response?.data?.detail || 'Check failed';
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  };

  const owned = !!result?.owned;
  const available = !!result?.available;

  return (
    <div className="rounded-xl border border-tbc-500/20 bg-ink-900/40 p-5">
      <div className="mb-1 flex items-center gap-2">
        <Search className="h-4 w-4 text-tbc-300" />
        <h3 className="text-base font-bold text-tbc-100">Check if domain is available for use</h3>
      </div>
      <p className="mb-3 text-sm text-tbc-200/60">
        See if a domain is free to register — or, if it&apos;s already in your
        Porkbun account, launch it onto a project in one click.
      </p>

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
            available
              ? 'border border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
              : owned
                ? 'border border-tbc-500/40 bg-tbc-500/10 text-tbc-100'
                : 'border border-rose-500/30 bg-rose-500/10 text-rose-200'
          }`}
        >
          {available || owned
            ? <CheckCircle2 className="h-4 w-4 shrink-0" />
            : <XCircle className="h-4 w-4 shrink-0" />}
          <span className="font-bold">{result.domain}</span>
          <span>
            {owned
              ? 'is in your Porkbun account'
              : available ? 'is available' : 'is taken'}
            {result.premium ? ' · premium' : ''}
          </span>
          {available && result.price && (
            <span className="font-mono text-emerald-300">
              ${result.price}/yr
              {result.first_year_promo ? ' (first-year promo)' : ''}
            </span>
          )}

          {/* Owned by you → launch it straight onto a project. */}
          {owned && onUseDomain && (
            <button
              type="button"
              onClick={() => onUseDomain(result.domain)}
              data-testid="use-checked-domain"
              className="ml-auto inline-flex items-center gap-1 rounded-md bg-tbc-500 px-2 py-1 text-xs font-semibold text-ink-950 hover:bg-tbc-400"
            >
              <Rocket className="h-3 w-3" /> Use this domain
            </button>
          )}

          {/* Free to register → send them to Porkbun checkout. */}
          {available && (
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

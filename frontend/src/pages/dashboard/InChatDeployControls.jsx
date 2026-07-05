import React, { useCallback, useEffect, useState } from 'react';
import { Rocket, ShieldCheck, Activity, ChevronDown, Loader2, Trash2, Pencil, Eye } from 'lucide-react';
import { toast } from 'sonner';
import api from '../../lib/api';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu';

const STORAGE_KEY = 'tbc.inChat.selectedProjectId';
const PREVIEW_KEY = 'tbc.inChat.lastPreviewUrl';
// Domain the operator wants this project launched onto. Shared with the
// ShipItPill domain field so the Deploy button can connect it in one click.
const LAUNCH_DOMAIN_KEY = 'tbc.inChat.launchDomain';
// The console deploys ITSELF under this id — never treat it as a preview
// target (that would send the operator back to this app).
const SELF_PROJECT_ID = 'tbctools-self';

const withHttps = (u) => (u && !/^https?:\/\//i.test(u) ? `https://${u}` : u);

/**
 * Contextual deploy controls that sit inside every chat session.
 * Operators pick a deploy project once (persisted in localStorage) and then
 * fire Deploy / Code Review / Health Check straight from the chat header.
 *
 * Hidden for non-operator users so the regular chat UI stays clean.
 */
export function InChatDeployControls({ user }) {
  const [projects, setProjects] = useState([]);
  const [selectedId, setSelectedId] = useState(() => {
    try { return localStorage.getItem(STORAGE_KEY) || ''; } catch { return ''; }
  });
  const [busy, setBusy] = useState(null); // 'deploy' | 'review' | 'health' | null
  // null = still loading; true/false = resolved deploy-access flag.
  const [access, setAccess] = useState(null); // {can_deploy, pending_request}
  const [requesting, setRequesting] = useState(false);
  const [deleting, setDeleting] = useState(null); // project id currently being deleted
  // When a launched domain isn't one we hold registrar keys for, the backend
  // returns manual DNS steps — we render them in a panel under the controls.
  const [manualDns, setManualDns] = useState(null); // { domain, records[], nameservers[] }

  const isOperator = user?.role === 'operator';

  const loadAccess = useCallback(async () => {
    try {
      const { data } = await api.get('/me/deploy-access');
      setAccess(data);
    } catch {
      setAccess({ can_deploy: false, pending_request: null });
    }
  }, []);

  const loadProjects = useCallback(async () => {
    if (!isOperator) return;
    try {
      const { data } = await api.get('/operator/deploy/projects');
      // Sort projects: pin the primary app first, then alphabetical. We show
      // EVERY project (including old test entries) so the operator can delete
      // stale ones right here via the trash button — see `del()` below.
      const nameOf = (p) => (p.projectName || p.name || '').trim();
      const isPrimary = (p) => /tbc ai tools/i.test(nameOf(p));
      const sorted = (data || [])
        .slice()
        .sort((a, b) => {
          if (isPrimary(a) !== isPrimary(b)) return isPrimary(a) ? -1 : 1;
          return nameOf(a).localeCompare(nameOf(b));
        });
      setProjects(sorted);
      if (!selectedId && sorted.length) {
        const firstId = sorted[0].id;
        setSelectedId(firstId);
        try { localStorage.setItem(STORAGE_KEY, firstId); } catch { /* ignore */ }
      }
    } catch {
      // Silent — operator may not have set up projects yet.
    }
  }, [isOperator, selectedId]);

  useEffect(() => { loadAccess(); loadProjects(); }, [loadAccess, loadProjects]);

  // Still resolving — show nothing to avoid flicker.
  if (access === null) return null;

  // Regular user without deploy access — show a single "Request access" CTA
  // (or a "Request pending" pill if they already asked).
  if (!isOperator && !access.can_deploy) {
    const pending = access.pending_request;
    const submit = async () => {
      setRequesting(true);
      try {
        const { data } = await api.post('/me/deploy-access/request', { message: '' });
        toast.success('Request sent — the operator will review it shortly');
        setAccess((prev) => ({ ...(prev || {}), pending_request: data }));
      } catch (e) {
        toast.error(e?.response?.data?.detail || 'Could not submit request');
      } finally {
        setRequesting(false);
      }
    };
    if (pending) {
      return (
        <div
          className="inline-flex items-center gap-1.5 rounded-lg border border-amber-900/60 bg-amber-500/10 px-2 py-1 text-xs text-amber-200"
          data-testid="deploy-access-pending"
        >
          <span>Deploy access requested</span>
          <a
            href="/settings/deploy-access"
            className="rounded px-1.5 py-0.5 text-amber-100 hover:bg-amber-500/20"
            data-testid="deploy-access-pending-link"
          >View</a>
        </div>
      );
    }
    return (
      <button
        type="button"
        data-testid="deploy-access-request-btn"
        onClick={submit}
        disabled={requesting}
        className="inline-flex items-center gap-1.5 rounded-lg border border-tbc-900/60 bg-ink-900/60 px-2.5 py-1.5 text-xs font-semibold text-tbc-100 hover:bg-ink-950 disabled:opacity-60"
      >
        {requesting ? 'Sending…' : 'Request deploy access'}
      </button>
    );
  }

  // Operators OR users with can_deploy=true continue to the full controls.
  if (!isOperator) return null;

  const selected = projects.find((p) => p.id === selectedId);

  const pick = (id) => {
    setSelectedId(id);
    try { localStorage.setItem(STORAGE_KEY, id); } catch { /* ignore */ }
  };

  // Permanently remove a stale deploy project from the operator's list.
  // Hits DELETE /operator/deploy/:id (audited server-side). This only removes
  // the entry from the deploy picker — it never touches the live Vercel site.
  const del = async (e, p) => {
    e.preventDefault();
    e.stopPropagation();
    const label = p.projectName || p.name || p.id;
    if (!window.confirm(`Delete "${label}" from the deploy list?\n\nThis only removes the entry here — your live website is not affected.`)) return;
    setDeleting(p.id);
    try {
      await api.delete(`/operator/deploy/${p.id}`);
      toast.success(`Deleted "${label}"`);
      setProjects((prev) => prev.filter((x) => x.id !== p.id));
      if (selectedId === p.id) {
        setSelectedId('');
        try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
      }
    } catch (err) {
      toast.error(err?.response?.data?.detail || 'Delete failed');
    } finally {
      setDeleting(null);
    }
  };

  // Rename a deploy project in place. Hits PATCH /operator/deploy/:id with a
  // new projectName — the same endpoint the Ops row uses — so the name updates
  // everywhere the picker is shown.
  const rename = async (e, p) => {
    e.preventDefault();
    e.stopPropagation();
    const current = p.projectName || p.name || '';
    const next = window.prompt('Rename project', current);
    if (next == null) return; // cancelled
    const trimmed = next.trim();
    if (!trimmed || trimmed === current) return;
    try {
      await api.patch(`/operator/deploy/${p.id}`, { projectName: trimmed });
      toast.success(`Renamed to “${trimmed}”`);
      setProjects((prev) => prev.map((x) => (x.id === p.id ? { ...x, projectName: trimmed } : x)));
    } catch (err) {
      toast.error(err?.response?.data?.detail || 'Rename failed');
    }
  };

  // Surface the domain auto-connect result from a deploy. When the domain
  // isn't one we can auto-configure (bought elsewhere), stash the manual DNS
  // steps so the panel below the controls can walk the operator through it.
  const showDomainLaunch = (dl) => {
    if (!dl) return;
    if (dl.manual_dns) {
      setManualDns({ domain: dl.domain, ...dl.manual_dns });
      toast.message(dl.message || `${dl.domain}: add the DNS records shown to finish.`, {
        duration: 10000,
      });
    } else if (dl.ok === false) {
      toast.error(dl.message || 'Could not connect the domain');
    } else {
      setManualDns(null);
      toast.success(dl.message || `${dl.domain} connected`);
    }
  };

  // Live preview target for the header button: the freshest in-chat preview
  // URL, else the selected project's URL/domain (never the self app).
  let previewUrl = '';
  try {
    const stored = localStorage.getItem(PREVIEW_KEY);
    if (stored) previewUrl = withHttps(stored);
  } catch { /* ignore */ }
  if (!previewUrl && selected && selected.id !== SELF_PROJECT_ID) {
    const u = selected.url || selected.domain;
    if (u) previewUrl = withHttps(u);
  }

  const run = async (kind) => {
    if (!selectedId) {
      toast.error('Pick a project first');
      return;
    }
    setBusy(kind);
    try {
      if (kind === 'deploy') {
        // One-click deploy + connect domain: pick up the domain the operator
        // set for this chat (shared with the ShipItPill field).
        let domain = '';
        try { domain = (localStorage.getItem(LAUNCH_DOMAIN_KEY) || '').trim(); } catch { /* ignore */ }
        const { data } = await api.post(
          `/operator/deploy/${selectedId}/deploy`,
          domain ? { domain } : {},
        );
        // Light up the header Preview button with the fresh deploy URL.
        const freshUrl = data?.url || data?.deployment_url;
        if (freshUrl) {
          try { localStorage.setItem(PREVIEW_KEY, freshUrl); } catch { /* ignore */ }
        }
        toast.success(`Deploy queued — ${freshUrl || data?.id || 'OK'}`);
        // Surface the auto-connect outcome (incl. manual DNS steps).
        if (data?.domain_launch) showDomainLaunch(data.domain_launch);
      } else if (kind === 'review') {
        const { data } = await api.post(`/operator/deploy/${selectedId}/code-review`, {});
        const verdict = data?.verdict || data?.summary || 'completed';
        toast.success(`Code review: ${verdict}`);
      } else if (kind === 'health') {
        const { data } = await api.post(`/operator/deploy/${selectedId}/healthcheck`, {});
        const status = data?.status || (data?.ok ? 'OK' : 'unknown');
        toast.success(`Health check: ${status}`);
      }
    } catch (e) {
      const detail = e?.response?.data?.detail || `${kind} failed`;
      const status = e?.response?.status;
      // Cloudflare 5xx (520-526) returns HTML, not JSON — `data?.detail`
      // would be undefined. Surface a clear message so the operator
      // knows it's a backend/network issue, not a "click harder" issue.
      if (status >= 520 && status <= 526) {
        toast.error(
          `Origin server didn't respond cleanly (HTTP ${status}). The deploy may still be running — wait 30s and click Health to confirm.`,
          { duration: 12000 },
        );
        return;
      }
      if (status === 504) {
        toast.error(
          'Deploy timed out — the build may still finish in the background. Click Health to check status.',
          { duration: 12000 },
        );
        return;
      }
      // Backend 412 with structured `repo_not_configured` error → the
      // operator hasn't set their GitHub repo yet. Surface a sticky
      // toast with a "Configure now" action that jumps to Settings.
      // Backend 412 ship-gate: the AI code review returned do_not_ship.
      // Give the operator a reliable one-click override (toast action —
      // native prompt/confirm get suppressed after repeated clicks).
      if (status === 412 && detail?.error === 'review_blocked') {
        toast.error('Deploy blocked by AI code review', {
          description: `${detail.review?.summary || 'Verdict: do_not_ship.'} You are the operator — you can override and ship.`,
          duration: Infinity,
          action: {
            label: 'Deploy anyway',
            onClick: async () => {
              const t = toast.loading('Overriding review & deploying…');
              try {
                const { data } = await api.post(`/operator/deploy/${selectedId}/deploy`, { bypass_review: true });
                toast.dismiss(t);
                toast.success(`Deploy queued — ${data?.url || data?.deployment_id || 'OK'}`);
              } catch (e2) {
                toast.dismiss(t);
                toast.error(e2?.response?.data?.detail?.message || e2?.response?.data?.detail || 'Forced deploy failed');
              }
            },
          },
          cancel: detail.fix_chat_session_id
            ? { label: 'Open fix chat', onClick: () => { window.location.href = `/dashboard/${detail.fix_chat_session_id}`; } }
            : { label: 'Dismiss', onClick: () => {} },
        });
        return;
      }
      if (status === 412 && detail?.error === 'repo_not_configured') {
        toast.error(detail.message || 'GitHub repo not configured', {
          duration: 15000,
          action: {
            label: 'Configure now',
            onClick: () => { window.location.href = detail.configure_url || '/operator?tab=settings'; },
          },
        });
        return;
      }
      // When the deploy fails because the Vercel token isn't set,
      // surface a sticky toast with a "Configure now" action that jumps
      // straight to the Operator Console → Ops tab so the operator can
      // paste the PAT without leaving the chat / hunting for the page.
      if (typeof detail === 'string' && detail.toLowerCase().includes('vercel token not configured')) {
        toast.error(detail, {
          duration: 12000,
          action: {
            label: 'Configure now',
            onClick: () => { window.location.href = '/operator?tab=ops'; },
          },
        });
      } else {
        toast.error(typeof detail === 'string' ? detail : detail?.message || `${kind} failed (${status || 'network'})`);
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
    {manualDns && <ManualDnsPanel data={manualDns} onClose={() => setManualDns(null)} />}
    <div
      className="flex items-center gap-1.5 rounded-lg border border-tbc-900/60 bg-ink-900/60 px-1.5 py-1"
      data-testid="in-chat-deploy-controls"
    >
      <DropdownMenu>
        <DropdownMenuTrigger
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-semibold text-tbc-100 hover:bg-ink-950"
          data-testid="in-chat-project-picker"
        >
          <span className="max-w-[120px] truncate">
            {/* Backend serialises the field as `projectName` (camel-case
                Vercel convention); fall back to `name` for older
                operator-clone forks that may still send the short key. */}
            {selected?.projectName || selected?.name || (projects.length ? 'Pick project' : 'No projects')}
          </span>
          <ChevronDown className="h-3 w-3 text-tbc-200/60" />
        </DropdownMenuTrigger>
        {/* GitHub repo shortcut moved to Operator → Links to declutter the
            chat header (see LinksTab). */}
        <DropdownMenuContent
          align="end"
          className="max-h-64 w-56 overflow-auto border-tbc-900/60 bg-ink-900 text-tbc-100"
        >
          <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-tbc-200/60">
            Deploy project
          </DropdownMenuLabel>
          <DropdownMenuSeparator className="bg-tbc-900/60" />
          {projects.length === 0 && (
            <div className="space-y-2 px-2 py-2">
              <div className="text-xs text-tbc-200/60">
                No deploy project yet — set your GitHub repo to enable the Deploy button.
              </div>
              <a
                href="/operator?tab=settings#self-source"
                data-testid="deploy-empty-configure-link"
                className="inline-flex w-full items-center justify-center rounded-md bg-tbc-500 px-2.5 py-1.5 text-xs font-semibold text-ink-950 hover:bg-tbc-400"
              >
                Configure repo now →
              </a>
            </div>
          )}
          {projects.map((p) => {
            const label = p.projectName || p.name || p.id;
            const primary = /tbc ai tools/i.test(label);
            return (
              <DropdownMenuItem
                key={p.id}
                onSelect={(e) => e.preventDefault()}
                onClick={() => pick(p.id)}
                className="flex items-center justify-between gap-2 text-xs focus:bg-ink-950 focus:text-tbc-100"
                data-testid={`in-chat-project-option-${p.id}`}
              >
                <span className="truncate">{label}</span>
                <span className="flex shrink-0 items-center gap-0.5">
                  {primary && (
                    <span className="rounded bg-tbc-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-tbc-300">
                      this app
                    </span>
                  )}
                  {/* Rename is available on every project (including this app). */}
                  <button
                    type="button"
                    onClick={(e) => rename(e, p)}
                    title={`Rename ${label}`}
                    aria-label={`Rename ${label}`}
                    className="rounded p-1 text-tbc-200/50 hover:bg-tbc-500/15 hover:text-tbc-200"
                    data-testid={`in-chat-project-rename-${p.id}`}
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                  {/* Delete stays off the primary app so it can't be removed. */}
                  {!primary && (
                    <button
                      type="button"
                      onClick={(e) => del(e, p)}
                      disabled={deleting === p.id}
                      title={`Delete ${label}`}
                      aria-label={`Delete ${label}`}
                      className="rounded p-1 text-tbc-200/50 hover:bg-rose-500/15 hover:text-rose-300 disabled:opacity-50"
                      data-testid={`in-chat-project-delete-${p.id}`}
                    >
                      {deleting === p.id
                        ? <Loader2 className="h-3 w-3 animate-spin" />
                        : <Trash2 className="h-3 w-3" />}
                    </button>
                  )}
                </span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>

      <ActionButton
        label="Deploy"
        icon={Rocket}
        busy={busy === 'deploy'}
        disabled={!selectedId || !!busy}
        onClick={() => run('deploy')}
        tone="primary"
        testid="in-chat-deploy-btn"
      />
      <ActionButton
        label="Review"
        icon={ShieldCheck}
        busy={busy === 'review'}
        disabled={!selectedId || !!busy}
        onClick={() => run('review')}
        tone="ghost"
        testid="in-chat-review-btn"
      />
      <ActionButton
        label="Health"
        icon={Activity}
        busy={busy === 'health'}
        disabled={!selectedId || !!busy}
        onClick={() => run('health')}
        tone="ghost"
        testid="in-chat-health-btn"
      />
      {/* Always-visible Preview — opens the live site the operator is building
          (last in-chat preview, else the selected project's URL). Disabled
          until there's a real URL, with a hint on why. */}
      {previewUrl ? (
        <a
          href={previewUrl}
          target="_blank"
          rel="noreferrer"
          title={`Open ${previewUrl}`}
          data-testid="in-chat-preview-btn"
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold text-tbc-100 transition hover:bg-ink-950"
        >
          <Eye className="h-3 w-3" />
          <span className="hidden sm:inline">Preview</span>
        </a>
      ) : (
        <span
          title="Deploy once to get a live preview link"
          data-testid="in-chat-preview-btn-disabled"
          className="inline-flex cursor-not-allowed items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold text-tbc-100/40"
        >
          <Eye className="h-3 w-3" />
          <span className="hidden sm:inline">Preview</span>
        </span>
      )}
    </div>
    </>
  );
}

/**
 * Step-by-step DNS panel for a launched domain we DON'T hold registrar keys
 * for. The site is already attached to Vercel (we host it) — the operator
 * just needs to paste these records at whichever registrar owns the domain,
 * then it goes live. Fixed, dismissible, and copy-friendly.
 */
function ManualDnsPanel({ data, onClose }) {
  const copy = (text) => {
    try { navigator.clipboard?.writeText(text); toast.success('Copied'); } catch { /* ignore */ }
  };
  return (
    <div
      className="fixed bottom-24 right-5 z-40 w-[22rem] max-w-[92vw] rounded-xl border border-tbc-900/70 bg-ink-900 p-4 shadow-2xl shadow-black/40"
      data-testid="manual-dns-panel"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="text-sm font-semibold text-tbc-100">
          Point {data.domain} at us
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-tbc-200/60 hover:bg-ink-950 hover:text-tbc-100"
          aria-label="Close"
        >
          <span aria-hidden>×</span>
        </button>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-tbc-200/70">
        This domain is registered elsewhere, so we can&apos;t change its DNS for
        you. Your site is already hosted on our platform — add the records below
        at your current registrar and it goes live in a few minutes.
      </p>

      <div className="mt-3 text-[10px] font-semibold uppercase tracking-wider text-tbc-200/50">
        Option A — DNS records
      </div>
      <div className="mt-1 space-y-1.5">
        {(data.records || []).map((r, i) => (
          <button
            key={i}
            type="button"
            onClick={() => copy(r.value)}
            title="Click to copy the value"
            className="flex w-full items-center justify-between gap-2 rounded-md border border-tbc-900/60 bg-ink-950 px-2 py-1.5 text-left text-xs text-tbc-100 hover:border-tbc-500/50"
          >
            <span className="font-mono">
              <span className="text-tbc-300">{r.type}</span>{' '}
              <span className="text-tbc-200/60">{r.host}</span>
            </span>
            <span className="truncate font-mono text-tbc-200/80">{r.value}</span>
          </button>
        ))}
      </div>

      {Array.isArray(data.nameservers) && data.nameservers.length > 0 && (
        <>
          <div className="mt-3 text-[10px] font-semibold uppercase tracking-wider text-tbc-200/50">
            Option B — or switch nameservers
          </div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {data.nameservers.map((ns) => (
              <button
                key={ns}
                type="button"
                onClick={() => copy(ns)}
                className="rounded-md border border-tbc-900/60 bg-ink-950 px-2 py-1 font-mono text-xs text-tbc-100 hover:border-tbc-500/50"
              >
                {ns}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ActionButton({ label, icon: Icon, busy, disabled, onClick, tone, testid }) {
  const base = 'inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-40';
  const styles = tone === 'primary'
    ? 'bg-tbc-500 text-ink-950 hover:bg-tbc-400'
    : 'text-tbc-100 hover:bg-ink-950';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`${base} ${styles}`}
      data-testid={testid}
      title={label}
    >
      {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Icon className="h-3 w-3" />}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

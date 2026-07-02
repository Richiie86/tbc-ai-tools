import React, { useCallback, useEffect, useState } from 'react';
import { Rocket, ShieldCheck, Activity, ChevronDown, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import api from '../../lib/api';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu';

const STORAGE_KEY = 'tbc.inChat.selectedProjectId';

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
      // Hide leftover dummy/test entries and pin the primary app to the top
      // so the picker is easy to scan. The backend also purges these on boot,
      // but this keeps the UI clean immediately even before that runs.
      const nameOf = (p) => (p.projectName || p.name || '').trim();
      const isJunk = (p) => {
        const n = nameOf(p).toLowerCase();
        return /^p2 test project/.test(n) || /^clone variant$/.test(n);
      };
      const isPrimary = (p) => /tbc ai tools/i.test(nameOf(p));
      const cleaned = (data || [])
        .filter((p) => !isJunk(p))
        .sort((a, b) => {
          if (isPrimary(a) !== isPrimary(b)) return isPrimary(a) ? -1 : 1;
          return nameOf(a).localeCompare(nameOf(b));
        });
      setProjects(cleaned);
      if (!selectedId && cleaned.length) {
        const firstId = cleaned[0].id;
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

  const run = async (kind) => {
    if (!selectedId) {
      toast.error('Pick a project first');
      return;
    }
    setBusy(kind);
    try {
      if (kind === 'deploy') {
        const { data } = await api.post(`/operator/deploy/${selectedId}/deploy`, {});
        toast.success(`Deploy queued — ${data?.url || data?.id || 'OK'}`);
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
                onClick={() => pick(p.id)}
                className="flex items-center justify-between gap-2 text-xs focus:bg-ink-950 focus:text-tbc-100"
                data-testid={`in-chat-project-option-${p.id}`}
              >
                <span className="truncate">{label}</span>
                {primary && (
                  <span className="shrink-0 rounded bg-tbc-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-tbc-300">
                    this app
                  </span>
                )}
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

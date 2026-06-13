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

  const isOperator = user?.role === 'operator';

  const loadProjects = useCallback(async () => {
    if (!isOperator) return;
    try {
      const { data } = await api.get('/operator/deploy/projects');
      setProjects(data || []);
      // Auto-select if nothing chosen yet
      if (!selectedId && data?.length) {
        const firstId = data[0].id;
        setSelectedId(firstId);
        try { localStorage.setItem(STORAGE_KEY, firstId); } catch { /* ignore */ }
      }
    } catch {
      // Silent — operator may not have set up projects yet.
    }
  }, [isOperator, selectedId]);

  useEffect(() => { loadProjects(); }, [loadProjects]);

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
        toast.error(detail);
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
            {selected?.name || (projects.length ? 'Pick project' : 'No projects')}
          </span>
          <ChevronDown className="h-3 w-3 text-tbc-200/60" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="max-h-64 w-56 overflow-auto border-tbc-900/60 bg-ink-900 text-tbc-100"
        >
          <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-tbc-200/60">
            Deploy project
          </DropdownMenuLabel>
          <DropdownMenuSeparator className="bg-tbc-900/60" />
          {projects.length === 0 && (
            <div className="px-2 py-2 text-xs text-tbc-200/60">
              Create a project in Operator → Projects first.
            </div>
          )}
          {projects.map((p) => (
            <DropdownMenuItem
              key={p.id}
              onClick={() => pick(p.id)}
              className="text-xs focus:bg-ink-950 focus:text-tbc-100"
              data-testid={`in-chat-project-option-${p.id}`}
            >
              {p.name}
            </DropdownMenuItem>
          ))}
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

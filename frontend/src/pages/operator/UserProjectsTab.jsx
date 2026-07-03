import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import api from '../../lib/api';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '../../components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from '../../components/ui/alert-dialog';
import {
  FolderKanban, Search, Eye, Trash2, RefreshCw, Mail, User as UserIcon,
  MessageSquare, Archive, Radio, Loader2,
} from 'lucide-react';

/**
 * Operator → User Projects
 *
 * A single archive of every user's projects (chat sessions). It shows both
 * LIVE projects and ARCHIVED snapshots of projects the user has since deleted
 * from their own account — those snapshots are preserved server-side so the
 * operator never loses a project.
 *
 * The operator can:
 *  - silently PREVIEW a project's full transcript (the user is never notified),
 *  - permanently DELETE a project behind a Yes/No safety confirmation.
 */

function fmtDate(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function KindBadge({ kind }) {
  const archived = kind === 'archived';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
        archived
          ? 'bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30'
          : 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30'
      }`}
    >
      {archived ? <Archive className="h-3 w-3" /> : <Radio className="h-3 w-3" />}
      {archived ? 'Archived' : 'Live'}
    </span>
  );
}

export default function UserProjectsTab() {
  const [data, setData] = useState({ total: 0, live: 0, archived: 0, groups: [] });
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');

  // Preview dialog state
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [preview, setPreview] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/operator/user-projects');
      setData(data);
    } catch (err) {
      console.error('Failed to load user projects', err);
      toast.error('Could not load user projects');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Client-side filter so typing is instant (server also supports ?q=).
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return data.groups;
    return data.groups
      .map((g) => ({
        ...g,
        projects: g.projects.filter(
          (p) =>
            (g.user_email || '').toLowerCase().includes(needle) ||
            (p.title || '').toLowerCase().includes(needle),
        ),
      }))
      .filter((g) => g.projects.length > 0);
  }, [data.groups, q]);

  async function openPreview(project) {
    setPreviewOpen(true);
    setPreviewLoading(true);
    setPreview(null);
    try {
      const { data } = await api.get(
        `/operator/user-projects/${project.kind}/${project.session_id}/messages`,
      );
      setPreview(data);
    } catch (err) {
      console.error('Preview failed', err);
      toast.error('Could not load transcript');
      setPreviewOpen(false);
    } finally {
      setPreviewLoading(false);
    }
  }

  async function doDelete(project) {
    try {
      await api.delete(`/operator/user-projects/${project.kind}/${project.session_id}`);
      toast.success('Project deleted');
      load();
    } catch (err) {
      console.error('Delete failed', err);
      toast.error('Could not delete project');
    }
  }

  return (
    <div className="space-y-6" data-testid="operator-user-projects-tab">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-tbc-500/15 text-tbc-300">
            <FolderKanban className="h-4 w-4" />
          </span>
          <div>
            <h2 className="text-lg font-bold text-tbc-100">User Projects</h2>
            <p className="max-w-xl text-sm text-tbc-200/60">
              Every user&apos;s projects, kept even after they delete them. Preview a
              transcript silently (the user is not notified) or permanently remove one.
            </p>
          </div>
        </div>
        <Button
          onClick={load}
          variant="outline"
          className="gap-2 border-tbc-900/60 bg-ink-950/60 text-tbc-100 hover:bg-ink-900"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </Button>
      </header>

      {/* Stat chips */}
      <div className="flex flex-wrap gap-2 text-xs">
        <span className="rounded-full bg-ink-950/60 px-3 py-1 text-tbc-200/70 ring-1 ring-tbc-900/60">
          {data.total} total
        </span>
        <span className="rounded-full bg-emerald-500/10 px-3 py-1 text-emerald-300 ring-1 ring-emerald-500/25">
          {data.live} live
        </span>
        <span className="rounded-full bg-amber-500/10 px-3 py-1 text-amber-300 ring-1 ring-amber-500/25">
          {data.archived} archived
        </span>
      </div>

      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-tbc-200/40" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter by email or project title…"
          className="border-tbc-900/60 bg-ink-950/60 pl-9 text-tbc-100 placeholder:text-tbc-200/40"
        />
      </div>

      {/* Groups */}
      {loading ? (
        <div className="flex items-center gap-2 py-12 text-tbc-200/60">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading projects…
        </div>
      ) : groups.length === 0 ? (
        <div className="rounded-xl border border-tbc-900/50 bg-ink-950/40 py-12 text-center text-sm text-tbc-200/50">
          No projects found.
        </div>
      ) : (
        <div className="space-y-6">
          {groups.map((group) => (
            <section key={group.user_email} className="rounded-xl border border-tbc-900/50 bg-ink-950/40">
              <div className="flex items-center gap-2 border-b border-tbc-900/50 px-4 py-3">
                <Mail className="h-3.5 w-3.5 text-tbc-300" />
                <span className="text-sm font-semibold text-tbc-100">{group.user_email}</span>
                {group.user_name && (
                  <span className="inline-flex items-center gap-1 text-xs text-tbc-200/50">
                    <UserIcon className="h-3 w-3" /> {group.user_name}
                  </span>
                )}
                <span className="ml-auto text-xs text-tbc-200/50">
                  {group.projects.length} project{group.projects.length === 1 ? '' : 's'}
                </span>
              </div>

              <ul className="divide-y divide-tbc-900/40">
                {group.projects.map((p) => (
                  <li
                    key={`${p.kind}-${p.session_id}`}
                    className="flex flex-wrap items-center gap-3 px-4 py-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-tbc-100">{p.title}</span>
                        <KindBadge kind={p.kind} />
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-tbc-200/50">
                        {p.model && <span>{p.model}</span>}
                        {typeof p.message_count === 'number' && (
                          <span className="inline-flex items-center gap-1">
                            <MessageSquare className="h-3 w-3" /> {p.message_count} msgs
                          </span>
                        )}
                        <span>Updated {fmtDate(p.updated_at)}</span>
                        {p.kind === 'archived' && <span>Archived {fmtDate(p.archived_at)}</span>}
                      </div>
                    </div>

                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => openPreview(p)}
                      className="gap-1.5 border-tbc-900/60 bg-ink-950/60 text-tbc-100 hover:bg-ink-900"
                    >
                      <Eye className="h-3.5 w-3.5" /> Preview
                    </Button>

                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          size="sm"
                          variant="outline"
                          className="gap-1.5 border-rose-500/30 bg-rose-500/5 text-rose-300 hover:bg-rose-500/15"
                        >
                          <Trash2 className="h-3.5 w-3.5" /> Delete
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent className="border-slate-800 bg-slate-900 text-slate-100">
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete this project?</AlertDialogTitle>
                          <AlertDialogDescription className="text-slate-400">
                            This permanently removes “{p.title}” ({group.user_email}) and its
                            transcript. This cannot be undone. Are you sure?
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel className="border-slate-700 bg-slate-800 text-slate-100 hover:bg-slate-700">
                            No, keep it
                          </AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => doDelete(p)}
                            className="bg-rose-500 text-white hover:bg-rose-400"
                          >
                            Yes, delete
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {/* Silent transcript preview */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-hidden border-slate-800 bg-ink-950 text-slate-100">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-white">
              {preview?.title || 'Project preview'}
              {preview && <KindBadge kind={preview.kind} />}
            </DialogTitle>
            <DialogDescription className="text-slate-400">
              {preview?.user_email ? `${preview.user_email} · ` : ''}
              Read-only. The user is not notified that you viewed this.
            </DialogDescription>
          </DialogHeader>

          <div className="mt-2 max-h-[60vh] space-y-4 overflow-y-auto pr-1">
            {previewLoading ? (
              <div className="flex items-center gap-2 py-10 text-slate-400">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading transcript…
              </div>
            ) : !preview?.messages?.length ? (
              <div className="py-10 text-center text-sm text-slate-500">
                No messages in this project.
              </div>
            ) : (
              preview.messages.map((m, i) => (
                <div key={i} className="flex flex-col gap-1">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-tbc-300/70">
                    {m.role}
                  </span>
                  <div
                    className={`whitespace-pre-wrap rounded-lg px-3 py-2 text-sm leading-relaxed ${
                      m.role === 'user'
                        ? 'bg-tbc-500/10 text-tbc-50'
                        : 'bg-slate-800/60 text-slate-200'
                    }`}
                  >
                    {m.content}
                  </div>
                </div>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

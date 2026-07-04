import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '../../components/ui/button';
import { ScrollArea } from '../../components/ui/scroll-area';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from '../../components/ui/alert-dialog';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '../../components/ui/dialog';
import { Input } from '../../components/ui/input';
import ReferBanner from '../../components/ReferBanner';
import CreditsBadge from '../../components/CreditsBadge';
import api from '../../lib/api';
import {
  Cpu, Plus, Trash2, MessageSquare, LogOut, Sparkles,
  ChevronLeft, ShieldCheck, Edit3, Settings as SettingsIcon,
} from 'lucide-react';

/** Left sidebar: branding, new-session button, grouped session list, footer actions. */
export function DashboardSidebar({
  sidebarOpen, setSidebarOpen,
  grouped, currentId, setCurrentId, basePath,
  user, newChat, renameSession, deleteSession, logout,
}) {
  const navigate = useNavigate();
  // In-app rename dialog state (replaces the old browser prompt so rename is a
  // proper, on-brand pop-up that also works on touch devices).
  const [renameTarget, setRenameTarget] = React.useState(null);
  const [renameValue, setRenameValue] = React.useState('');

  const openRename = (s) => { setRenameTarget(s); setRenameValue(s.title || ''); };
  const submitRename = () => {
    if (renameTarget && renameValue.trim()) {
      renameSession(renameTarget.id, renameValue.trim());
    }
    setRenameTarget(null);
  };

  return (
    <aside className={`flex shrink-0 flex-col border-r border-slate-800 bg-ink-950/90 transition-[width] duration-200 ${
      sidebarOpen ? 'w-72' : 'w-0'} overflow-hidden`}>
      <div className="flex items-center justify-between border-b border-slate-800 p-3">
        <Link to="/" className="flex items-center gap-2 px-1">
          <div className="grid h-8 w-8 place-items-center rounded-md bg-gradient-to-br from-tbc-300 to-tbc-500">
            <Cpu className="h-4 w-4 text-slate-950" strokeWidth={2.4} />
          </div>
          <span className="text-sm font-bold text-white">TBC AI Tools</span>
        </Link>
        <button
          onClick={() => setSidebarOpen(false)}
          className="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
      </div>

      <div className="p-3">
        <Button onClick={newChat} className="w-full justify-start gap-2 bg-tbc-500 text-slate-950 hover:bg-tbc-400 font-semibold">
          <Plus className="h-4 w-4" /> New session
        </Button>
      </div>

      <ScrollArea className="flex-1 px-2">
        {Object.keys(grouped).length === 0 ? (
          <div className="px-3 py-8 text-center text-sm text-slate-500">No chats yet</div>
        ) : (
          Object.entries(grouped).map(([label, items]) => (
            <div key={label} className="mb-3">
              <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">{label}</div>
              <div className="space-y-0.5">
                {items.map((s) => (
                  <div
                    key={s.id}
                    onClick={() => { setCurrentId(s.id); navigate(`${basePath}/${s.id}`); }}
                    className={`group flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-sm transition-colors ${
                      currentId === s.id ? 'bg-tbc-500/10 text-white' : 'text-slate-300 hover:bg-slate-800/80'
                    }`}
                  >
                    <MessageSquare className={`h-3.5 w-3.5 shrink-0 ${currentId === s.id ? 'text-tbc-400' : 'text-slate-500'}`} />
                    <span className="flex-1 truncate">{s.title}</span>
                    {/* Rename + delete are always visible (previously hover-only,
                        which made them unreachable on touch devices). They dim
                        when the row isn't hovered/focused to stay tidy. */}
                    <button
                      onClick={(e) => { e.stopPropagation(); openRename(s); }}
                      title="Rename project"
                      aria-label={`Rename ${s.title}`}
                      className="rounded p-1 text-slate-400 opacity-70 transition hover:bg-slate-700 hover:text-white focus:opacity-100 group-hover:opacity-100"
                    >
                      <Edit3 className="h-3 w-3" />
                    </button>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <button
                          onClick={(e) => e.stopPropagation()}
                          title="Delete project"
                          aria-label={`Delete ${s.title}`}
                          className="rounded p-1 text-slate-400 opacity-70 transition hover:bg-rose-500/20 hover:text-rose-300 focus:opacity-100 group-hover:opacity-100"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </AlertDialogTrigger>
                      <AlertDialogContent className="border-slate-800 bg-slate-900 text-slate-100">
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete this project?</AlertDialogTitle>
                          <AlertDialogDescription className="text-slate-400">
                            This removes “{s.title}” and all its messages from your account.
                            Are you sure you want to delete it?
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel className="border-slate-700 bg-slate-800 text-slate-100 hover:bg-slate-700">
                            No, keep it
                          </AlertDialogCancel>
                          <AlertDialogAction
                            onClick={(e) => deleteSession(s.id, e)}
                            className="bg-rose-500 text-white hover:bg-rose-400"
                          >
                            Yes, delete
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </ScrollArea>

      <div className="border-t border-slate-800 p-3">
        <ReferBanner />
        <div className="mb-2 flex items-center justify-between gap-2 rounded-md bg-slate-900 px-2.5 py-2 text-xs">
          <span className="inline-flex items-center gap-1 rounded-full bg-tbc-500/15 px-2 py-0.5 text-[10px] uppercase tracking-wider text-tbc-300">
            <Sparkles className="h-3 w-3" /> {user?.plan}
          </span>
          {/* Plain (non-link) badge — sidebar already has an Upgrade link just
              below, so we don't want two competing CTAs here. */}
          <CreditsBadge user={user} linkTo={null} compact testid="sidebar-credits-badge" />
        </div>
        {user?.role === 'operator' && (
          <Link to="/operator" className="mb-1 flex items-center gap-2 rounded-md px-2.5 py-2 text-xs font-medium text-tbc-300 hover:bg-slate-800">
            <ShieldCheck className="h-3.5 w-3.5" /> Operator console
          </Link>
        )}
        <Link to="/settings" className="mb-1 flex items-center gap-2 rounded-md px-2.5 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800" data-testid="sidebar-settings">
          <SettingsIcon className="h-3.5 w-3.5" /> Settings
        </Link>
        <Link to="/pricing" className="mb-1 flex items-center gap-2 rounded-md px-2.5 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800">
          <Sparkles className="h-3.5 w-3.5" /> Upgrade plan
        </Link>
        <button
          onClick={() => { logout(); navigate('/'); }}
          className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800"
          data-testid="sidebar-sign-out"
        >
          <LogOut className="h-3.5 w-3.5" /> Sign out
        </button>
        <button
          data-testid="sidebar-sign-out-everywhere"
          onClick={async () => {
            if (!window.confirm('Sign out of every device including this one?\n\nAny token currently in use elsewhere will stop working immediately. You will need to sign in again.')) return;
            try { await api.post('/auth/sign-out-everywhere'); } catch (e) {
              // Server-side may have already invalidated us — that's fine, we
              // still want to clear local state below. Log so an unexpected
              // 5xx doesn't disappear silently.
              console.warn('sign-out-everywhere returned an error (ignored)', e?.message);
            }
            logout();
            navigate('/');
          }}
          className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-[11px] font-medium text-rose-300/80 hover:bg-rose-500/10 hover:text-rose-200"
        >
          <ShieldCheck className="h-3.5 w-3.5" /> Sign out everywhere
        </button>
      </div>

      {/* Rename project pop-up */}
      <Dialog open={!!renameTarget} onOpenChange={(open) => { if (!open) setRenameTarget(null); }}>
        <DialogContent className="border-slate-800 bg-slate-900 text-slate-100 sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Rename project</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                e.preventDefault();
                submitRename();
              }
            }}
            placeholder="Project name"
            maxLength={120}
            className="border-slate-700 bg-slate-800 text-slate-100 placeholder:text-slate-500"
            aria-label="New project name"
          />
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setRenameTarget(null)}
              className="text-slate-300 hover:bg-slate-800 hover:text-white"
            >
              Cancel
            </Button>
            <Button
              onClick={submitRename}
              disabled={!renameValue.trim()}
              className="bg-tbc-500 font-semibold text-slate-950 hover:bg-tbc-400"
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  );
}

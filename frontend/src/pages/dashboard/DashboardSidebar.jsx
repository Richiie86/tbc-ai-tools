import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '../../components/ui/button';
import { ScrollArea } from '../../components/ui/scroll-area';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from '../../components/ui/alert-dialog';
import ReferBanner from '../../components/ReferBanner';
import api from '../../lib/api';
import {
  Cpu, Plus, Trash2, MessageSquare, LogOut, Sparkles,
  ChevronLeft, ShieldCheck, Edit3,
} from 'lucide-react';

/** Left sidebar: branding, new-session button, grouped session list, footer actions. */
export function DashboardSidebar({
  sidebarOpen, setSidebarOpen,
  grouped, currentId, setCurrentId, basePath,
  user, newChat, renameSession, deleteSession, logout,
}) {
  const navigate = useNavigate();
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
                    <button
                      onClick={(e) => { e.stopPropagation(); renameSession(s.id); }}
                      className="hidden rounded p-1 text-slate-400 hover:bg-slate-700 hover:text-white group-hover:block"
                    >
                      <Edit3 className="h-3 w-3" />
                    </button>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <button
                          onClick={(e) => e.stopPropagation()}
                          className="hidden rounded p-1 text-slate-400 hover:bg-rose-500/20 hover:text-rose-300 group-hover:block"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </AlertDialogTrigger>
                      <AlertDialogContent className="border-slate-800 bg-slate-900 text-slate-100">
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete chat?</AlertDialogTitle>
                          <AlertDialogDescription className="text-slate-400">
                            This permanently removes all messages in “{s.title}”.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel className="border-slate-700 bg-slate-800 text-slate-100 hover:bg-slate-700">
                            Cancel
                          </AlertDialogCancel>
                          <AlertDialogAction
                            onClick={(e) => deleteSession(s.id, e)}
                            className="bg-rose-500 text-white hover:bg-rose-400"
                          >
                            Delete
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
        <div className="mb-2 flex items-center gap-2 rounded-md bg-slate-900 px-2.5 py-2 text-xs text-slate-300">
          <Sparkles className="h-3.5 w-3.5 text-tbc-400" />
          <span className="flex-1 truncate">
            {user?.plan?.toUpperCase()} • {user?.role === 'operator' ? '∞' : user?.credits} credits
          </span>
        </div>
        {user?.role === 'operator' && (
          <Link to="/operator" className="mb-1 flex items-center gap-2 rounded-md px-2.5 py-2 text-xs font-medium text-tbc-300 hover:bg-slate-800">
            <ShieldCheck className="h-3.5 w-3.5" /> Operator console
          </Link>
        )}
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
            try { await api.post('/auth/sign-out-everywhere'); } catch { /* server already cleared us; navigate regardless */ }
            logout();
            navigate('/');
          }}
          className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-[11px] font-medium text-rose-300/80 hover:bg-rose-500/10 hover:text-rose-200"
        >
          <ShieldCheck className="h-3.5 w-3.5" /> Sign out everywhere
        </button>
      </div>
    </aside>
  );
}

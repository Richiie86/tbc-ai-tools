import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import api, { streamChat } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { Button } from '../components/ui/button';
import { Textarea } from '../components/ui/textarea';
import { ScrollArea } from '../components/ui/scroll-area';
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectLabel,
  SelectTrigger, SelectValue,
} from '../components/ui/select';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from '../components/ui/alert-dialog';
import Markdown from '../components/Markdown';
import ReferBanner from '../components/ReferBanner';
import { toast } from 'sonner';
import {
  Cpu, Send, Plus, Trash2, MessageSquare, Loader2, LogOut,
  Sparkles, ChevronLeft, Menu, ShieldCheck, Edit3, Clock, AlertCircle,
} from 'lucide-react';

function sidebarTimeLabel(iso) {
  try {
    const d = new Date(iso);
    const diffH = (Date.now() - d.getTime()) / 36e5;
    if (diffH < 24) return 'Today';
    if (diffH < 48) return 'Yesterday';
    if (diffH < 24 * 7) return 'This week';
    return 'Older';
  } catch { return ''; }
}

export default function Dashboard({ variant = 'tbc1' }) {
  const { user, logout, refresh } = useAuth();
  const { sessionId: paramSession } = useParams();
  const navigate = useNavigate();

  const isTbc2 = variant === 'tbc2';
  const basePath = isTbc2 ? '/tbc2' : '/dashboard';
  const brandTitle = isTbc2 ? 'TBC2 AI Control' : 'TBC AI Tools';
  const brandTag = isTbc2 ? 'Trader Edition' : 'Builder Edition';

  const [sessions, setSessions] = useState([]);
  const [currentId, setCurrentId] = useState(paramSession || null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [model, setModel] = useState('claude-opus-4-7');
  const [models, setModels] = useState({ providers: {} });
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const scrollRef = useRef(null);
  const taRef = useRef(null);

  // Load models + sessions on mount/variant change
  useEffect(() => {
    api.get('/chat/models').then((r) => setModels(r.data)).catch(() => {});
    loadSessions();
    // eslint-disable-next-line
  }, [variant]);

  // Load messages when session changes
  useEffect(() => {
    if (currentId) loadMessages(currentId);
    else setMessages([]);
    // eslint-disable-next-line
  }, [currentId]);

  // Sync sessionId from URL
  useEffect(() => {
    if (paramSession && paramSession !== currentId) setCurrentId(paramSession);
    // eslint-disable-next-line
  }, [paramSession]);

  // Auto-scroll
  useEffect(() => {
    const el = scrollRef.current;
    if (el) requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
  }, [messages, streamText]);

  async function loadSessions() {
    try {
      const { data } = await api.get('/chat/sessions', { params: { variant } });
      setSessions(data);
    } catch (err) { console.error('Failed to load sessions', err); }
  }

  async function loadMessages(id) {
    try {
      const { data } = await api.get(`/chat/sessions/${id}/messages`);
      setMessages(data.messages || []);
      setModel(data.session?.model || 'claude-opus-4-7');
    } catch (e) {
      toast.error('Could not load session');
      navigate('/dashboard');
    }
  }

  async function newChat() {
    // Reset UI first so the empty-state shows immediately even on slow connections.
    setMessages([]);
    setStreamText('');
    setInput('');
    try {
      const { data } = await api.post('/chat/sessions', {
        title: 'New Chat',
        model,
        variant,
      });
      // Prepend so it sits at the top of "Today" in the sidebar.
      setSessions((prev) => [data, ...prev.filter((s) => s.id !== data.id)]);
      setCurrentId(data.id);
      navigate(`${basePath}/${data.id}`);
      setTimeout(() => taRef.current?.focus(), 100);
    } catch (e) {
      // Fallback to the lazy-create flow so chatting still works even if the API hiccups.
      console.error('Create session failed, falling back to lazy create', e);
      toast.error('Could not create session — type a message to start one');
      setCurrentId(null);
      navigate(basePath);
      setTimeout(() => taRef.current?.focus(), 100);
    }
  }

  async function deleteSession(id, e) {
    e?.stopPropagation();
    try {
      await api.delete(`/chat/sessions/${id}`);
      toast.success('Chat deleted');
      setSessions((s) => s.filter((x) => x.id !== id));
      if (currentId === id) { setCurrentId(null); setMessages([]); navigate(basePath); }
    } catch {
      toast.error('Could not delete');
    }
  }

  async function renameSession(id) {
    const title = window.prompt('Rename chat:');
    if (!title) return;
    try {
      await api.patch(`/chat/sessions/${id}`, { title });
      setSessions((s) => s.map((x) => x.id === id ? { ...x, title } : x));
    } catch { toast.error('Rename failed'); }
  }

  async function send() {
    const text = input.trim();
    if (!text || streaming) return;
    if (user && user.role !== 'operator' && (user.credits ?? 0) <= 0) {
      toast.error('Out of credits. Please upgrade your plan.');
      navigate('/pricing');
      return;
    }
    setInput('');
    setStreaming(true);
    setStreamText('');
    // Optimistic user message
    const userMsg = { id: 'tmp-' + Date.now(), role: 'user', content: text };
    setMessages((m) => [...m, userMsg]);

    let acquiredSessionId = currentId;
    try {
      for await (const ev of streamChat({ session_id: currentId, message: text, model, variant })) {
        if (ev.type === 'delta') {
          if (ev.session_id && !acquiredSessionId) acquiredSessionId = ev.session_id;
          setStreamText((t) => t + (ev.content || ''));
        } else if (ev.type === 'done') {
          if (ev.session_id && !acquiredSessionId) acquiredSessionId = ev.session_id;
          break;
        } else if (ev.type === 'error') {
          throw new Error(ev.message || 'Stream error');
        }
      }
      // Persist final assistant message into state
      setMessages((m) => [
        ...m.filter((x) => x.id !== userMsg.id),
        { id: 'u-' + Date.now(), role: 'user', content: text },
        { id: 'a-' + Date.now(), role: 'assistant', content: streamTextRef.current || '' },
      ]);
      // Update sidebar / current
      if (!currentId && acquiredSessionId) {
        setCurrentId(acquiredSessionId);
        navigate(`${basePath}/${acquiredSessionId}`, { replace: true });
      }
      loadSessions();
      refresh();
    } catch (e) {
      toast.error(e.message || 'Failed');
      setMessages((m) => m.filter((x) => x.id !== userMsg.id));
    } finally {
      setStreaming(false);
      setStreamText('');
    }
  }

  // ref to live stream text so we don't lose latest on close
  const streamTextRef = useRef('');
  useEffect(() => { streamTextRef.current = streamText; }, [streamText]);

  const onKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const grouped = useMemo(() => {
    const map = {};
    for (const s of sessions) {
      const k = sidebarTimeLabel(s.updated_at);
      (map[k] ||= []).push(s);
    }
    return map;
  }, [sessions]);

  return (
    <div className="flex h-screen overflow-hidden bg-ink-950 text-slate-100">
      {/* SIDEBAR */}
      <aside className={`flex shrink-0 flex-col border-r border-slate-800 bg-ink-950/90 transition-[width] duration-200 ${sidebarOpen ? 'w-72' : 'w-0'} overflow-hidden`}>
        <div className="flex items-center justify-between border-b border-slate-800 p-3">
          <Link to="/" className="flex items-center gap-2 px-1">
            <div className="grid h-8 w-8 place-items-center rounded-md bg-gradient-to-br from-tbc-300 to-tbc-500">
              <Cpu className="h-4 w-4 text-slate-950" strokeWidth={2.4} />
            </div>
            <span className="text-sm font-bold text-white">TBC AI Tools</span>
          </Link>
          <button onClick={() => setSidebarOpen(false)} className="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white">
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
                      <button onClick={(e)=>{e.stopPropagation(); renameSession(s.id);}} className="hidden rounded p-1 text-slate-400 hover:bg-slate-700 hover:text-white group-hover:block">
                        <Edit3 className="h-3 w-3" />
                      </button>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <button onClick={(e)=>e.stopPropagation()} className="hidden rounded p-1 text-slate-400 hover:bg-rose-500/20 hover:text-rose-300 group-hover:block">
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </AlertDialogTrigger>
                        <AlertDialogContent className="border-slate-800 bg-slate-900 text-slate-100">
                          <AlertDialogHeader>
                            <AlertDialogTitle>Delete chat?</AlertDialogTitle>
                            <AlertDialogDescription className="text-slate-400">This permanently removes all messages in “{s.title}”.</AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel className="border-slate-700 bg-slate-800 text-slate-100 hover:bg-slate-700">Cancel</AlertDialogCancel>
                            <AlertDialogAction onClick={(e)=>deleteSession(s.id, e)} className="bg-rose-500 text-white hover:bg-rose-400">Delete</AlertDialogAction>
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
          <button onClick={() => { logout(); navigate('/'); }} className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800" data-testid="sidebar-sign-out">
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

      {/* MAIN */}
      <main className="flex flex-1 flex-col overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-800 bg-ink-950/80 px-5 py-3 backdrop-blur">
          <div className="flex items-center gap-3">
            {!sidebarOpen && (
              <button onClick={() => setSidebarOpen(true)} className="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white">
                <Menu className="h-4 w-4" />
              </button>
            )}
            <div className="text-sm font-semibold text-white">{brandTitle}</div>
          </div>
          <div className="flex items-center gap-3">
            <Select value={model} onValueChange={setModel}>
              <SelectTrigger className="h-9 w-[230px] border-slate-700 bg-slate-900 text-slate-100">
                <div className="flex items-center gap-2 text-sm">
                  <Cpu className="h-3.5 w-3.5 text-tbc-400" />
                  <SelectValue placeholder="Select model" />
                </div>
              </SelectTrigger>
              <SelectContent className="border-slate-800 bg-slate-900 text-slate-100">
                {Object.entries(models.providers || {}).map(([provider, items]) => (
                  <SelectGroup key={provider}>
                    <SelectLabel className="text-[10px] uppercase tracking-wider text-slate-500">{provider}</SelectLabel>
                    {items.map((m) => (
                      <SelectItem key={m.id} value={m.id} className="focus:bg-slate-800">{m.label}</SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <TrialBanner user={user} />

        <div ref={scrollRef} className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl px-5 py-8">
            {messages.length === 0 && !streaming ? (
              <EmptyState onPick={(p)=>{ setInput(p); taRef.current?.focus(); }} model={model} />
            ) : (
              <div className="space-y-7">
                {messages.map((m) => (
                  <MessageBubble key={m.id} role={m.role} content={m.content} />
                ))}
                {streaming && (
                  <MessageBubble role="assistant" content={streamText} streaming />
                )}
              </div>
            )}
          </div>
        </div>

        <div className="border-t border-slate-800 bg-ink-950/80 px-5 py-4 backdrop-blur">
          <div className="mx-auto max-w-3xl">
            <div className="flex items-end gap-2 rounded-2xl border border-slate-700 bg-slate-900 p-2 focus-within:border-tbc-500/60">
              <Textarea
                ref={taRef}
                rows={1}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKey}
                placeholder="Ask TBC AI Tools anything… (Shift+Enter for newline)"
                className="min-h-[44px] max-h-40 resize-none border-0 bg-transparent text-[15px] text-slate-100 focus-visible:ring-0 focus-visible:ring-offset-0"
              />
              <Button onClick={send} disabled={streaming || !input.trim()} className="h-10 shrink-0 bg-tbc-500 px-4 text-slate-950 hover:bg-tbc-400 font-semibold">
                {streaming ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </Button>
            </div>
            <div className="mt-2 text-center text-[11px] text-slate-500">
              TBC AI Tools may produce inaccurate information. Verify critical output.
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

function TrialBanner({ user }) {
  if (!user) return null;
  const expires = user.plan_expires_at;
  if (!expires) return null;
  const isExpired = !!user.plan_is_expired;
  const days = user.plan_days_remaining ?? 0;
  // Hide for already-expired & no upsell — but we DO show an expired banner.
  const tone = isExpired
    ? 'border-rose-500/40 bg-rose-500/10 text-rose-200'
    : days <= 3
    ? 'border-amber-500/40 bg-amber-500/10 text-amber-100'
    : 'border-sky-500/30 bg-sky-500/10 text-sky-100';
  const Icon = isExpired ? AlertCircle : Clock;
  return (
    <div className={`flex items-center justify-between gap-3 border-b px-5 py-2 text-xs ${tone}`} data-testid="trial-banner">
      <div className="flex items-center gap-2">
        <Icon className="h-3.5 w-3.5" />
        {isExpired ? (
          <span>
            Your <strong>{user.plan}</strong> trial has expired. Upgrade to keep building without interruption.
          </span>
        ) : (
          <span>
            <strong>{days}</strong> day{days === 1 ? '' : 's'} left on your <strong>{user.plan}</strong> trial · auto-downgrades when it ends.
          </span>
        )}
      </div>
      <Link
        to="/pricing"
        data-testid="trial-banner-upgrade"
        className="rounded-md bg-tbc-500 px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-ink-950 hover:bg-tbc-400"
      >
        Upgrade now
      </Link>
    </div>
  );
}

function EmptyState({ onPick, model }) {
  const suggestions = [
    'Build me a simple to-do app with React + FastAPI',
    'Explain JWT vs session-based auth in 100 words',
    'Write a Python script to backtest a moving average strategy',
    'Design a MongoDB schema for an e-commerce store',
  ];  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-tbc-300 to-tbc-500 shadow-lg shadow-tbc-500/30">
        <Cpu className="h-7 w-7 text-slate-950" strokeWidth={2.4} />
      </div>
      <h2 className="mt-5 text-3xl font-bold text-white">How can I help you build today?</h2>
      <p className="mt-2 text-sm text-slate-400">Using <span className="text-tbc-300">{model}</span> — switch model anytime</p>
      <div className="mt-8 grid w-full max-w-2xl gap-2 sm:grid-cols-2">
        {suggestions.map((s) => (
          <button key={s} onClick={() => onPick(s)} className="rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-3 text-left text-sm text-slate-200 transition-colors hover:border-tbc-500/40 hover:bg-slate-900">
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

function MessageBubble({ role, content, streaming }) {
  if (role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-tbc-500 px-4 py-2.5 text-[15px] font-medium text-slate-950 shadow-sm">
          <div className="whitespace-pre-wrap leading-relaxed">{content}</div>
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-tbc-300 to-tbc-500">
        <Cpu className="h-4 w-4 text-slate-950" strokeWidth={2.4} />
      </div>
      <div className="min-w-0 flex-1 rounded-2xl rounded-tl-md border border-slate-800 bg-slate-900/60 px-4 py-3">
        {content ? <Markdown>{content}</Markdown> : <div className="text-sm text-slate-500">Thinking…</div>}
        {streaming && content && <span className="caret-blink" />}
      </div>
    </div>
  );
}

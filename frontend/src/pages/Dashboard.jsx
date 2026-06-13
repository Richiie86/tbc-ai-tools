import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api, { streamChat } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectLabel,
  SelectTrigger, SelectValue,
} from '../components/ui/select';
import { toast } from 'sonner';
import { Cpu, Menu, ArrowDownToLine } from 'lucide-react';

import { DashboardSidebar } from './dashboard/DashboardSidebar';
import { TrialBanner } from './dashboard/TrialBanner';
import { EmptyState, MessageBubble } from './dashboard/ChatMessages';
import { ChatComposer } from './dashboard/ChatComposer';
import CreditsBadge from '../components/CreditsBadge';
import { OutOfCreditsDialog } from './dashboard/OutOfCreditsDialog';
import { DashboardGuideTour, DashboardGuideButton } from './dashboard/DashboardGuideTour';

// Anything within this many pixels from the bottom counts as "still at the
// end" so a stray scroll-wheel nudge doesn't unstick the stream. Module-level
// so the constant isn't reallocated every render.
const STICK_TO_BOTTOM_THRESHOLD_PX = 80;

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

  const [sessions, setSessions] = useState([]);
  const [currentId, setCurrentId] = useState(paramSession || null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [model, setModel] = useState('claude-opus-4-7');
  const [models, setModels] = useState({ providers: {} });
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [outOfCreditsOpen, setOutOfCreditsOpen] = useState(false);
  // Bump to re-launch the first-time tour from the "Guide" button.
  const [guideKey, setGuideKey] = useState(0);
  // "Stick to bottom" = follow new tokens. Flips OFF the moment the user
  // scrolls up so they can read older messages without the stream yanking
  // them back; flips back ON when they scroll to the bottom themselves or
  // click the floating "Jump to latest" button.
  const [stickToBottom, setStickToBottom] = useState(true);
  const scrollRef = useRef(null);
  const taRef = useRef(null);
  const streamTextRef = useRef('');

  const loadSessions = useCallback(async () => {
    try {
      const { data } = await api.get('/chat/sessions', { params: { variant } });
      setSessions(data);
    } catch (err) { console.error('Failed to load sessions', err); }
  }, [variant]);

  const loadMessages = useCallback(async (id) => {
    try {
      const { data } = await api.get(`/chat/sessions/${id}/messages`);
      setMessages(data.messages || []);
      setModel(data.session?.model || 'claude-opus-4-7');
    } catch (e) {
      console.error('Failed to load messages', e);
      toast.error('Could not load session');
      navigate('/dashboard');
    }
  }, [navigate]);

  // Load models + sessions on mount/variant change
  useEffect(() => {
    api.get('/chat/models').then((r) => setModels(r.data)).catch((err) => {
      // models endpoint is best-effort — log so we can spot upstream outages
      // in the browser console without breaking the chat UI.
      console.warn('Failed to load chat models', err);
    });
    loadSessions();
  }, [variant, loadSessions]);

  // Load messages when session changes
  useEffect(() => {
    if (currentId) loadMessages(currentId);
    else setMessages([]);
  }, [currentId, loadMessages]);

  // Sync sessionId from URL — functional setState so we don't depend on
  // `currentId` (would re-fire every time it changed and create a loop).
  useEffect(() => {
    if (!paramSession) return;
    setCurrentId((prev) => (paramSession !== prev ? paramSession : prev));
  }, [paramSession]);

  // Anything within this many pixels from the bottom counts as "still at
  // the end" so a stray scroll-wheel nudge doesn't unstick the stream.
  // Lifted to a named constant per code-review #4.

  // Conditional auto-scroll: only follow the bottom when the user is already
  // pinned there. Once they scroll up `stickToBottom` flips off (see the
  // onScroll handler on the scroller) and we leave their viewport alone.
  useEffect(() => {
    if (!stickToBottom) return;
    const el = scrollRef.current;
    if (el) requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
  }, [messages, streamText, stickToBottom]);

  // Detect user scroll position to toggle the follow flag.
  const onScrollContainer = useCallback((e) => {
    const el = e.currentTarget;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_TO_BOTTOM_THRESHOLD_PX;
    setStickToBottom(atBottom);
  }, []);

  const jumpToLatest = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setStickToBottom(true);
  }, []);

  // Mirror live stream text so the final-message commit doesn't lose the tail.
  useEffect(() => { streamTextRef.current = streamText; }, [streamText]);

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
    } catch (err) {
      console.error('Chat delete failed', err);
      toast.error('Could not delete');
    }
  }

  async function renameSession(id) {
    const title = window.prompt('Rename chat:');
    if (!title) return;
    try {
      await api.patch(`/chat/sessions/${id}`, { title });
      setSessions((s) => s.map((x) => x.id === id ? { ...x, title } : x));
    } catch (err) {
      console.error('Rename failed', err);
      toast.error('Rename failed');
    }
  }

  async function send() {
    const text = input.trim();
    if (!text || streaming) return;
    if (user && user.role !== 'operator' && (user.credits ?? 0) <= 0) {
      // Dedicated dialog (with a top-up CTA) converts far better than the old
      // toast + redirect. We keep the draft in the textarea so the user can
      // send it the moment they top up.
      setOutOfCreditsOpen(true);
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
      <DashboardSidebar
        sidebarOpen={sidebarOpen}
        setSidebarOpen={setSidebarOpen}
        grouped={grouped}
        currentId={currentId}
        setCurrentId={setCurrentId}
        basePath={basePath}
        user={user}
        newChat={newChat}
        renameSession={renameSession}
        deleteSession={deleteSession}
        logout={logout}
      />

      {/* MAIN */}
      <main className="flex flex-1 flex-col overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-800 bg-ink-950/80 px-5 py-3 backdrop-blur">
          <div className="flex items-center gap-3">
            {!sidebarOpen && (
              <button
                onClick={() => setSidebarOpen(true)}
                className="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"
              >
                <Menu className="h-4 w-4" />
              </button>
            )}
            <div className="text-sm font-semibold text-white">{brandTitle}</div>
          </div>
          <div className="flex items-center gap-3">
            {/* Credits badge sits right next to the model picker so users
                always see how much budget they have left while chatting. */}
            <CreditsBadge user={user} testid="dashboard-credits-badge" />
            <DashboardGuideButton onOpen={() => setGuideKey((k) => k + 1)} />
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

        <div
          ref={scrollRef}
          onScroll={onScrollContainer}
          className="relative flex-1 overflow-y-auto"
          data-testid="chat-scroll"
        >
          <div className="mx-auto max-w-3xl px-5 py-8">
            {messages.length === 0 && !streaming ? (
              <EmptyState
                onPick={(p) => { setInput(p); taRef.current?.focus(); }}
                model={model}
              />
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
          {!stickToBottom && (messages.length > 0 || streaming) && (
            <button
              data-testid="jump-to-latest"
              onClick={jumpToLatest}
              className="sticky bottom-4 ml-auto mr-6 flex items-center gap-1.5 rounded-full border border-tbc-500/40 bg-ink-950/90 px-3 py-1.5 text-xs font-semibold text-tbc-100 shadow-lg backdrop-blur transition hover:bg-tbc-500/10"
              title="Resume following the latest message"
            >
              <ArrowDownToLine className="h-3.5 w-3.5 text-tbc-300" />
              Jump to latest
              {streaming && (
                <span className="ml-0.5 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-tbc-400" />
              )}
            </button>
          )}
        </div>

        <ChatComposer
          input={input}
          setInput={setInput}
          streaming={streaming}
          onSend={send}
          taRef={taRef}
        />
      </main>
      <OutOfCreditsDialog
        open={outOfCreditsOpen}
        onOpenChange={setOutOfCreditsOpen}
        user={user}
      />
      <DashboardGuideTour key={guideKey} forceOpen={guideKey > 0} />
    </div>
  );
}

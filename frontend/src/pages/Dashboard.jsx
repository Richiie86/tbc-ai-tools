import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api, { streamChat } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { toast } from 'sonner';
import { ArrowDownToLine } from 'lucide-react';

import { DashboardSidebar } from './dashboard/DashboardSidebar';
import { DashboardHeader } from './dashboard/DashboardHeader';
import { TrialBanner } from './dashboard/TrialBanner';
import { EmptyState, MessageBubble } from './dashboard/ChatMessages';
import EndOfSessionActions from './dashboard/EndOfSessionActions';
import ViewPreviewButton from '../components/ViewPreviewButton';
import { ChatComposer } from './dashboard/ChatComposer';
import { OutOfCreditsDialog } from './dashboard/OutOfCreditsDialog';
import { DashboardGuideTour } from './dashboard/DashboardGuideTour';
import { PostAiDeploySuggestion } from './dashboard/PostAiDeploySuggestion';
import { useInlineChatActions } from './dashboard/useInlineChatActions';
import { useStickToBottom } from './dashboard/useStickToBottom';
import { useChatSessionsCrud } from './dashboard/useChatSessionsCrud';

export default function Dashboard({ variant = 'tbc1' }) {
  const { user, logout, refresh } = useAuth();
  const { sessionId: paramSession } = useParams();
  const navigate = useNavigate();

  const isTbc2 = variant === 'tbc2';
  const basePath = isTbc2 ? '/tbc2' : '/dashboard';
  const brandTitle = isTbc2 ? 'TBC2 AI Control' : 'TBC AI Tools';

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
  // Show the "AI is done — redeploy?" banner each time the AI finishes
  // a stream. The operator can dismiss; it re-shows on the next reply.
  const [showDeploySuggest, setShowDeploySuggest] = useState(false);
  const taRef = useRef(null);
  const streamTextRef = useRef('');

  // Session CRUD + grouped sidebar list — extracted into a hook so this
  // file stays focused on streaming + rendering.
  const { loadSessions, newChat, deleteSession, renameSession, grouped } =
    useChatSessionsCrud({
      variant, basePath, navigate,
      currentId, setCurrentId,
      setMessages, setStreamText, setInput,
      model, taRef,
    });

  // Stick-to-bottom scroll behaviour — also lifted into a hook.
  const { scrollRef, stickToBottom, onScrollContainer, jumpToLatest } =
    useStickToBottom([messages, streamText]);

  // Load messages when session changes
  useEffect(() => {
    let cancelled = false;
    async function loadMessages(id) {
      try {
        const { data } = await api.get(`/chat/sessions/${id}/messages`);
        if (cancelled) return;
        setMessages(data.messages || []);
        setModel(data.session?.model || 'claude-opus-4-7');
      } catch (e) {
        console.error('Failed to load messages', e);
        toast.error('Could not load session');
        navigate('/dashboard');
      }
    }
    if (currentId) loadMessages(currentId);
    else setMessages([]);
    return () => { cancelled = true; };
  }, [currentId, navigate]);

  // Load models list on mount/variant change
  useEffect(() => {
    api.get('/chat/models').then((r) => setModels(r.data)).catch((err) => {
      // models endpoint is best-effort — log so we can spot upstream outages
      // in the browser console without breaking the chat UI.
      console.warn('Failed to load chat models', err);
    });
  }, [variant]);

  // Sync sessionId from URL — functional setState so we don't depend on
  // `currentId` (would re-fire every time it changed and create a loop).
  useEffect(() => {
    if (!paramSession) return;
    setCurrentId((prev) => (paramSession !== prev ? paramSession : prev));
  }, [paramSession]);

  // Inline "Quick actions" handler used by assistant message bubbles
  // and the End-of-Session bar.
  const handleInlineAction = useInlineChatActions({ navigate, messages, currentId });

  // Mirror live stream text so the final-message commit doesn't lose the tail.
  useEffect(() => { streamTextRef.current = streamText; }, [streamText]);

  async function send(attachments = []) {
    const text = input.trim();
    if (!text && attachments.length === 0) return;
    if (streaming) return;
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
    setShowDeploySuggest(false);
    // Optimistic user message — preserve the attachments on the bubble so the
    // user sees what they sent even after the stream finishes. We store the
    // base64 inline; for very large multi-image sends this is fine because
    // we cap at 6 × 4MB upstream.
    const userMsg = {
      id: 'tmp-' + Date.now(),
      role: 'user',
      content: text,
      attachments: attachments.length ? attachments : undefined,
    };
    setMessages((m) => [...m, userMsg]);

    let acquiredSessionId = currentId;
    try {
      for await (const ev of streamChat({
        session_id: currentId, message: text, model, variant,
        attachments: attachments.length ? attachments : undefined,
      })) {
        if (ev.type === 'delta') {
          if (ev.session_id && !acquiredSessionId) acquiredSessionId = ev.session_id;
          setStreamText((t) => t + (ev.content || ''));
        } else if (ev.type === 'fallback_used') {
          // The primary model failed but a fallback caught the stream.
          const failed = (ev.attempted || []).slice(-1)[0] || 'primary model';
          const finalModel = ev.final_model || 'fallback';
          toast.info(`Retried with ${finalModel} after ${failed} failed`, {
            description: ev.failed_reason
              ? `Reason: ${String(ev.failed_reason).slice(0, 120)}`
              : undefined,
            duration: 6000,
          });
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
      // Surface the deploy suggestion now that the AI is done.
      if (user?.role === 'operator') setShowDeploySuggest(true);
    } catch (e) {
      toast.error(e.message || 'Failed');
      setMessages((m) => m.filter((x) => x.id !== userMsg.id));
    } finally {
      setStreaming(false);
      setStreamText('');
    }
  }

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
        <DashboardHeader
          brandTitle={brandTitle}
          sidebarOpen={sidebarOpen}
          onOpenSidebar={() => setSidebarOpen(true)}
          user={user}
          models={models}
          model={model}
          setModel={setModel}
          onOpenGuide={() => setGuideKey((k) => k + 1)}
        />

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
                  <MessageBubble
                    key={m.id}
                    role={m.role}
                    content={m.content}
                    onAction={handleInlineAction}
                  />
                ))}
                {streaming && (
                  <MessageBubble role="assistant" content={streamText} streaming />
                )}
                <EndOfSessionActions
                  messages={messages}
                  streaming={streaming}
                  onAction={handleInlineAction}
                />
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
        <PostAiDeploySuggestion
          user={user}
          visible={showDeploySuggest && !streaming}
          onDismiss={() => setShowDeploySuggest(false)}
        />
      </main>
      <OutOfCreditsDialog
        open={outOfCreditsOpen}
        onOpenChange={setOutOfCreditsOpen}
        user={user}
      />
      <DashboardGuideTour key={guideKey} forceOpen={guideKey > 0} />
      {/* Floating preview link — silently hides if no deploy project URL
          is configured. Operator can jump from chat → live Vercel preview
          without leaving the dashboard. */}
      {user?.role === 'operator' && <ViewPreviewButton />}
    </div>
  );
}

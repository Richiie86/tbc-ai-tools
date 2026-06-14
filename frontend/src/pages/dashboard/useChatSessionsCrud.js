import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import api from '../../lib/api';

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

/**
 * Owns the chat-session list + CRUD (new / rename / delete) so the
 * Dashboard view component can stay focused on streaming + rendering.
 * The caller still owns `messages`, `streamText` and `input` — those
 * are tightly coupled to the in-flight streaming flow and aren't worth
 * the indirection here.
 */
export function useChatSessionsCrud({
  variant,
  basePath,
  navigate,
  currentId,
  setCurrentId,
  setMessages,
  setStreamText,
  setInput,
  model,
  taRef,
}) {
  const [sessions, setSessions] = useState([]);

  const loadSessions = useCallback(async () => {
    try {
      const { data } = await api.get('/chat/sessions', { params: { variant } });
      setSessions(data);
    } catch (err) { console.error('Failed to load sessions', err); }
  }, [variant]);

  useEffect(() => { loadSessions(); }, [loadSessions]);

  const newChat = useCallback(async () => {
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
  }, [model, variant, basePath, navigate, setCurrentId, setMessages, setStreamText, setInput, taRef]);

  const deleteSession = useCallback(async (id, e) => {
    e?.stopPropagation();
    try {
      await api.delete(`/chat/sessions/${id}`);
      toast.success('Chat deleted');
      setSessions((s) => s.filter((x) => x.id !== id));
      if (currentId === id) {
        setCurrentId(null);
        setMessages([]);
        navigate(basePath);
      }
    } catch (err) {
      console.error('Chat delete failed', err);
      toast.error('Could not delete');
    }
  }, [currentId, basePath, navigate, setCurrentId, setMessages]);

  const renameSession = useCallback(async (id) => {
    const title = window.prompt('Rename chat:');
    if (!title) return;
    try {
      await api.patch(`/chat/sessions/${id}`, { title });
      setSessions((s) => s.map((x) => x.id === id ? { ...x, title } : x));
    } catch (err) {
      console.error('Rename failed', err);
      toast.error('Rename failed');
    }
  }, []);

  const grouped = useMemo(() => {
    const map = {};
    for (const s of sessions) {
      const k = sidebarTimeLabel(s.updated_at);
      (map[k] ||= []).push(s);
    }
    return map;
  }, [sessions]);

  return { sessions, loadSessions, newChat, deleteSession, renameSession, grouped };
}

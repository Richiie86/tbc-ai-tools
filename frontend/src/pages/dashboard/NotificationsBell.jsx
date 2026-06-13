import React, { useCallback, useEffect, useState } from 'react';
import { Bell, ShieldAlert, MessageSquare, Megaphone, X, Loader2, Check } from 'lucide-react';
import { Link } from 'react-router-dom';
import api from '../../lib/api';
import {
  Popover, PopoverContent, PopoverTrigger,
} from '../../components/ui/popover';

const POLL_MS = 60_000;

const KIND_ICONS = {
  '2fa_reminder': ShieldAlert,
  broadcast: Megaphone,
  dm: MessageSquare,
};

const relative = (iso) => {
  try {
    const d = new Date(iso).getTime();
    const diff = Date.now() - d;
    if (diff < 60_000) return 'just now';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return `${Math.floor(diff / 86_400_000)}d ago`;
  } catch { return ''; }
};

/**
 * Bell icon + dropdown for the dashboard navbar. Polls every minute so the
 * operator's DMs / 2FA reminders show up without needing a refresh.
 */
export function NotificationsBell() {
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/notifications');
      setItems(data.items || []);
      setUnread(data.unread_count || 0);
    } catch {
      // best-effort poll — fail quietly so we don't spam the toast queue.
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const markAllRead = async () => {
    setBusy(true);
    try {
      await api.post('/notifications/read-all');
      await load();
    } finally { setBusy(false); }
  };

  const dismiss = async (id) => {
    try {
      await api.delete(`/notifications/${id}`);
      await load();
    } catch { /* ignore */ }
  };

  const markOne = async (id) => {
    try {
      await api.post(`/notifications/${id}/read`);
      await load();
    } catch { /* ignore */ }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="notifications-bell"
          aria-label={`Notifications${unread ? ` (${unread} unread)` : ''}`}
          className="relative inline-flex h-9 w-9 items-center justify-center rounded-md text-slate-300 transition hover:bg-slate-800 hover:text-white"
        >
          <Bell className="h-4 w-4" />
          {unread > 0 && (
            <span
              data-testid="notifications-unread-badge"
              className="absolute -top-0.5 -right-0.5 grid h-4 min-w-[16px] place-items-center rounded-full bg-tbc-500 px-1 text-[9px] font-bold text-ink-950"
            >
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-80 border-tbc-900/60 bg-ink-900 p-0 text-tbc-100"
        data-testid="notifications-popover"
      >
        <div className="flex items-center justify-between border-b border-tbc-900/60 px-3 py-2">
          <span className="text-xs font-bold uppercase tracking-wider text-tbc-200">
            Notifications
          </span>
          <button
            type="button"
            onClick={markAllRead}
            disabled={busy || unread === 0}
            data-testid="notifications-mark-all-read"
            className="inline-flex items-center gap-1 text-[11px] font-semibold text-tbc-300 hover:text-tbc-100 disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
            Mark all read
          </button>
        </div>
        <div className="max-h-96 overflow-y-auto">
          {items.length === 0 && (
            <div className="px-4 py-8 text-center text-xs text-tbc-200/50">
              No notifications yet.
            </div>
          )}
          {items.map((n) => {
            const Icon = KIND_ICONS[n.kind] || Bell;
            const setupCta = n.kind === '2fa_reminder';
            return (
              <div
                key={n.id}
                data-testid={`notification-item-${n.id}`}
                className={`group flex gap-2 border-b border-tbc-900/40 px-3 py-2.5 text-xs transition-colors ${
                  n.read_at ? 'opacity-60' : 'bg-tbc-500/[0.04]'
                }`}
              >
                <div className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md ${
                  n.kind === '2fa_reminder' ? 'bg-amber-500/20 text-amber-300' : 'bg-tbc-500/20 text-tbc-200'
                }`}>
                  <Icon className="h-3 w-3" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-tbc-100">{n.subject}</div>
                  <div className="mt-0.5 whitespace-pre-wrap break-words text-[11px] text-tbc-200/80">
                    {n.body}
                  </div>
                  {setupCta && (
                    <Link
                      to="/setup-2fa"
                      onClick={() => { markOne(n.id); setOpen(false); }}
                      data-testid={`notification-cta-${n.id}`}
                      className="mt-1.5 inline-flex items-center gap-1 rounded-md bg-amber-500 px-2 py-1 text-[10px] font-bold text-ink-950 hover:bg-amber-400"
                    >
                      <ShieldAlert className="h-3 w-3" />
                      Set up 2FA now
                    </Link>
                  )}
                  <div className="mt-1 text-[10px] text-tbc-200/40">{relative(n.created_at)}</div>
                </div>
                <button
                  type="button"
                  onClick={() => dismiss(n.id)}
                  data-testid={`notification-dismiss-${n.id}`}
                  aria-label="Dismiss"
                  className="grid h-5 w-5 shrink-0 place-items-center self-start rounded text-tbc-200/40 opacity-0 transition-opacity hover:bg-tbc-500/10 hover:text-tbc-100 group-hover:opacity-100"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

import React, { useCallback, useEffect, useState } from 'react';
import api from '../lib/api';
import { Lock, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

/**
 * Emergency lockdown pill — always visible in the Operator console top
 * bar. ONE click flips BOTH `banner_enabled` and `login_lockdown_enabled`
 * to true (and back). When ON, renders as a pulsing red "App is private"
 * pill so it's impossible to miss from any tab.
 *
 * Polls the operator settings endpoint every 30s so the state survives
 * a hard reload and reflects changes made from the Settings tab.
 */
export default function EmergencyLockdownPill() {
  const [state, setState] = useState(null); // {banner_enabled, login_lockdown_enabled}
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/operator/app-settings');
      setState(data);
    } catch {
      // Silent — endpoint guarded by operator auth; non-operators won't see this pill anyway.
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(() => { if (!document.hidden) load(); }, 30_000);
    return () => clearInterval(id);
  }, [load]);

  if (!state) return null;
  const active = state.banner_enabled && state.login_lockdown_enabled;

  const toggle = async () => {
    const next = !active;
    if (next && !window.confirm(
      'Take the app private RIGHT NOW?\n\n' +
      '• Banner overlay → ON\n' +
      '• Login lockdown → ON\n\n' +
      'Existing sessions stay valid. Click again to release.',
    )) return;
    setBusy(true);
    try {
      const { data } = await api.patch('/operator/app-settings', {
        banner_enabled: next,
        login_lockdown_enabled: next,
      });
      setState(data);
      toast.success(next
        ? '🔒 App is now PRIVATE — banner + lockdown ON'
        : '🔓 App is back OPEN');
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Toggle failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={busy}
      data-testid="emergency-lockdown-pill"
      className={
        active
          ? 'inline-flex items-center gap-1.5 rounded-full border border-red-500/60 bg-red-500/15 px-3 py-1 text-[11px] font-bold text-red-200 hover:bg-red-500/25 transition-colors animate-pulse'
          : 'inline-flex items-center gap-1.5 rounded-full border border-tbc-900/60 bg-ink-900 px-3 py-1 text-[11px] text-tbc-200/70 hover:text-tbc-100 hover:border-amber-500/40 transition-colors'
      }
      title={active
        ? 'App is PRIVATE — click to release'
        : 'Take the app private (banner + login lockdown) in one click'}
    >
      {busy
        ? <Loader2 className="h-3 w-3 animate-spin" />
        : <Lock className="h-3 w-3" />}
      {active ? 'App is private' : 'Lock app'}
    </button>
  );
}

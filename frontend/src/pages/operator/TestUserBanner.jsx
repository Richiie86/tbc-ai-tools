import React, { useCallback, useEffect, useState } from 'react';
import api from '../../lib/api';
import { Eye, Copy, Check, ExternalLink, UserRound } from 'lucide-react';
import { toast } from 'sonner';

/**
 * Compact banner inside the Operator Console that exposes the seeded
 * preview-user credentials so the operator can drop into the app as a
 * regular customer in seconds.
 *
 * Click "Open as test user" → opens `/login?prefill=…` in a new tab
 * with the email pre-filled. Operator types/pastes the password (also
 * shown here, one click to copy) and sees the customer view live.
 */
export default function TestUserBanner() {
  const [info, setInfo] = useState(null);
  const [show, setShow] = useState(false);
  const [copied, setCopied] = useState(null);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/operator/test-user');
      setInfo(data);
    } catch { /* non-fatal */ }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (!info) return null;

  const copy = async (text, key) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      toast.success(`${key === 'email' ? 'Email' : 'Password'} copied`);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    } catch { toast.error('Clipboard blocked'); }
  };

  const openAsTestUser = () => {
    const url = `/login?prefill=${encodeURIComponent(info.email)}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  return (
    <div
      data-testid="test-user-banner"
      className="mb-5 flex flex-col items-start justify-between gap-3 rounded-xl border border-sky-500/30 bg-gradient-to-r from-sky-500/[0.07] via-ink-900/60 to-ink-900/60 p-3 sm:flex-row sm:items-center"
    >
      <div className="flex items-center gap-3">
        <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-sky-500/20 text-sky-300">
          <UserRound className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <div className="text-xs font-bold text-tbc-100">
            Preview as a customer — test-user account
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-tbc-200/70">
            <button
              type="button"
              onClick={() => copy(info.email, 'email')}
              className="inline-flex items-center gap-1 font-mono text-tbc-200 hover:text-tbc-100"
              data-testid="test-user-email"
              title="Click to copy"
            >
              {info.email}
              {copied === 'email'
                ? <Check className="h-3 w-3 text-emerald-300" />
                : <Copy className="h-3 w-3" />}
            </button>
            <span className="text-tbc-200/40">·</span>
            <button
              type="button"
              onClick={() => copy(info.password, 'password')}
              className="inline-flex items-center gap-1 font-mono text-tbc-200 hover:text-tbc-100"
              data-testid="test-user-password"
              title="Click to copy"
            >
              {show ? info.password : '•'.repeat(info.password.length)}
              {copied === 'password'
                ? <Check className="h-3 w-3 text-emerald-300" />
                : <Copy className="h-3 w-3" />}
            </button>
            <button
              type="button"
              onClick={() => setShow((s) => !s)}
              className="text-tbc-200/50 hover:text-tbc-100"
              data-testid="test-user-show-password"
              title="Show / hide password"
            >
              <Eye className="h-3 w-3" />
            </button>
            <span className="text-tbc-200/40">·</span>
            <span className="text-tbc-200/60">
              {info.plan} plan · {info.credits?.toLocaleString?.() ?? info.credits} credits
            </span>
          </div>
        </div>
      </div>
      <button
        type="button"
        onClick={openAsTestUser}
        data-testid="test-user-open-btn"
        className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-sky-500 px-3 py-1.5 text-xs font-bold text-ink-950 transition hover:bg-sky-400"
      >
        <ExternalLink className="h-3.5 w-3.5" />
        Open as test user
      </button>
    </div>
  );
}

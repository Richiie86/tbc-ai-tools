import React, { useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Megaphone, X } from 'lucide-react';
import api from '../lib/api';
import { useAuth } from '../context/AuthContext';

const DISMISS_KEY = 'tbc.marketingBanner.dismissedHash';

const hashMessages = (msgs) => {
  try {
    return msgs.map((m) => m.text).join('|').slice(0, 240);
  } catch { return ''; }
};

const inWindow = (cfg) => {
  const now = Date.now();
  if (cfg.starts_at) {
    const s = Date.parse(cfg.starts_at);
    if (!Number.isNaN(s) && now < s) return false;
  }
  if (cfg.ends_at) {
    const e = Date.parse(cfg.ends_at);
    if (!Number.isNaN(e) && now > e) return false;
  }
  return true;
};

/**
 * Right-to-left scrolling marketing banner mounted globally on public pages.
 * Operator configures messages + speed via Operator → Marketing tab; the
 * GET endpoint is public so we don't need auth to render the ticker. Users
 * can dismiss it for the current campaign (per-message-set hash).
 */
export default function MarketingBanner() {
  const [cfg, setCfg] = useState(null);
  const [dismissedHash, setDismissedHash] = useState(() => {
    try { return localStorage.getItem(DISMISS_KEY) || ''; } catch { return ''; }
  });
  const location = useLocation();
  const { user } = useAuth() || {};

  // Pick which named banner to show based on context:
  //   * /dashboard or /chat → "dashboard_subscription" for paying plans,
  //     "dashboard_new" otherwise.
  //   * everything else → "landing".
  const scope = useMemo(() => {
    const path = location.pathname || '/';
    const inDashboard = path.startsWith('/dashboard') || path.startsWith('/chat');
    if (!inDashboard) return 'landing';
    const plan = (user?.plan || '').toLowerCase();
    const isPaid = ['starter', 'pro', 'enterprise'].includes(plan);
    return isPaid ? 'dashboard_subscription' : 'dashboard_new';
  }, [location.pathname, user?.plan]);

  useEffect(() => {
    let cancelled = false;
    api.get(`/marketing/banner?scope=${scope}`)
      .then((r) => { if (!cancelled) setCfg(r.data); })
      .catch(() => { /* banner is optional */ });
    return () => { cancelled = true; };
  }, [scope]);

  const currentHash = useMemo(() => (cfg ? `${scope}|${hashMessages(cfg.messages || [])}` : ''), [cfg, scope]);

  if (!cfg || !cfg.enabled) return null;
  if (!Array.isArray(cfg.messages) || cfg.messages.length === 0) return null;
  if (!inWindow(cfg)) return null;
  if (dismissedHash && dismissedHash === currentHash) return null;

  const onDismiss = () => {
    try { localStorage.setItem(DISMISS_KEY, currentHash); } catch { /* ignore */ }
    setDismissedHash(currentHash);
  };

  // Duplicate the list once so the CSS animation loops seamlessly.
  const items = [...cfg.messages, ...cfg.messages];
  const duration = `${cfg.speed_seconds || 30}s`;

  return (
    <div
      data-testid="marketing-banner"
      className="relative isolate flex items-center gap-3 border-b border-tbc-500/30 bg-gradient-to-r from-tbc-500/15 via-ink-950 to-tbc-500/15 px-3 py-1.5 text-xs text-tbc-100"
    >
      <div className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-tbc-500/25 text-tbc-200">
        <Megaphone className="h-3.5 w-3.5" />
      </div>
      <div className="flex-1 overflow-hidden">
        <div
          className="flex whitespace-nowrap will-change-transform"
          style={{ animation: `tbc-marquee ${duration} linear infinite` }}
        >
          {items.map((m, idx) => (
            <BannerItem key={`${idx}-${m.text}`} item={m} />
          ))}
        </div>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        data-testid="marketing-banner-dismiss"
        aria-label="Dismiss banner"
        className="grid h-6 w-6 shrink-0 place-items-center rounded text-tbc-200/70 transition-colors hover:bg-tbc-500/20 hover:text-tbc-100"
      >
        <X className="h-3.5 w-3.5" />
      </button>
      <style>{`@keyframes tbc-marquee { 0% { transform: translateX(0); } 100% { transform: translateX(-50%); } }`}</style>
    </div>
  );
}

function BannerItem({ item }) {
  const content = (
    <span className="mx-8 inline-flex items-center gap-2 font-semibold tracking-wide">
      <span className="h-1 w-1 rounded-full bg-tbc-400" />
      {item.text}
    </span>
  );
  if (item.href) {
    if (item.href.startsWith('http')) {
      return (
        <a href={item.href} target="_blank" rel="noreferrer" className="hover:text-tbc-300">
          {content}
        </a>
      );
    }
    return <Link to={item.href} className="hover:text-tbc-300">{content}</Link>;
  }
  return content;
}

import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Gift, Copy, Check } from 'lucide-react';
import api from '../lib/api';

/**
 * Compact referral CTA card for the dashboard sidebar.
 * Shows the user's referral URL with a one-click copy and a CTA to
 * the full /refer page. Designed to surface every chat session and
 * lift the viral coefficient.
 */
export default function ReferBanner() {
  const [info, setInfo] = useState(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.get('/referral/me')
      .then((r) => { if (!cancelled) setInfo(r.data); })
      .catch(() => { /* silent — banner just won't render */ });
    return () => { cancelled = true; };
  }, []);

  if (!info) return null;
  const url = info.share_url_org || info.share_url_com;
  if (!url) return null;

  const onCopy = (e) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard blocked — no-op */
    }
  };

  return (
    <Link
      to="/refer"
      data-testid="sidebar-refer-banner"
      className="group mb-3 block overflow-hidden rounded-lg border border-tbc-500/40 bg-gradient-to-br from-tbc-500/15 via-ink-900 to-ink-950 p-2.5 transition-colors hover:border-tbc-400/70"
    >
      <div className="flex items-center gap-2">
        <div className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-tbc-500/25 text-tbc-200">
          <Gift className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-bold uppercase tracking-wider text-tbc-200">
            Earn {info.commission_pct}% commission
          </div>
          <div className="truncate text-[10px] text-tbc-200/60">
            Share your link, earn on every payment
          </div>
        </div>
      </div>
      <div className="mt-2 flex items-center gap-1.5">
        <code
          data-testid="sidebar-refer-url"
          className="flex-1 truncate rounded bg-ink-950/80 px-2 py-1 text-[10px] text-tbc-100/90 ring-1 ring-tbc-500/20"
          title={url}
        >
          {url.replace(/^https?:\/\//, '')}
        </code>
        <button
          type="button"
          onClick={onCopy}
          data-testid="sidebar-refer-copy"
          className="grid h-6 w-6 shrink-0 place-items-center rounded bg-tbc-500/20 text-tbc-200 transition-colors hover:bg-tbc-500/40"
          aria-label="Copy referral link"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        </button>
      </div>
    </Link>
  );
}

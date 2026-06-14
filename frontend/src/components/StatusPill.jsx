import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../lib/api';

/**
 * Compact "All systems operational" pill — public, auto-refreshing.
 * Fetches `/api/status` (anonymous endpoint, 30s edge cache), shows a
 * coloured dot + verdict label, links to `/status` for details.
 *
 * Failure-tolerant: if the status endpoint is unreachable (offline,
 * outage, mid-deploy), the pill silently hides rather than rendering a
 * scary red dot on the marketing footer.
 */
const TONE = {
  operational: { dot: 'bg-emerald-400', text: 'text-emerald-300', label: 'All systems operational' },
  degraded:    { dot: 'bg-amber-400',   text: 'text-amber-300',   label: 'Degraded performance' },
  outage:      { dot: 'bg-rose-400',    text: 'text-rose-300',    label: 'Major outage' },
};

export default function StatusPill() {
  const [overall, setOverall] = useState(null);
  const [selfHeal, setSelfHeal] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const probe = async () => {
      try {
        const { data } = await api.get('/status');
        if (!cancelled) {
          setOverall(data?.overall || null);
          setSelfHeal(data?.self_heal || null);
        }
      } catch {
        if (!cancelled) { setOverall(null); setSelfHeal(null); }
      }
    };
    probe();
    // Refresh every 60s — same cadence as the WhatsNew popover so we
    // stay quiet on the network.
    const t = setInterval(probe, 60_000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  if (!overall) return null;
  const tone = TONE[overall] || TONE.degraded;
  // Build a tooltip that also surfaces the autonomy story — "we monitor
  // uptime AND auto-fix issues in real time" is a stronger trust signal
  // than uptime alone.
  const tip = (() => {
    if (!selfHeal) return tone.label;
    const parts = [tone.label];
    if (selfHeal.opened_24h) parts.push(`${selfHeal.opened_24h} auto-PR${selfHeal.opened_24h === 1 ? '' : 's'} in last 24h`);
    if (selfHeal.merged_24h) parts.push(`${selfHeal.merged_24h} auto-merged`);
    return parts.join(' · ');
  })();
  return (
    <Link
      to="/status"
      title={tip}
      data-testid="footer-status-pill"
      className={`inline-flex items-center gap-1.5 rounded-full border border-slate-800 bg-slate-900/60 px-2.5 py-1 text-[11px] transition hover:border-tbc-500/40 ${tone.text}`}
    >
      <span className={`inline-block h-1.5 w-1.5 animate-pulse rounded-full ${tone.dot}`} />
      {tone.label}
    </Link>
  );
}

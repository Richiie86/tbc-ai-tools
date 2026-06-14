import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, ArrowRight, Command } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

/**
 * Operator-only command palette / search.
 *
 * Why this exists
 * ---------------
 * The Operator console is HUGE — 20+ tabs, each with multiple cards,
 * each with multiple fields. The operator asked: "Just let me search for
 * what I'm looking for". So we built a single search box that knows
 * every navigable surface in the console and jumps the operator there
 * in one tap.
 *
 * How it works
 * ------------
 *   - `INDEX` below is a static list of every searchable surface
 *     (`{tab, section, label, keywords[], anchor?}`).
 *   - Typing filters the list with a tiny fuzzy match (title prefix +
 *     keyword contains). No external dep — keeps the bundle thin.
 *   - Selecting an entry switches the tab via `?tab=...` query param
 *     and scrolls to the anchor on the next frame.
 *   - Keyboard: `/` or `Ctrl/Cmd+K` opens the palette; ↑/↓/Enter/Esc
 *     drive the result list.
 */
const INDEX = [
  // ─── Tabs (top-level) ──────────────────────────────────────────────
  { tab: 'users',     label: 'Users',                 keywords: ['accounts', 'members', 'list', 'pause', 'delete'] },
  { tab: 'analytics', label: 'Analytics',             keywords: ['metrics', 'usage', 'charts', 'traffic'] },
  { tab: 'projects',  label: 'Projects',              keywords: ['side projects', 'tradebridge'] },
  { tab: 'plans',     label: 'Plans',                 keywords: ['pricing', 'tiers', 'starter', 'pro'] },
  { tab: 'payments',  label: 'Payments',              keywords: ['stripe', 'paypal', 'crypto', 'transactions'] },
  { tab: 'treasury',  label: 'Treasury',              keywords: ['cash', 'balance', 'wallet'] },
  { tab: 'money',     label: 'Money',                 keywords: ['revenue', 'royalty', 'cashflow', 'p&l'] },
  { tab: 'licenses',  label: 'Licenses',              keywords: ['keys', 'activations'] },
  { tab: 'royalties', label: 'Royalties',             keywords: ['payouts', 'founders', 'split'] },
  { tab: 'settings',  label: 'Security / Settings',   keywords: ['config', 'secrets', 'tokens', 'preferences'] },
  { tab: 'ops',       label: 'Ops',                   keywords: ['deploy', 'projects', 'vercel'] },
  { tab: 'audit',     label: 'Audit log',             keywords: ['history', 'actions', 'trace'] },
  { tab: 'contacts',  label: 'Contacts',              keywords: ['inbox', 'messages', 'support'] },
  { tab: 'codes',     label: 'Codes',                 keywords: ['promo', 'discount', 'coupon'] },
  { tab: 'marketing', label: 'Marketing',             keywords: ['campaigns', 'emails', 'broadcast'] },
  { tab: 'messaging', label: 'Messaging',             keywords: ['notifications', 'broadcast'] },
  { tab: 'sandbox',   label: 'Sandbox',               keywords: ['test', 'preview', 'playground'] },
  { tab: 'learnings', label: 'AI Learnings',          keywords: ['drift', 'eval', 'training'] },
  { tab: 'brain',     label: 'AI Brain',              keywords: ['memory', 'skills', 'knowledge'] },
  { tab: 'tests',     label: 'AI Tests',              keywords: ['test bench', 'probes', 'drift', 'pytest'] },
  { tab: 'errors',    label: 'Errors',                keywords: ['runtime', 'crashes', 'rca', 'logs'] },
  { tab: 'ai-build',  label: 'AI Build',              keywords: ['nl to pr', 'patches', 'planner'] },

  // ─── Settings / Security cards (jump straight to anchor) ──────────
  { tab: 'settings', section: 'Public banner & lockdown', label: 'Public banner / lockdown mode',
    keywords: ['banner', 'lockdown', 'maintenance', 'announce'], anchor: 'public-banner' },
  { tab: 'settings', section: 'Slack / Discord webhook', label: 'Slack / Discord alert webhook',
    keywords: ['slack', 'discord', 'webhook', 'alerts'], anchor: 'webhook' },
  { tab: 'settings', section: 'Auto-Fix Loop', label: 'Autonomous Auto-Fix Loop',
    keywords: ['autofix', 'self-heal', 'cron', 'auto-merge', 'auto-push'], anchor: 'auto-fix' },
  { tab: 'settings', section: 'Auto-Fix Loop', label: 'Auto-push to empty repos (toggle)',
    keywords: ['push', 'empty repo', 'github', 'auto-push'], anchor: 'auto-fix' },
  { tab: 'settings', section: 'Auto-Fix Loop', label: 'Run tests automatically (pytest gate)',
    keywords: ['pytest', 'tests', 'gate', 'auto-merge'], anchor: 'auto-fix' },
  { tab: 'settings', section: 'Security', label: 'Account approvals (re-registration after vanish)',
    keywords: ['pending users', 'approve', 'banned', 'reregistration', 'accept'], anchor: 'security' },
  { tab: 'settings', section: 'Security', label: 'KYC bypass allowlist',
    keywords: ['kyc', 'bypass', 'allowlist', 'skip kyc'], anchor: 'security' },
  { tab: 'settings', section: 'Changelog', label: 'Changelog ("What\'s new")',
    keywords: ['changelog', 'whats new', 'release notes'], anchor: 'changelog' },
  { tab: 'settings', section: 'New user defaults', label: 'New user defaults (signup credits, deploy access)',
    keywords: ['signup', 'default credits', 'can deploy'], anchor: 'new-user-defaults' },
  { tab: 'settings', section: 'Stripe', label: 'Stripe API keys',
    keywords: ['stripe', 'cards', 'apple pay', 'google pay', 'sk_test', 'sk_live'], anchor: 'stripe' },
  { tab: 'settings', section: 'NOWPayments', label: 'NOWPayments (crypto auto)',
    keywords: ['crypto', 'nowpayments', 'btc', 'usdt'], anchor: 'nowpayments' },
  { tab: 'settings', section: 'PayPal', label: 'PayPal client ID / secret',
    keywords: ['paypal'], anchor: 'paypal' },
  { tab: 'settings', section: 'Resend', label: 'Resend (transactional emails)',
    keywords: ['email', 'resend', 'smtp', 'transactional'], anchor: 'resend' },
  { tab: 'settings', section: 'Emergent LLM', label: 'Emergent LLM key (AI chat)',
    keywords: ['llm', 'openai', 'claude', 'gemini', 'ai key', 'universal key'], anchor: 'llm-key' },
  { tab: 'settings', section: 'Payment methods', label: 'Enabled payment methods',
    keywords: ['toggle stripe', 'enable paypal'], anchor: 'payment-methods' },
  { tab: 'settings', section: 'Vercel & AI integration', label: 'Vercel deploy + GitHub token',
    keywords: ['vercel', 'github token', 'pat', 'deploy', 'self-deploy', 'webhook secret'], anchor: 'vercel' },
  { tab: 'settings', section: 'Vercel & AI integration', label: 'GitHub Personal Access Token',
    keywords: ['github', 'pat', 'token', 'github_token'], anchor: 'vercel' },
  { tab: 'settings', section: 'Vercel & AI integration', label: 'Vercel Personal Access Token',
    keywords: ['vercel', 'pat', 'vcp_'], anchor: 'vercel' },
  { tab: 'settings', section: 'Birthday rewards', label: 'Birthday rewards',
    keywords: ['birthday', 'rewards', 'credits gift'], anchor: 'birthday' },

  // ─── Ops actions ─────────────────────────────────────────────────────
  { tab: 'ops', label: 'Push Code (upload /app source)',
    keywords: ['push', 'initial push', 'github', 'upload', 'source'] },
  { tab: 'ops', label: 'Deploy (ship to Vercel)',
    keywords: ['deploy', 'ship', 'production', 'vercel'] },
  { tab: 'ops', label: 'Code Review (cross-AI)',
    keywords: ['review', 'code review', 'ai review'] },
  { tab: 'ops', label: 'Health Check',
    keywords: ['health', 'probe', 'uptime'] },
  { tab: 'ops', label: 'AI improvement suggestions',
    keywords: ['suggestions', 'improve', 'recommend'] },
];

/** Tiny scoring fn — exact > prefix > substring on label or keywords. */
function score(q, entry) {
  const ql = q.toLowerCase().trim();
  if (!ql) return 0;
  const label = (entry.label || '').toLowerCase();
  const kws = (entry.keywords || []).map((k) => k.toLowerCase());
  if (label === ql) return 1000;
  if (label.startsWith(ql)) return 800;
  if (label.includes(ql)) return 600;
  if (kws.some((k) => k === ql)) return 500;
  if (kws.some((k) => k.startsWith(ql))) return 400;
  if (kws.some((k) => k.includes(ql))) return 250;
  // Multi-word: every word must hit somewhere.
  const words = ql.split(/\s+/).filter(Boolean);
  if (words.length > 1 && words.every((w) => label.includes(w) || kws.some((k) => k.includes(w)))) return 150;
  return 0;
}

export default function OperatorSearch({ onTabChange }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const inputRef = useRef(null);

  const results = useMemo(() => {
    if (!q.trim()) {
      // Empty query → surface the most common destinations.
      return INDEX.slice(0, 8).map((e) => ({ ...e, _s: 0 }));
    }
    return INDEX
      .map((e) => ({ ...e, _s: score(q, e) }))
      .filter((e) => e._s > 0)
      .sort((a, b) => b._s - a._s)
      .slice(0, 12);
  }, [q]);

  // Global keyboard: `/` or Ctrl/Cmd+K opens.
  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target?.tagName || '').toUpperCase();
      const inEditable = tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable;
      if (((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k')
          || (e.key === '/' && !inEditable)) {
        e.preventDefault();
        setOpen(true);
      } else if (e.key === 'Escape' && open) {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 30);
    else { setQ(''); setHi(0); }
  }, [open]);

  const pick = useCallback((entry) => {
    if (!entry) return;
    setOpen(false);
    if (entry.tab && onTabChange) {
      onTabChange(entry.tab);
    } else if (entry.tab) {
      navigate(`/operator?tab=${entry.tab}`);
    }
    // Anchor scroll after the tab content mounts.
    if (entry.anchor) {
      requestAnimationFrame(() => {
        setTimeout(() => {
          const el = document.getElementById(`section-${entry.anchor}`);
          if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'start' });
            el.classList.add('ring-2', 'ring-amber-400/60');
            setTimeout(() => el.classList.remove('ring-2', 'ring-amber-400/60'), 1800);
          }
        }, 300);
      });
    }
  }, [navigate, onTabChange]);

  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi((i) => Math.min(i + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp')   { e.preventDefault(); setHi((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter')     { e.preventDefault(); pick(results[hi]); }
  };

  return (
    <>
      {/* Trigger pill — sits next to the BuildBadge. */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="operator-search-trigger"
        className="inline-flex items-center gap-2 rounded-full border border-tbc-900/60 bg-ink-900/60 px-3 py-1.5 text-xs text-tbc-200/80 transition hover:border-amber-500/40 hover:bg-ink-900 hover:text-tbc-100"
      >
        <Search className="h-3 w-3" />
        <span>Search operator…</span>
        <kbd className="hidden rounded border border-tbc-900/60 bg-ink-950 px-1.5 py-0.5 font-mono text-[10px] text-tbc-200/60 sm:inline-flex sm:items-center sm:gap-1">
          <Command className="h-2.5 w-2.5" />K
        </kbd>
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-[100] flex items-start justify-center bg-ink-950/70 px-4 pt-24 backdrop-blur-sm"
          onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}
          data-testid="operator-search-dialog"
        >
          <div className="w-full max-w-xl overflow-hidden rounded-2xl border border-tbc-900/70 bg-ink-950 shadow-2xl">
            <div className="flex items-center gap-3 border-b border-tbc-900/60 px-4 py-3">
              <Search className="h-4 w-4 text-amber-300" />
              <input
                ref={inputRef}
                value={q}
                onChange={(e) => { setQ(e.target.value); setHi(0); }}
                onKeyDown={onKey}
                placeholder='Try "github token", "push code", "kyc bypass", "auto-fix"…'
                data-testid="operator-search-input"
                className="grow bg-transparent text-sm text-tbc-100 placeholder:text-tbc-200/40 focus:outline-none"
              />
              <kbd className="rounded border border-tbc-900/60 bg-ink-900 px-1.5 py-0.5 text-[10px] text-tbc-200/60">Esc</kbd>
            </div>
            <div className="max-h-80 overflow-y-auto py-1">
              {results.length === 0 ? (
                <p className="px-4 py-6 text-center text-xs text-tbc-200/50">
                  Nothing matches. Try a tab name ("ops", "users") or a setting ("github", "stripe", "vercel").
                </p>
              ) : (
                results.map((r, i) => (
                  <button
                    key={`${r.tab}-${r.label}-${i}`}
                    type="button"
                    onMouseEnter={() => setHi(i)}
                    onClick={() => pick(r)}
                    data-testid={`operator-search-result-${i}`}
                    className={`flex w-full items-center gap-3 px-4 py-2 text-left text-sm transition ${
                      i === hi
                        ? 'bg-amber-500/10 text-tbc-100'
                        : 'text-tbc-100/90 hover:bg-ink-900/60'
                    }`}
                  >
                    <div className="grow">
                      <div className="font-semibold">{r.label}</div>
                      <div className="text-[10px] uppercase tracking-wider text-tbc-200/50">
                        {r.tab} {r.section ? `· ${r.section}` : ''}
                      </div>
                    </div>
                    <ArrowRight className={`h-3.5 w-3.5 shrink-0 ${i === hi ? 'text-amber-300' : 'text-tbc-200/30'}`} />
                  </button>
                ))
              )}
            </div>
            <div className="border-t border-tbc-900/60 bg-ink-900/40 px-4 py-2 text-[10px] text-tbc-200/40">
              <span className="font-mono">↑ ↓</span> navigate &nbsp;·&nbsp;
              <span className="font-mono">Enter</span> open &nbsp;·&nbsp;
              <span className="font-mono">/</span> or <span className="font-mono">⌘K</span> to reopen
            </div>
          </div>
        </div>
      )}
    </>
  );
}

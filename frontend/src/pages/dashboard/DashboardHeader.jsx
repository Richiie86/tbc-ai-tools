import React, { useMemo, useState } from 'react';
import { Cpu, Menu, Search } from 'lucide-react';
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectLabel,
  SelectTrigger, SelectValue,
} from '../../components/ui/select';
import { Input } from '../../components/ui/input';
import CreditsBadge from '../../components/CreditsBadge';
import AppUpdateDot from '../../components/AppUpdateDot';
import { InChatDeployControls } from './InChatDeployControls';
import { ChatDeployButton } from './ChatDeployButton';
import { NotificationsBell } from './NotificationsBell';
import { DashboardGuideButton } from './DashboardGuideTour';
import ViewModeToggle from '../../components/ViewModeToggle';

/**
 * The top bar of the Dashboard chat view: brand title, operator-only
 * deploy controls, notifications, credits badge, guide launcher, and the
 * provider/model dropdown.
 */
export function DashboardHeader({
  brandTitle,
  sidebarOpen,
  onOpenSidebar,
  user,
  models,
  model,
  setModel,
  onOpenGuide,
  currentId,
  messages,
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-slate-800 bg-ink-950/80 px-5 py-3 backdrop-blur">
      <div className="flex shrink-0 items-center gap-3">
        {!sidebarOpen && (
          <button
            onClick={onOpenSidebar}
            className="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"
          >
            <Menu className="h-4 w-4" />
          </button>
        )}
        <div className="hidden whitespace-nowrap text-sm font-semibold text-white sm:block">{brandTitle}</div>
      </div>
      <div className="flex min-w-0 flex-1 items-center justify-end gap-2 sm:gap-3">
        {/* Lower-priority controls live in a horizontal scroll strip so they
            never push the always-visible credits pill off screen on phones. */}
        <div className="flex min-w-0 items-center gap-2 overflow-x-auto scrollbar-none sm:gap-3 [&>*]:shrink-0">
          {/* Emergent-style per-chat deploy: turn THIS chat into a live app,
              then redeploy / push edits from the same session. */}
          <ChatDeployButton user={user} sessionId={currentId} messages={messages} />
          {/* Operator-only deploy controls (project picker) so we can ship the
              platform's own code / pick a specific project from inside chat. */}
          <InChatDeployControls user={user} />
          {/* Auto / Mobile / Computer layout switch — inline here (instead of a
              floating pill) so it never overlaps content on phones. */}
          <ViewModeToggle />
          <NotificationsBell />
          <DashboardGuideButton onOpen={onOpenGuide} />
        </div>
        {/* Always-visible cluster: the model picker (so the operator can ALWAYS
            switch AI / pick Auto without scrolling), credits, and the live
            app-update status. Pinned outside the scroll strip. */}
        <div className="flex shrink-0 items-center gap-2">
          <ModelPicker models={models} model={model} setModel={setModel} />
          <CreditsBadge user={user} testid="dashboard-credits-badge" />
          {/* Live app-update status — green = latest, amber = checking,
              blue = new build available (click to refresh). */}
          <AppUpdateDot position="inline" />
        </div>
      </div>
    </div>
  );
}

/**
 * Provider/model dropdown with a built-in search box. The search is essential
 * once OpenRouter is connected because it adds 300+ models — scrolling would
 * be unusable. Filtering matches on both the human label and the raw id, and
 * the currently-selected model is always kept visible so SelectValue can
 * render it even when it's filtered out of the list.
 */
// Map a provider group label ("OpenAI", "Anthropic", …) to its health entry
// from the /chat/models `health` map (keyed by lowercase provider id).
const _GROUP_TO_HEALTH_KEY = {
  OpenAI: 'openai',
  Anthropic: 'anthropic',
  Gemini: 'gemini',
  OpenRouter: 'openrouter',
};

function providerStatus(health, groupName) {
  const key = _GROUP_TO_HEALTH_KEY[groupName];
  if (!key || !health || !health[key]) return 'ok';
  return health[key].status || 'ok';
}

// Green = ok, amber = degraded (rate-limited / overloaded), red = down (out of
// credits or bad key — auto-skipped, another AI is used instead).
function ProviderStatusDot({ status }) {
  const cfg = {
    ok: { cls: 'bg-emerald-500', title: 'Available' },
    degraded: { cls: 'bg-amber-400', title: 'Busy / rate-limited — may be slow' },
    down: { cls: 'bg-red-500', title: 'Out of credits — auto-skipped, another AI is used' },
  }[status] || { cls: 'bg-slate-600', title: 'Unknown' };
  return (
    <span
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${cfg.cls}`}
      title={cfg.title}
      aria-label={`Provider status: ${cfg.title}`}
    />
  );
}

function ModelPicker({ models, model, setModel }) {
  const [q, setQ] = useState('');

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const groups = Object.entries(models.providers || {});
    if (!needle) return groups;
    return groups
      .map(([provider, items]) => [
        provider,
        items.filter(
          (m) =>
            m.id === model ||
            (m.label || '').toLowerCase().includes(needle) ||
            (m.id || '').toLowerCase().includes(needle),
        ),
      ])
      .filter(([, items]) => items.length > 0);
  }, [models.providers, q, model]);

  const totalCount = useMemo(
    () => Object.values(models.providers || {}).reduce((n, items) => n + items.length, 0),
    [models.providers],
  );

  return (
    <Select value={model} onValueChange={setModel}>
      <SelectTrigger className="h-9 w-[140px] min-w-0 border-slate-700 bg-slate-900 text-slate-100 sm:w-[230px]">
        {/* min-w-0 + overflow-hidden on the inner flex, plus truncate on the
            value, so a long model label (e.g. "Claude Opus 4.7 (recommended)")
            clips inside the pill instead of spilling over the credits badge. */}
        <div className="flex min-w-0 items-center gap-2 overflow-hidden text-sm">
          <Cpu className="h-3.5 w-3.5 shrink-0 text-tbc-400" />
          <span className="min-w-0 truncate">
            <SelectValue placeholder="Select model" />
          </span>
        </div>
      </SelectTrigger>
      <SelectContent className="border-slate-800 bg-slate-900 text-slate-100">
        {/* Sticky search box. stopPropagation on keydown keeps Radix Select's
            built-in typeahead from stealing the keystrokes. */}
        <div className="sticky top-0 z-10 -mx-1 mb-1 border-b border-slate-800 bg-slate-900 px-2 py-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              placeholder={`Search ${totalCount} models…`}
              className="h-8 border-slate-700 bg-slate-950 pl-7 text-xs text-slate-100"
              data-testid="model-search"
            />
          </div>
        </div>

        {!q && models.auto && (
          <SelectGroup>
            <SelectLabel className="text-[10px] uppercase tracking-wider text-slate-500">Smart</SelectLabel>
            <SelectItem value={models.auto.id} className="focus:bg-slate-800">
              {models.auto.label}
            </SelectItem>
          </SelectGroup>
        )}
        {filtered.map(([provider, items]) => (
          <SelectGroup key={provider}>
            <SelectLabel className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-slate-500">
              <ProviderStatusDot status={providerStatus(models.health, provider)} />
              {provider}
            </SelectLabel>
            {items.map((m) => (
              <SelectItem key={m.id} value={m.id} className="focus:bg-slate-800">{m.label}</SelectItem>
            ))}
          </SelectGroup>
        ))}
        {q && filtered.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">
            No models match “{q}”.
          </div>
        )}
      </SelectContent>
    </Select>
  );
}

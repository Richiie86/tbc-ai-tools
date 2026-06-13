import React from 'react';
import { Cpu, Menu } from 'lucide-react';
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectLabel,
  SelectTrigger, SelectValue,
} from '../../components/ui/select';
import CreditsBadge from '../../components/CreditsBadge';
import { InChatDeployControls } from './InChatDeployControls';
import { NotificationsBell } from './NotificationsBell';
import { DashboardGuideButton } from './DashboardGuideTour';

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
}) {
  return (
    <div className="flex items-center justify-between border-b border-slate-800 bg-ink-950/80 px-5 py-3 backdrop-blur">
      <div className="flex items-center gap-3">
        {!sidebarOpen && (
          <button
            onClick={onOpenSidebar}
            className="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"
          >
            <Menu className="h-4 w-4" />
          </button>
        )}
        <div className="text-sm font-semibold text-white">{brandTitle}</div>
      </div>
      <div className="flex items-center gap-3">
        {/* Operator-only deploy controls so we can ship code from inside chat. */}
        <InChatDeployControls user={user} />
        <NotificationsBell />
        {/* Credits badge sits right next to the model picker so users
            always see how much budget they have left while chatting. */}
        <CreditsBadge user={user} testid="dashboard-credits-badge" />
        <DashboardGuideButton onOpen={onOpenGuide} />
        <Select value={model} onValueChange={setModel}>
          <SelectTrigger className="h-9 w-[230px] border-slate-700 bg-slate-900 text-slate-100">
            <div className="flex items-center gap-2 text-sm">
              <Cpu className="h-3.5 w-3.5 text-tbc-400" />
              <SelectValue placeholder="Select model" />
            </div>
          </SelectTrigger>
          <SelectContent className="border-slate-800 bg-slate-900 text-slate-100">
            {Object.entries(models.providers || {}).map(([provider, items]) => (
              <SelectGroup key={provider}>
                <SelectLabel className="text-[10px] uppercase tracking-wider text-slate-500">{provider}</SelectLabel>
                {items.map((m) => (
                  <SelectItem key={m.id} value={m.id} className="focus:bg-slate-800">{m.label}</SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

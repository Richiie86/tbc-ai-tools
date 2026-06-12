import React from 'react';
import { DollarSign, TrendingUp, Clock, Activity } from 'lucide-react';
import { fmt } from './format';

function Tile({ icon: Icon, label, value, sub, tone = 'emerald', testid }) {
  const tones = {
    emerald: 'border-emerald-500/30 bg-emerald-500/5 text-emerald-300',
    sky:     'border-sky-500/30 bg-sky-500/5 text-sky-300',
    amber:   'border-amber-500/30 bg-amber-500/5 text-amber-300',
    violet:  'border-violet-500/30 bg-violet-500/5 text-violet-300',
  };
  return (
    <div data-testid={testid} className={`rounded-xl border p-4 ${tones[tone]}`}>
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider opacity-80">{label}</span>
        <Icon className="h-4 w-4 opacity-70" />
      </div>
      <div className="mt-2 text-2xl font-extrabold text-tbc-50">{value}</div>
      <div className="mt-1 text-[11px] opacity-60">{sub}</div>
    </div>
  );
}

/** The 4-tile KPI row at the top of the Money tab. */
export function MoneyTiles({ internal }) {
  const leading = internal.by_method_30d[0]?.method || '—';
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="money-tiles">
      <Tile
        icon={DollarSign} tone="emerald" testid="money-tile-total"
        label="Total revenue"
        value={fmt(internal.total_revenue_usd)}
        sub={`${internal.total_paid_count} paid transactions`}
      />
      <Tile
        icon={TrendingUp} tone="sky" testid="money-tile-30d"
        label="Last 30 days"
        value={fmt(internal.last_30d_revenue_usd)}
        sub={`${internal.last_30d_count} payments`}
      />
      <Tile
        icon={Clock} tone="amber" testid="money-tile-pending"
        label="Pending manual"
        value={internal.pending_manual_count}
        sub="awaiting review"
      />
      <Tile
        icon={Activity} tone="violet" testid="money-tile-methods"
        label="Methods (30d)"
        value={internal.by_method_30d.length}
        sub={`${leading} leads`}
      />
    </div>
  );
}

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  TrendingUp, UserPlus, Users as UsersIcon, Cake, RefreshCcw, Loader2, DollarSign,
} from 'lucide-react';
import api from '../../lib/api';
import { Button } from '../../components/ui/button';
import AlertsCard from './AlertsCard';

/**
 * Inline SVG sparkline + headline number. Zero deps, looks crisp at
 * any size, and renders ~30 data points without breaking a sweat.
 *
 * We deliberately don't pull in chart.js / recharts — the operator
 * console already ships ~2MB of JS and a sparkline is six lines of SVG.
 */
function Sparkline({ values = [], color = '#d4a028', height = 48 }) {
  const width = 320;          // viewBox width — SVG scales to its container
  const max = Math.max(1, ...values);
  const min = Math.min(0, ...values);
  const range = Math.max(1, max - min);
  const step = values.length > 1 ? width / (values.length - 1) : width;

  const pts = values.map((v, i) => {
    const x = i * step;
    const y = height - ((v - min) / range) * height;
    return [x, y];
  });
  const linePath = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const fillPath = pts.length
    ? `${linePath} L${(pts[pts.length - 1][0]).toFixed(1)},${height} L0,${height} Z`
    : '';

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
      role="presentation"
      className="h-full w-full"
    >
      {fillPath && (
        <path d={fillPath} fill={color} opacity={0.15} />
      )}
      <path d={linePath} fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" />
      {pts.length > 0 && (
        <circle
          cx={pts[pts.length - 1][0]}
          cy={pts[pts.length - 1][1]}
          r={2.5}
          fill={color}
        />
      )}
    </svg>
  );
}

function pctChange(arr) {
  // Compare last-7-day total vs the prior 7-day total so a single noisy
  // day doesn't dominate the headline delta.
  if (!arr || arr.length < 14) return null;
  const last7 = arr.slice(-7).reduce((a, b) => a + b, 0);
  const prev7 = arr.slice(-14, -7).reduce((a, b) => a + b, 0);
  if (prev7 === 0) return last7 > 0 ? +100 : 0;
  return Math.round(((last7 - prev7) / prev7) * 100);
}

function MetricCard({ icon: Icon, label, value, hint, series, color, testid }) {
  const delta = pctChange(series);
  const deltaTone =
    delta === null ? 'text-tbc-200/40'
      : delta >= 0 ? 'text-emerald-300'
        : 'text-rose-300';
  return (
    <div
      data-testid={testid}
      className="rounded-xl border border-tbc-900/60 bg-ink-900/70 p-4"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-tbc-500/15 text-tbc-300">
            <Icon className="h-4 w-4" />
          </div>
          <div className="text-xs uppercase tracking-wider text-tbc-200/60">{label}</div>
        </div>
        <div className={`text-[11px] font-semibold ${deltaTone}`}>
          {delta === null ? '—' : `${delta >= 0 ? '+' : ''}${delta}%`}
          <span className="ml-1 text-tbc-200/40 font-normal">7d</span>
        </div>
      </div>
      <div className="mt-2 text-2xl font-bold text-tbc-100">{value}</div>
      {hint && <div className="text-[11px] text-tbc-200/50">{hint}</div>}
      <div className="mt-2 h-12">
        <Sparkline values={series} color={color} />
      </div>
    </div>
  );
}

export default function AnalyticsTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data: payload } = await api.get('/operator/analytics/30d');
      setData(payload);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Failed to load analytics');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const fmtUsd = useMemo(() => new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 2,
  }), []);

  if (loading) {
    return (
      <div className="grid place-items-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-tbc-400" />
      </div>
    );
  }
  if (!data) return null;

  const { series, totals, days } = data;
  return (
    <div data-testid="analytics-tab" className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-tbc-100">Last 30 days</h2>
          <p className="text-[11px] text-tbc-200/60">
            {days[0]} → {days[days.length - 1]} · live from payments + users + referrals + notifications
          </p>
        </div>
        <Button
          data-testid="analytics-refresh-btn"
          onClick={load}
          variant="outline"
          size="sm"
          className="border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950"
        >
          <RefreshCcw className="mr-1.5 h-3 w-3" />
          Refresh
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          icon={DollarSign}
          label="Revenue (MRR proxy)"
          value={fmtUsd.format(totals.revenue_30d || 0)}
          hint="Trailing 30-day paid revenue"
          series={series.revenue}
          color="#d4a028"
          testid="metric-revenue"
        />
        <MetricCard
          icon={UserPlus}
          label="New signups"
          value={(totals.signups_30d || 0).toLocaleString()}
          hint="Accounts created"
          series={series.signups}
          color="#38bdf8"
          testid="metric-signups"
        />
        <MetricCard
          icon={UsersIcon}
          label="Referral conversions"
          value={(totals.referrals_30d || 0).toLocaleString()}
          hint="Paid via a referrer's code"
          series={series.referrals}
          color="#a78bfa"
          testid="metric-referrals"
        />
        <MetricCard
          icon={Cake}
          label="Birthday credits issued"
          value={(totals.birthday_30d || 0).toLocaleString()}
          hint="Automated DOB rewards sent"
          series={series.birthday}
          color="#f472b6"
          testid="metric-birthday"
        />
      </div>

      <div
        data-testid="analytics-summary-band"
        className="rounded-xl border border-tbc-900/60 bg-gradient-to-br from-tbc-500/[0.05] via-ink-900/60 to-ink-900/60 p-4"
      >
        <div className="flex items-center gap-2 text-tbc-100">
          <TrendingUp className="h-4 w-4 text-tbc-300" />
          <span className="text-sm font-bold">Growth snapshot</span>
        </div>
        <div className="mt-2 grid gap-2 text-xs text-tbc-200/80 sm:grid-cols-2">
          <div>
            <span className="text-tbc-200/60">Avg signups / day:</span>{' '}
            <span className="font-semibold text-tbc-100">
              {((totals.signups_30d || 0) / 30).toFixed(1)}
            </span>
          </div>
          <div>
            <span className="text-tbc-200/60">Avg revenue / day:</span>{' '}
            <span className="font-semibold text-tbc-100">
              {fmtUsd.format((totals.revenue_30d || 0) / 30)}
            </span>
          </div>
          <div>
            <span className="text-tbc-200/60">Referral attribution rate:</span>{' '}
            <span className="font-semibold text-tbc-100">
              {totals.signups_30d > 0
                ? `${Math.round((totals.referrals_30d / totals.signups_30d) * 100)}%`
                : '—'}
            </span>
          </div>
          <div>
            <span className="text-tbc-200/60">Birthday rewards / day:</span>{' '}
            <span className="font-semibold text-tbc-100">
              {((totals.birthday_30d || 0) / 30).toFixed(2)}
            </span>
          </div>
        </div>
      </div>

      <AlertsCard />
    </div>
  );
}

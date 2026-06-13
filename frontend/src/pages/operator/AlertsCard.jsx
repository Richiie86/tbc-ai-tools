import React, { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Bell, Loader2, Save, Send, TestTubeDiagonal } from 'lucide-react';
import api from '../../lib/api';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Switch } from '../../components/ui/switch';

/**
 * Operator-tunable growth-alert thresholds + channels.
 *
 * Reads/writes /api/operator/alerts/thresholds. Webhook URLs come back
 * masked (e.g. "https://hooks.slack.com/services/T123…") — submitting
 * the masked value leaves the saved one untouched (the backend ignores
 * inputs ending in "…" or "••••"). To clear a channel, the operator
 * empties the field and clicks Save (we forward null to clear).
 */
export default function AlertsCard() {
  const [cfg, setCfg] = useState(null);
  const [draft, setDraft] = useState({
    enabled: false,
    signup_drop_pct: 50,
    revenue_stall_days: 7,
    email_recipients: '',
    slack_webhook: '',
    discord_webhook: '',
  });
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [testing, setTesting] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/operator/alerts/thresholds');
      setCfg(data);
      setDraft({
        enabled: !!data.enabled,
        signup_drop_pct: Number(data.signup_drop_pct) || 50,
        revenue_stall_days: Number(data.revenue_stall_days) || 7,
        email_recipients: data.email_recipients || '',
        slack_webhook: data.slack_webhook || '',
        discord_webhook: data.discord_webhook || '',
      });
    } catch { /* non-fatal */ }
  }, []);

  useEffect(() => { load(); }, [load]);

  // For webhook URLs: if the user emptied the field, send null to clear.
  // Otherwise, only send the new value if it's not the masked placeholder.
  const _webhookForSave = (current, original) => {
    if (!current) return null;                              // explicit clear
    if (current.endsWith('…') || current === '••••') return undefined; // unchanged
    if (current === original) return undefined;              // unchanged
    return current;
  };

  const save = async () => {
    setSaving(true);
    try {
      const payload = {
        enabled: draft.enabled,
        signup_drop_pct: draft.signup_drop_pct,
        revenue_stall_days: draft.revenue_stall_days,
        email_recipients: draft.email_recipients,
      };
      const slack = _webhookForSave(draft.slack_webhook, cfg?.slack_webhook);
      if (slack !== undefined) payload.slack_webhook = slack;
      const discord = _webhookForSave(draft.discord_webhook, cfg?.discord_webhook);
      if (discord !== undefined) payload.discord_webhook = discord;

      const { data } = await api.put('/operator/alerts/thresholds', payload);
      setCfg(data);
      // Keep the masked values in the form so the operator doesn't think they need to retype.
      setDraft((d) => ({
        ...d,
        slack_webhook: data.slack_webhook || '',
        discord_webhook: data.discord_webhook || '',
      }));
      toast.success('Alert thresholds saved');
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const runNow = async () => {
    setRunning(true);
    try {
      const { data } = await api.post('/operator/alerts/run-now');
      if (!data.enabled) toast.message('Alerts are currently OFF — toggle on to start firing.');
      else if (data.fired) toast.success(`Fired alert · ${data.reasons.length} reason(s)`);
      else toast.success('Evaluated — no thresholds tripped right now');
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Run failed');
    } finally {
      setRunning(false);
    }
  };

  const testChannels = async () => {
    setTesting(true);
    try {
      const { data } = await api.post('/operator/alerts/test');
      const d = data?.dispatch || {};
      const summary = [
        d.slack ? 'Slack ✓' : null,
        d.discord ? 'Discord ✓' : null,
        d.emails_sent ? `Email · ${d.emails_sent} sent` : null,
      ].filter(Boolean).join(' · ') || 'No channels configured';
      toast.success(`Test sent · ${summary}`);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Test failed');
    } finally {
      setTesting(false);
    }
  };

  if (!cfg) {
    return (
      <div
        data-testid="alerts-card-skeleton"
        className="rounded-xl border border-amber-500/30 bg-gradient-to-br from-amber-500/[0.06] via-ink-900/60 to-ink-900/60 p-4"
      >
        <div className="flex items-center gap-2">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-amber-500/20 text-amber-300">
            <Bell className="h-4 w-4" />
          </div>
          <div className="flex-1 space-y-2">
            <div className="h-3 w-28 animate-pulse rounded bg-tbc-900/60" />
            <div className="h-2 w-64 animate-pulse rounded bg-tbc-900/40" />
          </div>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="h-9 animate-pulse rounded bg-tbc-900/40" />
          <div className="h-9 animate-pulse rounded bg-tbc-900/40" />
        </div>
        <div className="mt-3 space-y-3">
          <div className="h-9 animate-pulse rounded bg-tbc-900/40" />
          <div className="h-9 animate-pulse rounded bg-tbc-900/40" />
          <div className="h-9 animate-pulse rounded bg-tbc-900/40" />
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="alerts-card"
      className="rounded-xl border border-amber-500/30 bg-gradient-to-br from-amber-500/[0.06] via-ink-900/60 to-ink-900/60 p-4"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-amber-500/20 text-amber-300">
            <Bell className="h-4 w-4" />
          </div>
          <div>
            <div className="text-sm font-bold text-tbc-100">Growth alerts</div>
            <div className="text-[11px] text-tbc-200/60">
              Get a Slack / Discord / email ping when signups drop sharply or revenue stalls.
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-tbc-200/60">Enabled</span>
          <Switch
            data-testid="alerts-enabled-toggle"
            checked={draft.enabled}
            onCheckedChange={(v) => setDraft((d) => ({ ...d, enabled: v }))}
          />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-[11px] text-tbc-200/60">
            Alert if signups drop by ≥ (%) over the last 7 days vs prior 7 days
          </span>
          <Input
            type="number" min={0} max={100}
            data-testid="alerts-signup-drop-input"
            value={draft.signup_drop_pct}
            onChange={(e) => setDraft((d) => ({ ...d, signup_drop_pct: Math.max(0, Math.min(100, Number(e.target.value) || 0)) }))}
            className="border-tbc-900/60 bg-ink-950 text-tbc-100"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] text-tbc-200/60">
            Alert after this many consecutive $0-revenue days
          </span>
          <Input
            type="number" min={1} max={30}
            data-testid="alerts-revenue-stall-input"
            value={draft.revenue_stall_days}
            onChange={(e) => setDraft((d) => ({ ...d, revenue_stall_days: Math.max(1, Math.min(30, Number(e.target.value) || 1)) }))}
            className="border-tbc-900/60 bg-ink-950 text-tbc-100"
          />
        </label>
      </div>

      <div className="mt-3 space-y-3">
        <label className="block">
          <span className="mb-1 block text-[11px] text-tbc-200/60">
            Email recipients (comma-separated)
          </span>
          <Input
            data-testid="alerts-email-input"
            value={draft.email_recipients}
            onChange={(e) => setDraft((d) => ({ ...d, email_recipients: e.target.value }))}
            placeholder="you@tbctools.org, ops@tbctools.org"
            className="border-tbc-900/60 bg-ink-950 text-tbc-100"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] text-tbc-200/60">
            Slack incoming-webhook URL
          </span>
          <Input
            data-testid="alerts-slack-input"
            value={draft.slack_webhook}
            onChange={(e) => setDraft((d) => ({ ...d, slack_webhook: e.target.value }))}
            placeholder="https://hooks.slack.com/services/T…/B…/…"
            className="border-tbc-900/60 bg-ink-950 font-mono text-[11px] text-tbc-100"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] text-tbc-200/60">
            Discord webhook URL
          </span>
          <Input
            data-testid="alerts-discord-input"
            value={draft.discord_webhook}
            onChange={(e) => setDraft((d) => ({ ...d, discord_webhook: e.target.value }))}
            placeholder="https://discord.com/api/webhooks/…/…"
            className="border-tbc-900/60 bg-ink-950 font-mono text-[11px] text-tbc-100"
          />
        </label>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          data-testid="alerts-save-btn"
          onClick={save}
          disabled={saving}
          className="bg-tbc-500 text-ink-950 hover:bg-tbc-400 font-semibold"
        >
          {saving ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : <Save className="mr-1.5 h-3 w-3" />}
          Save
        </Button>
        <Button
          data-testid="alerts-test-btn"
          onClick={testChannels}
          disabled={testing}
          variant="outline"
          title="Send a test message through every configured channel"
          className="border-sky-500/40 bg-ink-900 text-sky-300 hover:bg-sky-500/10"
        >
          {testing ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : <TestTubeDiagonal className="mr-1.5 h-3 w-3" />}
          Test channels
        </Button>
        <Button
          data-testid="alerts-run-now-btn"
          onClick={runNow}
          disabled={running}
          variant="outline"
          title="Evaluate thresholds right now (ignores the once-per-day idempotency)"
          className="border-amber-500/40 bg-ink-900 text-amber-300 hover:bg-amber-500/10"
        >
          {running ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : <Send className="mr-1.5 h-3 w-3" />}
          Evaluate now
        </Button>
        {cfg?.last_fired_day && (
          <span data-testid="alerts-last-fired" className="ml-auto text-[11px] text-tbc-200/60">
            Last fired: <span className="font-mono text-tbc-200">{cfg.last_fired_day}</span>
          </span>
        )}
      </div>
    </div>
  );
}

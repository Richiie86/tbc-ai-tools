import React, { useCallback, useEffect, useState } from 'react';
import { Cake, Loader2, Save, Send } from 'lucide-react';
import { toast } from 'sonner';
import api from '../../lib/api';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Switch } from '../../components/ui/switch';

/**
 * Operator-tunable Birthday Rewards programme. Persists to
 * /api/operator/birthday-rewards (GET/PUT) and exposes a "Run now"
 * button that calls /run-now to fire the daily pass manually — useful
 * for QA and for forcing the message out after editing the template.
 */
export default function BirthdayRewardsCard() {
  const [cfg, setCfg] = useState(null);
  const [draft, setDraft] = useState({
    enabled: true, credits: 200, discount_pct: 10, message: '',
  });
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/operator/birthday-rewards');
      setCfg(data);
      setDraft({
        enabled: !!data.enabled,
        credits: Number(data.credits) || 0,
        discount_pct: Number(data.discount_pct) || 0,
        message: data.message || '',
      });
    } catch { /* non-fatal */ }
  }, []);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    setSaving(true);
    try {
      const { data } = await api.put('/operator/birthday-rewards', draft);
      setCfg(data);
      toast.success('Birthday rewards saved');
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const runNow = async () => {
    setRunning(true);
    try {
      const { data } = await api.post('/operator/birthday-rewards/run-now');
      if (data.enabled === false) toast.message('Programme is currently disabled — toggle on to send.');
      else toast.success(`Birthday pass complete · ${data.rewarded} rewarded · ${data.skipped_already_done} already done`);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Run failed');
    } finally {
      setRunning(false);
    }
  };

  if (!cfg) return null;

  return (
    <div
      data-testid="birthday-rewards-card"
      className="rounded-xl border border-pink-500/30 bg-gradient-to-br from-pink-500/[0.06] via-ink-900/60 to-ink-900/60 p-4"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-pink-500/20 text-pink-300">
            <Cake className="h-4 w-4" />
          </div>
          <div>
            <div className="text-sm font-bold text-tbc-100">Birthday rewards</div>
            <div className="text-[11px] text-tbc-200/60">
              Auto-credit on a user&apos;s birthday (DOB month/day match, once per year).
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-tbc-200/60">Enabled</span>
          <Switch
            data-testid="birthday-enabled-toggle"
            checked={draft.enabled}
            onCheckedChange={(v) => setDraft((d) => ({ ...d, enabled: v }))}
          />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-[11px] text-tbc-200/60">Credits granted</span>
          <Input
            type="number"
            min={0}
            data-testid="birthday-credits-input"
            value={draft.credits}
            onChange={(e) => setDraft((d) => ({ ...d, credits: Math.max(0, Number(e.target.value) || 0) }))}
            className="border-tbc-900/60 bg-ink-950 text-tbc-100"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] text-tbc-200/60">Plan upgrade discount (%)</span>
          <Input
            type="number"
            min={0}
            max={100}
            data-testid="birthday-discount-input"
            value={draft.discount_pct}
            onChange={(e) => setDraft((d) => ({ ...d, discount_pct: Math.max(0, Math.min(100, Number(e.target.value) || 0)) }))}
            className="border-tbc-900/60 bg-ink-950 text-tbc-100"
          />
        </label>
      </div>

      <label className="mt-3 block">
        <span className="mb-1 block text-[11px] text-tbc-200/60">
          Message template — placeholders: <code className="text-tbc-300">{'{credits}'}</code>{' '}
          <code className="text-tbc-300">{'{discount_pct}'}</code>{' '}
          <code className="text-tbc-300">{'{name}'}</code>
        </span>
        <textarea
          data-testid="birthday-message-input"
          rows={3}
          value={draft.message}
          onChange={(e) => setDraft((d) => ({ ...d, message: e.target.value }))}
          className="w-full resize-y rounded-md border border-tbc-900/60 bg-ink-950 px-3 py-2 text-sm text-tbc-100 focus:border-tbc-500/60 focus:outline-none"
          placeholder="Happy birthday from the team! …"
        />
      </label>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          data-testid="birthday-save-btn"
          onClick={save}
          disabled={saving}
          className="bg-tbc-500 text-ink-950 hover:bg-tbc-400 font-semibold"
        >
          {saving ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : <Save className="mr-1.5 h-3 w-3" />}
          Save
        </Button>
        <Button
          data-testid="birthday-run-now-btn"
          onClick={runNow}
          disabled={running}
          variant="outline"
          title="Force a birthday pass right now — handy for QA"
          className="border-pink-500/40 bg-ink-900 text-pink-300 hover:bg-pink-500/10"
        >
          {running ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : <Send className="mr-1.5 h-3 w-3" />}
          Run pass now
        </Button>
      </div>
    </div>
  );
}

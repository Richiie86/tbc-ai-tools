import React, { useCallback, useEffect, useState } from 'react';
import api from '../../lib/api';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Switch } from '../../components/ui/switch';
import { toast } from 'sonner';
import { Webhook, Loader2, Save, Send, Trash2 } from 'lucide-react';

/**
 * Operator-configurable Slack/Discord/generic-JSON webhook bridge.
 *
 * Backend lives in `webhook_ext.py`. We post `{text, content}` so both
 * Slack incoming-webhooks and Discord `/api/webhooks/...` URLs work
 * with the same payload — operator doesn't need to pick a provider.
 *
 * URL is write-only — server returns only the hostname so the operator
 * can confirm which workspace without leaking the token in screenshots.
 */
export default function WebhookSettingsCard() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [host, setHost] = useState(null);
  const [urlInput, setUrlInput] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/operator/webhook');
      setConfigured(!!data.configured);
      setEnabled(!!data.enabled);
      setHost(data.host || null);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Failed to load webhook config');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const saveUrl = async () => {
    const url = urlInput.trim();
    if (!url) {
      toast.error('Paste a webhook URL first');
      return;
    }
    setSaving(true);
    try {
      const { data } = await api.put('/operator/webhook', { url });
      setConfigured(!!data.configured);
      setEnabled(!!data.enabled);
      setHost(data.host || null);
      setUrlInput('');
      toast.success(`Webhook saved · ${data.host || 'ready'}`);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async (next) => {
    setEnabled(next);
    try {
      await api.put('/operator/webhook', { enabled: next });
      toast.success(next ? 'Webhook ON · alerts will fire' : 'Webhook OFF · alerts paused');
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not toggle');
      setEnabled(!next);  // rollback
    }
  };

  const sendTest = async () => {
    setTesting(true);
    try {
      await api.post('/operator/webhook/test');
      toast.success('Test ping sent · check Slack/Discord');
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Send failed — check URL + connectivity');
    } finally {
      setTesting(false);
    }
  };

  const clearUrl = async () => {
    if (!window.confirm('Remove the saved webhook URL? Alerts will stop firing until you paste a new one.')) return;
    setSaving(true);
    try {
      // Empty string clears it server-side.
      await api.put('/operator/webhook', { url: '' });
      setConfigured(false);
      setHost(null);
      toast.success('Webhook URL cleared');
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Clear failed');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="grid place-items-center py-8" data-testid="webhook-card-loading">
        <Loader2 className="h-4 w-4 animate-spin text-tbc-400" />
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="webhook-settings-card">
      <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/[0.04] p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h4 className="flex items-center gap-2 text-sm font-bold text-tbc-100">
              <Webhook className="h-4 w-4 text-emerald-300" />
              Slack / Discord alert webhook
            </h4>
            <p className="mt-0.5 text-[11px] text-tbc-200/60">
              One URL, both providers. Paste your Slack <em>Incoming Webhook</em> or
              Discord <em>/api/webhooks/&hellip;</em> URL — we fire alerts for critical
              errors, AI Test Bench drift, production promotes, and lockdown attempts.
            </p>
          </div>
          <Switch
            checked={enabled}
            onCheckedChange={toggleEnabled}
            disabled={!configured}
            data-testid="webhook-enabled-toggle"
          />
        </div>

        {configured && (
          <div
            className="mt-3 rounded border border-emerald-500/30 bg-emerald-500/[0.06] px-2.5 py-1.5 text-[11px] text-emerald-200"
            data-testid="webhook-current-host"
          >
            Current target · <span className="font-mono">{host || '—'}</span>
            <button
              type="button"
              onClick={clearUrl}
              className="ml-3 inline-flex items-center gap-1 text-emerald-300/80 hover:text-red-300"
              data-testid="webhook-clear"
            >
              <Trash2 className="h-3 w-3" /> remove
            </button>
          </div>
        )}

        <div className="mt-3">
          <label className="text-[10px] uppercase tracking-wider text-tbc-300">
            {configured ? 'Replace URL' : 'Webhook URL'}
          </label>
          <div className="mt-1 flex gap-2">
            <Input
              type="url"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              placeholder="https://hooks.slack.com/services/... or https://discord.com/api/webhooks/..."
              className="flex-1 border-tbc-900/60 bg-ink-950 text-tbc-100 text-sm font-mono"
              data-testid="webhook-url-input"
            />
            <Button
              size="sm"
              onClick={saveUrl}
              disabled={saving || !urlInput.trim()}
              data-testid="webhook-save"
              className="h-9 bg-tbc-500 text-ink-950 hover:bg-tbc-400 font-bold"
            >
              {saving
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : <><Save className="mr-1 h-3.5 w-3.5" />Save</>}
            </Button>
          </div>
          <p className="mt-1 text-[10px] text-tbc-200/50">
            Must be <code>https://</code>. URL is stored server-side and never echoed back —
            only the hostname is shown above.
          </p>
        </div>

        <div className="mt-3 flex items-center justify-between gap-2 border-t border-emerald-500/20 pt-3">
          <div className="text-[10px] text-tbc-200/50">
            Fires on: critical errors · AI drift · production promotes · lockdown attempts
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={sendTest}
            disabled={!configured || !enabled || testing}
            data-testid="webhook-send-test"
            className="h-7 border-emerald-500/40 bg-emerald-500/[0.06] text-emerald-200 hover:bg-emerald-500/[0.12]"
          >
            {testing
              ? <Loader2 className="h-3 w-3 animate-spin" />
              : <><Send className="mr-1 h-3 w-3" />Send test ping</>}
          </Button>
        </div>
      </div>
    </div>
  );
}

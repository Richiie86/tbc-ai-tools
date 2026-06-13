import React, { useCallback, useEffect, useState } from 'react';
import api from '../../lib/api';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Textarea } from '../../components/ui/textarea';
import { Switch } from '../../components/ui/switch';
import { toast } from 'sonner';
import { Loader2, Megaphone, Save, Eye, EyeOff } from 'lucide-react';

const EMPTY_CFG = {
  enabled: false,
  messages: [],
  speed_seconds: 30,
  starts_at: '',
  ends_at: '',
};

// Stringify messages for the operator textarea. Each line is either a plain
// message or "Message text|/relative-or-https-href". We round-trip via this
// shape so the operator can hand-edit without a JSON editor.
const messagesToText = (msgs) =>
  (msgs || [])
    .map((m) => (m.href ? `${m.text}|${m.href}` : m.text))
    .join('\n');

const textToMessages = (text) =>
  (text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [t, href] = line.split('|').map((s) => s.trim());
      return href ? { text: t, href } : { text: t };
    });

export default function MarketingTab() {
  const [cfg, setCfg] = useState(EMPTY_CFG);
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/marketing/banner');
      const fresh = { ...EMPTY_CFG, ...data };
      setCfg(fresh);
      setText(messagesToText(fresh.messages));
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Failed to load banner');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    setSaving(true);
    try {
      const payload = {
        enabled: !!cfg.enabled,
        messages: textToMessages(text),
        speed_seconds: Number(cfg.speed_seconds) || 30,
        starts_at: cfg.starts_at || null,
        ends_at: cfg.ends_at || null,
      };
      const { data } = await api.put('/operator/marketing/banner', payload);
      toast.success(`Saved — ${data.messages_count} message(s) live`);
      load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="grid place-items-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-tbc-400" />
      </div>
    );
  }

  return (
    <div className="space-y-5" data-testid="marketing-tab">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-base font-bold text-tbc-100">
            <Megaphone className="h-4 w-4 text-tbc-300" /> Scrolling marketing banner
          </h3>
          <p className="mt-1 text-sm text-tbc-200/60">
            Right-to-left ticker shown across every public page. Use one message per line.
            Append <code className="rounded bg-ink-950 px-1.5 py-0.5 text-tbc-100">|/pricing</code> (or a full URL) to make a line clickable.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-tbc-200/60">
            {cfg.enabled
              ? <><Eye className="h-3 w-3 text-emerald-300" /> Live</>
              : <><EyeOff className="h-3 w-3 text-tbc-200/40" /> Hidden</>}
          </span>
          <Switch
            checked={!!cfg.enabled}
            onCheckedChange={(v) => setCfg({ ...cfg, enabled: v })}
            data-testid="marketing-enabled-switch"
          />
        </div>
      </div>

      <div>
        <label className="text-xs font-semibold uppercase tracking-wider text-tbc-200/60">
          Messages (one per line)
        </label>
        <Textarea
          rows={6}
          data-testid="marketing-messages-input"
          className="mt-1.5 bg-ink-950 border-tbc-900/60 text-tbc-100"
          placeholder={'New: 20% off PRO this week!|/pricing\nCustom AI agents now in beta'}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <div>
          <label className="text-xs font-semibold uppercase tracking-wider text-tbc-200/60">
            Scroll speed (seconds for one loop)
          </label>
          <Input
            type="number"
            min="5"
            max="300"
            data-testid="marketing-speed-input"
            className="mt-1.5 bg-ink-950 border-tbc-900/60 text-tbc-100"
            value={cfg.speed_seconds}
            onChange={(e) => setCfg({ ...cfg, speed_seconds: e.target.value })}
          />
        </div>
        <div>
          <label className="text-xs font-semibold uppercase tracking-wider text-tbc-200/60">
            Starts at (optional)
          </label>
          <Input
            type="datetime-local"
            data-testid="marketing-starts-input"
            className="mt-1.5 bg-ink-950 border-tbc-900/60 text-tbc-100"
            value={cfg.starts_at || ''}
            onChange={(e) => setCfg({ ...cfg, starts_at: e.target.value })}
          />
        </div>
        <div>
          <label className="text-xs font-semibold uppercase tracking-wider text-tbc-200/60">
            Ends at (optional)
          </label>
          <Input
            type="datetime-local"
            data-testid="marketing-ends-input"
            className="mt-1.5 bg-ink-950 border-tbc-900/60 text-tbc-100"
            value={cfg.ends_at || ''}
            onChange={(e) => setCfg({ ...cfg, ends_at: e.target.value })}
          />
        </div>
      </div>

      <div className="flex items-center justify-end">
        <Button
          onClick={save}
          disabled={saving}
          data-testid="marketing-save-btn"
          className="bg-tbc-500 text-ink-950 hover:bg-tbc-400 font-semibold"
        >
          {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-1.5 h-4 w-4" />}
          Save banner
        </Button>
      </div>
    </div>
  );
}

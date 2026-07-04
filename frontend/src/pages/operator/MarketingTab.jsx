import React, { useCallback, useEffect, useState } from 'react';
import api from '../../lib/api';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Textarea } from '../../components/ui/textarea';
import { Switch } from '../../components/ui/switch';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../../components/ui/tabs';
import { toast } from 'sonner';
import { Loader2, Megaphone, Save, Eye, EyeOff, Globe, UserPlus, BadgeCheck } from 'lucide-react';
import SocialShareSection from './SocialShareSection';

const EMPTY_CFG = {
  enabled: false,
  messages: [],
  speed_seconds: 30,
  starts_at: '',
  ends_at: '',
};

const SCOPES = [
  { id: 'landing', label: 'Landing page', icon: Globe, hint: 'Shown on /, /pricing, /about and every other public page.' },
  { id: 'dashboard_new', label: 'Dashboard · new logins', icon: UserPlus, hint: 'Shown to free / not-yet-paid users when they reach the dashboard.' },
  { id: 'dashboard_subscription', label: 'Dashboard · subscribers', icon: BadgeCheck, hint: 'Shown only to users on Starter / Pro / Enterprise plans inside the dashboard.' },
];

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
  const [active, setActive] = useState('landing');
  return (
    <div className="space-y-4" data-testid="marketing-tab">
      <div>
        <h3 className="flex items-center gap-2 text-base font-bold text-tbc-100">
          <Megaphone className="h-4 w-4 text-tbc-300" /> Scrolling marketing banners
        </h3>
        <p className="mt-1 text-sm text-tbc-200/60">
          Three independent banners, each on its own schedule and audience. Use one line per message;
          append <code className="rounded bg-ink-950 px-1.5 py-0.5 text-tbc-100">|/pricing</code> (or a full URL) to make it clickable.
        </p>
      </div>
      <Tabs value={active} onValueChange={setActive}>
        <TabsList className="flex flex-wrap h-auto bg-ink-900 border border-tbc-900/60">
          {SCOPES.map((s) => (
            <TabsTrigger
              key={s.id}
              value={s.id}
              data-testid={`marketing-scope-${s.id}`}
              className="data-[state=active]:bg-tbc-500 data-[state=active]:text-ink-950"
            >
              <s.icon className="mr-1.5 h-3.5 w-3.5" />
              {s.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {SCOPES.map((s) => (
          <TabsContent key={s.id} value={s.id} className="mt-4">
            <BannerEditor scope={s.id} hint={s.hint} />
          </TabsContent>
        ))}
      </Tabs>

      <div className="border-t border-tbc-900/60 pt-6">
        <SocialShareSection />
      </div>
    </div>
  );
}

function BannerEditor({ scope, hint }) {
  const [cfg, setCfg] = useState(EMPTY_CFG);
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get(`/marketing/banner?scope=${scope}`);
      const fresh = { ...EMPTY_CFG, ...data };
      setCfg(fresh);
      setText(messagesToText(fresh.messages));
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Failed to load banner');
    } finally {
      setLoading(false);
    }
  }, [scope]);

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
      const { data } = await api.put(`/operator/marketing/banner?scope=${scope}`, payload);
      toast.success(`${scope} banner saved — ${data.messages_count} message(s) live`);
      load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="grid place-items-center py-10">
        <Loader2 className="h-5 w-5 animate-spin text-tbc-400" />
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid={`marketing-editor-${scope}`}>
      <div className="flex items-start justify-between gap-3 rounded-lg border border-tbc-900/60 bg-ink-950/40 p-3">
        <p className="text-xs text-tbc-200/60">{hint}</p>
        <div className="flex shrink-0 items-center gap-2">
          <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-tbc-200/60">
            {cfg.enabled
              ? <><Eye className="h-3 w-3 text-emerald-300" /> Live</>
              : <><EyeOff className="h-3 w-3 text-tbc-200/40" /> Hidden</>}
          </span>
          <Switch
            checked={!!cfg.enabled}
            onCheckedChange={(v) => setCfg({ ...cfg, enabled: v })}
            data-testid={`marketing-enabled-switch-${scope}`}
          />
        </div>
      </div>

      <div>
        <label className="text-xs font-semibold uppercase tracking-wider text-tbc-200/60">
          Messages (one per line)
        </label>
        <Textarea
          rows={5}
          data-testid={`marketing-messages-input-${scope}`}
          className="mt-1.5 bg-ink-950 border-tbc-900/60 text-tbc-100"
          placeholder={'New: 20% off PRO this week!|/pricing\nCustom AI agents now in beta'}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Scroll speed (seconds)">
          <Input
            type="number"
            min="5"
            max="300"
            data-testid={`marketing-speed-input-${scope}`}
            className="bg-ink-950 border-tbc-900/60 text-tbc-100"
            value={cfg.speed_seconds}
            onChange={(e) => setCfg({ ...cfg, speed_seconds: e.target.value })}
          />
        </Field>
        <Field label="Starts at (date + time)">
          <Input
            type="datetime-local"
            data-testid={`marketing-starts-input-${scope}`}
            className="bg-ink-950 border-tbc-900/60 text-tbc-100"
            value={cfg.starts_at || ''}
            onChange={(e) => setCfg({ ...cfg, starts_at: e.target.value })}
          />
        </Field>
        <Field label="Ends at (date + time)">
          <Input
            type="datetime-local"
            data-testid={`marketing-ends-input-${scope}`}
            className="bg-ink-950 border-tbc-900/60 text-tbc-100"
            value={cfg.ends_at || ''}
            onChange={(e) => setCfg({ ...cfg, ends_at: e.target.value })}
          />
        </Field>
      </div>

      <div className="flex items-center justify-end">
        <Button
          onClick={save}
          disabled={saving}
          data-testid={`marketing-save-btn-${scope}`}
          className="bg-tbc-500 text-ink-950 hover:bg-tbc-400 font-semibold"
        >
          {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-1.5 h-4 w-4" />}
          Save {scope.replace(/_/g, ' ')} banner
        </Button>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <label className="text-[10px] font-semibold uppercase tracking-wider text-tbc-200/60">{label}</label>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

import React, { useEffect, useState } from 'react';
import api from '../../lib/api';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Switch } from '../../components/ui/switch';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '../../components/ui/select';
import { toast } from 'sonner';
import { Loader2, KeyRound, Save, Lock, Eye, EyeOff, Plug, Mail, Sparkles } from 'lucide-react';

export default function SettingsTab() {
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    stripe_secret_key: '',
    nowpayments_api_key: '',
    nowpayments_ipn_secret: '',
    paypal_client_id: '',
    paypal_client_secret: '',
    emergent_llm_key: '',
    resend_api_key: '',
    sender_email: '',
  });
  const [reveal, setReveal] = useState({});

  const load = async () => {
    setLoading(true);
    try { const { data } = await api.get('/operator/settings'); setSettings(data); }
    catch { toast.error('Failed to load settings'); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const save = async (payload) => {
    setSaving(true);
    try {
      const { data } = await api.put('/operator/settings', payload);
      toast.success(`Saved (${(data.updated_keys || []).length} field${(data.updated_keys||[]).length===1?'':'s'})`);
      setForm((f) => ({ ...f, ...Object.fromEntries(Object.keys(payload).filter((k)=>typeof payload[k]==='string').map((k)=>[k,''])) }));
      load();
    } catch (e) { toast.error(e?.response?.data?.detail || 'Save failed'); }
    finally { setSaving(false); }
  };
  const clearKey = async (key) => {
    if (!window.confirm('Clear ' + key + '?')) return;
    try { await api.post(`/operator/settings/clear?key=${encodeURIComponent(key)}`); toast.success('Cleared'); load(); }
    catch { toast.error('Could not clear'); }
  };
  const [testing, setTesting] = useState({});
  const testConnection = async (provider) => {
    setTesting((t) => ({ ...t, [provider]: true }));
    try {
      const { data } = await api.post(`/operator/test-connection/${provider}`);
      if (data.ok) toast.success(data.message, { duration: 6000 });
      else toast.error(data.message, { duration: 8000 });
    } catch (e) {
      toast.error(e?.response?.data?.detail || `Could not test ${provider}`);
    } finally {
      setTesting((t) => ({ ...t, [provider]: false }));
    }
  };
  const toggleReveal = (k) => setReveal((r) => ({ ...r, [k]: !r[k] }));

  if (loading || !settings) return <div className="grid place-items-center py-12"><Loader2 className="h-6 w-6 animate-spin text-tbc-400" /></div>;

  return (
    <div className="grid gap-5">
      <Section icon={KeyRound} title="Stripe (cards, Apple Pay, Google Pay)">
        <KeyRow
          label="Stripe secret key"
          fieldKey="stripe_secret_key"
          isSet={settings.stripe_secret_key_set}
          masked={settings.stripe_secret_key_masked}
          value={form.stripe_secret_key}
          reveal={reveal.stripe_secret_key}
          onReveal={() => toggleReveal('stripe_secret_key')}
          onChange={(v) => setForm({ ...form, stripe_secret_key: v })}
          onSave={() => save({ stripe_secret_key: form.stripe_secret_key })}
          onClear={() => clearKey('stripe_secret_key')}
          placeholder="sk_live_... or sk_test_..."
        />
        <div className="flex items-center gap-3">
          <span className="text-xs text-tbc-200/60 w-24">Mode</span>
          <Select value={settings.stripe_mode} onValueChange={(v) => save({ stripe_mode: v })}>
            <SelectTrigger className="h-9 w-40 bg-ink-950 border-tbc-900/60 text-tbc-100"><SelectValue /></SelectTrigger>
            <SelectContent className="bg-ink-900 border-tbc-900/60 text-tbc-100">
              <SelectItem value="test">Test</SelectItem>
              <SelectItem value="live">Live</SelectItem>
            </SelectContent>
          </Select>
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="op-test-stripe"
            disabled={testing.stripe}
            onClick={() => testConnection('stripe')}
            className="ml-auto border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-tbc-500/10"
          >
            {testing.stripe ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Plug className="mr-1.5 h-3.5 w-3.5" />}
            Test connection
          </Button>
        </div>
      </Section>

      <Section icon={KeyRound} title="NOWPayments (crypto auto)">
        <KeyRow
          label="API key"
          fieldKey="nowpayments_api_key"
          isSet={settings.nowpayments_api_key_set}
          masked={settings.nowpayments_api_key_masked}
          value={form.nowpayments_api_key}
          reveal={reveal.nowpayments_api_key}
          onReveal={() => toggleReveal('nowpayments_api_key')}
          onChange={(v) => setForm({ ...form, nowpayments_api_key: v })}
          onSave={() => save({ nowpayments_api_key: form.nowpayments_api_key })}
          onClear={() => clearKey('nowpayments_api_key')}
        />
        <KeyRow
          label="IPN secret"
          fieldKey="nowpayments_ipn_secret"
          isSet={settings.nowpayments_ipn_secret_set}
          masked={null}
          value={form.nowpayments_ipn_secret}
          reveal={reveal.nowpayments_ipn_secret}
          onReveal={() => toggleReveal('nowpayments_ipn_secret')}
          onChange={(v) => setForm({ ...form, nowpayments_ipn_secret: v })}
          onSave={() => save({ nowpayments_ipn_secret: form.nowpayments_ipn_secret })}
          onClear={() => clearKey('nowpayments_ipn_secret')}
        />
      </Section>

      <Section icon={KeyRound} title="PayPal">
        <KeyRow
          label="Client ID"
          fieldKey="paypal_client_id"
          isSet={settings.paypal_client_id_set}
          masked={settings.paypal_client_id_masked}
          value={form.paypal_client_id}
          reveal={reveal.paypal_client_id}
          onReveal={() => toggleReveal('paypal_client_id')}
          onChange={(v) => setForm({ ...form, paypal_client_id: v })}
          onSave={() => save({ paypal_client_id: form.paypal_client_id })}
          onClear={() => clearKey('paypal_client_id')}
        />
        <KeyRow
          label="Client secret"
          fieldKey="paypal_client_secret"
          isSet={settings.paypal_client_secret_set}
          masked={null}
          value={form.paypal_client_secret}
          reveal={reveal.paypal_client_secret}
          onReveal={() => toggleReveal('paypal_client_secret')}
          onChange={(v) => setForm({ ...form, paypal_client_secret: v })}
          onSave={() => save({ paypal_client_secret: form.paypal_client_secret })}
          onClear={() => clearKey('paypal_client_secret')}
        />
        <div className="flex items-center gap-3">
          <span className="text-xs text-tbc-200/60 w-24">Mode</span>
          <Select value={settings.paypal_mode} onValueChange={(v) => save({ paypal_mode: v })}>
            <SelectTrigger className="h-9 w-40 bg-ink-950 border-tbc-900/60 text-tbc-100"><SelectValue /></SelectTrigger>
            <SelectContent className="bg-ink-900 border-tbc-900/60 text-tbc-100">
              <SelectItem value="sandbox">Sandbox</SelectItem>
              <SelectItem value="live">Live</SelectItem>
            </SelectContent>
          </Select>
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="op-test-paypal"
            disabled={testing.paypal}
            onClick={() => testConnection('paypal')}
            className="ml-auto border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-tbc-500/10"
          >
            {testing.paypal ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Plug className="mr-1.5 h-3.5 w-3.5" />}
            Test connection
          </Button>
        </div>
      </Section>

      <Section icon={Mail} title="Resend (transactional emails)">
        <div className="rounded-md border border-tbc-900/40 bg-ink-950/60 p-3 text-xs text-tbc-200/70">
          API key + sender are configured via backend env vars (<code className="text-tbc-300">RESEND_API_KEY</code>, <code className="text-tbc-300">SENDER_EMAIL</code>). The button below verifies the key works and that the sender domain is verified at Resend.
        </div>
        <div className="flex items-center gap-3">
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="op-test-resend"
            disabled={testing.resend}
            onClick={() => testConnection('resend')}
            className="border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-tbc-500/10"
          >
            {testing.resend ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Plug className="mr-1.5 h-3.5 w-3.5" />}
            Test connection
          </Button>
          <a
            href="https://resend.com/domains"
            target="_blank"
            rel="noreferrer"
            className="text-xs text-tbc-300 underline-offset-2 hover:underline"
          >
            Verify a domain →
          </a>
        </div>
      </Section>

      <Section icon={Lock} title="Enabled payment methods">
        <div className="grid gap-2 md:grid-cols-2">
          {[
            { k: 'enable_card', label: 'Card / Apple Pay / Google Pay' },
            { k: 'enable_paypal', label: 'PayPal' },
            { k: 'enable_crypto_auto', label: 'Crypto (auto via NOWPayments)' },
            { k: 'enable_crypto_manual', label: 'Crypto (manual wallet)' },
            { k: 'enable_bank', label: 'Bank transfer' },
          ].map((o) => (
            <div key={o.k} className="flex items-center justify-between rounded-lg border border-tbc-900/60 bg-ink-950 px-3 py-2">
              <span className="text-sm text-tbc-100">{o.label}</span>
              <Switch checked={!!settings[o.k]} onCheckedChange={(v) => save({ [o.k]: v })} />
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}

function Section({ icon: Icon, title, children }) {
  return (
    <div className="rounded-xl border border-tbc-900/60 bg-ink-900/40 p-5">
      <div className="mb-4 flex items-center gap-2">
        <Icon className="h-4 w-4 text-tbc-300" />
        <h3 className="text-sm font-bold uppercase tracking-wider text-tbc-100">{title}</h3>
      </div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function KeyRow({ label, fieldKey, isSet, masked, value, reveal, onReveal, onChange, onSave, onClear, placeholder }) {
  return (
    <div className="flex items-end gap-2">
      <div className="flex-1">
        <div className="flex items-center justify-between">
          <label className="text-xs font-semibold uppercase tracking-wider text-tbc-200/60">{label}</label>
          {isSet && (
            <span className="text-[11px] text-tbc-300">
              Set • {masked || '••••'}
            </span>
          )}
        </div>
        <div className="relative mt-1.5">
          <Input
            className="bg-ink-950 border-tbc-900/60 text-tbc-100 pr-10"
            type={reveal ? 'text' : 'password'}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder || (isSet ? 'Replace existing key…' : 'Paste key here')}
          />
          <button type="button" onClick={onReveal} className="absolute right-2 top-1/2 -translate-y-1/2 text-tbc-200/60 hover:text-tbc-100">
            {reveal ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
      </div>
      <Button disabled={!value} onClick={onSave} className="bg-tbc-500 text-ink-950 hover:bg-tbc-400 font-semibold"><Save className="mr-1.5 h-3.5 w-3.5" /> Save</Button>
      {isSet && (
        <Button variant="outline" onClick={onClear} className="border-rose-900/60 bg-ink-900 text-rose-300 hover:bg-rose-500/10">Clear</Button>
      )}
    </div>
  );
}
 checked={!!settings[o.k]} onCheckedChange={(v) => save({ [o.k]: v })} />
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}

function Section({ icon: Icon, title, children }) {
  return (
    <div className="rounded-xl border border-tbc-900/60 bg-ink-900/40 p-5">
      <div className="mb-4 flex items-center gap-2">
        <Icon className="h-4 w-4 text-tbc-300" />
        <h3 className="text-sm font-bold uppercase tracking-wider text-tbc-100">{title}</h3>
      </div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function KeyRow({ label, fieldKey, isSet, masked, value, reveal, onReveal, onChange, onSave, onClear, placeholder }) {
  return (
    <div className="flex items-end gap-2">
      <div className="flex-1">
        <div className="flex items-center justify-between">
          <label className="text-xs font-semibold uppercase tracking-wider text-tbc-200/60">{label}</label>
          {isSet && (
            <span className="text-[11px] text-tbc-300">
              Set • {masked || '••••'}
            </span>
          )}
        </div>
        <div className="relative mt-1.5">
          <Input
            className="bg-ink-950 border-tbc-900/60 text-tbc-100 pr-10"
            type={reveal ? 'text' : 'password'}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder || (isSet ? 'Replace existing key…' : 'Paste key here')}
          />
          <button type="button" onClick={onReveal} className="absolute right-2 top-1/2 -translate-y-1/2 text-tbc-200/60 hover:text-tbc-100">
            {reveal ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
      </div>
      <Button disabled={!value} onClick={onSave} className="bg-tbc-500 text-ink-950 hover:bg-tbc-400 font-semibold"><Save className="mr-1.5 h-3.5 w-3.5" /> Save</Button>
      {isSet && (
        <Button variant="outline" onClick={onClear} className="border-rose-900/60 bg-ink-900 text-rose-300 hover:bg-rose-500/10">Clear</Button>
      )}
    </div>
  );
}

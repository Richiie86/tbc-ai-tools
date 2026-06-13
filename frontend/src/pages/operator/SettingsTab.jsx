import React, { useEffect, useState, useCallback } from 'react';
import api from '../../lib/api';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Switch } from '../../components/ui/switch';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '../../components/ui/select';
import { toast } from 'sonner';
import { Loader2, KeyRound, Save, Lock, Eye, EyeOff, Plug, Mail, Sparkles, UserPlus, Rocket } from 'lucide-react';
import SecretsCard from './SecretsCard';
import BirthdayRewardsCard from './BirthdayRewardsCard';

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
    vercel_token: '',
    vercel_team_id: '',
    ai_api_key: '',
    deploy_webhook_url: '',
    deploy_webhook_secret: '',
    self_repo: '',
    self_git_ref: '',
    self_vercel_project_id: '',
    github_token: '',
  });
  const [reveal, setReveal] = useState({});

  const load = useCallback(async () => {
    setLoading(true);
    try { const { data } = await api.get('/operator/settings'); setSettings(data); }
    catch { toast.error('Failed to load settings'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

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
      <Section icon={UserPlus} title="New user defaults">
        <div className="rounded-md border border-tbc-900/40 bg-ink-950/60 p-3 text-xs text-tbc-200/70">
          Every newly-registered user is automatically placed on the plan you choose here. No manual action needed.
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-tbc-200/60 w-32">Default plan</span>
          <Select
            value={settings.default_plan_id || 'starter'}
            onValueChange={(v) => save({ default_plan_id: v })}
          >
            <SelectTrigger className="h-9 w-56 bg-ink-950 border-tbc-900/60 text-tbc-100" data-testid="settings-default-plan">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-ink-900 border-tbc-900/60 text-tbc-100">
              <SelectItem value="free">Free (50 credits)</SelectItem>
              <SelectItem value="starter">Starter / Beginner</SelectItem>
              <SelectItem value="pro">Pro</SelectItem>
              <SelectItem value="enterprise">Enterprise</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </Section>

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
          API key + sender can also be set via backend env vars (<code className="text-tbc-300">RESEND_API_KEY</code>, <code className="text-tbc-300">SENDER_EMAIL</code>). Anything set here in the database overrides env values.
        </div>
        <KeyRow
          label="Resend API key"
          fieldKey="resend_api_key"
          isSet={settings.resend_api_key_set}
          masked={settings.resend_api_key_masked}
          value={form.resend_api_key}
          reveal={reveal.resend_api_key}
          onReveal={() => toggleReveal('resend_api_key')}
          onChange={(v) => setForm({ ...form, resend_api_key: v })}
          onSave={() => save({ resend_api_key: form.resend_api_key })}
          onClear={() => clearKey('resend_api_key')}
        />
        <div className="flex items-center gap-3">
          <span className="text-xs text-tbc-200/60 w-24">Sender email</span>
          <Input
            data-testid="settings-sender-email"
            value={form.sender_email}
            onChange={(e) => setForm({ ...form, sender_email: e.target.value })}
            placeholder={settings.sender_email || 'noreply@tbctools.org'}
            className="h-9 max-w-md bg-ink-950 border-tbc-900/60 text-tbc-100"
          />
          <Button size="sm" onClick={() => save({ sender_email: form.sender_email })} className="bg-tbc-500 text-ink-950 hover:bg-tbc-400 font-semibold">Save</Button>
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

      <Section icon={Sparkles} title="Emergent LLM key (AI chat)">
        <div className="rounded-md border border-tbc-900/40 bg-ink-950/60 p-3 text-xs text-tbc-200/70">
          Powers GPT, Claude and Gemini in the Builder. Anything set here overrides the env var <code className="text-tbc-300">EMERGENT_LLM_KEY</code>. Rotate at <a href="https://app.emergent.sh" target="_blank" rel="noreferrer" className="text-tbc-300 hover:underline">Emergent → Profile → Universal Key</a>.
        </div>
        <KeyRow
          label="Universal LLM key"
          fieldKey="emergent_llm_key"
          isSet={settings.emergent_llm_key_set}
          masked={settings.emergent_llm_key_masked}
          value={form.emergent_llm_key}
          reveal={reveal.emergent_llm_key}
          onReveal={() => toggleReveal('emergent_llm_key')}
          onChange={(v) => setForm({ ...form, emergent_llm_key: v })}
          onSave={() => save({ emergent_llm_key: form.emergent_llm_key })}
          onClear={() => clearKey('emergent_llm_key')}
        />
      </Section>

      <Section icon={Lock} title="Enabled payment methods">
        <MasterPaymentsToggle settings={settings} save={save} />
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

      <Section icon={Rocket} title="Vercel deploy & AI integration">
        <p className="text-xs text-tbc-200/60">
          Settings live in one place. They power the Deploy / Redeploy /
          Preview buttons, the per-project Health Check, and the Bearer-token
          authenticated <code className="rounded bg-ink-950 px-1 text-tbc-300">/api/projects</code> surface.
        </p>

        {/* Rotation-friendly Vercel + GitHub key field. Test before save,
            auto-clears input, and shows "rotated N days ago" with amber/red
            warnings as the token ages toward expiry. */}
        <SecretsCard settings={settings} onChanged={load} />

        {/* Birthday rewards programme — enable/disable, tune credits +
            discount, and force a manual pass. */}
        <BirthdayRewardsCard />

        <div className="flex items-center gap-3">
          <span className="w-32 text-xs text-tbc-200/60">Team ID</span>
          <Input
            data-testid="settings-vercel-team-id"
            className="flex-1 border-tbc-900/60 bg-ink-950 text-tbc-100"
            value={form.vercel_team_id || settings.vercel_team_id || ''}
            placeholder="team_... (optional)"
            onChange={(e) => setForm({ ...form, vercel_team_id: e.target.value })}
          />
          <Button
            disabled={!form.vercel_team_id}
            onClick={() => save({ vercel_team_id: form.vercel_team_id })}
            className="bg-tbc-500 font-semibold text-ink-950 hover:bg-tbc-400"
          >
            <Save className="mr-1.5 h-3.5 w-3.5" /> Save
          </Button>
        </div>

        <KeyRow
          label="AI API Key (for /api/projects Bearer auth)"
          fieldKey="ai_api_key"
          isSet={settings.ai_api_key_set}
          masked={settings.ai_api_key_masked}
          value={form.ai_api_key}
          reveal={reveal.ai_api_key}
          onReveal={() => toggleReveal('ai_api_key')}
          onChange={(v) => setForm({ ...form, ai_api_key: v })}
          onSave={() => save({ ai_api_key: form.ai_api_key })}
          onClear={() => clearKey('ai_api_key')}
          placeholder="tbc_... — paste your own or generate one in Ops tab"
        />

        <div className="border-t border-tbc-900/60 pt-3">
          <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-tbc-200/60">
            Outbound webhook · ship-and-watch events
          </div>
          <div className="flex items-center gap-3">
            <span className="w-32 text-xs text-tbc-200/60">Webhook URL</span>
            <Input
              data-testid="settings-webhook-url"
              className="flex-1 border-tbc-900/60 bg-ink-950 text-tbc-100"
              value={form.deploy_webhook_url || settings.deploy_webhook_url || ''}
              placeholder="https://your-agent.example/hooks/deploy"
              onChange={(e) => setForm({ ...form, deploy_webhook_url: e.target.value })}
            />
            <Button
              disabled={!form.deploy_webhook_url}
              onClick={() => save({ deploy_webhook_url: form.deploy_webhook_url })}
              className="bg-tbc-500 font-semibold text-ink-950 hover:bg-tbc-400"
            >
              <Save className="mr-1.5 h-3.5 w-3.5" /> Save
            </Button>
          </div>
          <p className="mt-1 text-[10px] text-tbc-200/50">
            Fires <code>deployment.triggered</code>, <code>deployment.state_changed</code>,
            <code> deployment.succeeded</code>, <code>deployment.failed</code>. Body is
            HMAC-SHA256 signed with the secret below in the
            <code> X-TBC-Signature</code> header.
          </p>
          <KeyRow
            label="Webhook secret (HMAC-SHA256)"
            fieldKey="deploy_webhook_secret"
            isSet={settings.deploy_webhook_secret_set}
            masked={settings.deploy_webhook_secret_masked}
            value={form.deploy_webhook_secret}
            reveal={reveal.deploy_webhook_secret}
            onReveal={() => toggleReveal('deploy_webhook_secret')}
            onChange={(v) => setForm({ ...form, deploy_webhook_secret: v })}
            onSave={() => save({ deploy_webhook_secret: form.deploy_webhook_secret })}
            onClear={() => clearKey('deploy_webhook_secret')}
            placeholder="Random shared secret — verify signatures with it"
          />
        </div>

        <div className="border-t border-tbc-900/60 pt-3">
          <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-tbc-200/60">
            &ldquo;Update this app&rdquo; — self-deploy target
          </div>
          <p className="mb-2 text-[11px] text-tbc-200/50">
            Once set, the <strong>Deploy this app</strong> button in the Ops
            tab (and the matching AI-surface endpoint <code>POST /api/projects/self/deploy</code>)
            will ship this repository to Vercel.
          </p>
          <div className="grid gap-2 sm:grid-cols-3">
            <div>
              <label className="text-[10px] font-semibold uppercase tracking-wider text-tbc-200/60">Repo</label>
              <Input
                data-testid="settings-self-repo"
                className="mt-1 border-tbc-900/60 bg-ink-950 font-mono text-xs text-tbc-100"
                value={form.self_repo || settings.self_repo || ''}
                placeholder="owner/repo"
                onChange={(e) => setForm({ ...form, self_repo: e.target.value })}
              />
            </div>
            <div>
              <label className="text-[10px] font-semibold uppercase tracking-wider text-tbc-200/60">Branch</label>
              <Input
                data-testid="settings-self-ref"
                className="mt-1 border-tbc-900/60 bg-ink-950 text-xs text-tbc-100"
                value={form.self_git_ref || settings.self_git_ref || 'main'}
                placeholder="main"
                onChange={(e) => setForm({ ...form, self_git_ref: e.target.value })}
              />
            </div>
            <div>
              <label className="text-[10px] font-semibold uppercase tracking-wider text-tbc-200/60">Vercel project id (optional)</label>
              <Input
                data-testid="settings-self-vercel-id"
                className="mt-1 border-tbc-900/60 bg-ink-950 font-mono text-xs text-tbc-100"
                value={form.self_vercel_project_id || settings.self_vercel_project_id || ''}
                placeholder="prj_..."
                onChange={(e) => setForm({ ...form, self_vercel_project_id: e.target.value })}
              />
            </div>
          </div>
          <div className="mt-2 flex justify-end">
            <Button
              data-testid="settings-self-save"
              onClick={() => save({
                self_repo: form.self_repo,
                self_git_ref: form.self_git_ref,
                self_vercel_project_id: form.self_vercel_project_id,
              })}
              className="bg-tbc-500 font-semibold text-ink-950 hover:bg-tbc-400"
            >
              <Save className="mr-1.5 h-3.5 w-3.5" /> Save self-deploy target
            </Button>
          </div>
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

const PAYMENT_KEYS = ['enable_card', 'enable_paypal', 'enable_crypto_auto', 'enable_crypto_manual', 'enable_bank'];

function toneFor(enabledCount, total) {
  if (enabledCount === total) return 'emerald';
  if (enabledCount === 0) return 'rose';
  return 'amber';
}

function masterLabel(enabledCount, total) {
  if (enabledCount === total) return 'All payment methods enabled';
  if (enabledCount === 0) return 'All payment methods disabled';
  return `${enabledCount} of ${total} enabled`;
}

const TONE_BORDER = { emerald: 'border-emerald-500/40', rose: 'border-rose-500/40', amber: 'border-amber-500/40' };
const TONE_TEXT = { emerald: 'text-emerald-300', rose: 'text-rose-300', amber: 'text-amber-300' };

function MasterPaymentsToggle({ settings, save }) {
  const enabledCount = PAYMENT_KEYS.filter((k) => settings[k]).length;
  const total = PAYMENT_KEYS.length;
  const allOn = enabledCount === total;
  const tone = toneFor(enabledCount, total);

  const toggleAll = (on) => {
    const patch = Object.fromEntries(PAYMENT_KEYS.map((k) => [k, on]));
    save(patch);
  };

  return (
    <div
      className={`flex items-center justify-between rounded-lg border bg-ink-950 px-4 py-3 ${TONE_BORDER[tone]}`}
      data-testid="master-payments-toggle"
    >
      <div>
        <div className="text-sm font-semibold text-tbc-100">Master switch</div>
        <div className={`text-xs ${TONE_TEXT[tone]}`}>{masterLabel(enabledCount, total)}</div>
      </div>
      <div className="flex items-center gap-2">
        <Switch
          checked={allOn}
          onCheckedChange={(v) => toggleAll(!!v)}
          data-testid="master-payments-switch"
        />
      </div>
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
          {/*
            The combination of attributes below prevents browser /
            password-manager autofill from treating these as login
            credentials. Without them, Chrome would silently overwrite the
            operator's SAVED LOGIN PASSWORD with the API key the user just
            pasted (reported & fixed Feb 2026).
              - `name` is the field key (NOT "password")
              - `autoComplete="off"` blocks Chrome
              - `data-1p-ignore` blocks 1Password
              - `data-lpignore` blocks LastPass
              - `data-bwignore` blocks Bitwarden
          */}
          <Input
            className="bg-ink-950 border-tbc-900/60 text-tbc-100 pr-10"
            type={reveal ? 'text' : 'password'}
            name={`secret-${fieldKey}`}
            id={`secret-${fieldKey}`}
            autoComplete="off"
            data-1p-ignore="true"
            data-lpignore="true"
            data-bwignore="true"
            data-form-type="other"
            spellCheck={false}
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

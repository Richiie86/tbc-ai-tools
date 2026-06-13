import React, { useCallback, useEffect, useState } from 'react';
import api from '../../lib/api';
import { Button } from '../../components/ui/button';
import { Textarea } from '../../components/ui/textarea';
import { Switch } from '../../components/ui/switch';
import { toast } from 'sonner';
import { Megaphone, Lock, Save, Loader2 } from 'lucide-react';

/**
 * Operator-controlled app-wide toggles:
 *   - Personal-use banner overlay (text + on/off)
 *   - Login lockdown (operator-only sign-in)
 *
 * Both flags live on a single MongoDB doc `app_settings/_id=main`.
 * Save is atomic across the form; partial updates work too (omitted
 * fields are left untouched on the server).
 */
export default function AppSettingsCard() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [bannerEnabled, setBannerEnabled] = useState(false);
  const [bannerText, setBannerText] = useState('');
  const [lockdown, setLockdown] = useState(false);
  // Live preview of the banner — renders inline below the textarea so
  // the operator sees their copy before publishing.
  const [showPreview, setShowPreview] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/operator/app-settings');
      setBannerEnabled(!!data.banner_enabled);
      setBannerText(data.banner_text || '');
      setLockdown(!!data.login_lockdown_enabled);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Failed to load app settings');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    setSaving(true);
    try {
      await api.patch('/operator/app-settings', {
        banner_enabled: bannerEnabled,
        banner_text: bannerText,
        login_lockdown_enabled: lockdown,
      });
      toast.success('App settings saved');
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  // Inline toggles trigger an immediate save so the operator doesn't
  // have to remember to click "Save" — except for `bannerText` which
  // *requires* a save (textarea changes are local until Save).
  const toggleBanner = async (next) => {
    setBannerEnabled(next);
    try {
      await api.patch('/operator/app-settings', { banner_enabled: next });
      toast.success(next ? 'Banner ON · visible to everyone' : 'Banner OFF');
    } catch (e) {
      toast.error('Could not toggle banner');
      setBannerEnabled(!next);  // rollback
    }
  };

  const toggleLockdown = async (next) => {
    if (next && !window.confirm(
      'Lock down the app to operators only?\n\n' +
      'All non-operator login + registration attempts will return 503 until you turn this back off.',
    )) return;
    setLockdown(next);
    try {
      await api.patch('/operator/app-settings', { login_lockdown_enabled: next });
      toast.success(next ? '🔒 Login lockdown ON · only operators can sign in' : '🔓 Lockdown OFF');
    } catch (e) {
      toast.error('Could not toggle lockdown');
      setLockdown(!next);  // rollback
    }
  };

  if (loading) {
    return (
      <div className="grid place-items-center py-8" data-testid="app-settings-loading">
        <Loader2 className="h-4 w-4 animate-spin text-tbc-400" />
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="app-settings-card">
      {/* Personal-use banner */}
      <div className="rounded-lg border border-red-500/30 bg-red-500/[0.04] p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h4 className="flex items-center gap-2 text-sm font-bold text-tbc-100">
              <Megaphone className="h-4 w-4 text-red-300" />
              Personal-use banner overlay
            </h4>
            <p className="mt-0.5 text-[11px] text-tbc-200/60">
              Translucent red banner covering the whole landing page. Doesn't block clicks — purely informational. Visible to everyone, signed-in or not.
            </p>
          </div>
          <Switch
            checked={bannerEnabled}
            onCheckedChange={toggleBanner}
            data-testid="app-settings-banner-toggle"
          />
        </div>
        <div className="mt-3">
          <label className="text-[10px] uppercase tracking-wider text-tbc-300">Banner text</label>
          <Textarea
            value={bannerText}
            onChange={(e) => setBannerText(e.target.value)}
            rows={2}
            data-testid="app-settings-banner-text"
            placeholder="OBS! This application is only for personal use!"
            className="mt-1 bg-ink-950 border-tbc-900/60 text-tbc-100 text-sm"
          />
          <div className="mt-2 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setShowPreview((s) => !s)}
              className="text-[10px] text-tbc-300 hover:text-tbc-100 underline"
              data-testid="app-settings-banner-preview-toggle"
            >
              {showPreview ? 'Hide preview' : 'Preview'}
            </button>
            <Button
              size="sm"
              onClick={save}
              disabled={saving}
              data-testid="app-settings-banner-save"
              className="h-7 bg-tbc-500 text-ink-950 hover:bg-tbc-400 font-bold"
            >
              {saving
                ? <Loader2 className="h-3 w-3 animate-spin" />
                : <><Save className="mr-1 h-3 w-3" />Save text</>}
            </Button>
          </div>
          {showPreview && (
            <div
              data-testid="app-settings-banner-preview"
              className="mt-2 grid place-items-center rounded-md border-2 border-red-500/50 bg-red-900/60 p-4 text-center"
            >
              <span className="font-extrabold text-red-100" style={{ fontSize: 'clamp(14px, 2vw, 22px)' }}>
                {bannerText || 'OBS! This application is only for personal use!'}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Login lockdown */}
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/[0.04] p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h4 className="flex items-center gap-2 text-sm font-bold text-tbc-100">
              <Lock className="h-4 w-4 text-amber-300" />
              Login lockdown
            </h4>
            <p className="mt-0.5 text-[11px] text-tbc-200/60">
              When ON, only operator accounts can sign in. Every other login + registration attempt returns 503. Use this to take the app private for personal use or maintenance.
            </p>
          </div>
          <Switch
            checked={lockdown}
            onCheckedChange={toggleLockdown}
            data-testid="app-settings-lockdown-toggle"
          />
        </div>
        {lockdown && (
          <div className="mt-3 rounded border border-amber-500/40 bg-amber-500/[0.06] p-2 text-[11px] text-amber-200">
            🔒 Lockdown is ACTIVE. Existing user sessions remain valid until they log out, but no new logins or sign-ups can complete.
          </div>
        )}
      </div>
    </div>
  );
}

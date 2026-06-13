import React, { useEffect, useState } from 'react';

/**
 * Personal-use banner overlay.
 *
 * Polls the public `/api/app/announcement` endpoint and, when enabled,
 * paints a translucent red full-page overlay with the operator's chosen
 * text. Critical design constraints:
 *
 *   - `position: fixed; inset: 0` covers the entire viewport.
 *   - `pointer-events: none` so the underlying UI stays fully clickable
 *     — the banner is informational, not modal.
 *   - The text element re-enables pointer events only on itself so the
 *     close handler (per-session dismiss) works.
 *   - z-index: 9998 keeps it above page content but below sonner toasts
 *     and shadcn dialogs (which sit at 9999+).
 *
 * Refreshes once at mount and then every 60s so the operator's toggle
 * propagates to open tabs without a hard reload.
 */
const SESSION_KEY = 'tbc_personal_use_banner_dismissed';

export default function PersonalUseBanner() {
  const [data, setData] = useState(null); // {banner_enabled, banner_text}
  const [dismissed, setDismissed] = useState(() => {
    try { return sessionStorage.getItem(SESSION_KEY) === '1'; }
    catch { return false; }
  });

  useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        const url = `${process.env.REACT_APP_BACKEND_URL}/api/app/announcement`;
        const r = await fetch(url);
        if (!r.ok) return;
        const json = await r.json();
        if (!stopped) setData(json);
      } catch {
        // Silent — banner is best-effort.
      }
    };
    load();
    const id = setInterval(() => {
      if (!document.hidden) load();
    }, 60_000);
    return () => { stopped = true; clearInterval(id); };
  }, []);

  if (!data?.banner_enabled || dismissed) return null;

  return (
    <div
      data-testid="personal-use-banner"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9998,
        pointerEvents: 'none',
        display: 'grid',
        placeItems: 'center',
        // Faint red wash so the underlying UI stays legible.
        background: 'radial-gradient(ellipse at center, rgba(239,68,68,0.10) 0%, rgba(239,68,68,0.04) 60%, rgba(239,68,68,0.10) 100%)',
        animation: 'tbc-banner-fade 0.4s ease-out',
      }}
    >
      <div
        style={{
          // The actual text card — re-enable pointer events so the X
          // button below is clickable. Background uses a near-opaque red
          // so the message itself remains crisply readable even over a
          // busy hero section.
          pointerEvents: 'auto',
          maxWidth: '90vw',
          padding: '24px 36px',
          borderRadius: 14,
          border: '2px solid rgba(239,68,68,0.6)',
          background: 'rgba(127,29,29,0.85)',
          boxShadow: '0 16px 48px rgba(0,0,0,0.45)',
          color: '#fff5f5',
          textAlign: 'center',
          fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
        }}
      >
        <div
          data-testid="personal-use-banner-text"
          style={{
            fontWeight: 800,
            fontSize: 'clamp(20px, 4vw, 34px)',
            lineHeight: 1.25,
            letterSpacing: 0.5,
            textShadow: '0 2px 12px rgba(0,0,0,0.6)',
          }}
        >
          {data.banner_text}
        </div>
        <button
          type="button"
          data-testid="personal-use-banner-dismiss"
          onClick={() => {
            try { sessionStorage.setItem(SESSION_KEY, '1'); } catch {}
            setDismissed(true);
          }}
          style={{
            marginTop: 16,
            padding: '8px 22px',
            borderRadius: 8,
            border: '1px solid rgba(255,255,255,0.3)',
            background: 'rgba(255,255,255,0.12)',
            color: '#fff',
            fontWeight: 700,
            fontSize: 13,
            cursor: 'pointer',
            letterSpacing: 0.3,
          }}
        >
          I understand · hide for this session
        </button>
      </div>
      <style>{`
        @keyframes tbc-banner-fade {
          from { opacity: 0; } to { opacity: 1; }
        }
      `}</style>
    </div>
  );
}

import { useEffect, useRef } from 'react';
import { toast } from 'sonner';

/**
 * Detects when a newer production build has been deployed and prompts a
 * one-tap reload.
 *
 * WHY THIS EXISTS: this is a single-page app. Once the SPA JS is loaded in a
 * browser tab, client-side navigation never re-requests index.html, so the tab
 * keeps running whatever bundle it first loaded — sometimes for days. Every
 * feature we ship (rename/delete buttons, deploy fixes, etc.) stays invisible
 * in that stale tab until a full hard-reload. Users don't know to do that, so
 * they think the feature is "still missing".
 *
 * HOW IT WORKS: we fetch index.html (cache-busted) on an interval and whenever
 * the tab regains focus, extract the hashed main bundle filename
 * (e.g. main.d8c65e42.js), and compare it to the one that's currently running.
 * If it changed, a deployment happened — we surface a persistent toast with a
 * Reload action. No build-tooling changes required; the hash is already unique
 * per build via CRA's content hashing.
 */
export default function BuildUpdateWatcher() {
  const currentHashRef = useRef(null);
  const notifiedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    // Extract the main bundle filename from an index.html string.
    const parseBundle = (html) => {
      const m = html.match(/\/static\/js\/main\.[a-f0-9]+\.js/);
      return m ? m[0] : null;
    };

    // Record the bundle the running app was built from. Prefer the actual
    // <script> tags in the live document so we compare apples to apples.
    const detectCurrent = () => {
      const scripts = Array.from(document.querySelectorAll('script[src]'));
      const main = scripts
        .map((s) => s.getAttribute('src') || '')
        .find((src) => /\/static\/js\/main\.[a-f0-9]+\.js/.test(src));
      if (main) currentHashRef.current = main.replace(/^https?:\/\/[^/]+/, '');
    };

    const checkForUpdate = async () => {
      if (cancelled || notifiedRef.current) return;
      try {
        // cache:no-store guarantees we hit the origin, not the browser cache,
        // so we truly see the latest deployed index.html.
        const res = await fetch(`/?_v=${Date.now()}`, {
          cache: 'no-store',
          headers: { 'x-build-check': '1' },
        });
        if (!res.ok) return;
        const html = await res.text();
        const latest = parseBundle(html);
        if (!latest || !currentHashRef.current) return;
        if (latest !== currentHashRef.current) {
          notifiedRef.current = true;
          toast('A new version of TBC AI Tools is available', {
            description: 'Reload to get the latest features and fixes.',
            duration: Infinity,
            action: {
              label: 'Reload',
              onClick: () => window.location.reload(true),
            },
          });
        }
      } catch {
        // Offline or transient network error — ignore and retry next tick.
      }
    };

    detectCurrent();

    // Poll every 2 minutes, plus whenever the tab regains focus (the moment a
    // user is most likely coming back after a deploy).
    const interval = setInterval(checkForUpdate, 120000);
    const onFocus = () => checkForUpdate();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') checkForUpdate();
    });
    // First check shortly after mount so a long-open stale tab updates fast.
    const initial = setTimeout(checkForUpdate, 5000);

    return () => {
      cancelled = true;
      clearInterval(interval);
      clearTimeout(initial);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  return null;
}

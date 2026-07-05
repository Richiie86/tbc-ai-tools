import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Monitor, Smartphone, X, RefreshCw, ExternalLink, Eye, Loader2 } from 'lucide-react';
import api from '../lib/api';

// Keys shared with the in-chat deploy flow (PostAiDeploySuggestion / SandboxTab).
const SELECTED_KEY = 'tbc.inChat.selectedProjectId';
const PREVIEW_KEY = 'tbc.inChat.lastPreviewUrl';
// The operator console deploys ITSELF under this id — never preview it.
const SELF_PROJECT_ID = 'tbctools-self';

const withHttps = (u) => (u && !/^https?:\/\//i.test(u) ? `https://${u}` : u);

/**
 * PreviewPane — an EMBEDDED live preview of the web the operator is
 * currently building, shown inside the dashboard (no new tab required).
 *
 * A floating "Preview" button toggles a docked panel on the right that
 * loads the resolved preview URL in an iframe, with a phone / desktop
 * width switch, a refresh button, and an "open in new tab" escape hatch
 * for sites that block being framed.
 *
 * URL resolution mirrors the old ViewPreviewButton (highest intent first):
 *   1. `tbc.inChat.lastPreviewUrl` — the exact URL from the in-chat deploy
 *      that just happened.
 *   2. The explicitly-selected deploy project's url/domain — as long as it
 *      isn't the operator app itself.
 * If neither resolves, the button hides rather than framing the wrong site.
 */
export default function PreviewPane() {
  const [url, setUrl] = useState(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [device, setDevice] = useState('desktop'); // 'desktop' | 'mobile'
  const [frameKey, setFrameKey] = useState(0);       // bump to hard-reload the iframe
  const [framed, setFramed] = useState(true);        // false if the site blocks embedding
  const frameLoaded = useRef(false);

  const resolve = useCallback(async () => {
    setLoading(true);
    try {
      let inChatPreview = '';
      try { inChatPreview = localStorage.getItem(PREVIEW_KEY) || ''; } catch { /* ignore */ }
      if (inChatPreview) { setUrl(withHttps(inChatPreview)); return; }

      let projectId = '';
      try { projectId = localStorage.getItem(SELECTED_KEY) || ''; } catch { /* ignore */ }
      if (!projectId || projectId === SELF_PROJECT_ID) { setUrl(null); return; }

      const { data } = await api.get('/operator/deploy/projects');
      const list = data?.projects || data || [];
      const picked = list.find(
        (p) => p.id === projectId && p.id !== SELF_PROJECT_ID && (p.url || p.domain),
      );
      setUrl(picked ? withHttps(picked.url || picked.domain) : null);
    } catch {
      setUrl(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { resolve(); }, [resolve]);

  // Keep in sync with in-chat deploys in this or another tab.
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key === PREVIEW_KEY || e.key === SELECTED_KEY) resolve();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [resolve]);

  // When the URL changes (fresh deploy), reset the frame + assume it embeds.
  useEffect(() => {
    frameLoaded.current = false;
    setFramed(true);
    setFrameKey((k) => k + 1);
  }, [url]);

  const reload = () => { frameLoaded.current = false; setFramed(true); setFrameKey((k) => k + 1); };

  if (loading || !url) return null;

  return (
    <>
      {/* Floating toggle — hides while the panel is open. */}
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          data-testid="preview-pane-toggle"
          title="Open a live preview of what you're building"
          className="fixed bottom-20 right-5 z-30 inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-sky-500 to-tbc-500 px-4 py-2.5 text-sm font-bold text-ink-950 shadow-lg shadow-tbc-500/30 transition hover:from-sky-400 hover:to-tbc-400"
        >
          <Eye className="h-4 w-4" />
          Preview
        </button>
      )}

      {open && (
        <aside
          data-testid="preview-pane"
          className="fixed inset-y-0 right-0 z-40 flex w-full flex-col border-l border-slate-800 bg-ink-950 shadow-2xl sm:w-[440px]"
        >
          {/* Header controls */}
          <div className="flex items-center justify-between gap-2 border-b border-slate-800 px-3 py-2">
            <div className="flex items-center gap-2 text-sm font-semibold text-white">
              <Eye className="h-4 w-4 text-tbc-400" />
              Live preview
            </div>
            <div className="flex items-center gap-1">
              <div className="mr-1 flex items-center gap-0.5 rounded-md border border-slate-700 bg-slate-900 p-0.5">
                <button
                  onClick={() => setDevice('desktop')}
                  aria-pressed={device === 'desktop'}
                  title="Desktop width"
                  className={`grid h-7 w-7 place-items-center rounded ${device === 'desktop' ? 'bg-tbc-500 text-ink-950' : 'text-slate-300 hover:text-white'}`}
                >
                  <Monitor className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => setDevice('mobile')}
                  aria-pressed={device === 'mobile'}
                  title="Mobile width"
                  className={`grid h-7 w-7 place-items-center rounded ${device === 'mobile' ? 'bg-tbc-500 text-ink-950' : 'text-slate-300 hover:text-white'}`}
                >
                  <Smartphone className="h-3.5 w-3.5" />
                </button>
              </div>
              <button
                onClick={reload}
                title="Reload preview"
                className="grid h-7 w-7 place-items-center rounded-md text-slate-300 hover:bg-slate-800 hover:text-white"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                title="Open in a new tab"
                className="grid h-7 w-7 place-items-center rounded-md text-slate-300 hover:bg-slate-800 hover:text-white"
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
              <button
                onClick={() => setOpen(false)}
                title="Close preview"
                data-testid="preview-pane-close"
                className="grid h-7 w-7 place-items-center rounded-md text-slate-300 hover:bg-slate-800 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* URL bar */}
          <div className="truncate border-b border-slate-800 bg-slate-900/60 px-3 py-1.5 text-[11px] text-slate-400" title={url}>
            {url}
          </div>

          {/* Frame */}
          <div className="relative flex-1 overflow-auto bg-slate-950">
            {framed ? (
              <div className={device === 'mobile' ? 'mx-auto h-full w-[390px] max-w-full' : 'h-full w-full'}>
                <iframe
                  key={frameKey}
                  src={url}
                  title="Live preview of your build"
                  className="h-full w-full border-0 bg-white"
                  onLoad={() => { frameLoaded.current = true; }}
                  sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
                />
                {/* If the site sets X-Frame-Options/CSP frame-ancestors, the
                    iframe stays blank. Give the operator a fallback after a
                    short grace period. */}
                <BlankFrameFallback loadedRef={frameLoaded} onBlocked={() => setFramed(false)} frameKey={frameKey} />
              </div>
            ) : (
              <div className="grid h-full place-items-center p-6 text-center">
                <div>
                  <p className="text-sm font-semibold text-slate-200">This site can&apos;t be embedded here.</p>
                  <p className="mt-1 text-xs text-slate-400">
                    It blocks being shown inside another page. Open it in a new tab instead.
                  </p>
                  <a
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-4 inline-flex items-center gap-2 rounded-lg bg-tbc-500 px-3 py-2 text-sm font-semibold text-ink-950 transition hover:bg-tbc-400"
                  >
                    <ExternalLink className="h-4 w-4" /> Open preview
                  </a>
                </div>
              </div>
            )}
          </div>
        </aside>
      )}
    </>
  );
}

/**
 * Detects the "blank iframe" case: if the iframe hasn't fired `onLoad`
 * within a grace window, the target almost certainly refused to be framed.
 * We can't read the frame's contents cross-origin, so a timeout is the
 * pragmatic signal.
 */
function BlankFrameFallback({ loadedRef, onBlocked, frameKey }) {
  const [checking, setChecking] = useState(true);
  useEffect(() => {
    setChecking(true);
    const t = setTimeout(() => {
      setChecking(false);
      if (!loadedRef.current) onBlocked();
    }, 4000);
    return () => clearTimeout(t);
  }, [frameKey, loadedRef, onBlocked]);

  if (!checking) return null;
  return (
    <div className="pointer-events-none absolute inset-0 grid place-items-center bg-slate-950/60">
      <Loader2 className="h-5 w-5 animate-spin text-tbc-400" />
    </div>
  );
}

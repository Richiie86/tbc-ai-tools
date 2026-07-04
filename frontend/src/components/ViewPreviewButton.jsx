import React, { useCallback, useEffect, useState } from 'react';
import { ExternalLink, Loader2 } from 'lucide-react';
import api from '../lib/api';

// Keys shared with the in-chat deploy flow (PostAiDeploySuggestion).
const SELECTED_KEY = 'tbc.inChat.selectedProjectId';
const PREVIEW_KEY = 'tbc.inChat.lastPreviewUrl';
// The operator console deploys ITSELF under this id. It must never be the
// target of "View Preview" — that's what caused the button to open this app
// instead of the web the operator is building.
const SELF_PROJECT_ID = 'tbctools-self';

const withHttps = (u) => (u && !/^https?:\/\//i.test(u) ? `https://${u}` : u);

/**
 * Floating "View Preview" button — sits bottom-right of the chat,
 * always visible. Opens the live preview of the web the operator is
 * CURRENTLY building — never this operator app itself.
 *
 * Lookup order (highest intent → lowest):
 *   1. `tbc.inChat.lastPreviewUrl` — the exact URL written the moment the
 *      in-chat build deployed. This is what the operator just made.
 *   2. The explicitly-selected deploy project's `url`/`domain`
 *      (`tbc.inChat.selectedProjectId`), as long as it isn't the self app.
 *
 * We deliberately DON'T fall back to "the first project with any URL",
 * because that would grab the self app (tbctools-self) and send the
 * operator back to this console. If we can't resolve a real target, the
 * button hides itself rather than link somewhere wrong.
 */
export default function ViewPreviewButton() {
  const [url, setUrl] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // 1) The freshest, most-intentful target: the preview URL from the
      //    in-chat deploy that just happened.
      let inChatPreview = '';
      try { inChatPreview = localStorage.getItem(PREVIEW_KEY) || ''; } catch { /* ignore */ }
      if (inChatPreview) {
        setUrl(withHttps(inChatPreview));
        return;
      }

      // 2) The explicitly selected deploy project — but only if it isn't
      //    the operator app itself.
      let projectId = '';
      try { projectId = localStorage.getItem(SELECTED_KEY) || ''; } catch { /* ignore */ }
      if (!projectId || projectId === SELF_PROJECT_ID) {
        setUrl(null);
        return;
      }

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

  useEffect(() => { load(); }, [load]);

  // Keep the button in sync with in-chat deploys happening in this or
  // another tab, without needing a full reload.
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key === PREVIEW_KEY || e.key === SELECTED_KEY) load();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [load]);

  if (loading) return null;
  if (!url) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      data-testid="view-preview-fab"
      title={`Open ${url} in a new tab`}
      className="fixed bottom-20 right-5 z-30 inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-sky-500 to-tbc-500 px-4 py-2.5 text-sm font-bold text-ink-950 shadow-lg shadow-tbc-500/30 transition hover:from-sky-400 hover:to-tbc-400"
    >
      <ExternalLink className="h-4 w-4" />
      View Preview
    </a>
  );
}

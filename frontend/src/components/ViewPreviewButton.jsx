import React, { useCallback, useEffect, useState } from 'react';
import { ExternalLink, Loader2 } from 'lucide-react';
import api from '../lib/api';

/**
 * Floating "View Preview" button — sits bottom-right of the chat,
 * always visible. Looks up the deploy project the operator selected
 * (same localStorage key the inline Deploy button uses) and opens its
 * latest live URL in a new tab.
 *
 * Lookup order, cheapest → most expensive:
 *   1. Operator-saved `tbc.inChat.selectedProjectId` → fetch project doc
 *      → use its `url` / `domain` field directly (no Vercel call).
 *   2. Fallback: hit `/operator/deploy/projects` and pick the first
 *      that has a `url`.
 *
 * Silent fail: if nothing's configured, the button hides itself rather
 * than rendering a broken link.
 */
export default function ViewPreviewButton() {
  const [url, setUrl] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      let projectId = '';
      try { projectId = localStorage.getItem('tbc.inChat.selectedProjectId') || ''; } catch { /* ignore */ }
      const { data } = await api.get('/operator/deploy/projects');
      const list = data?.projects || data || [];
      // Prefer the operator's selected project; fall back to the first
      // one with a public URL configured.
      const picked = list.find((p) => p.id === projectId && (p.url || p.domain))
        || list.find((p) => p.url || p.domain);
      if (picked) {
        let u = picked.url || picked.domain;
        if (u && !u.startsWith('http')) u = `https://${u}`;
        setUrl(u);
      } else {
        setUrl(null);
      }
    } catch {
      setUrl(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

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

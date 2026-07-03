import React, { useEffect, useState } from 'react';
import api from '../lib/api';

/**
 * Renders a persisted build/preview screenshot as a small thumbnail that
 * opens a full-size lightbox on click.
 *
 * The image is fetched through the API client as a blob (responseType:
 * 'blob') so the httpOnly auth cookie is sent even when the backend is on a
 * different origin — a plain <img src> wouldn't carry credentials reliably.
 *
 * Props:
 *   - src:  API path (relative to the axios baseURL), e.g.
 *           `/operator/ai-build/visual-verify/<id>/screenshot`
 *   - alt:  accessible description
 *   - className: optional override for the thumbnail button sizing
 */
export default function ScreenshotThumb({ src, alt, className }) {
  const [objectUrl, setObjectUrl] = useState(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let revoked = false;
    let url = null;
    (async () => {
      try {
        const resp = await api.get(src, { responseType: 'blob' });
        if (revoked) return;
        url = URL.createObjectURL(resp.data);
        setObjectUrl(url);
      } catch {
        setFailed(true);
      }
    })();
    return () => {
      revoked = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [src]);

  if (failed || !objectUrl) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Open screenshot"
        data-testid="screenshot-thumb"
        className={
          className ||
          'h-7 w-12 shrink-0 overflow-hidden rounded border border-tbc-900/60 hover:border-tbc-500/60'
        }
      >
        <img src={objectUrl} alt={alt} className="h-full w-full object-cover object-top" />
      </button>
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Screenshot preview"
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-[100] flex items-center justify-center bg-ink-950/80 p-4"
        >
          <img
            src={objectUrl}
            alt={alt}
            className="max-h-[90vh] max-w-[90vw] rounded-lg border border-tbc-900/60 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  );
}

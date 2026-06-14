import { useCallback, useEffect, useRef, useState } from 'react';

// Anything within this many pixels from the bottom counts as "still at
// the end" so a stray scroll-wheel nudge doesn't unstick the stream.
const STICK_TO_BOTTOM_THRESHOLD_PX = 80;

/**
 * Auto-follows the bottom of a scroll container while the user is pinned
 * there, releases as soon as they scroll up to read earlier messages,
 * and gives back a `jumpToLatest()` to resume following on demand.
 *
 * Extracted from Dashboard.jsx so the streaming view stays under ~250
 * lines and so the same behaviour can be re-used elsewhere (e.g. an
 * embedded mini-chat in a side panel) without copy-paste.
 *
 * @param {Array} deps — anything that should force a re-pin when it
 *                       changes AND `stickToBottom` is currently on
 *                       (typically `[messages, streamText]`).
 */
export function useStickToBottom(deps = []) {
  const scrollRef = useRef(null);
  const [stickToBottom, setStickToBottom] = useState(true);

  // Conditional auto-scroll: only follow the bottom when the user is
  // already pinned there. Once they scroll up we leave their viewport
  // alone — the floating "Jump to latest" button puts them back.
  useEffect(() => {
    if (!stickToBottom) return;
    const el = scrollRef.current;
    if (el) requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stickToBottom, ...deps]);

  const onScrollContainer = useCallback((e) => {
    const el = e.currentTarget;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_TO_BOTTOM_THRESHOLD_PX;
    setStickToBottom(atBottom);
  }, []);

  const jumpToLatest = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setStickToBottom(true);
  }, []);

  return { scrollRef, stickToBottom, onScrollContainer, jumpToLatest };
}

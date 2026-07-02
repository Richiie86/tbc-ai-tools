import { createContext, useContext, useState, useEffect, useCallback } from 'react';

/**
 * ViewMode lets anyone force how the site is laid out, regardless of device:
 *   - 'auto'     → normal responsive behaviour (follows the real screen)
 *   - 'mobile'   → phone layout (viewport = device width)
 *   - 'computer' → full desktop layout (viewport pinned to a wide width, so a
 *                  phone renders the same as a computer, zoomed to fit)
 *
 * It works by rewriting the <meta name="viewport"> tag — the same trick a
 * browser's "Desktop site" option uses — so it applies across every page.
 * The choice is saved to localStorage so it sticks between visits.
 */

const STORAGE_KEY = 'tbc_view_mode';
const DESKTOP_WIDTH = 1280; // px the "computer" layout is designed around

const ViewModeContext = createContext({
  mode: 'auto',
  setMode: () => {},
});

function applyViewport(mode) {
  let tag = document.querySelector('meta[name="viewport"]');
  if (!tag) {
    tag = document.createElement('meta');
    tag.name = 'viewport';
    document.head.appendChild(tag);
  }
  if (mode === 'computer') {
    // Pin the viewport to a desktop width so phones show the full computer UI.
    tag.setAttribute('content', `width=${DESKTOP_WIDTH}, initial-scale=${(typeof window !== 'undefined' ? window.screen.width / DESKTOP_WIDTH : 1).toFixed(3)}`);
  } else {
    // 'mobile' and 'auto' both use the natural device width.
    tag.setAttribute('content', 'width=device-width, initial-scale=1');
  }
  // Expose the mode as a data attribute for any CSS that wants to react to it.
  document.documentElement.setAttribute('data-view-mode', mode);
}

export function ViewModeProvider({ children }) {
  const [mode, setModeState] = useState(() => {
    if (typeof window === 'undefined') return 'auto';
    return localStorage.getItem(STORAGE_KEY) || 'auto';
  });

  useEffect(() => {
    applyViewport(mode);
  }, [mode]);

  const setMode = useCallback((next) => {
    setModeState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* ignore storage errors (private mode, etc.) */
    }
  }, []);

  return (
    <ViewModeContext.Provider value={{ mode, setMode }}>
      {children}
    </ViewModeContext.Provider>
  );
}

export function useViewMode() {
  return useContext(ViewModeContext);
}

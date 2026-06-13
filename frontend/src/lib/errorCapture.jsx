/**
 * Runtime error capture — wires every uncaught JavaScript error and
 * unhandled promise rejection into `POST /api/runtime-errors` so the
 * Operator → Errors tab can surface them.
 *
 * Mounted once at app boot in `src/index.js` via `installErrorCapture()`.
 * The React tree is wrapped in `<RuntimeErrorBoundary>` so render-time
 * exceptions are caught too.
 */
import React from 'react';

const BACKEND = process.env.REACT_APP_BACKEND_URL;
const ENDPOINT = `${BACKEND}/api/runtime-errors`;

// We're inside the app's own error handler — fetch() failures must NEVER
// throw, or we'd amplify the bug we're trying to report.
async function report(payload) {
  try {
    await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // No credentials — endpoint is public + rate-limited.
      body: JSON.stringify(payload),
      keepalive: true,  // survive page-unload during a navigation error
    });
  } catch {
    // Swallow — best-effort only.
  }
}

let installed = false;

/**
 * Return true when the error clearly originates from a browser
 * extension (crypto wallets, ad blockers, password managers, etc.) and
 * should NOT be reported as an app bug. Common signatures:
 *   - `event.filename` starts with `chrome-extension://`, `moz-extension://`, `safari-web-extension://`
 *   - stack trace references those schemes
 *   - certain well-known extension error strings (e.g. wallet "must has
 *     at least one account") that have nothing to do with our app
 */
function isExtensionNoise({ filename, stack, message }) {
  const EXT_RE = /(chrome-extension|moz-extension|safari-web-extension|webkit-masked-url):\/\//i;
  if (filename && EXT_RE.test(filename)) return true;
  if (stack && EXT_RE.test(stack)) return true;
  // Known wallet-extension grammar tells (extensions are notorious for
  // bad English in error strings — easy heuristic, low false-positive).
  if (message && /wallet must has at least one account/i.test(message)) return true;
  return false;
}

export function installErrorCapture() {
  if (installed) return;
  installed = true;

  window.addEventListener('error', (e) => {
    if (!e?.error && !e?.message) return;
    const stack = e.error?.stack || '';
    if (isExtensionNoise({ filename: e.filename, stack, message: e.message })) return;
    report({
      message: e.message || String(e.error),
      stack,
      source: 'frontend',
      url: window.location.href,
      user_agent: navigator.userAgent,
      context: {
        filename: e.filename,
        line: e.lineno,
        col: e.colno,
      },
    });
  });

  window.addEventListener('unhandledrejection', (e) => {
    const r = e?.reason;
    const message = r?.message || (typeof r === 'string' ? r : 'unhandledrejection');
    const stack = r?.stack || '';
    if (isExtensionNoise({ filename: '', stack, message })) return;
    report({
      message: message.slice(0, 4000),
      stack,
      source: 'frontend',
      url: window.location.href,
      user_agent: navigator.userAgent,
      context: { kind: 'unhandledrejection' },
    });
  });
}

/**
 * React error boundary — catches render-time exceptions that the global
 * window.onerror handler misses (React 18 swallows them). Falls back to
 * a minimal "something broke" panel so the operator can refresh.
 */
export class RuntimeErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, errorId: null };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, info) {
    report({
      message: error?.message || 'React render error',
      stack: (error?.stack || '') + '\n\nComponentStack:\n' + (info?.componentStack || ''),
      source: 'frontend',
      url: window.location.href,
      user_agent: navigator.userAgent,
      context: { kind: 'react-boundary' },
    });
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div
        data-testid="runtime-error-boundary"
        style={{
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          background: '#0a0a0c',
          color: '#f5f5f5',
          fontFamily: 'system-ui, sans-serif',
          padding: '24px',
        }}
      >
        <div style={{ maxWidth: 520, textAlign: 'center' }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>⚠️</div>
          <h2 style={{ margin: 0, fontSize: 20 }}>Something broke on this page.</h2>
          <p style={{ marginTop: 8, color: '#9ca3af', fontSize: 14 }}>
            We logged the error. Open the Operator → Errors tab to inspect it,
            or refresh to retry.
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{
              marginTop: 16,
              padding: '8px 18px',
              borderRadius: 8,
              border: '1px solid #2a2a2e',
              background: '#f4cf6a',
              color: '#0a0a0c',
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            Refresh
          </button>
        </div>
      </div>
    );
  }
}

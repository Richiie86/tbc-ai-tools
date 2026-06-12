import axios from 'axios';

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;
export const API = `${BACKEND_URL}/api`;

// withCredentials=true makes the browser send/receive the `tbc_session` httpOnly cookie
// on every API call. This is the new primary auth channel; we no longer touch the JWT
// from JS, eliminating the XSS-theft surface of localStorage.
const api = axios.create({
  baseURL: API,
  headers: { 'Content-Type': 'application/json' },
  withCredentials: true,
});

api.interceptors.response.use(
  (r) => r,
  (err) => {
    if (err?.response?.status === 401) {
      // soft handle in components
    }
    return Promise.reject(err);
  }
);

export default api;

// Streaming helper for chat (SSE via fetch). credentials:'include' sends the cookie.
export async function* streamChat({ session_id, message, model, variant, attachments }) {
  const res = await fetch(`${API}/chat/stream`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id, message, model, variant, attachments }),
  });
  if (!res.ok) {
    let detail = 'Request failed';
    try { const j = await res.json(); detail = j.detail || detail; } catch { /* non-JSON error body — keep default detail */ }
    throw new Error(detail);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';
    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      try {
        const ev = JSON.parse(payload);
        yield ev;
      } catch { /* skip malformed SSE frame */ }
    }
  }
}

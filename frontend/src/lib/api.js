import axios from 'axios';

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;
export const API = `${BACKEND_URL}/api`;

const api = axios.create({ baseURL: API, headers: { 'Content-Type': 'application/json' } });

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('tbc_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
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

// Streaming helper for chat (SSE via fetch)
export async function* streamChat({ session_id, message, model, variant, attachments }) {
  const token = localStorage.getItem('tbc_token');
  const res = await fetch(`${API}/chat/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
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

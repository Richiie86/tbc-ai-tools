import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import api from '../lib/api';

const AuthCtx = createContext(null);

/**
 * AuthProvider — session-cookie edition.
 *
 * The JWT lives in an `tbc_session` httpOnly cookie set by the backend on
 * login/register/2fa-verify. JavaScript never sees it, so XSS can't steal it.
 *
 * `user`:
 *   - null     → session check in flight (or just logged out)
 *   - object   → authenticated
 * `token`:
 *   - kept ONLY because a handful of legacy code paths read it from context.
 *     We populate it from the login response so those paths keep working, but
 *     it's no longer stored in localStorage or used for new requests.
 */
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const { data } = await api.get('/auth/me');
      setUser(data);
    } catch {
      // No valid cookie / 401 → simply not authenticated. Stay quiet.
      setUser(null);
      setToken(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Called by Login/Register/Verify2FA after a successful auth response.
  // `t` is the JWT — kept in memory only for legacy reads via useAuth().token.
  // The cookie is the source of truth.
  const saveToken = (t) => {
    setToken(t || null);
    if (!t) setUser(null);
  };

  const logout = async () => {
    try { await api.post('/auth/logout'); } catch { /* idempotent; ignore network errors */ }
    setToken(null);
    setUser(null);
  };

  return (
    <AuthCtx.Provider value={{ user, token, loading, setUser, saveToken, refresh, logout }}>
      {children}
    </AuthCtx.Provider>
  );
}

export function useAuth() {
  return useContext(AuthCtx);
}

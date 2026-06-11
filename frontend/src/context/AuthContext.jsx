import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import api from '../lib/api';

const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(() => localStorage.getItem('tbc_token'));
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const t = localStorage.getItem('tbc_token');
    if (!t) { setUser(null); setLoading(false); return; }
    try {
      const { data } = await api.get('/auth/me');
      setUser(data);
    } catch (e) {
      setUser(null);
      localStorage.removeItem('tbc_token');
      setToken(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const saveToken = (t) => {
    if (t) { localStorage.setItem('tbc_token', t); setToken(t); }
    else { localStorage.removeItem('tbc_token'); setToken(null); setUser(null); }
  };

  const logout = () => { saveToken(null); };

  return (
    <AuthCtx.Provider value={{ user, token, loading, setUser, saveToken, refresh, logout }}>
      {children}
    </AuthCtx.Provider>
  );
}

export function useAuth() {
  return useContext(AuthCtx);
}

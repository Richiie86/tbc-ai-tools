import React, { useEffect, useState } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import api from '../lib/api';

export default function ReferralLanding() {
  const { code } = useParams();
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!code) { setDone(true); return; }
    (async () => {
      try {
        localStorage.setItem('tbc_ref_code', code);
        await api.post('/referral/track', { code, referrer: document.referrer || null });
      } catch (err) { console.error('Referral track failed', err); }
      setDone(true);
    })();
  }, [code]);

  if (!done) return null;
  return <Navigate to="/register" replace />;
}

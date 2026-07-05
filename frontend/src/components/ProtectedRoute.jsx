import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Loader2 } from 'lucide-react';

export default function ProtectedRoute({ children, operatorOnly = false }) {
  const { user, loading } = useAuth();
  const loc = useLocation();

  if (loading) {
    return (
      <div className="grid min-h-screen place-items-center bg-ink-950">
        <Loader2 className="h-7 w-7 animate-spin text-tbc-400" />
      </div>
    );
  }
  if (!user) return <Navigate to="/login" state={{ from: loc.pathname }} replace />;
  // Bootstrap-password rotation gate: the operator is seeded with a shared
  // one-time password. Until they set their own, funnel every protected route
  // to the password settings so they can't use the app with the shared
  // credential still live. Allow /settings itself so they can actually rotate.
  if (user.must_change_password && !loc.pathname.startsWith('/settings')) {
    return <Navigate to="/settings?section=password" replace />;
  }
  if (operatorOnly && user.role !== 'operator') return <Navigate to="/dashboard" replace />;
  return children;
}

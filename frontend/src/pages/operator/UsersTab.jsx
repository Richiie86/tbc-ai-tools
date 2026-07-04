import React, { useMemo, useState, useEffect } from 'react';
import { Search, KeyRound, ArrowRight } from 'lucide-react';
import { toast } from 'sonner';
import api from '../../lib/api';
import { Input } from '../../components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '../../components/ui/select';
import { UsersBulkToolbar } from './users/UsersBulkToolbar';
import { UsersTable } from './users/UsersTable';

/**
 * Surfaces open Bring Your Own Keys requests at the top of the Users tab so
 * they aren't missed. Operators also get an in-app notification when one comes
 * in; this banner is the actionable list. Clicking one jumps to that user so
 * the operator can approve + set a price in their profile.
 */
function ByokEnquiriesBanner({ onOpenUser }) {
  const [enquiries, setEnquiries] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const { data } = await api.get('/operator/byok/enquiries?status=open');
      setEnquiries(Array.isArray(data) ? data : []);
    } catch { /* non-fatal — banner just stays hidden */ }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  if (loading || enquiries.length === 0) return null;

  return (
    <div className="mb-3 rounded-xl border border-tbc-500/30 bg-tbc-500/5 p-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-tbc-100">
        <KeyRound className="h-3.5 w-3.5 text-tbc-300" />
        Bring Your Own Keys — {enquiries.length} open request{enquiries.length === 1 ? '' : 's'}
      </div>
      <ul className="space-y-1.5">
        {enquiries.map((e) => (
          <li key={e.id}
            className="flex items-center justify-between gap-3 rounded-lg border border-tbc-900/50 bg-ink-950/60 px-3 py-2">
            <div className="min-w-0">
              <div className="truncate text-xs font-medium text-tbc-50">
                {e.user_email || e.user_name || e.user_id}
                {e.company ? <span className="text-tbc-200/60"> · {e.company}</span> : null}
              </div>
              {e.message ? (
                <div className="truncate text-[11px] text-tbc-200/60">{e.message}</div>
              ) : null}
              <div className="text-[10px] text-tbc-200/40">
                {e.created_at ? new Date(e.created_at).toLocaleString() : ''}
              </div>
            </div>
            <button
              onClick={() => onOpenUser?.(e.user_email || '')}
              className="flex shrink-0 items-center gap-1 rounded-md bg-tbc-500 px-2.5 py-1 text-[11px] font-semibold text-ink-950 hover:bg-tbc-400"
            >
              Review <ArrowRight className="h-3 w-3" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The Users tab content extracted from Operator.jsx. Owns the search box,
 * bulk selection state, bulk actions, per-row actions, and CSV export.
 * The parent passes the raw users list + `onChanged` callback so it can
 * refresh stats/users after any mutation.
 */
export function UsersTab({ users, onChanged }) {
  const [userSearch, setUserSearch] = useState('');
  // 'active' (default — hides deleted), 'deleted', 'paused', or 'all'.
  const [statusFilter, setStatusFilter] = useState('active');
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  const clearSelection = () => setSelectedIds(new Set());
  const toggleSelect = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleSelectAll = (visible) => {
    setSelectedIds((prev) => {
      const allSelected = visible.every((u) => prev.has(u.id));
      if (allSelected) return new Set();
      const next = new Set(prev);
      visible.forEach((u) => next.add(u.id));
      return next;
    });
  };

  const runBulk = async (action, extra = {}) => {
    if (selectedIds.size === 0) return;
    let confirmMsg = `${action.replace('_', ' ')} ${selectedIds.size} user${selectedIds.size === 1 ? '' : 's'}?`;
    if (action === 'delete') confirmMsg += '\n\nSoft-delete keeps history but blocks login.';
    if (action === 'vanish') confirmMsg += '\n\nPERMANENT DELETE — the user documents are removed from the database. This cannot be undone.';
    if (!window.confirm(confirmMsg)) return;
    setBulkBusy(true);
    try {
      const { data } = await api.post('/operator/users/bulk', {
        user_ids: Array.from(selectedIds), action, ...extra,
      });
      const okCount = (data.ok || []).length;
      const skippedCount = (data.skipped || []).length;
      toast.success(`${okCount} updated${skippedCount ? ` · ${skippedCount} skipped` : ''}`);
      clearSelection();
      onChanged?.();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Bulk action failed');
    } finally {
      setBulkBusy(false);
    }
  };

  const exportSelectedCsv = () => {
    if (selectedIds.size === 0) return;
    const rows = users.filter((u) => selectedIds.has(u.id));
    const escape = (v) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ['email', 'name', 'plan', 'credits', 'status', 'role', 'totp_enabled', 'joined'];
    const lines = [header.join(',')];
    for (const u of rows) {
      lines.push([
        escape(u.email),
        escape(u.name || ''),
        escape(u.plan || ''),
        escape(u.credits ?? 0),
        escape(u.deleted_at ? 'deleted' : (u.status || 'active')),
        escape(u.role || 'user'),
        escape(u.totp_enabled ? 'yes' : 'no'),
        escape(u.created_at ? new Date(u.created_at).toISOString() : ''),
      ].join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tbc-users-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success(`Exported ${rows.length} user${rows.length === 1 ? '' : 's'} to CSV`);
  };

  const grantCredits = async (userId, amount) => {
    try {
      await api.post(`/operator/users/${userId}/credits?amount=${amount}`);
      const verb = amount >= 0 ? 'Granted' : 'Removed';
      toast.success(`${verb} ${Math.abs(amount).toLocaleString()} credit${Math.abs(amount) === 1 ? '' : 's'}`);
      onChanged?.();
    } catch { toast.error('Could not adjust credits'); }
  };
  const setPlan = async (userId, plan) => {
    try {
      const { data } = await api.post(`/operator/users/${userId}/plan?plan=${plan}`);
      toast.success(`Plan set to ${plan}` + (data.credits_added ? ` (+${data.credits_added} credits)` : ''));
      onChanged?.();
    } catch { toast.error('Could not change plan'); }
  };
  const reset2FA = async (userId, email) => {
    if (!window.confirm(`Reset 2FA for ${email}?\n\nThe user will be asked to re-enrol on next login.`)) return;
    try {
      await api.post(`/operator/users/${userId}/reset-2fa`);
      toast.success(`2FA reset for ${email}`);
      onChanged?.();
    } catch (e) { toast.error(e?.response?.data?.detail || 'Could not reset 2FA'); }
  };
  const togglePause = async (userId, email, currentStatus) => {
    const action = currentStatus === 'paused' ? 'resume' : 'pause';
    if (!window.confirm(`${action === 'pause' ? 'Pause' : 'Resume'} ${email}?\n\n${
      action === 'pause' ? 'They will be blocked from logging in until resumed.' : 'They will be able to log in again.'
    }`)) return;
    try {
      const { data } = await api.post(`/operator/users/${userId}/pause`);
      toast.success(`${email} is now ${data.status}`);
      onChanged?.();
    } catch (e) { toast.error(e?.response?.data?.detail || `Could not ${action} user`); }
  };
  const deleteUser = async (userId, email) => {
    if (!window.confirm(`Delete ${email}?\n\nThis soft-deletes the account (keeps transaction history, blocks login). The action cannot be undone from the UI.`)) return;
    try {
      await api.post(`/operator/users/${userId}/delete`);
      toast.success(`${email} deleted`);
      onChanged?.();
    } catch (e) { toast.error(e?.response?.data?.detail || 'Could not delete user'); }
  };
  const restoreUser = async (userId, email) => {
    try {
      const { data } = await api.post(`/operator/users/${userId}/restore`);
      toast.success(data?.already_active ? `${email} was already active` : `${email} restored`);
      onChanged?.();
    } catch (e) { toast.error(e?.response?.data?.detail || 'Could not restore user'); }
  };
  const vanishUser = async (userId, email) => {
    // The UsersTable AlertDialog already required typing the email — we
    // re-send it on the wire so the backend re-verifies (defense in depth).
    try {
      await api.post(`/operator/users/${userId}/vanish`, { confirm_email: email });
      toast.success(`${email} permanently deleted`);
      onChanged?.();
    } catch (e) { toast.error(e?.response?.data?.detail || 'Could not vanish user'); }
  };
  const toggleDeploy = async (userId, nextCanDeploy) => {
    try {
      await api.patch(`/operator/users/${userId}/deploy-access`, { can_deploy: nextCanDeploy });
      toast.success(nextCanDeploy ? 'Deploy access granted' : 'Deploy access revoked');
      onChanged?.();
    } catch (e) { toast.error(e?.response?.data?.detail || 'Could not update deploy access'); }
  };

  const filteredUsers = useMemo(() => {
    const q = userSearch.trim().toLowerCase();
    let list = users;
    if (statusFilter === 'active') {
      list = list.filter((u) => !u.deleted_at && u.status !== 'deleted' && u.status !== 'paused');
    } else if (statusFilter === 'deleted') {
      list = list.filter((u) => u.deleted_at || u.status === 'deleted');
    } else if (statusFilter === 'paused') {
      list = list.filter((u) => !u.deleted_at && u.status === 'paused');
    }
    // 'all' → no status filter
    if (!q) return list;
    return list.filter(
      (u) => u.email.toLowerCase().includes(q) || (u.name || '').toLowerCase().includes(q),
    );
  }, [users, userSearch, statusFilter]);

  const reviewEnquiry = (email) => {
    if (email) {
      setUserSearch(email);
      setStatusFilter('all');
      toast.message('Showing the requesting account below — open it to approve BYOK.');
    }
  };

  return (
    <>
      <ByokEnquiriesBanner onOpenUser={reviewEnquiry} />

      <div className="mb-3 flex items-center gap-3">
        <div className="relative w-72">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-tbc-200/40" />
          <Input
            value={userSearch}
            onChange={(e) => setUserSearch(e.target.value)}
            placeholder="Search by email or name..."
            className="border-tbc-900/60 bg-ink-900 pl-9 text-tbc-100"
          />
        </div>
        <div className="text-xs text-tbc-200/60">
          {filteredUsers.length} of {users.length} users
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger
            data-testid="users-status-filter"
            className="h-9 w-36 border-tbc-900/60 bg-ink-900 text-tbc-100"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="border-tbc-900/60 bg-ink-900 text-tbc-100">
            <SelectItem value="active" className="focus:bg-ink-950">Active only</SelectItem>
            <SelectItem value="paused" className="focus:bg-ink-950">Paused</SelectItem>
            <SelectItem value="deleted" className="focus:bg-ink-950">Deleted</SelectItem>
            <SelectItem value="all" className="focus:bg-ink-950">All (incl. deleted)</SelectItem>
          </SelectContent>
        </Select>
        {selectedIds.size > 0 && (
          <button
            data-testid="bulk-clear"
            onClick={clearSelection}
            className="ml-auto rounded border border-tbc-900/60 bg-ink-900 px-2 py-1 text-[11px] text-tbc-200 hover:bg-ink-950"
          >
            Clear selection
          </button>
        )}
      </div>

      <UsersBulkToolbar
        selectedCount={selectedIds.size}
        bulkBusy={bulkBusy}
        onExportCsv={exportSelectedCsv}
        onPause={() => runBulk('pause')}
        onResume={() => runBulk('resume')}
        onGrantCredits={(credits) => runBulk('grant_credits', { credits })}
        onSetPlan={(plan) => runBulk('set_plan', { plan })}
        onDelete={() => runBulk('delete')}
        onRestore={() => runBulk('restore')}
        onVanish={() => runBulk('vanish')}
      />

      <UsersTable
        users={filteredUsers}
        selectedIds={selectedIds}
        onToggleSelect={toggleSelect}
        onToggleSelectAll={toggleSelectAll}
        onGrantCredits={grantCredits}
        onSetPlan={setPlan}
        onReset2FA={reset2FA}
        onTogglePause={togglePause}
        onDelete={deleteUser}
        onRestore={restoreUser}
        onVanish={vanishUser}
        onToggleDeploy={toggleDeploy}
      />
    </>
  );
}

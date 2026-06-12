import React from 'react';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '../../../components/ui/table';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '../../../components/ui/select';
import { Button } from '../../../components/ui/button';

const PLANS = ['free', 'starter', 'pro', 'enterprise'];

function StatusPill({ user }) {
  if (user.deleted_at) {
    return <span className="rounded-full bg-rose-500/15 px-2 py-0.5 text-[10px] uppercase tracking-wider text-rose-300">Deleted</span>;
  }
  if (user.status === 'paused') {
    return <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] uppercase tracking-wider text-amber-300">Paused</span>;
  }
  return <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] uppercase tracking-wider text-emerald-300">Active</span>;
}

/**
 * Users table — header with bulk-select checkbox, per-row checkboxes, and the
 * per-user inline actions (grant credits, reset 2FA, pause/resume, delete).
 */
export function UsersTable({
  users, selectedIds, onToggleSelect, onToggleSelectAll,
  onGrantCredits, onSetPlan, onReset2FA, onTogglePause, onDelete,
}) {
  const allSelected = users.length > 0 && users.every((u) => selectedIds.has(u.id));
  return (
    <div className="rounded-xl border border-tbc-900/60 bg-ink-900/40">
      <Table>
        <TableHeader>
          <TableRow className="border-tbc-900/60 hover:bg-transparent">
            <TableHead className="w-10">
              <input
                type="checkbox"
                data-testid="bulk-select-all"
                className="h-4 w-4 cursor-pointer accent-tbc-500"
                checked={allSelected}
                onChange={() => onToggleSelectAll(users)}
              />
            </TableHead>
            <TableHead>Email</TableHead>
            <TableHead>Name</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Plan</TableHead>
            <TableHead>Credits</TableHead>
            <TableHead>2FA</TableHead>
            <TableHead>Joined</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {users.map((u) => (
            <TableRow
              key={u.id}
              className={`border-tbc-900/60 hover:bg-ink-900/60 ${selectedIds.has(u.id) ? 'bg-tbc-500/5' : ''}`}
            >
              <TableCell>
                <input
                  type="checkbox"
                  data-testid={`bulk-select-${u.id}`}
                  className="h-4 w-4 cursor-pointer accent-tbc-500"
                  checked={selectedIds.has(u.id)}
                  onChange={() => onToggleSelect(u.id)}
                />
              </TableCell>
              <TableCell className="font-medium text-tbc-100">{u.email}</TableCell>
              <TableCell className="text-tbc-200/80">{u.name || '—'}</TableCell>
              <TableCell><StatusPill user={u} /></TableCell>
              <TableCell>
                <span className={`rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider ${
                  u.role === 'operator' ? 'bg-tbc-500/20 text-tbc-300' : 'bg-ink-900 text-tbc-200/70'
                }`}>{u.role}</span>
              </TableCell>
              <TableCell>
                <Select
                  value={u.plan}
                  onValueChange={(v) => onSetPlan(u.id, v)}
                  disabled={u.role === 'operator'}
                >
                  <SelectTrigger className="h-8 w-32 border-tbc-900/60 bg-ink-900 text-tbc-100">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="border-tbc-900/60 bg-ink-900 text-tbc-100">
                    {PLANS.map((p) => (
                      <SelectItem key={p} value={p} className="capitalize focus:bg-ink-950">{p}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </TableCell>
              <TableCell className="text-tbc-200">{u.credits?.toLocaleString()}</TableCell>
              <TableCell>{u.totp_enabled
                ? <span className="text-tbc-300">On</span>
                : <span className="text-tbc-200/40">Off</span>}</TableCell>
              <TableCell className="text-xs text-tbc-200/60">
                {u.created_at ? new Date(u.created_at).toLocaleDateString() : '—'}
              </TableCell>
              <TableCell className="text-right">
                <div className="flex justify-end gap-1.5">
                  <Button
                    size="sm" variant="outline"
                    data-testid={`op-grant-credits-${u.id}`}
                    className="border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-900/40"
                    onClick={() => onGrantCredits(u.id, 100)}
                  >
                    +100
                  </Button>
                  {u.totp_enabled && (
                    <Button
                      size="sm" variant="outline"
                      data-testid={`op-reset-2fa-${u.id}`}
                      title="Reset 2FA — user will re-enrol on next login"
                      className="border-rose-900/60 bg-ink-900 text-rose-300 hover:bg-rose-500/10"
                      onClick={() => onReset2FA(u.id, u.email)}
                    >
                      Reset 2FA
                    </Button>
                  )}
                  {u.role !== 'operator' && !u.deleted_at && (
                    <Button
                      size="sm" variant="outline"
                      data-testid={`op-pause-${u.id}`}
                      title={u.status === 'paused' ? 'Resume — allow login' : 'Pause — block login'}
                      className={u.status === 'paused'
                        ? 'border-emerald-900/60 bg-ink-900 text-emerald-300 hover:bg-emerald-500/10'
                        : 'border-amber-900/60 bg-ink-900 text-amber-300 hover:bg-amber-500/10'}
                      onClick={() => onTogglePause(u.id, u.email, u.status)}
                    >
                      {u.status === 'paused' ? 'Resume' : 'Pause'}
                    </Button>
                  )}
                  {u.role !== 'operator' && !u.deleted_at && (
                    <Button
                      size="sm" variant="outline"
                      data-testid={`op-delete-${u.id}`}
                      title="Soft-delete — blocks login, keeps audit trail"
                      className="border-rose-900/60 bg-ink-900 text-rose-300 hover:bg-rose-500/20"
                      onClick={() => onDelete(u.id, u.email)}
                    >
                      Delete
                    </Button>
                  )}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

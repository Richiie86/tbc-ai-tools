import React, { useState } from 'react';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '../../../components/ui/table';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '../../../components/ui/select';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '../../../components/ui/alert-dialog';
import { Sparkles, AlertTriangle } from 'lucide-react';
import { CreditsAdjuster } from './CreditsAdjuster';

const PLANS = ['free', 'starter', 'pro', 'enterprise'];

// Roles that must NEVER be destructible from this UI. Belt-and-suspenders
// over the backend `role == 'operator'` block: even if the data layer is
// somehow misconfigured the UI hard-hides Pause/Delete/Vanish for these.
const PROTECTED_ROLES = new Set(['operator', 'admin']);
const isProtectedRole = (u) => PROTECTED_ROLES.has(u.role);

// The seeded preview-user account used by the Test-User Banner and the
// E2E suite. Deleting it doesn't break anything permanently (it can be
// re-seeded) but it WILL break QA flows until the seeder re-runs, so we
// gate it behind a dedicated warning popup.
const SEED_TEST_EMAIL = 'preview-user@tbctools.dev';
const isSeedTestUser = (u) => (u.email || '').toLowerCase() === SEED_TEST_EMAIL;

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
  onGrantCredits, onSetPlan, onReset2FA, onTogglePause, onDelete, onRestore, onVanish,
  onToggleDeploy,
}) {
  const allSelected = users.length > 0 && users.every((u) => selectedIds.has(u.id));
  // Vanish dialog state. Single dialog at the table level so we don't mount
  // a hidden AlertDialog per row (cheaper + simpler focus management).
  const [vanishTarget, setVanishTarget] = useState(null); // { id, email }
  const [vanishConfirm, setVanishConfirm] = useState('');
  const vanishMatch = vanishTarget && vanishConfirm.trim().toLowerCase() === (vanishTarget.email || '').toLowerCase();
  // Pre-warning popup when the operator clicks Delete/Vanish on the seeded
  // preview-user account. Holds the *intended* next action so we can
  // forward to it when the operator confirms they really mean it.
  // shape: { id, email, kind: 'delete' | 'vanish' }
  const [seedWarn, setSeedWarn] = useState(null);

  // Click handlers that intercept the protected-account cases. Per-row
  // buttons call these instead of onDelete/setVanishTarget directly.
  const clickDelete = (u) => {
    if (isProtectedRole(u)) return; // belt-and-suspenders; button shouldn't render anyway
    if (isSeedTestUser(u)) { setSeedWarn({ id: u.id, email: u.email, kind: 'delete' }); return; }
    onDelete(u.id, u.email);
  };
  const clickVanish = (u) => {
    if (isProtectedRole(u)) return;
    if (isSeedTestUser(u)) { setSeedWarn({ id: u.id, email: u.email, kind: 'vanish' }); return; }
    setVanishConfirm(''); setVanishTarget({ id: u.id, email: u.email });
  };
  const seedProceed = () => {
    const w = seedWarn; setSeedWarn(null);
    if (!w) return;
    if (w.kind === 'delete') onDelete(w.id, w.email);
    else { setVanishConfirm(''); setVanishTarget({ id: w.id, email: w.email }); }
  };
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
            <TableHead title="Whether this user can hit deploy CTAs in their dashboard">Deploy</TableHead>
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
                  disabled={isProtectedRole(u)}
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
              <TableCell>
                {isProtectedRole(u) ? (
                  <span
                    data-testid={`op-deploy-implicit-${u.id}`}
                    title="Operators always have deploy access"
                    className="text-tbc-300"
                  >Always</span>
                ) : (
                  <button
                    type="button"
                    data-testid={`op-toggle-deploy-${u.id}`}
                    onClick={() => onToggleDeploy(u.id, !u.can_deploy)}
                    title={u.can_deploy
                      ? 'Click to revoke deploy access for this user'
                      : 'Click to grant deploy access for this user'}
                    className={`inline-flex h-6 w-11 items-center rounded-full border transition-colors ${
                      u.can_deploy
                        ? 'border-emerald-900/60 bg-emerald-500/30'
                        : 'border-tbc-900/60 bg-ink-950'
                    }`}
                  >
                    <span
                      className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
                        u.can_deploy ? 'translate-x-5' : 'translate-x-0.5'
                      }`}
                    />
                  </button>
                )}
              </TableCell>
              <TableCell className="text-xs text-tbc-200/60">
                {u.created_at ? new Date(u.created_at).toLocaleDateString() : '—'}
              </TableCell>
              <TableCell className="text-right">
                <div className="flex justify-end gap-1.5">
                  <CreditsAdjuster
                    userId={u.id}
                    currentCredits={u.credits}
                    onGrant={onGrantCredits}
                  />
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
                  {!isProtectedRole(u) && !u.deleted_at && (
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
                  {!isProtectedRole(u) && !u.deleted_at && (
                    <Button
                      size="sm" variant="outline"
                      data-testid={`op-delete-${u.id}`}
                      title="Soft-delete — blocks login, keeps audit trail"
                      className="border-rose-900/60 bg-ink-900 text-rose-300 hover:bg-rose-500/20"
                      onClick={() => clickDelete(u)}
                    >
                      Delete
                    </Button>
                  )}
                  {!isProtectedRole(u) && u.deleted_at && (
                    <Button
                      size="sm" variant="outline"
                      data-testid={`op-restore-${u.id}`}
                      title="Restore — clears deleted_at and re-activates this account"
                      className="border-emerald-900/60 bg-ink-900 text-emerald-300 hover:bg-emerald-500/20"
                      onClick={() => onRestore(u.id, u.email)}
                    >
                      Restore
                    </Button>
                  )}
                  {!isProtectedRole(u) && (
                    <Button
                      size="sm" variant="outline"
                      data-testid={`op-vanish-${u.id}`}
                      title="Permanent delete — vanish this account from the database. Cannot be undone."
                      className="border-rose-500/60 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20"
                      onClick={() => clickVanish(u)}
                    >
                      <Sparkles className="mr-1 h-3 w-3" />
                      Vanish
                    </Button>
                  )}
                  {isProtectedRole(u) && (
                    <span
                      data-testid={`op-protected-${u.id}`}
                      title={`${u.role} accounts are protected — they cannot be paused, deleted, or vanished from this UI`}
                      className="inline-flex items-center gap-1 rounded-full bg-tbc-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-tbc-300"
                    >
                      🔒 Protected
                    </span>
                  )}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {/* Pre-warning when the operator clicks Delete or Vanish on the
          seeded preview-user account. Deleting it doesn't break anything
          permanent but it WILL break the Test-User Banner and E2E flows
          until the seeder re-runs, so we make sure it was intentional. */}
      <AlertDialog
        open={!!seedWarn}
        onOpenChange={(v) => { if (!v) setSeedWarn(null); }}
      >
        <AlertDialogContent
          data-testid="seed-user-warning-dialog"
          className="border-amber-500/40 bg-ink-950 text-tbc-100"
        >
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-amber-200">
              <AlertTriangle className="h-5 w-5" />
              Wait — this is the seeded preview-user
            </AlertDialogTitle>
            <AlertDialogDescription className="text-tbc-200/80">
              <span className="font-mono text-amber-200">{seedWarn?.email}</span> is the
              built-in QA account used by the <span className="font-semibold">Test User Banner</span>
              {' '}and the E2E test suite. {seedWarn?.kind === 'vanish'
                ? 'Permanently deleting it will break "Open as test user" until the seeder reruns.'
                : 'Soft-deleting it will block QA logins until restored or until the seeder reruns.'}
              <br /><br />
              If this was an accident, click Cancel. To continue, confirm below.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              data-testid="seed-user-warning-cancel"
              className="border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950"
            >
              Cancel — keep test user
            </AlertDialogCancel>
            <AlertDialogAction
              data-testid="seed-user-warning-continue"
              onClick={seedProceed}
              className="bg-amber-500 text-ink-950 hover:bg-amber-400 font-semibold"
            >
              I understand — continue
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Vanish (permanent-delete) confirmation. Requires the operator to
          type the target's exact email — eliminates any chance of a
          mis-clicked irreversible delete. */}
      <AlertDialog
        open={!!vanishTarget}
        onOpenChange={(v) => { if (!v) { setVanishTarget(null); setVanishConfirm(''); } }}
      >        <AlertDialogContent
          data-testid="vanish-confirm-dialog"
          className="border-rose-500/40 bg-ink-950 text-tbc-100"
        >
          <AlertDialogHeader>
            <AlertDialogTitle className="text-rose-200">
              Permanently delete {vanishTarget?.email}?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-tbc-200/70">
              This <span className="font-semibold text-rose-200">cannot be undone</span>.
              The user document is removed from the database. Audit log, referrals, and
              payment history remain as an immutable record.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="mt-2">
            <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-tbc-200/60">
              Type <span className="font-mono text-rose-300">{vanishTarget?.email}</span> to confirm
            </label>
            <Input
              data-testid="vanish-confirm-input"
              autoFocus
              value={vanishConfirm}
              onChange={(e) => setVanishConfirm(e.target.value)}
              placeholder={vanishTarget?.email}
              className="border-rose-500/40 bg-ink-900 font-mono text-tbc-100"
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel
              data-testid="vanish-cancel"
              className="border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950"
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              data-testid="vanish-confirm-btn"
              disabled={!vanishMatch}
              onClick={() => {
                const t = vanishTarget;
                setVanishTarget(null); setVanishConfirm('');
                if (t) onVanish(t.id, t.email);
              }}
              className="bg-rose-500 text-ink-950 hover:bg-rose-400 font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Vanish forever
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

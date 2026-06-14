import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, ShieldCheck, UserCheck, Trash2, MailPlus, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import api from '../../lib/api';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';

/**
 * Operator-only Security card.
 *
 * Two locked workflows, both stamped `/api/operator/security/...` so the
 * operator-only auth guard covers them:
 *   1. Pending re-registrations — held accounts whose email was
 *      previously vanished. Approve to let them log in; reject to
 *      hard-delete the held doc.
 *   2. KYC bypass allowlist — small text input where the operator
 *      drops an email that should skip KYC. 2FA is unaffected (it
 *      lives in the auth flow). Lives on `db.kyc_bypass_emails`.
 *
 * Reads via GET, writes via POST/DELETE. State is local; no Redux
 * because nothing else in the app needs to subscribe to it.
 */
export default function SecurityCard() {
  const [pending, setPending] = useState([]);
  const [pendingLoading, setPendingLoading] = useState(false);
  const [bypass, setBypass] = useState([]);
  const [bypassLoading, setBypassLoading] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [newNote, setNewNote] = useState('');
  const [adding, setAdding] = useState(false);
  const [actingId, setActingId] = useState(null);

  const loadPending = useCallback(async () => {
    setPendingLoading(true);
    try {
      const { data } = await api.get('/operator/security/pending-users');
      setPending(data?.pending || []);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not load pending users');
    } finally {
      setPendingLoading(false);
    }
  }, []);

  const loadBypass = useCallback(async () => {
    setBypassLoading(true);
    try {
      const { data } = await api.get('/operator/security/kyc-bypass');
      setBypass(data?.emails || []);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not load KYC bypass list');
    } finally {
      setBypassLoading(false);
    }
  }, []);

  useEffect(() => { loadPending(); loadBypass(); }, [loadPending, loadBypass]);

  const approve = async (u) => {
    setActingId(u.id);
    try {
      await api.post(`/operator/security/pending-users/${u.id}/approve`);
      toast.success(`Approved ${u.email}`);
      setPending((p) => p.filter((x) => x.id !== u.id));
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Approve failed');
    } finally {
      setActingId(null);
    }
  };

  const reject = async (u) => {
    if (!window.confirm(`Reject and delete ${u.email}? They will not be able to register again.`)) return;
    setActingId(u.id);
    try {
      await api.post(`/operator/security/pending-users/${u.id}/reject`);
      toast.success(`Rejected ${u.email}`);
      setPending((p) => p.filter((x) => x.id !== u.id));
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Reject failed');
    } finally {
      setActingId(null);
    }
  };

  const addBypass = async (e) => {
    e?.preventDefault?.();
    const email = newEmail.trim().toLowerCase();
    if (!email) return;
    setAdding(true);
    try {
      await api.post('/operator/security/kyc-bypass', { email, note: newNote || null });
      toast.success(`KYC bypass added for ${email}`);
      setNewEmail(''); setNewNote('');
      loadBypass();
    } catch (err) {
      toast.error(err?.response?.data?.detail || 'Could not add bypass');
    } finally {
      setAdding(false);
    }
  };

  const removeBypass = async (email) => {
    if (!window.confirm(`Remove KYC bypass for ${email}?`)) return;
    try {
      await api.delete(`/operator/security/kyc-bypass/${encodeURIComponent(email)}`);
      toast.success(`Removed ${email}`);
      setBypass((b) => b.filter((x) => x.email !== email));
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Remove failed');
    }
  };

  return (
    <div className="space-y-6">
      {/* ── Pending re-registrations ─────────────────────────────── */}
      <section
        data-testid="security-pending-users-card"
        className="rounded-2xl border border-tbc-900/60 bg-ink-900/40 p-4"
      >
        <header className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <UserCheck className="h-4 w-4 text-amber-300" />
            <h3 className="text-sm font-bold uppercase tracking-wider text-tbc-100">
              Pending re-registrations
            </h3>
            <span
              data-testid="security-pending-count"
              className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-bold uppercase text-amber-200"
            >
              {pending.length}
            </span>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={loadPending}
            disabled={pendingLoading}
            data-testid="security-pending-refresh"
            className="border-tbc-700/60 bg-ink-900 text-tbc-200 hover:bg-ink-950"
          >
            {pendingLoading ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : null}
            Refresh
          </Button>
        </header>
        <p className="mt-1 text-xs leading-relaxed text-tbc-200/70">
          Anyone signing up with an email you previously permanently deleted is held
          here until you accept them. They cannot log in until you do.
        </p>

        {pending.length === 0 ? (
          <p className="mt-3 text-[11px] text-tbc-200/50">
            No pending accounts. When a deleted email re-registers, they will appear here.
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {pending.map((u) => (
              <li
                key={u.id}
                data-testid={`security-pending-${u.id}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-tbc-900/60 bg-ink-950/60 p-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-tbc-100">{u.email}</p>
                  <p className="text-[11px] text-tbc-200/60">
                    {u.name ? `${u.name} · ` : ''}{u.reason}
                    {u.created_at ? ` · ${new Date(u.created_at).toLocaleString()}` : ''}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    size="sm"
                    onClick={() => approve(u)}
                    disabled={actingId === u.id}
                    data-testid={`security-pending-approve-${u.id}`}
                    className="bg-emerald-500 text-ink-950 hover:bg-emerald-400 font-semibold"
                  >
                    {actingId === u.id
                      ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                      : <ShieldCheck className="mr-1.5 h-3 w-3" />}
                    Accept
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => reject(u)}
                    disabled={actingId === u.id}
                    data-testid={`security-pending-reject-${u.id}`}
                    className="border-rose-500/40 bg-ink-900 text-rose-300 hover:bg-rose-500/10"
                  >
                    <Trash2 className="mr-1.5 h-3 w-3" />
                    Reject
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── KYC bypass allowlist ────────────────────────────────── */}
      <section
        data-testid="security-kyc-bypass-card"
        className="rounded-2xl border border-tbc-900/60 bg-ink-900/40 p-4"
      >
        <header className="flex items-center gap-2">
          <MailPlus className="h-4 w-4 text-sky-300" />
          <h3 className="text-sm font-bold uppercase tracking-wider text-tbc-100">
            KYC bypass
          </h3>
          <span className="rounded-full border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-[10px] font-bold uppercase text-sky-200">
            {bypass.length}
          </span>
        </header>
        <p className="mt-1 text-xs leading-relaxed text-tbc-200/70">
          Drop an email here to let the user skip KYC. <span className="font-bold text-amber-300">2FA is still required</span> — that
          gate is enforced separately. Operator-only; nobody else can edit this list.
        </p>

        <form
          onSubmit={addBypass}
          className="mt-3 flex flex-wrap items-end gap-2"
          data-testid="security-kyc-bypass-form"
        >
          <div className="grow basis-64">
            <label className="block text-[10px] font-bold uppercase tracking-wider text-tbc-200/70">Email</label>
            <Input
              type="email"
              required
              placeholder="vendor@example.com"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              data-testid="security-kyc-bypass-email-input"
              className="mt-1 bg-ink-950 border-tbc-900/60 text-tbc-100"
            />
          </div>
          <div className="grow basis-72">
            <label className="block text-[10px] font-bold uppercase tracking-wider text-tbc-200/70">Note (optional)</label>
            <Input
              type="text"
              placeholder="vendor account / internal QA / etc."
              value={newNote}
              maxLength={200}
              onChange={(e) => setNewNote(e.target.value)}
              data-testid="security-kyc-bypass-note-input"
              className="mt-1 bg-ink-950 border-tbc-900/60 text-tbc-100"
            />
          </div>
          <Button
            type="submit"
            disabled={adding || !newEmail.trim()}
            data-testid="security-kyc-bypass-add"
            className="bg-sky-500 text-ink-950 hover:bg-sky-400 font-semibold"
          >
            {adding ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : <Plus className="mr-1.5 h-3 w-3" />}
            Add
          </Button>
        </form>

        {bypassLoading && bypass.length === 0 ? (
          <p className="mt-3 text-[11px] text-tbc-200/50">Loading…</p>
        ) : bypass.length === 0 ? (
          <p className="mt-3 text-[11px] text-tbc-200/50">No emails on the bypass list yet.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {bypass.map((b) => (
              <li
                key={b.email}
                data-testid={`security-kyc-bypass-row-${b.email}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-tbc-900/60 bg-ink-950/60 p-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-tbc-100">{b.email}</p>
                  <p className="text-[11px] text-tbc-200/60">
                    {b.note ? `${b.note} · ` : ''}added by {b.added_by || 'operator'}
                    {b.created_at ? ` · ${new Date(b.created_at).toLocaleString()}` : ''}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => removeBypass(b.email)}
                  data-testid={`security-kyc-bypass-remove-${b.email}`}
                  className="border-rose-500/40 bg-ink-900 text-rose-300 hover:bg-rose-500/10"
                >
                  <X className="mr-1.5 h-3 w-3" />
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

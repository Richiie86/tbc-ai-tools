import React, { useState } from 'react';
import { Mail, Trash2, Loader2 } from 'lucide-react';
import api from '../../lib/api';
import { Button } from '../../components/ui/button';
import { toast } from 'sonner';

/**
 * Contact-form submissions list. Now supports per-row delete + bulk delete
 * so the inbox stays manageable. Calls:
 *   DELETE /api/operator/contacts/{id}                — single
 *   POST   /api/operator/contacts/bulk-delete         — `{ids:[...]}` or `{all:true}`
 *
 * Parent (`Operator.jsx`) reloads its contact list via `onChanged` so the
 * total-messages stat card and the on-screen list stay in sync after a
 * delete.
 */
export function ContactsList({ contacts, onChanged }) {
  const [busyId, setBusyId] = useState(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  const deleteOne = async (c) => {
    if (!window.confirm(`Delete message from ${c.email}?`)) return;
    setBusyId(c.id);
    try {
      await api.delete(`/operator/contacts/${c.id}`);
      toast.success('Message deleted');
      onChanged?.();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Delete failed');
    } finally {
      setBusyId(null);
    }
  };

  const deleteAll = async () => {
    if (!window.confirm(`Delete ALL ${contacts.length} message${contacts.length === 1 ? '' : 's'}? This cannot be undone.`)) return;
    setBulkBusy(true);
    try {
      const { data } = await api.post('/operator/contacts/bulk-delete', { all: true });
      toast.success(`Deleted ${data.deleted} message${data.deleted === 1 ? '' : 's'}`);
      onChanged?.();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Bulk delete failed');
    } finally {
      setBulkBusy(false);
    }
  };

  if (contacts.length === 0) {
    return (
      <div className="rounded-xl border border-tbc-900/60 bg-ink-900/40 p-8 text-center text-tbc-200/50">
        No contact submissions yet
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between rounded-lg border border-tbc-900/60 bg-ink-900/40 px-3 py-2">
        <span className="text-xs text-tbc-200/70">
          {contacts.length} message{contacts.length === 1 ? '' : 's'} · oldest first {contacts.length > 10 && 'are eating space'}
        </span>
        <Button
          size="sm"
          variant="outline"
          data-testid="contacts-delete-all"
          onClick={deleteAll}
          disabled={bulkBusy}
          className="border-rose-500/40 bg-ink-900 text-rose-200 hover:bg-rose-500/10"
        >
          {bulkBusy ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : <Trash2 className="mr-1.5 h-3 w-3" />}
          Delete all
        </Button>
      </div>
      {contacts.map((c) => (
        <div
          key={c.id}
          data-testid={`contact-${c.id}`}
          className="rounded-xl border border-tbc-900/60 bg-ink-900/40 p-5"
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm">
              <Mail className="h-4 w-4 text-tbc-400" />
              <span className="font-semibold text-tbc-100">{c.name}</span>
              <span className="text-tbc-200/60">&lt;{c.email}&gt;</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-tbc-200/50">{new Date(c.created_at).toLocaleString()}</span>
              <Button
                size="sm"
                variant="ghost"
                data-testid={`contact-delete-${c.id}`}
                onClick={() => deleteOne(c)}
                disabled={busyId === c.id}
                title="Delete this message"
                className="h-7 px-2 text-rose-300/80 hover:bg-rose-500/10 hover:text-rose-200"
              >
                {busyId === c.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
              </Button>
            </div>
          </div>
          {c.subject && <div className="mt-2 text-sm font-medium text-tbc-100">{c.subject}</div>}
          <p className="mt-2 whitespace-pre-wrap text-sm text-tbc-200/80">{c.message}</p>
        </div>
      ))}
    </div>
  );
}

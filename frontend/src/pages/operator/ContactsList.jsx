import React from 'react';
import { Mail } from 'lucide-react';

/** Contact-form submissions list rendered in the Operator → Contacts tab. */
export function ContactsList({ contacts }) {
  if (contacts.length === 0) {
    return (
      <div className="rounded-xl border border-tbc-900/60 bg-ink-900/40 p-8 text-center text-tbc-200/50">
        No contact submissions yet
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {contacts.map((c) => (
        <div key={c.id} className="rounded-xl border border-tbc-900/60 bg-ink-900/40 p-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm">
              <Mail className="h-4 w-4 text-tbc-400" />
              <span className="font-semibold text-tbc-100">{c.name}</span>
              <span className="text-tbc-200/60">&lt;{c.email}&gt;</span>
            </div>
            <span className="text-xs text-tbc-200/50">{new Date(c.created_at).toLocaleString()}</span>
          </div>
          {c.subject && <div className="mt-2 text-sm font-medium text-tbc-100">{c.subject}</div>}
          <p className="mt-2 whitespace-pre-wrap text-sm text-tbc-200/80">{c.message}</p>
        </div>
      ))}
    </div>
  );
}

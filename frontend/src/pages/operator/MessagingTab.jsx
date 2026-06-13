import React, { useCallback, useEffect, useState } from 'react';
import api from '../../lib/api';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Textarea } from '../../components/ui/textarea';
import { Switch } from '../../components/ui/switch';
import { toast } from 'sonner';
import { Loader2, Send, ShieldAlert, Users as UsersIcon, Sparkles } from 'lucide-react';

/**
 * Operator → user messaging tab.
 *
 * Two flows:
 *   • Broadcast a custom message to an audience (all / no-2FA / paid / explicit ids)
 *   • One-click "Remind users without 2FA" — pre-filled subject/body, sends to
 *     every user whose totp_enabled != true.
 */
export default function MessagingTab({ users }) {
  const [audiences, setAudiences] = useState(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [onlyNo2FA, setOnlyNo2FA] = useState(false);
  const [onlyPaid, setOnlyPaid] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendingReminder, setSendingReminder] = useState(false);
  const [singleEmail, setSingleEmail] = useState('');
  const [sendingSingle, setSendingSingle] = useState(false);

  const loadAudiences = useCallback(async () => {
    try {
      const { data } = await api.get('/operator/notify/audiences');
      setAudiences(data);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Failed to load audience counts');
    }
  }, []);

  useEffect(() => { loadAudiences(); }, [loadAudiences]);

  const recipientCount = (() => {
    if (!audiences) return 0;
    if (onlyNo2FA && onlyPaid) {
      // Approximate the intersection client-side — counts can refine on send.
      return Math.min(audiences.no_2fa, audiences.paid);
    }
    if (onlyNo2FA) return audiences.no_2fa;
    if (onlyPaid) return audiences.paid;
    return audiences.total_users;
  })();

  const broadcast = async () => {
    if (!subject.trim() || !body.trim()) {
      toast.error('Subject and body are required');
      return;
    }
    setSending(true);
    try {
      const { data } = await api.post('/operator/notify/broadcast', {
        subject, body,
        kind: 'broadcast',
        only_no_2fa: onlyNo2FA,
        only_paid: onlyPaid,
      });
      toast.success(`Sent to ${data.sent} user${data.sent === 1 ? '' : 's'}`);
      setSubject('');
      setBody('');
      loadAudiences();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Send failed');
    } finally {
      setSending(false);
    }
  };

  const sendReminder = async () => {
    setSendingReminder(true);
    try {
      const { data } = await api.post('/operator/notify/2fa-reminder', {});
      if (data.sent === 0) {
        toast.success('Everyone already has 2FA enabled. 🎉');
      } else {
        toast.success(`2FA reminder sent to ${data.sent} user${data.sent === 1 ? '' : 's'}`);
      }
      loadAudiences();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Reminder failed');
    } finally {
      setSendingReminder(false);
    }
  };

  const dmByEmail = async () => {
    if (!singleEmail.trim() || !subject.trim() || !body.trim()) {
      toast.error('Email, subject and body are required');
      return;
    }
    const target = (users || []).find((u) => u.email.toLowerCase() === singleEmail.trim().toLowerCase());
    if (!target) {
      toast.error(`No user found with email ${singleEmail}`);
      return;
    }
    setSendingSingle(true);
    try {
      await api.post(`/operator/users/${target.id}/notify`, {
        subject, body, kind: 'dm',
      });
      toast.success(`Sent DM to ${target.email}`);
      setSingleEmail('');
      setSubject('');
      setBody('');
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Send failed');
    } finally {
      setSendingSingle(false);
    }
  };

  return (
    <div className="space-y-6" data-testid="messaging-tab">
      {/* 2FA reminder fast lane */}
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
        <div className="flex items-start gap-3">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-amber-500/20 text-amber-300">
            <ShieldAlert className="h-4 w-4" />
          </div>
          <div className="flex-1">
            <div className="text-sm font-bold text-tbc-100">Remind users without 2FA</div>
            <div className="mt-1 text-xs text-tbc-200/60">
              Sends an in-app notification with setup instructions to every user whose 2FA
              is still off. {audiences && (
                <span className="font-semibold text-amber-300">
                  {audiences.no_2fa} of {audiences.total_users} user{audiences.total_users === 1 ? '' : 's'} pending.
                </span>
              )}
            </div>
          </div>
          <Button
            onClick={sendReminder}
            disabled={sendingReminder || (audiences && audiences.no_2fa === 0)}
            data-testid="messaging-send-2fa-reminder"
            className="bg-amber-500 text-ink-950 font-semibold hover:bg-amber-400"
          >
            {sendingReminder ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ShieldAlert className="mr-1.5 h-4 w-4" />}
            Send reminder
          </Button>
        </div>
      </div>

      {/* Composer */}
      <div className="rounded-xl border border-tbc-900/60 bg-ink-900/60 p-5">
        <div className="mb-4 flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-tbc-300" />
          <h3 className="text-base font-bold text-tbc-100">Compose a message</h3>
        </div>

        <div className="space-y-3">
          <Field label="Subject">
            <Input
              data-testid="messaging-subject-input"
              className="bg-ink-950 border-tbc-900/60 text-tbc-100"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="A short, scannable headline"
            />
          </Field>
          <Field label="Body">
            <Textarea
              rows={5}
              data-testid="messaging-body-input"
              className="bg-ink-950 border-tbc-900/60 text-tbc-100"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="The full message your users will read in their notifications inbox."
            />
          </Field>
        </div>

        <div className="mt-5 grid gap-3 md:grid-cols-2">
          {/* Broadcast lane */}
          <div className="rounded-lg border border-tbc-900/60 bg-ink-950/60 p-3">
            <div className="mb-2 flex items-center gap-2">
              <UsersIcon className="h-4 w-4 text-tbc-300" />
              <span className="text-xs font-bold uppercase tracking-wider text-tbc-200">Broadcast</span>
            </div>
            <div className="space-y-2 text-xs">
              <label className="flex items-center justify-between">
                <span className="text-tbc-200">Only users without 2FA</span>
                <Switch
                  checked={onlyNo2FA}
                  onCheckedChange={setOnlyNo2FA}
                  data-testid="messaging-filter-no2fa"
                />
              </label>
              <label className="flex items-center justify-between">
                <span className="text-tbc-200">Only paid users</span>
                <Switch
                  checked={onlyPaid}
                  onCheckedChange={setOnlyPaid}
                  data-testid="messaging-filter-paid"
                />
              </label>
            </div>
            <Button
              onClick={broadcast}
              disabled={sending}
              data-testid="messaging-broadcast-btn"
              className="mt-3 w-full bg-tbc-500 text-ink-950 font-semibold hover:bg-tbc-400"
            >
              {sending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-1.5 h-4 w-4" />}
              Send to {recipientCount.toLocaleString()} user{recipientCount === 1 ? '' : 's'}
            </Button>
          </div>

          {/* DM by email */}
          <div className="rounded-lg border border-tbc-900/60 bg-ink-950/60 p-3">
            <div className="mb-2 flex items-center gap-2">
              <Send className="h-4 w-4 text-tbc-300" />
              <span className="text-xs font-bold uppercase tracking-wider text-tbc-200">Direct message</span>
            </div>
            <Input
              data-testid="messaging-single-email"
              type="email"
              list="messaging-user-emails"
              placeholder="user@example.com"
              value={singleEmail}
              onChange={(e) => setSingleEmail(e.target.value)}
              className="bg-ink-950 border-tbc-900/60 text-xs text-tbc-100"
            />
            <datalist id="messaging-user-emails">
              {(users || []).map((u) => <option key={u.id} value={u.email} />)}
            </datalist>
            <p className="mt-1.5 text-[10px] text-tbc-200/50">
              Type or pick an email — uses the subject &amp; body above.
            </p>
            <Button
              onClick={dmByEmail}
              disabled={sendingSingle || !singleEmail}
              data-testid="messaging-send-dm-btn"
              className="mt-3 w-full bg-ink-900 border border-tbc-900/60 text-tbc-100 font-semibold hover:bg-ink-950"
            >
              {sendingSingle ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-1.5 h-4 w-4" />}
              Send DM
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <label className="text-[10px] font-semibold uppercase tracking-wider text-tbc-200/60">{label}</label>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

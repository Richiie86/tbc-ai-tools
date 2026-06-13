import React, { useCallback, useEffect, useState } from 'react';
import api from '../../lib/api';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Textarea } from '../../components/ui/textarea';
import { Switch } from '../../components/ui/switch';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '../../components/ui/alert-dialog';
import { toast } from 'sonner';
import {
  Brain, Plus, Loader2, Trash2, Save, Sparkles, CheckCircle2, XCircle, FileText, Archive,
} from 'lucide-react';

/**
 * Operator-managed "AI Learnings" tab.
 *
 * Every enabled entry is auto-injected into the chat SYSTEM_PROMPT so all
 * models share the same accumulated knowledge. The auto-self-learner
 * (server.py → ai_learnings_auto.py) drops new proposals in here with
 * enabled=false; the operator approves, edits, or deletes them.
 */
export default function AILearningsTab() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newText, setNewText] = useState('');
  const [adding, setAdding] = useState(false);
  const [savingId, setSavingId] = useState(null);
  const [edits, setEdits] = useState({}); // id -> draft text
  const [confirmDelete, setConfirmDelete] = useState(null); // item pending deletion
  const [digest, setDigest] = useState(null); // {markdown, count, fallback} or null
  const [digestLoading, setDigestLoading] = useState(false);
  const [includeArchived, setIncludeArchived] = useState(false);
  // Per-operator GC window (days). Persisted to localStorage so toggling
  // back to the tab keeps the setting. Backend default is 14.
  const [gcDays, setGcDays] = useState(() => {
    const raw = parseInt(localStorage.getItem('ai_learnings_gc_days') || '14', 10);
    return Number.isFinite(raw) && raw > 0 && raw <= 365 ? raw : 14;
  });
  const [gcRunning, setGcRunning] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/operator/ai-learnings', {
        params: { include_archived: includeArchived },
      });
      setItems(data || []);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Failed to load learnings');
    } finally {
      setLoading(false);
    }
  }, [includeArchived]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    localStorage.setItem('ai_learnings_gc_days', String(gcDays));
  }, [gcDays]);

  const runGc = async () => {
    setGcRunning(true);
    try {
      const { data } = await api.post('/operator/ai-learnings/gc', null, {
        params: { days: gcDays },
      });
      const n = data?.archived_count || 0;
      toast.success(
        n === 0
          ? `Nothing to archive — no auto-proposals older than ${gcDays} days`
          : `Archived ${n} stale auto-proposal${n === 1 ? '' : 's'}`,
      );
      load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'GC failed');
    } finally {
      setGcRunning(false);
    }
  };

  const addLearning = async () => {
    const text = newText.trim();
    if (text.length < 4) {
      toast.error('Learning must be at least 4 characters');
      return;
    }
    setAdding(true);
    try {
      await api.post('/operator/ai-learnings', { text, enabled: true });
      setNewText('');
      toast.success('Learning added — all AI models will pick it up on next reply');
      load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Add failed');
    } finally {
      setAdding(false);
    }
  };

  const toggleEnabled = async (item) => {
    setSavingId(item.id);
    try {
      await api.patch(`/operator/ai-learnings/${item.id}`, { enabled: !item.enabled });
      setItems((cur) => cur.map((i) => (i.id === item.id ? { ...i, enabled: !item.enabled } : i)));
      toast.success(`Learning ${!item.enabled ? 'enabled' : 'disabled'}`);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Update failed');
    } finally {
      setSavingId(null);
    }
  };

  const saveEdit = async (item) => {
    const text = (edits[item.id] || '').trim();
    if (text.length < 4) {
      toast.error('Learning must be at least 4 characters');
      return;
    }
    setSavingId(item.id);
    try {
      await api.patch(`/operator/ai-learnings/${item.id}`, { text });
      setItems((cur) => cur.map((i) => (i.id === item.id ? { ...i, text } : i)));
      setEdits((cur) => { const n = { ...cur }; delete n[item.id]; return n; });
      toast.success('Learning updated');
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Update failed');
    } finally {
      setSavingId(null);
    }
  };

  const deleteItem = async (item) => {
    setSavingId(item.id);
    try {
      await api.delete(`/operator/ai-learnings/${item.id}`);
      setItems((cur) => cur.filter((i) => i.id !== item.id));
      toast.success('Deleted');
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Delete failed');
    } finally {
      setSavingId(null);
      setConfirmDelete(null);
    }
  };

  const approveProposal = async (item) => {
    // For auto-proposed items (enabled=false), one-click approve flips enabled=true
    setSavingId(item.id);
    try {
      await api.patch(`/operator/ai-learnings/${item.id}`, { enabled: true });
      setItems((cur) => cur.map((i) => (i.id === item.id ? { ...i, enabled: true } : i)));
      toast.success('Approved — AI will use this on the next reply');
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Approve failed');
    } finally {
      setSavingId(null);
    }
  };

  const generateDigest = async () => {
    setDigestLoading(true);
    setDigest(null);
    try {
      const { data } = await api.get('/operator/ai-learnings/digest', { params: { weeks: 1 } });
      setDigest(data);
      if (data.count === 0) {
        toast.info('No new learnings in the last week');
      } else {
        toast.success(`Digest ready · ${data.count} learning${data.count === 1 ? '' : 's'} summarised`);
      }
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Digest generation failed');
    } finally {
      setDigestLoading(false);
    }
  };

  const proposals = items.filter((i) => !i.enabled);
  const active = items.filter((i) => i.enabled);

  return (
    <div className="space-y-5" data-testid="ai-learnings-tab">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-base font-bold text-tbc-100">
            <Brain className="h-4 w-4 text-tbc-300" />
            AI Learnings — shared across every model
          </h3>
          <p className="mt-1 text-sm text-tbc-200/60">
            Every enabled entry is appended to the chat <code className="text-tbc-100">SYSTEM_PROMPT</code> so
            Claude, GPT, and Gemini share the same accumulated knowledge. The auto-learner watches conversations
            and drops new proposals here as <em>pending</em> — approve them with one click.
          </p>
        </div>
        <Button
          onClick={generateDigest}
          disabled={digestLoading}
          data-testid="ai-learnings-digest-btn"
          variant="outline"
          className="shrink-0 border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950"
        >
          {digestLoading
            ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Generating…</>
            : <><FileText className="mr-1.5 h-4 w-4" />Weekly digest</>}
        </Button>
      </div>

      {/* GC controls — operator-tuned archive window for unapproved
          auto-proposals. Backend default is 14 days; this UI persists the
          operator's preference to localStorage and lets them archive on
          demand without waiting for the nightly scheduler. */}
      <div
        className="flex flex-wrap items-center gap-3 rounded-md border border-tbc-900/60 bg-ink-900/40 p-2.5 text-[11px] text-tbc-200/80"
        data-testid="ai-learnings-gc-bar"
      >
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(e) => setIncludeArchived(e.target.checked)}
            data-testid="ai-learnings-show-archived"
          />
          Show archived
        </label>
        <div className="ml-auto flex items-center gap-2">
          <span>Archive auto-proposals older than</span>
          <Input
            type="number"
            min={1}
            max={365}
            value={gcDays}
            onChange={(e) => setGcDays(Math.max(1, Math.min(365, parseInt(e.target.value || '14', 10) || 14)))}
            data-testid="ai-learnings-gc-days"
            className="h-7 w-16 bg-ink-950 border-tbc-900/60 text-tbc-100 text-center"
          />
          <span>days</span>
          <Button
            onClick={runGc}
            disabled={gcRunning}
            data-testid="ai-learnings-gc-run"
            size="sm"
            variant="outline"
            className="h-7 border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950"
          >
            {gcRunning
              ? <Loader2 className="h-3 w-3 animate-spin" />
              : <><Archive className="mr-1 h-3 w-3" />Run GC</>}
          </Button>
        </div>
      </div>

      {digest && (
        <div
          className="rounded-lg border border-tbc-500/30 bg-tbc-500/[0.04] p-4"
          data-testid="ai-learnings-digest-output"
        >
          <div className="mb-1 flex items-center justify-between text-[11px] uppercase tracking-wider text-tbc-300">
            <span>Weekly digest · {digest.count} learning{digest.count === 1 ? '' : 's'}</span>
            <button
              onClick={() => setDigest(null)}
              className="text-tbc-200/50 hover:text-tbc-100"
              data-testid="ai-learnings-digest-close"
            >
              <XCircle className="h-3.5 w-3.5" />
            </button>
          </div>
          <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-tbc-100">
            {digest.markdown}
          </pre>
          {digest.fallback && (
            <div className="mt-2 text-[10px] text-amber-300/70">
              Deterministic fallback used — LLM was unreachable.
            </div>
          )}
        </div>
      )}

      {/* Add new learning */}
      <div className="rounded-lg border border-tbc-900/60 bg-ink-900/60 p-3" data-testid="ai-learnings-new">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-tbc-300">
          Teach the AI something new
        </div>
        <Textarea
          value={newText}
          onChange={(e) => setNewText(e.target.value)}
          placeholder='e.g. "When users ask about deployment, always point them to the Deploy button. Never write tutorials."'
          rows={3}
          data-testid="ai-learnings-new-text"
          className="bg-ink-950 border-tbc-900/60 text-tbc-100 text-sm"
        />
        <div className="mt-2 flex justify-end">
          <Button
            onClick={addLearning}
            disabled={adding || newText.trim().length < 4}
            data-testid="ai-learnings-add-btn"
            className="bg-tbc-500 text-ink-950 hover:bg-tbc-400 font-bold"
          >
            {adding ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-1.5 h-4 w-4" />}
            Add learning
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="grid place-items-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-tbc-400" />
        </div>
      ) : (
        <>
          {/* Pending proposals from the auto-learner */}
          {proposals.length > 0 && (
            <div data-testid="ai-learnings-proposals">
              <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-amber-300">
                <Sparkles className="h-3 w-3" />
                Pending auto-proposals · {proposals.length}
              </div>
              <ul className="space-y-2">
                {proposals.map((item) => (
                  <LearningRow
                    key={item.id}
                    item={item}
                    isPending
                    edits={edits}
                    setEdits={setEdits}
                    savingId={savingId}
                    onApprove={() => approveProposal(item)}
                    onToggle={() => toggleEnabled(item)}
                    onSave={() => saveEdit(item)}
                    onDelete={() => setConfirmDelete(item)}
                  />
                ))}
              </ul>
            </div>
          )}

          {/* Active learnings */}
          <div data-testid="ai-learnings-active">
            <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-emerald-300">
              <CheckCircle2 className="h-3 w-3" />
              Active learnings · {active.length}
            </div>
            {active.length === 0 ? (
              <div className="rounded-lg border border-dashed border-tbc-900/60 bg-ink-900/30 p-6 text-center text-xs text-tbc-200/50">
                No active learnings yet. Add one above, or wait for the auto-learner to suggest some
                from real conversations.
              </div>
            ) : (
              <ul className="space-y-2">
                {active.map((item) => (
                  <LearningRow
                    key={item.id}
                    item={item}
                    edits={edits}
                    setEdits={setEdits}
                    savingId={savingId}
                    onToggle={() => toggleEnabled(item)}
                    onSave={() => saveEdit(item)}
                    onDelete={() => setConfirmDelete(item)}
                  />
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      <AlertDialog
        open={!!confirmDelete}
        onOpenChange={(o) => { if (!o) setConfirmDelete(null); }}
      >
        <AlertDialogContent
          data-testid="ai-learning-delete-dialog"
          className="bg-ink-900 border-tbc-900/60 text-tbc-100"
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this learning?</AlertDialogTitle>
            <AlertDialogDescription className="text-tbc-200/70">
              The AI will stop using this on the next reply. This cannot be undone.
              {confirmDelete && (
                <span className="mt-2 block rounded bg-ink-950 p-2 font-mono text-[11px] text-tbc-100">
                  {confirmDelete.text}
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              data-testid="ai-learning-delete-cancel"
              className="border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950"
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              data-testid="ai-learning-delete-confirm"
              onClick={() => confirmDelete && deleteItem(confirmDelete)}
              className="bg-red-500 text-white hover:bg-red-600 font-bold"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function LearningRow({ item, isPending, edits, setEdits, savingId, onApprove, onToggle, onSave, onDelete }) {
  const isEditing = edits[item.id] !== undefined;
  const draft = edits[item.id] ?? item.text;
  const busy = savingId === item.id;
  return (
    <li
      data-testid={`ai-learning-${item.id}`}
      className={`rounded-md border p-2.5 ${
        isPending
          ? 'border-amber-500/40 bg-amber-500/[0.04]'
          : 'border-tbc-900/60 bg-ink-900/40'
      }`}
    >
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          {isEditing ? (
            <Textarea
              value={draft}
              onChange={(e) => setEdits((cur) => ({ ...cur, [item.id]: e.target.value }))}
              rows={2}
              data-testid={`ai-learning-edit-${item.id}`}
              className="bg-ink-950 border-tbc-900/60 text-tbc-100 text-sm"
            />
          ) : (
            <button
              type="button"
              onClick={() => setEdits((cur) => ({ ...cur, [item.id]: item.text }))}
              className="block w-full text-left text-sm text-tbc-100 hover:text-tbc-300"
              data-testid={`ai-learning-text-${item.id}`}
            >
              {item.text}
            </button>
          )}
          <div className="mt-1 text-[10px] text-tbc-200/40">
            {item.created_by || 'system'} · {item.created_at?.slice(0, 10) || '–'}
            {item.source === 'runtime_error' && (
              <span
                className="ml-1.5 rounded-full bg-red-500/15 px-1.5 py-0.5 text-[9px] text-red-300"
                title="Auto-proposed from a real runtime error after high-confidence RCA"
              >
                from error
              </span>
            )}
            {item.archived && (
              <span
                className="ml-1.5 rounded-full bg-tbc-200/15 px-1.5 py-0.5 text-[9px] text-tbc-200/60"
                title="Garbage-collected — operator never approved this auto-proposal within the GC window"
              >
                archived
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {isPending && !isEditing && (
            <Button
              size="sm"
              onClick={onApprove}
              disabled={busy}
              data-testid={`ai-learning-approve-${item.id}`}
              className="h-7 bg-emerald-500 text-ink-950 hover:bg-emerald-400 font-bold"
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <><CheckCircle2 className="mr-1 h-3 w-3" />Approve</>}
            </Button>
          )}
          {isEditing ? (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={onSave}
                disabled={busy}
                data-testid={`ai-learning-save-${item.id}`}
                className="h-7 border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950"
              >
                {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <><Save className="mr-1 h-3 w-3" />Save</>}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setEdits((cur) => { const n = { ...cur }; delete n[item.id]; return n; })}
                className="h-7 text-tbc-200/60 hover:text-tbc-100"
                data-testid={`ai-learning-cancel-${item.id}`}
              >
                <XCircle className="h-3 w-3" />
              </Button>
            </>
          ) : (
            !isPending && (
              <Switch
                checked={item.enabled}
                onCheckedChange={onToggle}
                disabled={busy}
                data-testid={`ai-learning-toggle-${item.id}`}
              />
            )
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={onDelete}
            disabled={busy}
            data-testid={`ai-learning-delete-${item.id}`}
            className="h-7 text-red-400/80 hover:text-red-300 hover:bg-red-500/10"
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </div>
    </li>
  );
}

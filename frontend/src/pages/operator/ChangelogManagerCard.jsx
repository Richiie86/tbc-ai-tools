import React, { useCallback, useEffect, useState } from 'react';
import api from '../../lib/api';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Textarea } from '../../components/ui/textarea';
import { toast } from 'sonner';
import { Megaphone, Send, Trash2, Loader2 } from 'lucide-react';

/**
 * Operator-only changelog editor — post manual entries to the in-app
 * "What's new" popover + the public `/changelog` page. Auto-promoted
 * entries from production deploys flow into the same collection, so
 * this card just adds an inline composer + delete-row action over the
 * existing `POST /api/changelog` and `DELETE /api/changelog/{id}`
 * endpoints.
 */
export default function ChangelogManagerCard() {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [tag, setTag] = useState('');
  const [posting, setPosting] = useState(false);
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/changelog?limit=15');
      setEntries(data?.entries || []);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Failed to load changelog');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const post = async () => {
    if (title.trim().length < 1) {
      toast.error('Title is required');
      return;
    }
    setPosting(true);
    try {
      await api.post('/changelog', {
        title: title.trim(),
        body_md: body.trim(),
        tag: tag.trim() || null,
      });
      toast.success('Posted to changelog');
      setTitle(''); setBody(''); setTag('');
      load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Post failed');
    } finally {
      setPosting(false);
    }
  };

  const del = async (id) => {
    if (!window.confirm('Delete this changelog entry? Public + popover will hide it immediately.')) return;
    try {
      await api.delete(`/changelog/${id}`);
      toast.success('Entry deleted');
      load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Delete failed');
    }
  };

  return (
    <div className="space-y-4" data-testid="changelog-manager-card">
      <div className="rounded-lg border border-tbc-500/30 bg-tbc-500/[0.04] p-4">
        <h4 className="flex items-center gap-2 text-sm font-bold text-tbc-100">
          <Megaphone className="h-4 w-4 text-tbc-300" /> Post a manual update
        </h4>
        <p className="mt-0.5 text-[11px] text-tbc-200/60">
          Shows up in the bell-icon popover for logged-in users and on the public
          <code className="mx-1">/changelog</code> page.
        </p>

        <div className="mt-3 space-y-2">
          <div>
            <label className="text-[10px] uppercase tracking-wider text-tbc-300">Title</label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Auto-fix loop now also handles drift alerts"
              maxLength={200}
              data-testid="changelog-title"
              className="mt-1 border-tbc-900/60 bg-ink-950 text-tbc-100 text-sm"
            />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="col-span-2">
              <label className="text-[10px] uppercase tracking-wider text-tbc-300">Body (optional)</label>
              <Textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Multi-line markdown supported (rendered as plain text in the popover)."
                rows={3}
                maxLength={8000}
                data-testid="changelog-body"
                className="mt-1 border-tbc-900/60 bg-ink-950 text-tbc-100 text-sm"
              />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider text-tbc-300">Tag (optional)</label>
              <Input
                value={tag}
                onChange={(e) => setTag(e.target.value)}
                placeholder="v1.2 or feature"
                maxLength={64}
                data-testid="changelog-tag"
                className="mt-1 border-tbc-900/60 bg-ink-950 text-tbc-100 text-sm"
              />
            </div>
          </div>
          <div className="pt-1">
            <Button
              onClick={post}
              disabled={posting || !title.trim()}
              data-testid="changelog-post"
              className="bg-tbc-500 text-ink-950 hover:bg-tbc-400 font-bold"
            >
              {posting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
              Post
            </Button>
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-tbc-900/60 bg-ink-900/40 p-4">
        <div className="text-[10px] uppercase tracking-wider text-tbc-300">Recent entries</div>
        {loading ? (
          <div className="grid place-items-center py-6">
            <Loader2 className="h-4 w-4 animate-spin text-tbc-300" />
          </div>
        ) : entries.length === 0 ? (
          <p className="mt-2 text-xs text-tbc-200/50">No entries yet.</p>
        ) : (
          <ul className="mt-2 space-y-1.5" data-testid="changelog-entries">
            {entries.map((e) => (
              <li
                key={e.id}
                className="flex items-start justify-between gap-3 rounded border border-tbc-900/60 bg-ink-950 px-3 py-2 text-xs"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-semibold text-tbc-100">{e.title}</span>
                    {e.tag && <span className="shrink-0 rounded-full bg-tbc-500/15 px-1.5 py-0.5 text-[9px] font-mono uppercase text-tbc-300">{e.tag}</span>}
                    {e.source === 'promote' && <span className="shrink-0 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[9px] text-emerald-300">deploy</span>}
                  </div>
                  <div className="text-[10px] text-tbc-200/50">{e.created_at ? new Date(e.created_at).toLocaleString() : ''}</div>
                </div>
                <button
                  type="button"
                  onClick={() => del(e.id)}
                  data-testid={`changelog-delete-${e.id}`}
                  className="rounded p-1 text-tbc-200/60 hover:bg-rose-500/10 hover:text-rose-300"
                  aria-label="Delete entry"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

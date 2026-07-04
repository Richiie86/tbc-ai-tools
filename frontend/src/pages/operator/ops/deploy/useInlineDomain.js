import { useState, useCallback } from 'react';
import { toast } from 'sonner';
import api from '../../../../lib/api';

/**
 * Inline-domain editor state machine for a single deploy project.
 *
 * Extracted out of ProjectRow.jsx so the row component focuses on layout
 * + action dispatch. Owns:
 *   - whether the editor is open (`editing`)
 *   - the draft value while typing (`draft`)
 *   - the in-flight save (`saving`)
 *   - PATCH /api/operator/deploy/{id}/domain on commit
 *
 * Usage:
 *   const dom = useInlineDomain(project, onSaved);
 *   <Input value={dom.draft} onChange={...} onKeyDown={dom.onKeyDown} />
 *   <Button onClick={dom.save}>Save</Button>
 */
export function useInlineDomain(project, onSaved) {
  const [editing, setEditing] = useState(!project.domain);
  const [draft, setDraft] = useState(project.domain || '');
  const [saving, setSaving] = useState(false);

  const save = useCallback(async () => {
    const next = draft.trim();
    if (!next) {
      toast.error('Domain required');
      return;
    }
    setSaving(true);
    try {
      const { data } = await api.patch(
        `/operator/deploy/${project.id}/domain`,
        { domain: next },
      );
      toast.success('Domain saved');
      // Surface Vercel attach status as a friendly secondary toast — the
      // backend best-effort attaches the domain on Vercel so subsequent
      // Deploy clicks can route immediately. Non-fatal if it fails.
      if (data?.vercel_attached) {
        toast.success('Attached on Vercel', { duration: 2000 });
      } else if (data?.vercel_error) {
        toast.message(`Vercel attach skipped — ${data.vercel_error}`, {
          duration: 4500,
        });
      }
      // Porkbun DNS auto-config: when connected, the backend points the
      // domain's DNS straight at Vercel so it goes live on THIS domain.
      if (data?.dns_configured) {
        toast.success('Porkbun DNS pointed at Vercel', { duration: 2500 });
      } else if (data?.dns_error) {
        toast.message(`DNS auto-setup skipped — ${data.dns_error}`, {
          duration: 4500,
        });
      }
      setEditing(false);
      // Optimistic refresh: pass the updated project doc so the parent
      // can merge it into local state without waiting for a full refetch.
      onSaved?.(data);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Save failed');
    } finally {
      setSaving(false);
    }
  }, [draft, project.id, onSaved]);

  const cancel = useCallback(() => {
    setDraft(project.domain || '');
    setEditing(false);
  }, [project.domain]);

  const onKeyDown = useCallback((e) => {
    if (e.key === 'Enter') save();
    else if (e.key === 'Escape') cancel();
  }, [save, cancel]);

  return {
    editing,
    setEditing,
    draft,
    setDraft,
    saving,
    save,
    cancel,
    onKeyDown,
  };
}

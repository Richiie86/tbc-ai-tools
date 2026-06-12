import React from 'react';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Textarea } from '../../../components/ui/textarea';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '../../../components/ui/select';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '../../../components/ui/dialog';
import { Loader2 } from 'lucide-react';
import { STAGES, stageOf } from './stages';

function Field({ label, children }) {
  return (
    <div>
      <label className="text-xs font-semibold uppercase tracking-wider text-tbc-200/60">{label}</label>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

/**
 * Create/edit dialog for a single project. Form state lives in the parent so
 * Cancel just closes the dialog without us having to mirror anything.
 */
export function ProjectFormDialog({
  open, onOpenChange, editing, form, setForm, tagsText, setTagsText,
  saving, onSave,
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-tbc-900/60 bg-ink-900 text-tbc-100 max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {editing ? 'Edit project' : `New project · ${stageOf(form.status).label}`}
          </DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <Field label="Title">
            <Input
              data-testid="projects-form-title"
              className="bg-ink-950 border-tbc-900/60 text-tbc-100"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="My awesome SaaS"
            />
          </Field>
          <Field label="Description">
            <Textarea
              rows={3}
              data-testid="projects-form-description"
              className="bg-ink-950 border-tbc-900/60 text-tbc-100"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Stage">
              <Select value={form.status} onValueChange={(v) => setForm({ ...form, status: v })}>
                <SelectTrigger
                  data-testid="projects-form-status"
                  className="bg-ink-950 border-tbc-900/60 text-tbc-100"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-ink-900 border-tbc-900/60 text-tbc-100">
                  {STAGES.map((s) => (
                    <SelectItem key={s.v} value={s.v}>{s.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Tags (comma separated)">
              <Input
                data-testid="projects-form-tags"
                className="bg-ink-950 border-tbc-900/60 text-tbc-100"
                value={tagsText}
                onChange={(e) => setTagsText(e.target.value)}
                placeholder="react, fastapi, mvp"
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="External link">
              <Input
                data-testid="projects-form-link"
                className="bg-ink-950 border-tbc-900/60 text-tbc-100"
                value={form.link_url}
                onChange={(e) => setForm({ ...form, link_url: e.target.value })}
                placeholder="https://..."
              />
            </Field>
            <Field label="Chat session id">
              <Input
                data-testid="projects-form-chat"
                className="bg-ink-950 border-tbc-900/60 text-tbc-100 font-mono text-xs"
                value={form.chat_session_id}
                onChange={(e) => setForm({ ...form, chat_session_id: e.target.value })}
                placeholder="copy from TBC dashboard URL"
              />
            </Field>
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950"
          >
            Cancel
          </Button>
          <Button
            data-testid="projects-form-save"
            onClick={onSave}
            disabled={saving}
            className="bg-tbc-500 text-ink-950 hover:bg-tbc-400 font-semibold"
          >
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

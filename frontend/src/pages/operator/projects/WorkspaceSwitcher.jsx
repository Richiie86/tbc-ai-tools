import React, { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Folder, FolderPlus, Layers, Loader2 } from 'lucide-react';
import api from '../../../lib/api';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '../../../components/ui/dialog';

/**
 * Workspace switcher shown at the top of the Projects tab.
 *
 * Two roles:
 *   1. Filter — selecting an entry restricts the cards below to projects
 *      whose `tags` contain the chosen workspace name. The special pills
 *      "all" and "default" mean "show everything" and "show only items
 *      with no workspace tag" respectively.
 *   2. Create — clicking "+ New" opens a dialog that registers a fresh
 *      workspace name via POST /operator/projects/workspaces and selects
 *      it. The new workspace will be empty until the operator either
 *      runs Clone all or moves projects into it.
 *
 * Selection persists in localStorage so reload / tab switch returns the
 * operator to the same view.
 */
export function WorkspaceSwitcher({ selected, onSelect, onAfterChange }) {
  const [workspaces, setWorkspaces] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [newName, setNewName] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/operator/projects/workspaces');
      setWorkspaces(data?.workspaces || []);
    } catch (e) {
      console.error('Failed to load workspaces', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const createWorkspace = async () => {
    const name = newName.trim().toLowerCase();
    if (!name) return;
    setCreating(true);
    try {
      const { data } = await api.post('/operator/projects/workspaces', { name });
      setWorkspaces(data?.workspaces || []);
      onSelect(name);
      onAfterChange?.();
      setDialogOpen(false);
      setNewName('');
      toast.success(`Workspace "${name}" created`);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not create workspace');
    } finally {
      setCreating(false);
    }
  };

  const pill = (value, label, Icon) => {
    const isActive = selected === value;
    return (
      <button
        key={value}
        data-testid={`workspace-pill-${value}`}
        onClick={() => onSelect(value)}
        className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12px] font-semibold transition ${
          isActive
            ? 'border-tbc-500 bg-tbc-500/15 text-tbc-100'
            : 'border-tbc-900/60 bg-ink-900 text-tbc-200/70 hover:border-tbc-500/40 hover:text-tbc-100'
        }`}
      >
        <Icon className="h-3 w-3" />
        {label}
      </button>
    );
  };

  return (
    <div
      data-testid="workspace-switcher"
      className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-tbc-900/60 bg-ink-900/50 p-2.5"
    >
      <span className="mr-1 inline-flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-tbc-200/50">
        <Layers className="h-3 w-3" /> Workspace
      </span>
      {pill('all', 'All projects', Layers)}
      {pill('default', 'Default (untagged)', Folder)}
      {loading ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin text-tbc-200/40" />
      ) : (
        workspaces.map((w) => pill(w, w, Folder))
      )}
      <Button
        data-testid="workspace-create-btn"
        size="sm"
        variant="outline"
        onClick={() => setDialogOpen(true)}
        className="ml-1 h-7 border-tbc-500/40 bg-ink-900 px-2.5 text-[11px] text-tbc-300 hover:bg-tbc-500/10"
      >
        <FolderPlus className="mr-1 h-3 w-3" />
        New
      </Button>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent
          data-testid="workspace-create-dialog"
          className="border-tbc-900/60 bg-ink-950 text-tbc-100"
        >
          <DialogHeader>
            <DialogTitle className="text-tbc-100">New workspace</DialogTitle>
            <DialogDescription className="text-tbc-200/70">
              Workspaces group related projects so you can switch between parallel
              workstreams without losing context. Names are lowercase, alphanumeric,
              dashes/underscores allowed (1-31 chars).
            </DialogDescription>
          </DialogHeader>
          <div className="mt-2">
            <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-tbc-200/60">
              Workspace name
            </label>
            <Input
              data-testid="workspace-create-input"
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. tbc2"
              onKeyDown={(e) => { if (e.key === 'Enter') createWorkspace(); }}
              className="border-tbc-900/60 bg-ink-900 font-mono text-tbc-100"
            />
            <p className="mt-2 text-[10px] text-tbc-200/50">
              Tip: after creating, use <span className="font-semibold text-tbc-200">Clone all to {newName.trim() || 'workspace'}</span> to seed it with copies of every project.
            </p>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDialogOpen(false)}
              className="border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950"
            >
              Cancel
            </Button>
            <Button
              data-testid="workspace-create-submit"
              onClick={createWorkspace}
              disabled={creating || !newName.trim()}
              className="bg-tbc-500 text-ink-950 hover:bg-tbc-400 font-semibold disabled:opacity-50"
            >
              {creating ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : null}
              Create workspace
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

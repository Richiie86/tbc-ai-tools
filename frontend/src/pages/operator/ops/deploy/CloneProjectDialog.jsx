import React, { useEffect, useState } from 'react';
import { GitFork, Loader2 } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '../../../../components/ui/dialog';
import { Button } from '../../../../components/ui/button';
import { Input } from '../../../../components/ui/input';
import { Label } from '../../../../components/ui/label';

/**
 * Shadcn-styled replacement for window.prompt() — collects a new name for
 * the cloned project. Returns the entered string (or "" for "use default")
 * to `onConfirm`. `null` is implied if the user closes via X or Cancel.
 *
 * Kept in its own file so the OpsDeploySection stays focused on layout and
 * so the dialog can be reused for other "clone with name" flows later.
 */
export function CloneProjectDialog({ open, onOpenChange, project, onConfirm, busy }) {
  const [name, setName] = useState('');

  // Reset the input every time the dialog re-opens for a different project
  // so the default name reflects the *current* source.
  useEffect(() => {
    if (open) setName(`${project.projectName} (copy)`);
  }, [open, project.projectName]);

  const submit = () => {
    onConfirm(name.trim() || undefined);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid={`clone-dialog-${project.id}`}
        className="max-w-md border-tbc-900/60 bg-ink-950 text-tbc-100"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-tbc-100">
            <GitFork className="h-4 w-4 text-tbc-300" />
            Clone project
          </DialogTitle>
          <DialogDescription className="text-tbc-200/70">
            Creates a new project on the same repo
            (<code className="rounded bg-ink-900 px-1 font-mono text-tbc-300">{project.repo}</code>)
            with a blank domain. Set the new domain on the clone before deploying.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor="clone-name" className="text-xs uppercase tracking-wider text-tbc-200/70">
            New project name
          </Label>
          <Input
            id="clone-name"
            data-testid={`clone-dialog-name-${project.id}`}
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !busy) submit(); }}
            placeholder={`${project.projectName} (copy)`}
            className="border-tbc-900/60 bg-ink-900 text-tbc-100"
          />
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
            className="border-tbc-900/60 bg-ink-900 text-tbc-200 hover:bg-ink-950"
          >
            Cancel
          </Button>
          <Button
            data-testid={`clone-dialog-confirm-${project.id}`}
            onClick={submit}
            disabled={busy}
            className="bg-tbc-500 text-ink-950 hover:bg-tbc-400 font-semibold"
          >
            {busy ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : <GitFork className="mr-1.5 h-3 w-3" />}
            Clone
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

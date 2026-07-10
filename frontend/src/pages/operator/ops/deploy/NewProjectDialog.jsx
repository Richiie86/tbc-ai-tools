import React, { useEffect, useState } from 'react';
import { Rocket, Loader2, Globe, Github } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '../../../../components/ui/dialog';
import { Button } from '../../../../components/ui/button';
import { Input } from '../../../../components/ui/input';
import { Label } from '../../../../components/ui/label';

/**
 * Operator-facing "create a deploy project" dialog. Lets a human add their
 * own GitHub repo, then launch it with Preview/Deploy from the project row.
 * A custom domain can be added now or later; Vercel still gives a vercel.app
 * URL when no custom domain is set.
 */
export function NewProjectDialog({ open, onOpenChange, onCreate, busy }) {
  const [name, setName] = useState('');
  const [repo, setRepo] = useState('');
  const [domain, setDomain] = useState('');
  const [gitRef, setGitRef] = useState('');

  // Clear the form each time it re-opens so a previous create doesn't leak.
  useEffect(() => {
    if (open) { setName(''); setRepo(''); setDomain(''); setGitRef(''); }
  }, [open]);

  const submit = () => {
    if (!name.trim() || !repo.trim()) return;
    onCreate({
      projectName: name.trim(),
      repo: repo.trim(),
      domain: domain.trim(),
      gitRef: gitRef.trim() || null,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="new-project-dialog"
        className="max-w-md border-tbc-900/60 bg-ink-950 text-tbc-100"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-tbc-100">
            <Rocket className="h-4 w-4 text-tbc-300" />
            New deploy project
          </DialogTitle>
          <DialogDescription className="text-tbc-200/70">
            Add your GitHub repo, then launch it from the project row with Preview or Deploy.
            A custom domain is optional and can be added later.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="np-name" className="text-xs uppercase tracking-wider text-tbc-200/70">
              Project name <span className="text-rose-400">*</span>
            </Label>
            <Input
              id="np-name"
              data-testid="new-project-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !busy) submit(); }}
              placeholder="My cool app"
              className="border-tbc-900/60 bg-ink-900 text-tbc-100"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="np-repo" className="text-xs uppercase tracking-wider text-tbc-200/70">
              GitHub repo <span className="text-rose-400">*</span>
            </Label>
            <div className="flex items-center gap-1.5">
              <Github className="h-3.5 w-3.5 shrink-0 text-tbc-300" />
              <Input
                id="np-repo"
                data-testid="new-project-repo"
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !busy) submit(); }}
                placeholder="Richiie86/my-app"
                className="border-tbc-900/60 bg-ink-900 font-mono text-sm text-tbc-100"
              />
            </div>
            <p className="text-[11px] text-tbc-200/50">This is the code Vercel will build when you click Preview or Deploy.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="np-domain" className="text-xs uppercase tracking-wider text-tbc-200/70">
              Domain <span className="text-tbc-200/40">(optional — can add later)</span>
            </Label>
            <div className="flex items-center gap-1.5">
              <Globe className="h-3.5 w-3.5 shrink-0 text-tbc-300" />
              <Input
                id="np-domain"
                data-testid="new-project-domain"
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !busy) submit(); }}
                placeholder="app.example.com"
                className="border-tbc-900/60 bg-ink-900 font-mono text-sm text-tbc-100"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="np-ref" className="text-xs uppercase tracking-wider text-tbc-200/70">
              Branch <span className="text-tbc-200/40">(optional)</span>
            </Label>
            <Input
              id="np-ref"
              data-testid="new-project-ref"
              value={gitRef}
              onChange={(e) => setGitRef(e.target.value)}
              placeholder="main"
              className="border-tbc-900/60 bg-ink-900 font-mono text-sm text-tbc-100"
            />
          </div>
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
            data-testid="new-project-create"
            onClick={submit}
            disabled={busy || !name.trim() || !repo.trim()}
            className="bg-tbc-500 text-ink-950 hover:bg-tbc-400 font-semibold"
          >
            {busy ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : <Rocket className="mr-1.5 h-3 w-3" />}
            Create launch project
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

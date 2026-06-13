import React, { useEffect, useState } from 'react';
import api from '../../lib/api';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Textarea } from '../../components/ui/textarea';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '../../components/ui/select';
import { toast } from 'sonner';
import {
  Bot, Loader2, Wand2, Check, X, FileCode2, ChevronDown, ChevronUp,
} from 'lucide-react';

/**
 * Ask-AI panel inside the Operator Sandbox.
 *
 * The operator types an instruction, picks a model, and the backend asks
 * the LLM for a structured JSON of file edits (path + new_content). The
 * panel renders a side-by-side preview and offers a single "Apply &
 * commit" button per file — which reuses the existing `/operator/self/file`
 * endpoint so it goes through the same review / commit / webhook flow.
 *
 * Designed to live above the current editor in SandboxTab so the operator
 * can both manually tweak and AI-tweak the same file in one session.
 */
export default function SandboxAIPanel({ openFile, draft, onApplyToEditor, branch }) {
  const [collapsed, setCollapsed] = useState(true);
  const [models, setModels] = useState([]);
  const [model, setModel] = useState('claude-sonnet-4-6');
  const [instruction, setInstruction] = useState('');
  const [proposing, setProposing] = useState(false);
  const [proposal, setProposal] = useState(null); // { files:[{path,new_content,reason}], notes, model, session_id }
  const [applying, setApplying] = useState(null); // path being committed

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await api.get('/operator/sandbox/ai/models');
        if (cancelled) return;
        setModels(data.models || []);
        if (data.default) setModel(data.default);
      } catch (e) {
        // Non-fatal — operator may not yet have configured the universal key.
        console.warn('Sandbox AI models load failed', e);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const propose = async () => {
    if (!openFile) {
      toast.error('Open a file first — the AI uses it as context');
      return;
    }
    if (instruction.trim().length < 4) {
      toast.error('Describe what you want the AI to change');
      return;
    }
    setProposing(true);
    setProposal(null);
    try {
      const { data } = await api.post('/operator/sandbox/ai/propose', {
        instruction: instruction.trim(),
        // Send the *current draft* as context, not the saved file body,
        // so the operator can iterate AI suggestions on top of their
        // unsaved edits.
        files: [{ path: openFile.path, content: draft || '' }],
        model,
        edit_mode: 'single',
      });
      setProposal(data);
      if (!data.files?.length) {
        toast.info(data.notes || 'AI returned no file changes');
      } else {
        toast.success(`AI proposed changes to ${data.files.length} file(s)`);
      }
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'AI proposal failed');
    } finally {
      setProposing(false);
    }
  };

  const applyToEditor = (file) => {
    if (!onApplyToEditor) return;
    onApplyToEditor(file.new_content);
    toast.success(`Pulled ${file.path} into the editor — review then click "Save commit"`);
  };

  const applyAndCommit = async (file) => {
    if (!openFile) return;
    if (!window.confirm(`Commit AI changes to ${file.path} on ${branch || 'main'}?\nThis triggers an auto-deploy via the GitHub webhook.`)) return;
    setApplying(file.path);
    try {
      await api.put('/operator/self/file', {
        path: file.path,
        content: file.new_content,
        sha: openFile.sha,
        message: `sandbox-ai: ${instruction.slice(0, 60)}`,
      });
      toast.success(`Committed — auto-deploy in flight`);
      // Push into the in-memory editor so the operator sees the latest
      // body without a manual reload.
      if (onApplyToEditor) onApplyToEditor(file.new_content);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Commit failed');
    } finally {
      setApplying(null);
    }
  };

  return (
    <div className="rounded-lg border border-tbc-500/40 bg-tbc-500/[0.05] p-3" data-testid="sandbox-ai-panel">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="flex w-full items-center justify-between text-left"
        data-testid="sandbox-ai-toggle"
      >
        <div className="flex items-center gap-2">
          <Bot className="h-4 w-4 text-tbc-300" />
          <span className="text-sm font-bold text-tbc-100">Ask AI to code this for me</span>
          <span className="hidden sm:inline text-[10px] text-tbc-200/50">
            — picks a model, edits the open file, previews the diff before committing
          </span>
        </div>
        {collapsed ? <ChevronDown className="h-4 w-4 text-tbc-300" /> : <ChevronUp className="h-4 w-4 text-tbc-300" />}
      </button>

      {!collapsed && (
        <div className="mt-3 space-y-3">
          {!openFile && (
            <div className="rounded border border-amber-500/40 bg-amber-500/[0.06] p-2 text-[11px] text-amber-200">
              Open a file on the left first — the AI uses it as the only source of context.
            </div>
          )}
          <div className="grid gap-2 sm:grid-cols-[1fr_220px]">
            <Textarea
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder='e.g. "Add a dark-mode toggle button to the top-right of this component"'
              rows={3}
              data-testid="sandbox-ai-instruction"
              className="bg-ink-950 border-tbc-900/60 text-tbc-100 text-sm"
            />
            <div className="space-y-2">
              <Select value={model} onValueChange={setModel}>
                <SelectTrigger data-testid="sandbox-ai-model" className="bg-ink-950 border-tbc-900/60 text-tbc-100">
                  <SelectValue placeholder="Pick a model" />
                </SelectTrigger>
                <SelectContent className="bg-ink-900 text-tbc-100 border-tbc-900/60">
                  {models.length === 0 ? (
                    <SelectItem value={model} disabled>Loading…</SelectItem>
                  ) : (
                    models.map((m) => (
                      <SelectItem key={m.id} value={m.id} data-testid={`sandbox-ai-model-${m.id}`}>
                        {m.display}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
              <Button
                onClick={propose}
                disabled={proposing || !openFile || instruction.trim().length < 4}
                data-testid="sandbox-ai-propose"
                className="w-full bg-tbc-500 text-ink-950 hover:bg-tbc-400 font-bold"
              >
                {proposing
                  ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Thinking…</>
                  : <><Wand2 className="mr-1.5 h-4 w-4" />Propose changes</>}
              </Button>
            </div>
          </div>

          {proposal && (
            <div className="space-y-2" data-testid="sandbox-ai-proposal">
              <div className="rounded border border-tbc-900/60 bg-ink-900/60 p-2 text-[11px] text-tbc-200">
                <strong className="text-tbc-100">AI notes:</strong> {proposal.notes || '—'}
                <span className="ml-2 text-tbc-200/50">via {proposal.model}</span>
              </div>
              {proposal.files.length === 0 ? (
                <div className="rounded border border-dashed border-tbc-900/60 p-3 text-center text-xs text-tbc-200/50">
                  The model didn't propose any file edits this time.
                </div>
              ) : (
                <ul className="space-y-2">
                  {proposal.files.map((f) => (
                    <li
                      key={f.path}
                      data-testid={`sandbox-ai-file-${f.path}`}
                      className="rounded border border-tbc-900/60 bg-ink-900/40 p-2"
                    >
                      <div className="flex items-start gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 truncate text-[12px] font-mono text-tbc-100">
                            <FileCode2 className="h-3 w-3 text-tbc-300" />
                            {f.path}
                          </div>
                          {f.reason && (
                            <div className="mt-0.5 text-[11px] text-tbc-200/60">{f.reason}</div>
                          )}
                          <details className="mt-1.5">
                            <summary className="cursor-pointer text-[10px] text-tbc-300 hover:text-tbc-100">
                              Preview new content ({f.new_content.length} chars)
                            </summary>
                            <pre className="mt-1.5 max-h-64 overflow-auto rounded bg-ink-950 p-2 text-[10px] leading-snug text-tbc-100">
                              {f.new_content}
                            </pre>
                          </details>
                        </div>
                        <div className="flex flex-col gap-1.5 shrink-0">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => applyToEditor(f)}
                            data-testid={`sandbox-ai-load-${f.path}`}
                            className="h-7 border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950"
                          >
                            Load into editor
                          </Button>
                          <Button
                            size="sm"
                            onClick={() => applyAndCommit(f)}
                            disabled={applying === f.path}
                            data-testid={`sandbox-ai-commit-${f.path}`}
                            className="h-7 bg-emerald-500 text-ink-950 hover:bg-emerald-400 font-bold"
                          >
                            {applying === f.path
                              ? <Loader2 className="h-3 w-3 animate-spin" />
                              : <><Check className="mr-1 h-3 w-3" />Apply &amp; commit</>}
                          </Button>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

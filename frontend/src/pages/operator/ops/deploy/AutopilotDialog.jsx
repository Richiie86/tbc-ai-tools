import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Bot, ShieldCheck, AlertTriangle, Rocket, Activity, Loader2, MessageSquare,
  CheckCircle2, X,
} from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '../../../../components/ui/dialog';
import { Button } from '../../../../components/ui/button';
import { toast } from 'sonner';

/**
 * Live timeline view of the ship-and-watch autopilot loop.
 *
 * Opens a `fetch` stream against POST /api/operator/deploy/{id}/autopilot
 * and renders each SSE frame as a typed timeline entry. We use `fetch` +
 * ReadableStream instead of EventSource because EventSource cannot send
 * POST + a JSON body, and switching to GET would mean shoving settings into
 * the URL — keeping the auth cookie + payload semantics intact is cleaner.
 *
 * Each event type maps to a small JSX renderer; unknown types are surfaced
 * verbatim as JSON so the operator can still see what the backend sent.
 */
const ICONS = {
  loop_start: Bot,
  review_start: ShieldCheck,
  review_done: ShieldCheck,
  gate_blocked: AlertTriangle,
  deploy_start: Rocket,
  deploy_started: Rocket,
  deploy_state: Loader2,
  deploy_ready: Rocket,
  health_check: Activity,
  loop_complete: CheckCircle2,
  loop_error: AlertTriangle,
  auto_fix_start: Bot,
  auto_fix_patches: Bot,
  auto_fix_committed: CheckCircle2,
  auto_fix_error: AlertTriangle,
};
const TONES = {
  loop_start: 'text-tbc-300',
  review_start: 'text-violet-300',
  review_done: 'text-violet-300',
  gate_blocked: 'text-rose-300',
  deploy_start: 'text-tbc-300',
  deploy_started: 'text-tbc-300',
  deploy_state: 'text-tbc-200/70',
  deploy_ready: 'text-tbc-300',
  health_check: 'text-emerald-300',
  loop_complete: 'text-emerald-300',
  loop_error: 'text-rose-300',
  auto_fix_start: 'text-amber-300',
  auto_fix_patches: 'text-amber-300',
  auto_fix_committed: 'text-emerald-300',
  auto_fix_error: 'text-rose-300',
};

function EventCard({ event }) {
  const Icon = ICONS[event.type] || Activity;
  const tone = TONES[event.type] || 'text-tbc-200';
  return (
    <div data-testid={`autopilot-event-${event.type}`} className="flex gap-2 rounded-lg border border-tbc-900/60 bg-ink-900/60 p-2">
      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${tone}`} />
      <div className="min-w-0 flex-1">
        <div className={`text-[11px] font-bold uppercase tracking-wider ${tone}`}>
          {event.type.replace(/_/g, ' ')}
        </div>
        {/* Type-specific renderers — fall through to JSON pre for unknown. */}
        {event.type === 'review_done' && (
          <p className="mt-1 text-xs text-tbc-100">
            Verdict: <span className="font-semibold">{event.data.verdict}</span>{' '}
            · {event.data.findings_count} finding{event.data.findings_count === 1 ? '' : 's'}
            {typeof event.data.iteration === 'number' && event.data.iteration > 0 && (
              <span className="ml-2 rounded bg-amber-500/10 px-1 text-[10px] text-amber-300">
                after fix iteration {event.data.iteration}
              </span>
            )}
            {event.data.summary && <span className="block text-tbc-200/70 mt-1">{event.data.summary}</span>}
          </p>
        )}
        {event.type === 'auto_fix_start' && (
          <p className="mt-1 text-xs text-amber-200">
            Iteration <span className="font-semibold">{event.data.iteration}</span> /
            {' '}{event.data.max_iterations} · asking LLM to patch{' '}
            {event.data.findings_to_fix} finding{event.data.findings_to_fix === 1 ? '' : 's'}…
          </p>
        )}
        {event.type === 'auto_fix_patches' && (
          <div className="mt-1 text-xs text-tbc-100">
            <p className="text-amber-200">
              {event.data.patch_count} patch{event.data.patch_count === 1 ? '' : 'es'} drafted ·
              {' '}<code className="rounded bg-ink-950 px-1 font-mono text-[10px]">{event.data.commit_message}</code>
            </p>
            {Array.isArray(event.data.paths) && event.data.paths.length > 0 && (
              <ul className="mt-1 list-disc pl-5 text-[10px] text-tbc-200/70">
                {event.data.paths.map((p, i) => (
                  <li key={i}><code className="font-mono">{p}</code></li>
                ))}
              </ul>
            )}
          </div>
        )}
        {event.type === 'auto_fix_committed' && (
          <div className="mt-1 text-xs text-emerald-200">
            ✅ Committed {(event.data.commits || []).length} patch{(event.data.commits || []).length === 1 ? '' : 'es'} (iteration {event.data.iteration})
            {Array.isArray(event.data.commits) && (
              <ul className="mt-1 list-none pl-3 text-[10px] text-emerald-100/80">
                {event.data.commits.map((c, i) => (
                  <li key={i}>
                    <code className="font-mono">{c.path}</code>
                    {c.commit_url && (
                      <>
                        {' '}→{' '}
                        <a href={c.commit_url} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">
                          {(c.commit_sha || '').slice(0, 7)}
                        </a>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {event.type === 'auto_fix_error' && (
          <p className="mt-1 text-xs text-rose-200">
            Auto-fix failed at <span className="font-mono">{event.data.stage}</span>: {event.data.message}
          </p>
        )}
        {event.type === 'gate_blocked' && (
          <p className="mt-1 text-xs text-rose-200">
            {event.data.next_action || 'Loop halted by ship-gate.'}
          </p>
        )}
        {event.type === 'deploy_state' && (
          <p className="mt-1 font-mono text-[11px] text-tbc-200/80">
            state: <span className="text-tbc-100">{event.data.state}</span>
          </p>
        )}
        {(event.type === 'deploy_started' || event.type === 'deploy_ready') && (
          <p className="mt-1 text-xs text-tbc-100">
            {event.data.url && (
              <a
                href={event.data.url.startsWith('http') ? event.data.url : `https://${event.data.url}`}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-tbc-300 hover:text-tbc-200 underline-offset-2 hover:underline"
              >
                {event.data.url}
              </a>
            )}
            {event.data.state && <span className="ml-2 text-tbc-200/70">{event.data.state}</span>}
          </p>
        )}
        {event.type === 'health_check' && (
          <p className="mt-1 text-xs text-tbc-100">
            {event.data.ok ? '✅' : '❌'} HTTP {event.data.http_status ?? '—'} · {event.data.latency_ms}ms
            {event.data.error && <span className="block text-rose-200">{event.data.error}</span>}
          </p>
        )}
        {event.type === 'loop_complete' && (
          <p className="mt-1 text-xs text-emerald-200">
            {event.data.ok ? 'Loop succeeded — deploy is live and healthy.' : (event.data.message || 'Loop finished with warnings.')}
          </p>
        )}
        {event.type === 'loop_error' && (
          <p className="mt-1 text-xs text-rose-200">
            {event.data.message || 'Unexpected error'}
            {event.data.stage && <span className="ml-2 text-rose-300/70">(stage: {event.data.stage})</span>}
          </p>
        )}
        {/* Fallback for unknown event types only. */}
        {!(['review_done','gate_blocked','deploy_state','deploy_started','deploy_ready','health_check','loop_complete','loop_error','auto_fix_start','auto_fix_patches','auto_fix_committed','auto_fix_error'].includes(event.type)) && (
          <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[10px] text-tbc-200/70">
            {JSON.stringify(event.data, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}

/**
 * Parse a chunk of SSE bytes into discrete {type, data} events. The protocol
 * delimits frames with a blank line ("\n\n") and each frame has `event:` and
 * `data:` lines. Keeping the parser in-component avoids pulling another dep.
 */
function* parseSse(buffer) {
  const frames = buffer.split('\n\n');
  // Last fragment may be incomplete — caller stashes it back into the buffer.
  for (let i = 0; i < frames.length - 1; i++) {
    const frame = frames[i].trim();
    if (!frame) continue;
    let type = 'message';
    let dataLine = '';
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) type = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLine += line.slice(5).trim();
    }
    let data = {};
    try { data = JSON.parse(dataLine); } catch { data = { raw: dataLine }; }
    yield { type, data };
  }
  yield { remainder: frames[frames.length - 1] };
}

export function AutopilotDialog({ open, onOpenChange, project }) {
  const [events, setEvents] = useState([]);
  const [running, setRunning] = useState(false);
  const [target, setTarget] = useState('preview');
  const [bypass, setBypass] = useState(false);
  // Default 0 = manual mode (gate stops the loop). Bump to 1-5 to let the
  // autopilot ask the LLM for patches, commit them via GitHub, and retry.
  const [autoFixIters, setAutoFixIters] = useState(0);
  const abortRef = useRef(null);
  const navigate = useNavigate();

  // Reset every time the dialog re-opens so a previous run's timeline
  // doesn't bleed into a new project.
  useEffect(() => {
    if (open) {
      setEvents([]);
      setRunning(false);
    }
    return () => {
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }
    };
  }, [open]);

  const start = async () => {
    setEvents([]);
    setRunning(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const base = (await import('../../../../lib/api')).default.defaults.baseURL;
      const resp = await fetch(`${base}/operator/deploy/${project.id}/autopilot`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target,
          bypass_review: bypass,
          watch_timeout_s: 90,
          auto_fix_max_iterations: Number(autoFixIters) || 0,
        }),
        signal: controller.signal,
      });
      if (!resp.ok || !resp.body) {
        const detail = await resp.text();
        toast.error(`Autopilot failed to start: ${resp.status} ${detail.slice(0, 120)}`);
        setRunning(false);
        return;
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (const item of parseSse(buffer)) {
          if (item.remainder !== undefined) {
            buffer = item.remainder;
            continue;
          }
          setEvents((prev) => [...prev, item]);
          if (item.type === 'loop_complete' || item.type === 'loop_error') {
            // Server will close the stream; we don't have to abort.
          }
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError') {
        toast.error(`Autopilot stream error: ${String(e).slice(0, 160)}`);
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  const stop = () => {
    if (abortRef.current) abortRef.current.abort();
    setRunning(false);
  };

  // If the loop ended in a ship-gate block with a seeded chat, surface a
  // shortcut so the operator can jump straight to it.
  const gateBlock = events.find((e) => e.type === 'gate_blocked');
  const fixChatId = gateBlock?.data?.fix_chat_session_id;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v && running) stop(); onOpenChange(v); }}>
      <DialogContent
        data-testid={`autopilot-dialog-${project.id}`}
        className="max-h-[88vh] max-w-2xl overflow-hidden border-tbc-900/60 bg-ink-950 text-tbc-100"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-tbc-100">
            <Bot className="h-5 w-5 text-tbc-300" />
            Autopilot · {project.projectName}
          </DialogTitle>
          <DialogDescription className="text-tbc-200/70">
            Runs the full <strong>review → ship → watch → react</strong> loop on
            <code className="ml-1 rounded bg-ink-900 px-1 font-mono text-tbc-300">{project.repo}</code>.
            Stops at the ship-gate unless you override.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          <label className="inline-flex items-center gap-1 text-xs text-tbc-200/80">
            <span>Target</span>
            <select
              data-testid={`autopilot-target-${project.id}`}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              disabled={running}
              className="rounded border border-tbc-900/60 bg-ink-900 px-2 py-1 text-xs text-tbc-100"
            >
              <option value="preview">preview</option>
              <option value="production">production</option>
            </select>
          </label>
          <label className="inline-flex items-center gap-1 text-xs text-tbc-200/80">
            <input
              data-testid={`autopilot-bypass-${project.id}`}
              type="checkbox"
              checked={bypass}
              onChange={(e) => setBypass(e.target.checked)}
              disabled={running}
              className="accent-tbc-400"
            />
            <span>Bypass review gate</span>
          </label>
          <label className="inline-flex items-center gap-1 text-xs text-tbc-200/80">
            <span>Auto-fix iterations</span>
            <select
              data-testid={`autopilot-autofix-${project.id}`}
              value={autoFixIters}
              onChange={(e) => setAutoFixIters(Number(e.target.value))}
              disabled={running || bypass}
              title={bypass ? 'Disabled while bypassing the gate' : 'How many fix → commit → re-review cycles to run before giving up. Needs github_token with Contents:Write.'}
              className="rounded border border-tbc-900/60 bg-ink-900 px-2 py-1 text-xs text-tbc-100 disabled:opacity-40"
            >
              <option value="0">0 (manual)</option>
              <option value="1">1</option>
              <option value="2">2</option>
              <option value="3">3</option>
              <option value="5">5</option>
            </select>
          </label>
          {!running ? (
            <Button
              size="sm"
              data-testid={`autopilot-start-${project.id}`}
              onClick={start}
              disabled={!project.domain}
              title={!project.domain ? 'Set a domain first' : 'Run the full loop'}
              className="bg-tbc-500 text-ink-950 hover:bg-tbc-400 font-semibold"
            >
              <Bot className="mr-1.5 h-3 w-3" />
              Run autopilot
            </Button>
          ) : (
            <Button
              size="sm"
              data-testid={`autopilot-stop-${project.id}`}
              onClick={stop}
              variant="outline"
              className="border-rose-500/40 bg-ink-900 text-rose-200 hover:bg-rose-500/10"
            >
              <X className="mr-1.5 h-3 w-3" />
              Stop
            </Button>
          )}
        </div>

        <div className="max-h-[60vh] space-y-2 overflow-y-auto pr-1">
          {events.length === 0 && !running && (
            <p className="rounded-lg border border-dashed border-tbc-900/60 p-4 text-center text-xs text-tbc-200/60">
              Press <span className="font-semibold">Run autopilot</span> to start the timeline.
            </p>
          )}
          {events.map((e, i) => <EventCard key={i} event={e} />)}
          {running && (
            <div className="flex items-center gap-2 rounded-lg border border-tbc-900/60 bg-ink-900/60 p-2 text-xs text-tbc-200">
              <Loader2 className="h-3 w-3 animate-spin text-tbc-300" />
              Waiting for next event…
            </div>
          )}
        </div>

        {fixChatId && (
          <div className="mt-2 flex justify-end">
            <Button
              size="sm"
              data-testid={`autopilot-open-fix-${project.id}`}
              onClick={() => navigate(`/dashboard/${fixChatId}`)}
              className="bg-tbc-500 text-ink-950 hover:bg-tbc-400 font-semibold"
            >
              <MessageSquare className="mr-1.5 h-3 w-3" />
              Open fix chat
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

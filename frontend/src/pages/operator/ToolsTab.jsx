import React, { useCallback, useEffect, useState } from 'react';
import api from '../../lib/api';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Switch } from '../../components/ui/switch';
import { toast } from 'sonner';
import {
  Loader2, Wrench, Globe, ListOrdered, KeyRound, CheckCircle2, Info,
} from 'lucide-react';

/**
 * AI Tools — a registry of tools the chat AI can use while coding & building.
 *
 * Every tool here is fully wired into the backend and augments chat answers
 * automatically when enabled. We deliberately only ship tools that actually
 * work with the app's Claude + MongoDB stack (no dead toggles):
 *   • Web Search        — live web results on time-sensitive questions.
 *   • Sequential Thinking — structured step-by-step reasoning on hard tasks.
 */

const TOOL_ICON = {
  web_search: Globe,
  sequential_thinking: ListOrdered,
};

export default function ToolsTab() {
  const [tools, setTools] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(null); // tool id being saved
  const [keyDraft, setKeyDraft] = useState({}); // tool id -> key input value

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/operator/tools');
      setTools(data.tools || []);
    } catch {
      toast.error('Failed to load AI tools');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const patch = async (toolId, body, successMsg) => {
    setSaving(toolId);
    try {
      const { data } = await api.put(`/operator/tools/${toolId}`, body);
      setTools((list) => list.map((t) => (t.id === toolId ? data.tool : t)));
      if (successMsg) toast.success(successMsg);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not update tool');
    } finally {
      setSaving(null);
    }
  };

  const toggle = (tool, next) =>
    patch(tool.id, { enabled: next }, next ? `${tool.name} enabled` : `${tool.name} disabled`);

  const saveKey = (tool) => {
    const val = (keyDraft[tool.id] || '').trim();
    patch(tool.id, { api_key: val }, val ? `${tool.name} API key saved` : `${tool.name} API key cleared`);
    setKeyDraft((d) => ({ ...d, [tool.id]: '' }));
  };

  if (loading || !tools) {
    return (
      <div className="grid place-items-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-tbc-400" />
      </div>
    );
  }

  return (
    <div className="space-y-5" data-testid="tools-tab">
      {/* Intro */}
      <div className="flex items-start gap-3 rounded-xl border border-tbc-900/60 bg-ink-900/50 p-5">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-tbc-500/15 text-tbc-300">
          <Wrench className="h-5 w-5" />
        </div>
        <div>
          <h2 className="text-lg font-bold text-tbc-100">AI Tools</h2>
          <p className="mt-1 max-w-2xl text-sm text-tbc-200/60">
            Extra powers your AI can use while coding and building. When a tool is
            on, it kicks in automatically on the right kind of message — you and
            your users don&apos;t have to do anything. Turn any of them off here.
          </p>
        </div>
      </div>

      {/* Tool cards */}
      <div className="space-y-4">
        {tools.map((tool) => {
          const Icon = TOOL_ICON[tool.id] || Wrench;
          const busy = saving === tool.id;
          const needsKey = tool.needs_key && !tool.has_key;
          return (
            <div
              key={tool.id}
              className="rounded-xl border border-tbc-500/30 bg-gradient-to-br from-tbc-500/[0.05] via-ink-900/60 to-ink-900/60 p-5"
              data-testid={`tool-${tool.id}`}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                  <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-tbc-500/15 text-tbc-300">
                    <Icon className="h-5 w-5" />
                  </div>
                  <div>
                    <h3 className="flex flex-wrap items-center gap-2 text-base font-bold text-tbc-100">
                      {tool.name}
                      <span className="rounded-full bg-tbc-900/70 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-tbc-300">
                        {tool.category}
                      </span>
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                        tool.enabled ? 'bg-emerald-500/20 text-emerald-300' : 'bg-tbc-900/70 text-tbc-300'
                      }`}>
                        {tool.enabled ? 'ON' : 'OFF'}
                      </span>
                    </h3>
                    <p className="mt-1 max-w-xl text-sm text-tbc-200/60">{tool.description}</p>
                    <p className="mt-1.5 flex items-center gap-1.5 text-xs text-tbc-200/40">
                      <Info className="h-3.5 w-3.5" /> {tool.trigger}
                    </p>
                  </div>
                </div>
                <Switch
                  data-testid={`tool-${tool.id}-toggle`}
                  checked={!!tool.enabled}
                  onCheckedChange={(v) => toggle(tool, v)}
                  disabled={busy}
                />
              </div>

              {/* Key management for tools that need one */}
              {tool.needs_key && (
                <div className="mt-4 border-t border-tbc-900/50 pt-4">
                  <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
                    <span className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 ${
                      tool.has_key ? 'bg-emerald-500/10 text-emerald-300' : 'bg-amber-500/10 text-amber-300'
                    }`}>
                      {tool.has_key
                        ? <><CheckCircle2 className="h-3.5 w-3.5" /> API key set ({tool.key_source})</>
                        : <><KeyRound className="h-3.5 w-3.5" /> API key required</>}
                    </span>
                    {tool.provider && (
                      <span className="rounded-lg bg-ink-950/50 px-2.5 py-1.5 text-tbc-200/50">
                        provider: {tool.provider}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <Input
                      type="password"
                      value={keyDraft[tool.id] || ''}
                      onChange={(e) => setKeyDraft((d) => ({ ...d, [tool.id]: e.target.value }))}
                      placeholder="Paste Serper or Brave API key (leave blank to clear)"
                      className="flex-1 border-tbc-900/70 bg-ink-950/60 text-sm"
                    />
                    <Button
                      onClick={() => saveKey(tool)}
                      disabled={busy}
                      className="bg-tbc-600 text-white hover:bg-tbc-500"
                    >
                      {busy ? <Loader2 className="h-4 w-4 animate-spin" />
                        : ((keyDraft[tool.id] || '').trim() ? 'Save key' : 'Clear key')}
                    </Button>
                  </div>
                  {needsKey && (
                    <p className="mt-2 text-[11px] text-tbc-200/40">
                      Get a free key at serper.dev or brave.com/search/api. Without a
                      key this tool stays inactive even when toggled on.
                    </p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

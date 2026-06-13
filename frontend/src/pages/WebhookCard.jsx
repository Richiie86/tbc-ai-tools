import React, { useCallback, useEffect, useState } from 'react';
import api from '../lib/api';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { toast } from 'sonner';
import {
  Webhook, Copy, Check, RotateCw, Loader2, Github, ExternalLink, Eye, EyeOff,
} from 'lucide-react';

/**
 * Per-project GitHub webhook setup card.
 *
 * Shows the webhook URL + content-type, lets the operator rotate the
 * shared secret (one-time reveal), and links straight to the repo's
 * Webhooks settings page so set-up is two clicks.
 */
export default function WebhookCard({ projectId, repo }) {
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [rotating, setRotating] = useState(false);
  const [revealedSecret, setRevealedSecret] = useState('');
  const [show, setShow] = useState(false);
  const [copied, setCopied] = useState(null);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get(`/operator/deploy/${projectId}/webhook`);
      setInfo(data);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Failed to load webhook info');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const rotate = async () => {
    if (info?.secret_set && !window.confirm('Rotate the secret? Your current GitHub webhook will stop validating until you paste the new value into github.com.')) return;
    setRotating(true);
    try {
      const { data } = await api.post(`/operator/deploy/${projectId}/webhook/rotate`);
      setRevealedSecret(data.secret);
      setShow(true);
      toast.success('Secret rotated — copy it now, it will not be shown again');
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Rotate failed');
    } finally {
      setRotating(false);
    }
  };

  const copy = async (text, key) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    } catch { toast.error('Clipboard blocked'); }
  };

  if (loading) {
    return (
      <Card className="border-tbc-900/60 bg-ink-900/60 p-5">
        <Loader2 className="h-5 w-5 animate-spin text-tbc-400" />
      </Card>
    );
  }

  if (!info) return null;
  const githubUrl = repo ? `https://github.com/${repo}/settings/hooks/new` : null;

  return (
    <Card
      className="border-tbc-900/60 bg-ink-900/60 p-5"
      data-testid="webhook-card"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-tbc-500/20 text-tbc-300">
            <Webhook className="h-4 w-4" />
          </div>
          <div>
            <h2 className="text-sm font-bold uppercase tracking-wider text-tbc-200">GitHub push webhook</h2>
            <p className="mt-1 text-xs text-tbc-200/60">
              When set up on the repo, every push to <code className="rounded bg-ink-950 px-1">main</code> triggers
              a deploy automatically. Pair with <span className="font-semibold text-emerald-300">Auto-promote</span> for
              a fully hands-off pipeline.
            </p>
          </div>
        </div>
        {githubUrl && (
          <a
            href={githubUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-tbc-900/60 bg-ink-950 px-2.5 py-1 text-[11px] font-semibold text-tbc-100 hover:bg-ink-900"
            data-testid="webhook-github-link"
          >
            <Github className="h-3 w-3" />
            Open GitHub
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>

      <div className="mt-4 space-y-3">
        <FieldRow
          label="Webhook URL"
          value={info.webhook_url}
          copied={copied === 'url'}
          onCopy={() => copy(info.webhook_url, 'url')}
          testid="webhook-url"
        />
        <FieldRow
          label="Content-Type"
          value={info.content_type}
          mono
          testid="webhook-content-type"
        />

        <div>
          <div className="flex items-center justify-between">
            <label className="text-[10px] font-semibold uppercase tracking-wider text-tbc-200/60">
              Secret
            </label>
            <span className="text-[10px] uppercase tracking-wider text-tbc-200/60">
              {info.secret_set
                ? <>Active · <span className="font-mono">{info.secret_masked}</span></>
                : <span className="text-rose-300">Not set</span>}
            </span>
          </div>
          {revealedSecret && (
            <div
              className="mt-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 p-2 text-xs text-emerald-100"
              data-testid="webhook-revealed-secret"
            >
              <div className="mb-1 text-[10px] uppercase tracking-wider text-emerald-300">
                One-time reveal — copy now
              </div>
              <div className="flex items-center gap-2">
                <code className="flex-1 break-all font-mono text-[11px]">
                  {show ? revealedSecret : '•'.repeat(Math.min(32, revealedSecret.length))}
                </code>
                <button
                  type="button"
                  onClick={() => setShow((s) => !s)}
                  className="text-emerald-200 hover:text-emerald-100"
                  data-testid="webhook-secret-toggle"
                >
                  {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>
                <button
                  type="button"
                  onClick={() => copy(revealedSecret, 'secret')}
                  className="text-emerald-200 hover:text-emerald-100"
                  data-testid="webhook-secret-copy"
                >
                  {copied === 'secret'
                    ? <Check className="h-3.5 w-3.5" />
                    : <Copy className="h-3.5 w-3.5" />}
                </button>
              </div>
            </div>
          )}
          <Button
            onClick={rotate}
            disabled={rotating}
            data-testid="webhook-rotate-btn"
            className="mt-2 bg-tbc-500 text-ink-950 font-semibold hover:bg-tbc-400"
          >
            {rotating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RotateCw className="mr-1.5 h-4 w-4" />}
            {info.secret_set ? 'Rotate secret' : 'Generate secret'}
          </Button>
        </div>

        <p className="rounded-md border border-tbc-900/60 bg-ink-950/50 p-3 text-[11px] leading-relaxed text-tbc-200/70">
          {info.instructions}
        </p>
      </div>
    </Card>
  );
}

function FieldRow({ label, value, mono, copied, onCopy, testid }) {
  return (
    <div>
      <label className="text-[10px] font-semibold uppercase tracking-wider text-tbc-200/60">
        {label}
      </label>
      <div className="mt-1.5 flex items-center gap-2 rounded-md border border-tbc-900/60 bg-ink-950 px-2.5 py-1.5">
        <code className={`flex-1 break-all text-[11px] text-tbc-100 ${mono ? 'font-mono' : ''}`} data-testid={testid}>
          {value}
        </code>
        {onCopy && (
          <button
            type="button"
            onClick={onCopy}
            className="text-tbc-200/60 hover:text-tbc-100"
            data-testid={`${testid}-copy`}
          >
            {copied
              ? <Check className="h-3.5 w-3.5 text-emerald-300" />
              : <Copy className="h-3.5 w-3.5" />}
          </button>
        )}
      </div>
    </div>
  );
}

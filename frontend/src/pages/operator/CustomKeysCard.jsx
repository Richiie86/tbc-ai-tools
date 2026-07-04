import React, { useCallback, useEffect, useState } from 'react';
import api from '../../lib/api';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { toast } from 'sonner';
import {
  Boxes, Loader2, Plus, Eye, EyeOff, RotateCw, Trash2, Save, X,
} from 'lucide-react';

/**
 * Custom keys — add an API key for ANY system, with no provider-specific code.
 *
 * The operator gives the key a name (e.g. "Porkbun API", "SendGrid",
 * "Twilio Auth Token") and pastes the value. The backend stores it encrypted
 * in a generic list (/operator/keys/custom) and exposes it by name/env_key for
 * later use. This is what lets brand-new services be added instantly.
 */
export default function CustomKeysCard({ initialName = '', initialValue = '', onAdded }) {
  const [keys, setKeys] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/operator/keys/custom');
      setKeys(data.keys || []);
    } catch {
      setKeys([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div
      className="rounded-xl border border-tbc-500/25 bg-gradient-to-br from-tbc-500/[0.05] via-ink-900/60 to-ink-900/60 p-5"
      data-testid="custom-keys-card"
    >
      <div className="mb-1 flex items-center gap-2">
        <Boxes className="h-4 w-4 text-tbc-300" />
        <h3 className="text-base font-bold text-tbc-100">Custom keys</h3>
        <span className="ml-auto rounded-full bg-tbc-500/15 px-2 py-0.5 text-xs font-semibold text-tbc-200">
          {keys?.length || 0} added
        </span>
      </div>
      <p className="mb-4 text-xs text-tbc-200/60">
        Add an API key for any system — even ones we don&apos;t recognise
        automatically. Name it, paste it, save it. It&apos;s encrypted at rest
        and available to your app by name.
      </p>

      <AddForm initialName={initialName} initialValue={initialValue} onSaved={() => { load(); onAdded?.(); }} />

      <div className="mt-4 space-y-3" data-testid="custom-keys-list">
        {loading ? (
          <div className="grid place-items-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-tbc-400" />
          </div>
        ) : keys.length === 0 ? (
          <p className="rounded-md border border-dashed border-tbc-500/25 bg-ink-900/40 px-3 py-4 text-center text-sm text-tbc-200/60">
            No custom keys yet. Add one above for any service you use.
          </p>
        ) : (
          keys.map((k) => <CustomKeyRow key={k.id} item={k} onChanged={load} />)
        )}
      </div>
    </div>
  );
}

function AddForm({ initialName, initialValue, onSaved }) {
  const [name, setName] = useState(initialName);
  const [value, setValue] = useState(initialValue);
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);

  // Keep in sync if the parent hands us a pre-filled value (smart-paste fallback).
  useEffect(() => { if (initialName) setName(initialName); }, [initialName]);
  useEffect(() => { if (initialValue) setValue(initialValue); }, [initialValue]);

  const submit = async () => {
    const n = name.trim();
    const v = value.trim();
    if (!n) { toast.error('Give this key a name first'); return; }
    if (!v) { toast.error('Paste the key value'); return; }
    setBusy(true);
    try {
      const { data } = await api.post('/operator/keys/custom', { name: n, value: v });
      toast.success(data.updated ? `Updated "${n}"` : `Added "${n}"`);
      setName('');
      setValue('');
      onSaved?.();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not save this key');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-2 rounded-lg border border-tbc-500/15 bg-ink-900/40 p-3 sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1.5fr)_auto] sm:items-center">
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Name (e.g. Porkbun API)"
        data-testid="custom-key-name"
        autoComplete="off"
        className="h-10 border-tbc-900/60 bg-ink-900 text-tbc-100"
      />
      <div className="relative">
        <Input
          type={reveal ? 'text' : 'password'}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) submit();
          }}
          placeholder="Paste the key value…"
          data-testid="custom-key-value"
          name="custom-key-value"
          autoComplete="off"
          data-1p-ignore="true"
          data-lpignore="true"
          spellCheck={false}
          className="h-10 border-tbc-900/60 bg-ink-900 pr-9 text-tbc-100"
        />
        <button
          type="button"
          onClick={() => setReveal((r) => !r)}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-tbc-200/60 hover:text-tbc-100"
          aria-label={reveal ? 'Hide value' : 'Show value'}
        >
          {reveal ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        </button>
      </div>
      <Button
        disabled={!name || !value || busy}
        onClick={submit}
        data-testid="custom-key-add"
        className="h-10 bg-tbc-500 font-semibold text-ink-950 hover:bg-tbc-400"
      >
        {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Plus className="mr-1 h-3.5 w-3.5" />}
        Add key
      </Button>
    </div>
  );
}

function CustomKeyRow({ item, onChanged }) {
  const [rotating, setRotating] = useState(false);
  const [newValue, setNewValue] = useState('');
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);

  const rotate = async () => {
    const v = newValue.trim();
    if (!v) { toast.error('Paste the new value'); return; }
    setBusy(true);
    try {
      await api.post(`/operator/keys/custom/${item.id}/rotate`, { value: v });
      toast.success(`Rotated "${item.name}"`);
      setRotating(false);
      setNewValue('');
      onChanged?.();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not rotate this key');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Delete "${item.name}"? This cannot be undone.`)) return;
    setBusy(true);
    try {
      await api.delete(`/operator/keys/custom/${item.id}`);
      toast.success(`Deleted "${item.name}"`);
      onChanged?.();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not delete this key');
    } finally {
      setBusy(false);
    }
  };

  const stamp = item.rotated_at || item.created_at;
  const stampLabel = item.rotated_at ? 'Rotated' : 'Added';

  return (
    <div className="rounded-lg border border-tbc-900/60 bg-ink-900/60 p-3" data-testid={`custom-key-${item.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-tbc-100">{item.name}</span>
            <code className="rounded bg-tbc-500/10 px-1.5 py-0.5 font-mono text-[11px] text-tbc-200/80">
              {item.masked}
            </code>
          </div>
          {stamp && (
            <span className="text-[11px] text-tbc-200/50">
              {stampLabel} {new Date(stamp).toLocaleDateString()}
              {item.env_key ? ` · ${item.env_key}` : ''}
            </span>
          )}
        </div>
        {!rotating && (
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setRotating(true)}
              data-testid={`custom-key-rotate-${item.id}`}
              className="h-8 border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950"
            >
              <RotateCw className="mr-1 h-3.5 w-3.5" /> Rotate
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={remove}
              data-testid={`custom-key-delete-${item.id}`}
              className="h-8 border-rose-500/40 bg-transparent text-rose-300 hover:bg-rose-500/10"
            >
              <Trash2 className="mr-1 h-3.5 w-3.5" /> Delete
            </Button>
          </div>
        )}
      </div>

      {rotating && (
        <div className="mt-3 flex items-center gap-2">
          <div className="relative flex-1">
            <Input
              type={reveal ? 'text' : 'password'}
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) rotate();
              }}
              placeholder="Paste the new value…"
              autoComplete="off"
              data-1p-ignore="true"
              spellCheck={false}
              className="h-9 border-tbc-900/60 bg-ink-900 pr-9 text-tbc-100"
            />
            <button
              type="button"
              onClick={() => setReveal((r) => !r)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-tbc-200/60 hover:text-tbc-100"
              aria-label={reveal ? 'Hide value' : 'Show value'}
            >
              {reveal ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </button>
          </div>
          <Button
            disabled={!newValue || busy}
            onClick={rotate}
            className="h-9 bg-tbc-500 font-semibold text-ink-950 hover:bg-tbc-400"
          >
            {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-1 h-3.5 w-3.5" />}
            Save
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => { setRotating(false); setNewValue(''); }}
            className="h-9 border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
    </div>
  );
}

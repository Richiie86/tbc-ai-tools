import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, Download, Upload, Database, AlertTriangle, History, Camera, RotateCcw, GitCompareArrows } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../../components/ui/button';
import api from '../../lib/api';

/**
 * BackupCard — operator-only export / import for portable data
 * (deploy projects, promo codes, KYC bypass list, app settings).
 *
 * Workflow:
 *   1. On the source environment (e.g. Emergent preview), click Export
 *      → a JSON file downloads to your device.
 *   2. On the target environment (e.g. tbctools.org production), click
 *      Import → paste the JSON or select the downloaded file → submit.
 *
 * Secrets in `payment_settings` (Stripe keys, GitHub token, etc.) are
 * STRIPPED on export — the operator re-enters those manually in the
 * target env. This keeps credentials from automatically traveling
 * across environments.
 */
export default function BackupCard() {
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [pasted, setPasted] = useState('');
  const [mode, setMode] = useState('merge');
  const [counts, setCounts] = useState(null);
  // Snapshot history (30-day rolling, local disk). Server keeps the
  // files on `/app/data/backups/`; this list is fetched on mount and
  // again after every manual snapshot / restore so the operator sees
  // their action reflected immediately.
  const [snapshots, setSnapshots] = useState([]);
  const [snapshotsLoading, setSnapshotsLoading] = useState(false);
  const [snapshotting, setSnapshotting] = useState(false);
  const [restoringId, setRestoringId] = useState(null);
  const [retentionDays, setRetentionDays] = useState(30);
  const [s3Status, setS3Status] = useState({ enabled: false, bucket: null });
  // Per-snapshot diff cache + the id currently expanded. Lazy-loaded
  // when the operator clicks "Preview" on a row so the list itself
  // stays cheap.
  const [diffById, setDiffById] = useState({});
  const [diffOpenId, setDiffOpenId] = useState(null);
  const [diffLoadingId, setDiffLoadingId] = useState(null);

  const loadSnapshots = useCallback(async () => {
    setSnapshotsLoading(true);
    try {
      const { data } = await api.get('/operator/backup/snapshots');
      setSnapshots(data?.snapshots || []);
      setRetentionDays(data?.retention_days || 30);
      setS3Status({ enabled: !!data?.s3_enabled, bucket: data?.s3_bucket || null });
    } catch (e) {
      // Don't toast on first load — the card still works without history.
      console.warn('snapshots fetch failed', e);
    } finally {
      setSnapshotsLoading(false);
    }
  }, []);

  // Show a quick "what's currently here" summary so the operator can
  // gut-check whether they're about to import into an empty env (safe)
  // or one with data (use merge mode).
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { data } = await api.get('/operator/backup/export');
        if (alive) setCounts(data?.counts || null);
      } catch { /* swallow — card still works without the preview */ }
    })();
    loadSnapshots();
    return () => { alive = false; };
  }, [loadSnapshots]);

  const snapshotNow = useCallback(async () => {
    setSnapshotting(true);
    try {
      const { data } = await api.post('/operator/backup/snapshots');
      toast.success(`Snapshot ${data.filename} saved · ${(data.size_bytes / 1024).toFixed(1)} KB`);
      loadSnapshots();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Snapshot failed');
    } finally {
      setSnapshotting(false);
    }
  }, [loadSnapshots]);

  const downloadSnapshot = useCallback(async (snap) => {
    try {
      const { data } = await api.get(`/operator/backup/snapshots/${snap.id}/download`, {
        responseType: 'blob',
      });
      const url = URL.createObjectURL(data);
      const a = document.createElement('a');
      a.href = url;
      a.download = snap.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Download failed');
    }
  }, []);

  const restoreSnapshot = useCallback(async (snap, restoreMode) => {
    const verb = restoreMode === 'replace' ? 'REPLACE current data with' : 'merge';
    if (!window.confirm(`${verb === 'merge' ? 'Merge' : verb} snapshot ${snap.filename}?${restoreMode === 'replace' ? '\n\nThis will WIPE existing rows before importing.' : ''}`)) return;
    setRestoringId(snap.id);
    try {
      const { data } = await api.post(`/operator/backup/snapshots/${snap.id}/restore`, null, {
        params: { mode: restoreMode },
      });
      const total = Object.values(data?.written || {}).reduce((a, b) => a + b, 0);
      toast.success(`Restored ${total} items from ${snap.filename}`);
      // Refresh the "currently in env" counts strip.
      try {
        const { data: fresh } = await api.get('/operator/backup/export');
        setCounts(fresh?.counts || null);
      } catch { /* non-fatal */ }
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Restore failed');
    } finally {
      setRestoringId(null);
    }
  }, []);

  // Pre-flight diff — fetched lazily when the operator clicks "Preview"
  // on a snapshot row. The result is cached so reopening the same row
  // doesn't re-hit the backend.
  const togglePreview = useCallback(async (snap) => {
    if (diffOpenId === snap.id) {
      setDiffOpenId(null);
      return;
    }
    setDiffOpenId(snap.id);
    if (diffById[snap.id]) return; // already cached
    setDiffLoadingId(snap.id);
    try {
      const { data } = await api.get(`/operator/backup/snapshots/${snap.id}/diff`);
      setDiffById((prev) => ({ ...prev, [snap.id]: data }));
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not load preview');
      setDiffOpenId(null);
    } finally {
      setDiffLoadingId(null);
    }
  }, [diffOpenId, diffById]);

  const exportNow = useCallback(async () => {
    setExporting(true);
    try {
      const { data } = await api.get('/operator/backup/export');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const a = document.createElement('a');
      a.href = url;
      a.download = `tbc-operator-backup-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success(`Backup downloaded (${data.counts.deploy_projects + data.counts.promo_codes + data.counts.kyc_bypass_emails + data.counts.app_settings} items)`);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Export failed');
    } finally {
      setExporting(false);
    }
  }, []);

  const importNow = useCallback(async () => {
    if (!pasted.trim()) {
      toast.error('Paste the JSON backup first');
      return;
    }
    let parsed;
    try { parsed = JSON.parse(pasted); }
    catch { toast.error('That is not valid JSON'); return; }
    if (mode === 'replace' && !window.confirm(
      'REPLACE mode wipes deploy_projects, promo_codes, kyc_bypass_emails, vanished_emails and app_settings before importing.\n\nContinue?'
    )) return;
    setImporting(true);
    try {
      const body = { ...parsed, mode };
      const { data } = await api.post('/operator/backup/import', body);
      const total = Object.values(data?.written || {}).reduce((a, b) => a + b, 0);
      toast.success(`Imported ${total} items · ${JSON.stringify(data.written)}`);
      setPasted('');
      // Refresh the local counts preview.
      const { data: fresh } = await api.get('/operator/backup/export');
      setCounts(fresh?.counts || null);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Import failed');
    } finally {
      setImporting(false);
    }
  }, [pasted, mode]);

  const onFile = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => setPasted(String(reader.result || ''));
    reader.readAsText(f);
  };

  return (
    <div className="space-y-4" data-testid="backup-card">
      <p className="text-xs leading-relaxed text-tbc-200/70">
        Download all your portable operator data (deploy projects, promo codes,
        KYC bypass, app settings) as a JSON file, then re-import it in another
        environment. <span className="font-bold text-amber-300">Secrets are stripped</span> on
        export — re-enter API keys manually in the target env.
      </p>

      {counts && (
        <div
          className="flex flex-wrap gap-x-4 gap-y-1 rounded-md border border-tbc-900/60 bg-ink-900/60 px-3 py-2 text-[11px] text-tbc-200/80"
          data-testid="backup-counts"
        >
          <span><Database className="mr-1 inline h-3 w-3" />Currently in this env:</span>
          <span><b className="text-tbc-100">{counts.deploy_projects}</b> deploy projects</span>
          <span><b className="text-tbc-100">{counts.promo_codes}</b> promo codes</span>
          <span><b className="text-tbc-100">{counts.kyc_bypass_emails}</b> KYC bypass</span>
          <span><b className="text-tbc-100">{counts.vanished_emails}</b> vanished</span>
          <span><b className="text-tbc-100">{counts.app_settings}</b> app settings</span>
        </div>
      )}

      <Button
        onClick={exportNow}
        disabled={exporting}
        data-testid="backup-export-btn"
        className="bg-sky-500 text-ink-950 hover:bg-sky-400 font-semibold"
      >
        {exporting ? <Loader2 className="mr-2 h-3 w-3 animate-spin" /> : <Download className="mr-2 h-3 w-3" />}
        Export backup (JSON download)
      </Button>

      <div className="rounded-lg border border-tbc-900/60 bg-ink-950/60 p-3">
        <p className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-tbc-100">
          <Upload className="h-3 w-3 text-emerald-300" />
          Import backup
        </p>

        <div className="mb-2 flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-[11px] text-tbc-200/80">
            <input
              type="radio"
              name="backup-mode"
              checked={mode === 'merge'}
              onChange={() => setMode('merge')}
              data-testid="backup-mode-merge"
            />
            <span><b>Merge</b> (upsert by id · safe)</span>
          </label>
          <label className="flex items-center gap-1.5 text-[11px] text-tbc-200/80">
            <input
              type="radio"
              name="backup-mode"
              checked={mode === 'replace'}
              onChange={() => setMode('replace')}
              data-testid="backup-mode-replace"
            />
            <span className="text-rose-300"><b>Replace</b> (wipe first · destructive)</span>
          </label>
        </div>

        <input
          type="file"
          accept=".json,application/json"
          onChange={onFile}
          data-testid="backup-import-file"
          className="mb-2 block w-full text-[11px] text-tbc-200/80 file:mr-3 file:rounded-md file:border-0 file:bg-tbc-700/40 file:px-3 file:py-1.5 file:text-[11px] file:font-semibold file:text-tbc-100 hover:file:bg-tbc-700/60"
        />
        <textarea
          value={pasted}
          onChange={(e) => setPasted(e.target.value)}
          rows={5}
          placeholder='…or paste the JSON here'
          data-testid="backup-import-textarea"
          className="w-full rounded-md border border-tbc-900/60 bg-ink-950 p-2 font-mono text-[11px] text-tbc-100 placeholder:text-tbc-200/40 focus:outline-none focus:ring-1 focus:ring-amber-500/40"
        />

        {mode === 'replace' && (
          <p className="mt-1 flex items-start gap-1.5 text-[11px] text-rose-300">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
            Replace mode will DELETE existing rows in the listed collections before importing.
          </p>
        )}

        <Button
          onClick={importNow}
          disabled={importing || !pasted.trim()}
          data-testid="backup-import-btn"
          className="mt-2 bg-emerald-500 text-ink-950 hover:bg-emerald-400 font-semibold disabled:opacity-50"
        >
          {importing ? <Loader2 className="mr-2 h-3 w-3 animate-spin" /> : <Upload className="mr-2 h-3 w-3" />}
          Import {mode === 'replace' ? '(REPLACE)' : '(merge)'}
        </Button>
      </div>

      {/* ── Snapshot history (30-day rolling, local disk) ─────────── */}
      <div className="rounded-lg border border-tbc-900/60 bg-ink-950/60 p-3" data-testid="backup-snapshots-card">
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-tbc-100">
            <History className="h-3 w-3 text-amber-300" />
            Snapshot history
            <span className="rounded-full border border-amber-500/30 bg-amber-500/[0.08] px-1.5 py-0.5 text-[9px] font-bold uppercase text-amber-200">
              {retentionDays}-day rolling
            </span>
            {s3Status.enabled ? (
              <span
                data-testid="backup-s3-on"
                title={`Mirroring to s3://${s3Status.bucket}`}
                className="rounded-full border border-emerald-500/30 bg-emerald-500/[0.08] px-1.5 py-0.5 text-[9px] font-bold uppercase text-emerald-200"
              >
                S3 on
              </span>
            ) : (
              <span
                data-testid="backup-s3-off"
                title="Set S3_BACKUP_BUCKET to enable an off-host mirror"
                className="rounded-full border border-tbc-700/40 bg-ink-900/60 px-1.5 py-0.5 text-[9px] font-bold uppercase text-tbc-200/60"
              >
                S3 off
              </span>
            )}
          </p>
          <Button
            size="sm"
            onClick={snapshotNow}
            disabled={snapshotting}
            data-testid="backup-snapshot-now"
            className="h-7 bg-amber-500 px-2 text-[11px] font-semibold text-ink-950 hover:bg-amber-400"
          >
            {snapshotting
              ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
              : <Camera className="mr-1.5 h-3 w-3" />}
            Snapshot now
          </Button>
        </div>
        <p className="mb-2 text-[11px] leading-relaxed text-tbc-200/60">
          A daily scheduled job writes a snapshot to <code>/app/data/backups/</code>.
          Files older than {retentionDays} days are automatically pruned. Restore from any
          listed snapshot below without re-uploading the JSON.
        </p>

        {snapshotsLoading && snapshots.length === 0 ? (
          <p className="text-[11px] text-tbc-200/50">Loading…</p>
        ) : snapshots.length === 0 ? (
          <p className="text-[11px] text-tbc-200/50" data-testid="backup-snapshots-empty">
            No snapshots yet. Tap <strong>Snapshot now</strong> or wait for the daily job to fire.
          </p>
        ) : (
          <ul className="space-y-1.5" data-testid="backup-snapshots-list">
            {snapshots.map((s) => (
              <li
                key={s.id}
                data-testid={`backup-snapshot-row-${s.id}`}
                className="rounded-md border border-tbc-900/60 bg-ink-900/40 px-2.5 py-1.5"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[11px] font-mono text-tbc-100" title={s.filename}>{s.filename}</p>
                    <p className="text-[10px] text-tbc-200/50">
                      {new Date(s.created_at).toLocaleString()} · {(s.size_bytes / 1024).toFixed(1)} KB
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => togglePreview(s)}
                      disabled={diffLoadingId === s.id}
                      data-testid={`backup-snapshot-preview-${s.id}`}
                      className="h-7 border-amber-500/40 bg-ink-900 px-2 text-[10px] text-amber-200 hover:bg-amber-500/10"
                    >
                      {diffLoadingId === s.id
                        ? <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                        : <GitCompareArrows className="mr-1 h-3 w-3" />}
                      {diffOpenId === s.id ? 'Hide' : 'Preview'}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => downloadSnapshot(s)}
                      data-testid={`backup-snapshot-download-${s.id}`}
                      className="h-7 border-tbc-700/60 bg-ink-900 px-2 text-[10px] text-tbc-200 hover:bg-ink-950"
                    >
                      <Download className="mr-1 h-3 w-3" />
                      Download
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => restoreSnapshot(s, 'merge')}
                      disabled={restoringId === s.id}
                      data-testid={`backup-snapshot-restore-merge-${s.id}`}
                      className="h-7 bg-emerald-500 px-2 text-[10px] font-semibold text-ink-950 hover:bg-emerald-400"
                    >
                      {restoringId === s.id
                        ? <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                        : <RotateCcw className="mr-1 h-3 w-3" />}
                      Merge
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => restoreSnapshot(s, 'replace')}
                      disabled={restoringId === s.id}
                      data-testid={`backup-snapshot-restore-replace-${s.id}`}
                      className="h-7 border-rose-500/40 bg-ink-900 px-2 text-[10px] text-rose-300 hover:bg-rose-500/10"
                    >
                      Replace
                    </Button>
                  </div>
                </div>

                {/* Collapsible diff strip — counts only, no row-level diff. */}
                {diffOpenId === s.id && diffById[s.id] && (
                  <div
                    data-testid={`backup-snapshot-diff-${s.id}`}
                    className="mt-2 grid gap-1 rounded border border-tbc-900/60 bg-ink-950/80 p-2 text-[10px]"
                  >
                    <div className="text-tbc-200/60">
                      Snapshot taken {new Date(diffById[s.id].snapshot_exported_at).toLocaleString()} by{' '}
                      <code className="rounded bg-ink-900 px-1 py-0.5 text-tbc-200">{diffById[s.id].snapshot_exported_by}</code>
                    </div>
                    <table className="mt-1 w-full">
                      <thead className="text-[9px] uppercase tracking-wider text-tbc-200/50">
                        <tr>
                          <th className="text-left">Collection</th>
                          <th className="text-right">Current</th>
                          <th className="text-right">Snapshot</th>
                          <th className="text-right">Merge writes ≤</th>
                          <th className="text-right">Replace delta</th>
                        </tr>
                      </thead>
                      <tbody className="font-mono">
                        {(diffById[s.id].rows || []).map((r) => (
                          <tr
                            key={r.collection}
                            data-testid={`backup-snapshot-diff-row-${s.id}-${r.collection}`}
                            className="border-t border-tbc-900/40 text-tbc-100"
                          >
                            <td className="py-0.5">{r.collection}</td>
                            <td className="text-right text-tbc-200/70">{r.current_count}</td>
                            <td className="text-right text-tbc-100">{r.snapshot_count}</td>
                            <td className="text-right text-emerald-300">+{r.merge_delta_max}</td>
                            <td className={`text-right ${
                              r.replace_delta > 0 ? 'text-emerald-300'
                              : r.replace_delta < 0 ? 'text-rose-300'
                              : 'text-tbc-200/50'
                            }`}>
                              {r.replace_delta > 0 ? '+' : ''}{r.replace_delta}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="text-[9px] leading-relaxed text-tbc-200/50">
                      <strong className="text-emerald-300">Merge</strong> upserts by primary key — actual writes
                      may be fewer (existing ids update in place). <strong className="text-rose-300">Replace</strong>
                      {' '}WIPES the collection first then inserts the snapshot rows; the delta column shows the net change.
                    </p>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

import React from 'react';
import { Button } from '../../../components/ui/button';
import { Download, Loader2 } from 'lucide-react';

/**
 * Bulk-action toolbar that appears above the users table when 1+ users are
 * selected. Every action is delegated up via callbacks — this component is
 * purely presentational.
 */
export function UsersBulkToolbar({
  selectedCount, bulkBusy, onExportCsv, onPause, onResume,
  onGrantCredits, onSetPlan, onDelete,
}) {
  if (selectedCount === 0) return null;
  return (
    <div
      data-testid="bulk-toolbar"
      className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-tbc-500/40 bg-tbc-500/10 px-3 py-2"
    >
      <span className="text-xs font-bold text-tbc-100">{selectedCount} selected</span>
      <span className="text-tbc-200/40">·</span>

      <Button
        data-testid="bulk-export-csv" size="sm" disabled={bulkBusy} variant="outline"
        className="border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950"
        onClick={onExportCsv}
      >
        <Download className="mr-1.5 h-3 w-3" /> Export CSV
      </Button>
      <Button
        data-testid="bulk-pause" size="sm" disabled={bulkBusy} variant="outline"
        className="border-amber-500/40 bg-ink-900 text-amber-300 hover:bg-amber-500/10"
        onClick={onPause}
      >
        {bulkBusy ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : null}
        Pause
      </Button>
      <Button
        data-testid="bulk-resume" size="sm" disabled={bulkBusy} variant="outline"
        className="border-emerald-500/40 bg-ink-900 text-emerald-300 hover:bg-emerald-500/10"
        onClick={onResume}
      >
        Resume
      </Button>
      <Button
        data-testid="bulk-grant-credits" size="sm" disabled={bulkBusy} variant="outline"
        className="border-tbc-500/40 bg-ink-900 text-tbc-300 hover:bg-tbc-500/10"
        onClick={() => {
          const v = window.prompt('Grant how many credits per user? (negative to deduct)', '100');
          const amt = parseInt(v, 10);
          if (!isNaN(amt)) onGrantCredits(amt);
        }}
      >
        ± Credits
      </Button>
      <Button
        data-testid="bulk-set-plan" size="sm" disabled={bulkBusy} variant="outline"
        className="border-sky-500/40 bg-ink-900 text-sky-300 hover:bg-sky-500/10"
        onClick={() => {
          const v = window.prompt('Set plan id for selected users (e.g. starter / pro / trial7):', 'starter');
          if (v) onSetPlan(v.trim());
        }}
      >
        Set plan
      </Button>
      <Button
        data-testid="bulk-delete" size="sm" disabled={bulkBusy} variant="outline"
        className="border-rose-500/40 bg-ink-900 text-rose-300 hover:bg-rose-500/10"
        onClick={onDelete}
      >
        Soft-delete
      </Button>
    </div>
  );
}

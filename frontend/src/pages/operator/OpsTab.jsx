import React, { useCallback, useEffect, useState } from 'react';
import api from '../../lib/api';
import { toast } from 'sonner';

import { OpsQuickActions }      from './ops/OpsQuickActions';
import { OpsHealthCheck }       from './ops/OpsHealthCheck';
import { OpsCodeReview }        from './ops/OpsCodeReview';
import { OpsRestartAndDeploy }  from './ops/OpsRestartAndDeploy';
import { OpsTrialEmailCron }    from './ops/OpsTrialEmailCron';

export default function OpsTab() {
  const [health, setHealth] = useState(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [review, setReview] = useState(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [restartingSvc, setRestartingSvc] = useState(null);
  const [deployInfo, setDeployInfo] = useState(null);
  const [copied, setCopied] = useState(false);
  const [trialRun, setTrialRun] = useState(null);
  const [trialBusy, setTrialBusy] = useState(false);

  const loadHealth = useCallback(async () => {
    setHealthLoading(true);
    try {
      const { data } = await api.get('/operator/ops/health');
      setHealth(data);
    } catch (err) {
      console.error('Health check failed', err);
      toast.error('Health check failed');
    } finally {
      setHealthLoading(false);
    }
  }, []);

  const loadDeployInfo = useCallback(async () => {
    try {
      const { data } = await api.get('/operator/ops/deploy-info');
      setDeployInfo(data);
    } catch (e) {
      // Non-critical: deploy info is decorative. Log so it shows up in console.
      console.warn('deploy-info fetch failed', e?.response?.status, e?.message);
    }
  }, []);

  useEffect(() => {
    loadHealth();
    loadDeployInfo();
  }, [loadHealth, loadDeployInfo]);

  const runReview = async () => {
    setReviewLoading(true);
    setReview(null);
    try {
      const { data } = await api.post('/operator/ops/code-review');
      setReview(data);
      const lintOk = data?.python?.lint?.ok;
      const fmtOk  = data?.python?.format?.ok;
      if (lintOk && fmtOk) toast.success('Code review passed ✓');
      else toast.warning('Code review found issues — see report below');
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Code review failed');
    } finally {
      setReviewLoading(false);
    }
  };

  const restart = async (service) => {
    if (!window.confirm(`Restart ${service}? Brief downtime (~3s).`)) return;
    setRestartingSvc(service);
    try {
      await api.post(`/operator/ops/restart?service=${service}`);
      toast.success(`${service} restarted`);
      // give services time to come back
      setTimeout(() => loadHealth(), 3500);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Restart failed');
    } finally {
      setRestartingSvc(null);
    }
  };

  const copyCommit = async () => {
    const sha = deployInfo?.commit?.sha;
    if (!sha) return;
    try {
      await navigator.clipboard.writeText(sha);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.warn('Clipboard copy failed', err);
      toast.error('Copy failed');
    }
  };

  const runTrialCron = async (dryRun) => {
    setTrialBusy(true);
    setTrialRun(null);
    try {
      const { data } = await api.post(`/operator/cron/trial-reminders?dry_run=${dryRun ? 'true' : 'false'}`);
      setTrialRun(data);
      const total = (data.t3_sent || 0) + (data.expired_sent || 0);
      if (dryRun) toast.message(`Dry-run: ${total} email${total === 1 ? '' : 's'} would be sent`);
      else toast.success(`${total} trial email${total === 1 ? '' : 's'} dispatched`);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Trial cron failed');
    } finally {
      setTrialBusy(false);
    }
  };

  return (
    <div className="grid gap-6" data-testid="ops-tab">
      <OpsQuickActions
        onHealth={loadHealth}
        onReview={runReview}
        healthLoading={healthLoading}
        reviewLoading={reviewLoading}
        healthSummary={health?.summary}
      />
      <OpsHealthCheck health={health} loading={healthLoading} onRefresh={loadHealth} />
      <OpsCodeReview review={review} loading={reviewLoading} onRun={runReview} />
      <OpsRestartAndDeploy
        restartingSvc={restartingSvc}
        onRestart={restart}
        deployInfo={deployInfo}
        copied={copied}
        onCopyCommit={copyCommit}
      />
      <OpsTrialEmailCron trialRun={trialRun} busy={trialBusy} onRun={runTrialCron} />
    </div>
  );
}

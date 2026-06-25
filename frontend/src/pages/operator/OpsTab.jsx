import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../lib/api';
import { toast } from 'sonner';

import { OpsQuickActions }      from './ops/OpsQuickActions';
import { OpsHealthCheck }       from './ops/OpsHealthCheck';
import { OpsCodeReview }        from './ops/OpsCodeReview';
import { OpsRestartAndDeploy }  from './ops/OpsRestartAndDeploy';
import { OpsTrialEmailCron }    from './ops/OpsTrialEmailCron';
import { OpsDeploySection }     from './ops/OpsDeploySection';

export default function OpsTab() {
  const navigate = useNavigate();
  const [health, setHealth] = useState(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [review, setReview] = useState(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [restartingSvc, setRestartingSvc] = useState(null);
  const [deployInfo, setDeployInfo] = useState(null);
  const [copied, setCopied] = useState(false);
  const [trialRun, setTrialRun] = useState(null);
  const [trialBusy, setTrialBusy] = useState(false);
  const [selfDeployBusy, setSelfDeployBusy] = useState(false);

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

  // One-tap "Deploy this app" → ships the configured self-repo to Vercel via
  // POST /operator/deploy/self/deploy. Replaces the old card that only linked
  // out to Emergent's now-defunct deploy panel. Surfaces the backend's
  // actionable preconditions (missing Vercel token, unconfigured/empty repo,
  // blocked review) as toasts with a one-click jump to the right settings.
  const selfDeploy = async () => {
    if (!window.confirm('Deploy this app to production now?')) return;
    setSelfDeployBusy(true);
    try {
      const { data } = await api.post('/operator/deploy/self/deploy', { target: 'production' });
      toast.success(`Deploy started · ${data.state || 'queued'}`);
      loadDeployInfo();
    } catch (e) {
      const status = e?.response?.status;
      const detail = e?.response?.data?.detail;
      // 412 preconditions carry a structured {error, message} body.
      if (status === 412 && detail && typeof detail === 'object') {
        const goSettings = {
          label: 'Open settings',
          onClick: () => navigate('/operator?tab=settings#self-source'),
        };
        toast.error(detail.message || 'Deploy blocked — check the self-deploy settings.', {
          duration: 12000,
          action: detail.error === 'review_blocked' ? undefined : goSettings,
        });
        return;
      }
      const msg = typeof detail === 'string'
        ? detail
        : `Deploy failed${status ? ` (HTTP ${status})` : ''}`;
      // 503 = Vercel token or self_repo not configured → point at the fix.
      if (status === 503) {
        const isToken = msg.toLowerCase().includes('vercel token');
        toast.error(msg, {
          duration: 12000,
          action: {
            label: 'Configure now',
            onClick: () => navigate(isToken ? '/operator?tab=ops' : '/operator?tab=settings#self-source'),
          },
        });
      } else {
        toast.error(msg);
      }
    } finally {
      setSelfDeployBusy(false);
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
      <OpsDeploySection />
      <OpsCodeReview review={review} loading={reviewLoading} onRun={runReview} />
      <OpsRestartAndDeploy
        restartingSvc={restartingSvc}
        onRestart={restart}
        deployInfo={deployInfo}
        copied={copied}
        onCopyCommit={copyCommit}
        onSelfDeploy={selfDeploy}
        selfDeployBusy={selfDeployBusy}
      />
      <OpsTrialEmailCron trialRun={trialRun} busy={trialBusy} onRun={runTrialCron} />
    </div>
  );
}

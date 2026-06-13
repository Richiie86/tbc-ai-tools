"""GitHub PR Preview widget — surfaces every active Vercel preview branch
on the Operator dashboard so the operator can promote any of them to prod
with a single click.

The endpoint joins:

  - `deploy_projects` (one or more projects the operator has registered)
  - Vercel's `/v6/deployments?projectId=…` (last 30 deployments per project)

…and groups results by `meta.githubCommitRef` (the branch). For each
branch we keep only the latest READY preview deployment. Production
deployments are skipped — they're already live.

Endpoint: `GET /api/operator/deploy/previews` (operator-only).
"""
import logging
from collections import OrderedDict
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException

from auth_utils import get_current_operator
from db import db
from vercel_api_ext import vercel_list_deployments

logger = logging.getLogger('tbc')

router = APIRouter(prefix='/api/operator/deploy', tags=['deploy-previews'])


def _bucket_state(state: str) -> str:
    """Vercel exposes a long list of states (BUILDING, INITIALIZING, READY,
    ERROR, CANCELED, QUEUED…). We collapse them into three so the widget
    only has to render three colours."""
    s = (state or '').upper()
    if s == 'READY':
        return 'ready'
    if s in ('ERROR', 'CANCELED'):
        return 'failed'
    return 'building'


@router.get('/previews')
async def list_previews(_op: dict = Depends(get_current_operator)):
    """Returns one row per active preview branch with everything the UI
    needs to render the widget + drive the Promote button:

        [
          {
            project_id: '…',          # internal id, used for promote endpoint
            project_name: 'tbctools',
            branch: 'feat/dark-mode',
            preview_url: 'https://tbctools-feat-dark-mode.vercel.app',
            deployment_id: 'dpl_…',   # required to promote
            state: 'ready' | 'building' | 'failed',
            created_at: iso,
            commit_sha: '…',          # short
            commit_message: '…',      # truncated
          }, …
        ]
    """
    settings = await db.settings.find_one({'_id': 'payment_settings'}) or {}

    projects = await db.deploy_projects.find({}).to_list(50)
    out: list[dict] = []
    for proj in projects:
        vid = proj.get('vercel_project_id')
        if not vid:
            continue  # never deployed — nothing to list
        try:
            deployments = await vercel_list_deployments(settings, vid, limit=30)
        except HTTPException:
            # Token missing / project access issue — skip silently so the
            # widget renders other projects' previews instead of 5xx-ing.
            continue
        except Exception as e:
            logger.warning('list_previews: vercel call failed for %s: %s', vid, e)
            continue

        # Group by branch — keep only the *latest* deployment per branch.
        by_branch: OrderedDict[str, dict] = OrderedDict()
        for d in deployments:
            target = (d.get('target') or '').lower()
            if target == 'production':
                continue  # already shipped
            meta = d.get('meta') or {}
            branch = (
                meta.get('githubCommitRef')
                or meta.get('gitlabCommitRef')
                or meta.get('bitbucketCommitRef')
                or 'unknown'
            )
            if branch in by_branch:
                continue  # we already kept the newest (deployments come newest-first)
            by_branch[branch] = d

        for branch, d in by_branch.items():
            meta = d.get('meta') or {}
            created_ms = d.get('created') or d.get('createdAt') or 0
            try:
                created_iso = datetime.fromtimestamp(int(created_ms) / 1000, tz=timezone.utc).isoformat()
            except Exception:
                created_iso = None
            out.append({
                'project_id': proj.get('id'),
                'project_name': proj.get('name') or vid,
                'branch': branch,
                'preview_url': f"https://{d.get('url')}" if d.get('url') else None,
                'deployment_id': d.get('uid') or d.get('id'),
                'state': _bucket_state(d.get('state') or d.get('readyState')),
                'created_at': created_iso,
                'commit_sha': (meta.get('githubCommitSha') or '')[:8],
                'commit_message': (meta.get('githubCommitMessage') or '')[:120],
            })

    # Newest first.
    out.sort(key=lambda r: r.get('created_at') or '', reverse=True)
    return {'previews': out}

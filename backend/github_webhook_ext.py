"""GitHub push webhook → auto-deploy.

Receives `POST /api/webhooks/github` whenever GitHub fires a `push` event,
verifies the HMAC-SHA256 signature, finds the matching deploy project by
`repo` + `gitRef`, and triggers a deploy. Combined with the per-project
`auto_promote` flag this closes the loop:

    git push → webhook → deploy → preview ready → (if green) auto-promote.

Per-project webhook secrets live on the deploy project doc itself
(`github_webhook_secret`), so different projects can use different shared
secrets without bleeding into one another.
"""
import hmac
import hashlib
import logging
import secrets
from typing import Optional

from fastapi import APIRouter, Body, Depends, Header, HTTPException, Request
import httpx

from auth_utils import get_current_operator
from db import db


logger = logging.getLogger('tbc.github_webhook')
router = APIRouter(prefix='/api')


def _verify_signature(secret: str, raw_body: bytes, header: Optional[str]) -> bool:
    """Constant-time compare against GitHub's `X-Hub-Signature-256`."""
    if not header or not secret:
        return False
    if not header.startswith('sha256='):
        return False
    digest = hmac.new(secret.encode('utf-8'), raw_body, hashlib.sha256).hexdigest()
    expected = f'sha256={digest}'
    return hmac.compare_digest(expected, header)


# ---------- Operator surface — manage webhook secret per project --------
@router.post('/operator/deploy/{project_id}/webhook/rotate')
async def rotate_project_webhook_secret(
    project_id: str,
    _op: dict = Depends(get_current_operator),
):
    """Generate a fresh shared secret for the project and return it once.

    The secret is stored hashed-at-rest is *not* good enough here because
    GitHub needs the plain value too — we keep it plain in the project
    doc, masked when echoed via the settings endpoint.
    """
    project = await db.deploy_projects.find_one({'id': project_id})
    if not project:
        raise HTTPException(404, 'Project not found')
    fresh = 'whsec_' + secrets.token_urlsafe(28)
    await db.deploy_projects.update_one(
        {'id': project_id},
        {'$set': {'github_webhook_secret': fresh}},
    )
    return {
        'ok': True,
        'secret': fresh,           # one-time reveal — operator must copy it now
        'masked': '••••' + fresh[-4:],
        'project_id': project_id,
    }




@router.post('/operator/deploy/{project_id}/webhook/install')
async def install_project_webhook(
    project_id: str,
    request: Request,
    _op: dict = Depends(get_current_operator),
):
    """Create or update the GitHub push webhook automatically.

    Uses the GitHub token saved in My Keys. The token needs repository webhook
    administration permission (classic: `admin:repo_hook`; fine-grained:
    Webhooks read/write for the repository). This removes the old manual copy
    URL/secret flow when the token has permission.
    """
    project = await db.deploy_projects.find_one({'id': project_id})
    if not project:
        raise HTTPException(404, 'Project not found')
    repo = (project.get('repo') or '').strip()
    if not repo or '/' not in repo:
        raise HTTPException(409, 'Add a GitHub repo to this project before installing a webhook.')

    settings = await db.settings.find_one({'_id': 'payment_settings'}) or {}
    token = (settings.get('github_token') or '').strip()
    if not token:
        raise HTTPException(503, 'GitHub token not set in Operator → My Keys.')

    secret = project.get('github_webhook_secret')
    if not secret:
        secret = 'whsec_' + secrets.token_urlsafe(28)
        await db.deploy_projects.update_one(
            {'id': project_id}, {'$set': {'github_webhook_secret': secret}},
        )

    base = str(request.url).split('/api/')[0].rstrip('/')
    hook_url = f'{base}/api/webhooks/github'
    headers = {
        'Authorization': f'Bearer {token}',
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
    }
    body = {
        'name': 'web',
        'active': True,
        'events': ['push'],
        'config': {
            'url': hook_url,
            'content_type': 'json',
            'secret': secret,
            'insecure_ssl': '0',
        },
    }

    async with httpx.AsyncClient(timeout=20.0) as client:
        # Prefer updating an existing hook for the same URL so repeated clicks
        # keep the setup idempotent. If listing is forbidden, try create.
        existing_id = None
        hooks = await client.get(f'https://api.github.com/repos/{repo}/hooks', headers=headers)
        if hooks.status_code == 200:
            for h in hooks.json() or []:
                cfg = h.get('config') or {}
                if cfg.get('url') == hook_url:
                    existing_id = h.get('id')
                    break
        if existing_id:
            resp = await client.patch(
                f'https://api.github.com/repos/{repo}/hooks/{existing_id}',
                headers=headers, json=body,
            )
            action = 'updated'
        else:
            resp = await client.post(f'https://api.github.com/repos/{repo}/hooks', headers=headers, json=body)
            action = 'created'

    if resp.status_code not in (200, 201):
        msg = resp.text[:300]
        if resp.status_code in (401, 403):
            raise HTTPException(403, 'GitHub token cannot manage webhooks for this repo. Add webhook write/admin permission in GitHub, then try again.')
        raise HTTPException(502, f'GitHub webhook install failed: {msg}')

    return {
        'ok': True,
        'action': action,
        'repo': repo,
        'webhook_url': hook_url,
        'secret_set': True,
        'secret_masked': '••••' + secret[-4:],
        'github_hook_id': (resp.json() or {}).get('id'),
        'events': ['push'],
    }


@router.get('/operator/deploy/{project_id}/webhook')
async def get_project_webhook_info(
    project_id: str,
    request: Request,
    _op: dict = Depends(get_current_operator),
):
    """Return everything the operator needs to paste into GitHub's
    Webhooks → Add webhook page: the URL, content-type, secret presence."""
    project = await db.deploy_projects.find_one({'id': project_id})
    if not project:
        raise HTTPException(404, 'Project not found')
    base = str(request.url).split('/api/')[0].rstrip('/')
    secret = project.get('github_webhook_secret')
    return {
        'webhook_url': f'{base}/api/webhooks/github',
        'content_type': 'application/json',
        'secret_set': bool(secret),
        'secret_masked': ('••••' + secret[-4:]) if secret else None,
        'project_id': project_id,
        'events': ['push'],
        'instructions': (
            'On github.com, open your repo → Settings → Webhooks → Add webhook. '
            'Paste the URL, set content-type to application/json, paste the secret, '
            'choose "Just the push event", and Save.'
        ),
    }


# ---------- The actual webhook endpoint (called by GitHub) --------------
@router.post('/webhooks/github')
async def github_push_webhook(
    request: Request,
    x_github_event: Optional[str] = Header(default=None),
    x_hub_signature_256: Optional[str] = Header(default=None),
):
    """Handle GitHub's push event. Signature verified per-project so a
    secret leak only compromises that single project."""
    raw_body = await request.body()
    try:
        payload = await request.json()
    except Exception:
        raise HTTPException(400, 'Invalid JSON body')

    # GitHub sends a one-shot `ping` event when the webhook is first added.
    # Answer 200 so the UI shows green even before the first push.
    if x_github_event == 'ping':
        return {'ok': True, 'pong': True}

    if x_github_event != 'push':
        return {'ok': True, 'ignored': x_github_event}

    repo_full = (payload.get('repository') or {}).get('full_name')
    ref = payload.get('ref', '')
    if not repo_full or not ref.startswith('refs/heads/'):
        return {'ok': True, 'ignored': 'non-branch push'}
    branch = ref.split('refs/heads/', 1)[1]

    # Find every project that watches this repo + branch. A repo can back
    # multiple environments (staging vs prod) so we may fan-out to >1 deploy.
    matches = []
    async for doc in db.deploy_projects.find({'repo': repo_full}):
        proj_ref = doc.get('gitRef') or 'main'
        if proj_ref == branch and doc.get('github_webhook_secret'):
            matches.append(doc)

    if not matches:
        logger.info('GitHub push for %s@%s → no matching project', repo_full, branch)
        return {'ok': True, 'matched': 0, 'reason': 'no matching project with webhook secret'}

    deployed = []
    skipped = []
    render_deploy = None
    for proj in matches:
        secret = proj.get('github_webhook_secret')
        if not _verify_signature(secret, raw_body, x_hub_signature_256):
            logger.warning('GitHub webhook signature mismatch for %s', proj['id'])
            skipped.append({'project_id': proj['id'], 'reason': 'invalid_signature'})
            continue

        # Reuse the existing _trigger_deploy helper. Lazy import to dodge
        # the circular module dependency at startup.
        from deploy_projects_ext import _trigger_deploy, get_settings_doc
        try:
            settings = await get_settings_doc()
            res = await _trigger_deploy(
                proj['id'], settings,
                target='preview',          # always preview — auto_promote will ship if green
                git_ref=branch,
                bypass_review=True,        # webhook trusts the push; ship-gate still blocks promote
                user_id=None,
            )
            deployed.append({
                'project_id': proj['id'],
                'deployment_id': res.get('deployment_id'),
                'url': res.get('url'),
            })
            # Platform repo pushes should also deploy the Render backend. Vercel
            # handles the frontend via its Git integration; this closes the
            # backend half of the automation when Render's own autoDeploy is not
            # connected or when the operator relies on a saved deploy hook.
            if repo_full.lower() == 'richiie86/tbc-ai-tools' and branch == 'main':
                try:
                    from deploy_ext import trigger_render_deploy
                    render_deploy = await trigger_render_deploy(source='github-webhook')
                except Exception as re:
                    logger.warning('Render auto-deploy after GitHub push failed: %s', str(re)[:200])
                    render_deploy = {'ok': False, 'error': str(re)[:200]}
        except Exception as e:
            logger.error('Webhook deploy failed for %s: %s', proj['id'], str(e)[:200])
            skipped.append({'project_id': proj['id'], 'reason': str(e)[:200]})

    return {
        'ok': True,
        'matched': len(matches),
        'deployed': deployed,
        'skipped': skipped,
        'render_deploy': render_deploy,
    }

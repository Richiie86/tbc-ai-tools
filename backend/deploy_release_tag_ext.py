"""GitHub release-tagging + CHANGELOG entry for production promotes.

Optional add-ons triggered by the operator's promote button when the
flags `auto_tag=true` and/or `auto_changelog=true` are set in
`PromoteRequest`. Every step is **best-effort and isolated** — a failure
here must never roll back the underlying Vercel promote.

Tag format: `prod-YYYY-MM-DD-N` where N is the 1-based sequence of
production promotes that day. Picking a date-prefixed scheme (instead of
SemVer) keeps audits skim-able and avoids forcing the operator to decide
what's a major/minor.
"""
import base64
import logging
from datetime import datetime, timezone
from typing import Optional

import httpx

logger = logging.getLogger('tbc')

GH_API = 'https://api.github.com'


def _gh_headers(token: str) -> dict:
    return {
        'Authorization': f'Bearer {token}',
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
    }


async def _next_daily_tag_index(token: str, repo: str, date_prefix: str) -> int:
    """Returns N for `prod-YYYY-MM-DD-N`. Lists existing tags matching the
    prefix and picks max+1. Resilient to API errors — falls back to 1."""
    try:
        async with httpx.AsyncClient(timeout=8.0) as cli:
            r = await cli.get(
                f'{GH_API}/repos/{repo}/git/matching-refs/tags/prod-{date_prefix}',
                headers=_gh_headers(token),
            )
        if r.status_code != 200:
            return 1
        refs = r.json() or []
        nums: list[int] = []
        for ref in refs:
            name = (ref.get('ref') or '').rsplit('/', 1)[-1]  # e.g. prod-2026-06-13-2
            try:
                nums.append(int(name.rsplit('-', 1)[-1]))
            except Exception:
                pass
        return (max(nums) + 1) if nums else 1
    except Exception as e:
        logger.warning('next_daily_tag_index lookup failed: %s', e)
        return 1


async def create_release_tag(
    settings: dict,
    repo: str,
    commit_sha: str,
    message: str,
) -> Optional[dict]:
    """Create an annotated tag on GitHub pointing at `commit_sha`. Returns
    the new ref + tag-object on success, or None on any failure.

    Uses the two-step Git Data API (create-object → create-ref) which gives
    us an annotated tag (carries the operator's promote note + a UTC
    timestamp) instead of a lightweight one.
    """
    token = settings.get('github_token')
    if not token or not repo or not commit_sha:
        return None
    today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    idx = await _next_daily_tag_index(token, repo, today)
    tag_name = f'prod-{today}-{idx}'
    tagger_email = (
        settings.get('release_tagger_email')
        or settings.get('operator_email')
        or 'autopilot@tbctools.org'
    )
    try:
        async with httpx.AsyncClient(timeout=12.0) as cli:
            # 1. Create the tag object (annotated tag carrying the message).
            tag_obj = await cli.post(
                f'{GH_API}/repos/{repo}/git/tags',
                headers=_gh_headers(token),
                json={
                    'tag': tag_name,
                    'message': message[:1_000],
                    'object': commit_sha,
                    'type': 'commit',
                    'tagger': {
                        'name': 'TBC Autopilot',
                        'email': tagger_email,
                        'date': datetime.now(timezone.utc).isoformat(),
                    },
                },
            )
            if tag_obj.status_code >= 400:
                logger.warning('create_release_tag(tag obj) failed: %s %s',
                               tag_obj.status_code, tag_obj.text[:300])
                return None
            tag_sha = tag_obj.json().get('sha')
            # 2. Point a ref at the tag object so it actually shows up under
            #    GitHub Releases / tags listing.
            ref = await cli.post(
                f'{GH_API}/repos/{repo}/git/refs',
                headers=_gh_headers(token),
                json={'ref': f'refs/tags/{tag_name}', 'sha': tag_sha},
            )
            if ref.status_code >= 400:
                logger.warning('create_release_tag(ref) failed: %s %s',
                               ref.status_code, ref.text[:300])
                return None
        return {
            'tag': tag_name,
            'tag_sha': tag_sha,
            'commit_sha': commit_sha,
            'url': f'https://github.com/{repo}/releases/tag/{tag_name}',
        }
    except Exception as e:
        logger.warning('create_release_tag failed: %s', e)
        return None


async def prepend_changelog_entry(
    settings: dict,
    repo: str,
    branch: str,
    tag_name: str,
    commit_sha: str,
    project_name: str,
    promoted_by: str,
) -> Optional[dict]:
    """Prepend a new entry to CHANGELOG.md in the project's default branch.

    Uses GitHub's Contents API (read SHA → write new content). Best-effort:
    creates the file if it doesn't exist, leaves alone if anything fails.
    Returns the commit info on success.
    """
    token = settings.get('github_token')
    if not token or not repo or not tag_name:
        return None
    path = 'CHANGELOG.md'
    now = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')
    entry = (
        f'## {tag_name} — {now}\n'
        f'- Promoted to production from `{branch or "?"}` ({commit_sha[:8]})\n'
        f'- Project: {project_name}\n'
        f'- Promoted by: {promoted_by}\n\n'
    )
    try:
        async with httpx.AsyncClient(timeout=12.0) as cli:
            # 1. Read current content (if any).
            existing_sha: Optional[str] = None
            existing_body = ''
            cur = await cli.get(
                f'{GH_API}/repos/{repo}/contents/{path}',
                params={'ref': branch} if branch else None,
                headers=_gh_headers(token),
            )
            if cur.status_code == 200:
                doc = cur.json()
                existing_sha = doc.get('sha')
                try:
                    existing_body = base64.b64decode(doc.get('content', '')).decode('utf-8')
                except Exception:
                    existing_body = ''
            elif cur.status_code != 404:
                logger.warning('prepend_changelog read failed: %s', cur.status_code)
                return None

            new_body = entry + existing_body
            put = await cli.put(
                f'{GH_API}/repos/{repo}/contents/{path}',
                headers=_gh_headers(token),
                json={
                    'message': f'chore(changelog): {tag_name}',
                    'content': base64.b64encode(new_body.encode('utf-8')).decode('ascii'),
                    **({'sha': existing_sha} if existing_sha else {}),
                    **({'branch': branch} if branch else {}),
                },
            )
            if put.status_code >= 400:
                logger.warning('prepend_changelog write failed: %s %s',
                               put.status_code, put.text[:300])
                return None
            return put.json().get('commit')
    except Exception as e:
        logger.warning('prepend_changelog failed: %s', e)
        return None

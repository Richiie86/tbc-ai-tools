# Projects API — for your AI program

Your AI program manages deploy projects over HTTP. Every request must include the
API key as a Bearer token:

```
Authorization: Bearer <AI_API_KEY>
Content-Type: application/json
```

Set `AI_API_KEY` in **Project Settings → Vars**. The base URL is your deployed app
(e.g. `https://www.tbctools.org`).

---

## Create a project

`POST /api/projects`

```bash
curl -X POST https://www.tbctools.org/api/projects \
  -H "Authorization: Bearer $AI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "projectName": "My Cool App",
    "repo": "tbctools/my-cool-app",
    "domain": "my-cool-app.tbctools.org",
    "repoType": "github",
    "gitRef": "main"
  }'
```

Only `projectName`, `repo`, and `domain` are required. `repoType` defaults to
`"github"` and `gitRef` is optional (defaults to the repo's default branch).

Response `201`:

```json
{ "project": { "id": "my-cool-app-lq3x9", "projectName": "My Cool App", "...": "..." } }
```

## Update a project

Send the same `POST` with the existing `id`:

```bash
curl -X POST https://www.tbctools.org/api/projects \
  -H "Authorization: Bearer $AI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "id": "my-cool-app-lq3x9", "projectName": "My Cool App", "repo": "tbctools/my-cool-app", "domain": "app.tbctools.org" }'
```

## List all projects

```bash
curl https://www.tbctools.org/api/projects \
  -H "Authorization: Bearer $AI_API_KEY"
```

## Get / delete one project

```bash
curl https://www.tbctools.org/api/projects/my-cool-app-lq3x9 \
  -H "Authorization: Bearer $AI_API_KEY"

curl -X DELETE https://www.tbctools.org/api/projects/my-cool-app-lq3x9 \
  -H "Authorization: Bearer $AI_API_KEY"
```

---

## JavaScript / TypeScript

```ts
async function createProject(input: {
  projectName: string
  repo: string
  domain: string
  repoType?: "github"
  gitRef?: string
}) {
  const res = await fetch("https://www.tbctools.org/api/projects", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.AI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  })
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`)
  const { project } = await res.json()
  return project
}
```

## Python

```python
import os, requests

def create_project(project_name, repo, domain, git_ref="main"):
    res = requests.post(
        "https://www.tbctools.org/api/projects",
        headers={"Authorization": f"Bearer {os.environ['AI_API_KEY']}"},
        json={
            "projectName": project_name,
            "repo": repo,
            "domain": domain,
            "gitRef": git_ref,
        },
    )
    res.raise_for_status()
    return res.json()["project"]
```

---

After your AI program creates a project here, it appears in the dashboard with its own
**Deploy / Redeploy** button, live build status, and preview link — so you can push and
update each build in place.

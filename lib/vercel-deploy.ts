const VERCEL_API = "https://api.vercel.com"

export type GitRepoType = "github" | "gitlab" | "bitbucket"

export interface DeployRequest {
  /** Project name on Vercel (created if it doesn't exist) */
  projectName: string
  /** Git repo in "owner/repo" form */
  repo: string
  /** Git provider */
  repoType?: GitRepoType
  /** Branch or commit ref to deploy */
  ref?: string
  /** Domain to bind the deployment / project to */
  domain: string
  /** Optional Vercel team/scope id */
  teamId?: string
}

export interface DeployResult {
  deploymentId: string
  deploymentUrl: string
  inspectorUrl: string
  domain: string
  domainConfigured: boolean
  warnings: string[]
}

function authHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  }
}

function withTeam(path: string, teamId?: string) {
  if (!teamId) return path
  const sep = path.includes("?") ? "&" : "?"
  return `${path}${sep}teamId=${encodeURIComponent(teamId)}`
}

async function vercelFetch(token: string, path: string, init?: RequestInit) {
  const res = await fetch(`${VERCEL_API}${path}`, {
    ...init,
    headers: { ...authHeaders(token), ...(init?.headers || {}) },
  })
  const text = await res.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = { raw: text }
  }
  if (!res.ok) {
    const message = json?.error?.message || json?.message || `Vercel API error (${res.status})`
    const err = new Error(message) as Error & { code?: string; status?: number }
    err.code = json?.error?.code || json?.code
    err.status = res.status
    throw err
  }
  return json
}

/** Translate raw Vercel API errors into clear, actionable messages for the UI. */
export function friendlyDeployError(err: unknown): string {
  const e = err as { message?: string; code?: string; status?: number }
  const code = e?.code || ""
  const msg = e?.message || "Deployment failed."

  if (code === "api-deployments-free-per-day" || /more than 100/i.test(msg)) {
    return "Daily deploy limit reached (100/day on the Vercel Hobby plan). Try again tomorrow, or upgrade to Vercel Pro for more deployments."
  }
  if (e?.status === 429 || /rate limit/i.test(msg)) {
    return "Vercel is rate-limiting requests right now. Please wait a moment and try again."
  }
  if (code === "forbidden" || e?.status === 403) {
    return "Your Vercel token doesn't have access to this resource. Check VERCEL_API_TOKEN and VERCEL_TEAM_ID."
  }
  if (/not found/i.test(msg) && /repo/i.test(msg)) {
    return msg // already friendly from resolveGithubRepoId
  }
  return msg
}

/**
 * Resolve a GitHub "owner/repo" to its numeric repo id.
 * The Vercel deployments API requires `repoId` (not the slug) in gitSource.
 */
async function resolveGithubRepoId(repo: string): Promise<number> {
  const ghToken = process.env.GITHUB_TOKEN
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  }
  if (ghToken) headers.Authorization = `Bearer ${ghToken}`

  const res = await fetch(`https://api.github.com/repos/${repo}`, { headers })
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(
        `GitHub repo "${repo}" not found or not accessible. Check the name and that GITHUB_TOKEN has access.`,
      )
    }
    throw new Error(`Could not resolve GitHub repo "${repo}" (status ${res.status}).`)
  }
  const data = await res.json()
  if (typeof data.id !== "number") {
    throw new Error(`GitHub did not return a numeric id for "${repo}".`)
  }
  return data.id
}

/** Find an existing project by name, or create one linked to the git repo. */
async function ensureProject(token: string, req: DeployRequest) {
  const { projectName, repo, repoType = "github", teamId } = req

  try {
    const existing = await vercelFetch(
      token,
      withTeam(`/v9/projects/${encodeURIComponent(projectName)}`, teamId),
    )
    return existing
  } catch {
    // Not found — create it.
  }

  return vercelFetch(token, withTeam("/v11/projects", teamId), {
    method: "POST",
    body: JSON.stringify({
      name: projectName,
      gitRepository: { type: repoType, repo },
    }),
  })
}

/** Bind a custom domain to the project. Returns whether it was configured cleanly. */
async function ensureDomain(token: string, req: DeployRequest, warnings: string[]) {
  const { projectName, domain, teamId } = req
  try {
    await vercelFetch(token, withTeam(`/v10/projects/${encodeURIComponent(projectName)}/domains`, teamId), {
      method: "POST",
      body: JSON.stringify({ name: domain }),
    })
    return true
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Domain already assigned to this project is fine.
    if (/already (in use|assigned|exists)/i.test(message)) return true
    warnings.push(`Domain "${domain}": ${message}`)
    return false
  }
}

export async function deployToVercel(token: string, req: DeployRequest): Promise<DeployResult> {
  const warnings: string[] = []
  const repoType = req.repoType ?? "github"

  await ensureProject(token, req)
  const domainConfigured = await ensureDomain(token, req, warnings)

  // Vercel's deployments API needs the numeric repo id for GitHub sources.
  const gitSource: Record<string, unknown> = {
    type: repoType,
    ref: req.ref || "main",
  }
  if (repoType === "github") {
    gitSource.repoId = await resolveGithubRepoId(req.repo)
  } else {
    // GitLab/Bitbucket accept the slug form.
    gitSource.repo = req.repo
  }

  // skipAutoDetectionConfirmation lets Vercel auto-detect the framework for
  // brand-new projects without requiring a full projectSettings payload.
  const deployment = await vercelFetch(
    token,
    withTeam("/v13/deployments?skipAutoDetectionConfirmation=1", req.teamId),
    {
      method: "POST",
      body: JSON.stringify({
        name: req.projectName,
        target: "production",
        gitSource,
        projectSettings: { framework: null },
      }),
    },
  )

  const url: string = deployment.url ? `https://${deployment.url}` : ""
  return {
    deploymentId: deployment.id,
    deploymentUrl: url,
    inspectorUrl: deployment.inspectorUrl || "",
    domain: req.domain,
    domainConfigured,
    warnings,
  }
}

export interface DeployStatus {
  /** Vercel readyState: QUEUED | BUILDING | READY | ERROR | CANCELED | INITIALIZING */
  readyState: string
  /** True once the deployment is live. */
  ready: boolean
  /** Final deployment url. */
  deploymentUrl: string
  /** Whether the bound domain has verified DNS and is serving. */
  domainVerified: boolean
  /** Domain misconfiguration / verification notes. */
  domainMessage: string
}

/** Poll the live status of a deployment and the verification state of its domain. */
export async function getDeployStatus(
  token: string,
  opts: { deploymentId: string; projectName: string; domain: string; teamId?: string },
): Promise<DeployStatus> {
  const { deploymentId, projectName, domain, teamId } = opts

  const deployment = await vercelFetch(token, withTeam(`/v13/deployments/${deploymentId}`, teamId))
  const readyState: string = deployment.readyState || deployment.status || "QUEUED"

  let domainVerified = false
  let domainMessage = ""
  try {
    const cfg = await vercelFetch(
      token,
      withTeam(
        `/v9/projects/${encodeURIComponent(projectName)}/domains/${encodeURIComponent(domain)}`,
        teamId,
      ),
    )
    domainVerified = cfg.verified === true && !cfg.misconfigured
    if (cfg.misconfigured) domainMessage = "DNS records are misconfigured."
    else if (!cfg.verified) domainMessage = "Awaiting domain verification."
    else domainMessage = "Domain verified and serving."
  } catch (err) {
    domainMessage = err instanceof Error ? err.message : "Could not read domain status."
  }

  return {
    readyState,
    ready: readyState === "READY",
    deploymentUrl: deployment.url ? `https://${deployment.url}` : "",
    domainVerified,
    domainMessage,
  }
}

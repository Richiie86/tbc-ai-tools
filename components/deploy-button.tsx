"use client"

import * as React from "react"
import { Loader2, Rocket, CheckCircle2, AlertCircle, ExternalLink, Globe, Clock } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export interface DeployResultData {
  deploymentId: string
  deploymentUrl: string
  inspectorUrl: string
  domain: string
  domainConfigured: boolean
  warnings: string[]
}

export interface DeployStatusData {
  readyState: string
  ready: boolean
  deploymentUrl: string
  domainVerified: boolean
  domainMessage: string
}

export interface DeployButtonProps {
  /** Project name on Vercel (created if missing). */
  projectName: string
  /** Git repo as "owner/repo". */
  repo: string
  /** Target domain to bind this deploy to. */
  domain: string
  /** Branch or commit ref. Defaults to "main". */
  ref?: string
  /** Git provider. Defaults to "github". */
  repoType?: "github" | "gitlab" | "bitbucket"
  /** Optional Vercel team id. */
  teamId?: string
  /** Button label. */
  label?: string
  className?: string
  onDeployed?: (result: DeployResultData) => void
}

interface DeployState {
  status: "idle" | "deploying" | "success" | "error"
  result?: DeployResultData
  error?: string
}

const TERMINAL_STATES = new Set(["READY", "ERROR", "CANCELED"])

function readyStateLabel(s: string) {
  switch (s) {
    case "QUEUED":
      return "Queued"
    case "INITIALIZING":
      return "Initializing"
    case "BUILDING":
      return "Building"
    case "READY":
      return "Live"
    case "ERROR":
      return "Build failed"
    case "CANCELED":
      return "Canceled"
    default:
      return s
  }
}

export function DeployButton({
  projectName,
  repo,
  domain,
  ref,
  repoType = "github",
  teamId,
  label = "Deploy to domain",
  className,
  onDeployed,
}: DeployButtonProps) {
  const [state, setState] = React.useState<DeployState>({ status: "idle" })
  const [live, setLive] = React.useState<DeployStatusData | null>(null)
  const pollRef = React.useRef<ReturnType<typeof setInterval> | null>(null)

  const stopPolling = React.useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  React.useEffect(() => stopPolling, [stopPolling])

  const startPolling = React.useCallback(
    (deploymentId: string) => {
      stopPolling()
      const params = new URLSearchParams({ deploymentId, projectName, domain })
      if (teamId) params.set("teamId", teamId)

      const tick = async () => {
        try {
          const res = await fetch(`/api/deploy/status?${params.toString()}`)
          const data = await res.json()
          if (!res.ok) return
          setLive(data)
          if (TERMINAL_STATES.has(data.readyState) && (data.domainVerified || data.readyState !== "READY")) {
            stopPolling()
          }
        } catch {
          /* keep polling; transient errors are fine */
        }
      }

      tick()
      pollRef.current = setInterval(tick, 4000)
    },
    [projectName, domain, teamId, stopPolling],
  )

  async function handleDeploy() {
    setState({ status: "deploying" })
    setLive(null)
    try {
      const res = await fetch("/api/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectName, repo, domain, ref, repoType, teamId }),
      })
      const data = await res.json()
      if (!res.ok) {
        setState({ status: "error", error: data.error || "Deployment failed." })
        return
      }
      setState({ status: "success", result: data })
      onDeployed?.(data)
      if (data.deploymentId) startPolling(data.deploymentId)
    } catch (err) {
      setState({
        status: "error",
        error: err instanceof Error ? err.message : "Network error.",
      })
    }
  }

  const isDeploying = state.status === "deploying"
  const isPolling = pollRef.current !== null

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <Button
        type="button"
        onClick={handleDeploy}
        disabled={isDeploying || !projectName || !repo || !domain}
        className="gap-2"
      >
        {isDeploying ? (
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        ) : (
          <Rocket className="size-4" aria-hidden="true" />
        )}
        {isDeploying ? "Deploying…" : label}
      </Button>

      {state.status === "success" && state.result && (
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3 text-sm">
          <div className="flex items-center gap-2 font-medium text-foreground">
            <CheckCircle2 className="size-4 text-chart-3" aria-hidden="true" />
            Deployment started
          </div>

          {(state.result.deploymentUrl || live?.deploymentUrl) && (
            <a
              href={live?.deploymentUrl || state.result.deploymentUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              {live?.deploymentUrl || state.result.deploymentUrl}
              <ExternalLink className="size-3" aria-hidden="true" />
            </a>
          )}

          {/* Live build status */}
          {live && (
            <div className="flex items-center gap-2">
              {live.readyState === "READY" ? (
                <CheckCircle2 className="size-4 text-chart-3" aria-hidden="true" />
              ) : live.readyState === "ERROR" || live.readyState === "CANCELED" ? (
                <AlertCircle className="size-4 text-destructive" aria-hidden="true" />
              ) : (
                <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden="true" />
              )}
              <span className="text-foreground">Build: {readyStateLabel(live.readyState)}</span>
            </div>
          )}

          {/* Domain verification status */}
          <div className="flex items-center gap-2">
            {live?.domainVerified ? (
              <Globe className="size-4 text-chart-3" aria-hidden="true" />
            ) : (
              <Clock className="size-4 text-muted-foreground" aria-hidden="true" />
            )}
            <span className={cn(live?.domainVerified ? "text-foreground" : "text-muted-foreground")}>
              {live?.domainMessage ||
                (state.result.domainConfigured
                  ? `Bound to ${state.result.domain}. Checking verification…`
                  : `Domain ${state.result.domain} needs DNS/verification.`)}
            </span>
          </div>

          {isPolling && (
            <p className="text-xs text-muted-foreground">Auto-refreshing status every few seconds…</p>
          )}

          {state.result.warnings.length > 0 && (
            <ul className="list-inside list-disc text-muted-foreground">
              {state.result.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {state.status === "error" && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{state.error}</span>
        </div>
      )}
    </div>
  )
}

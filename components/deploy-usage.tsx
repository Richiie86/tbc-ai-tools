"use client"

import useSWR from "swr"
import { Gauge, RefreshCw } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"

interface Usage {
  used: number
  limit: number
  remaining: number
  error?: string
}

const fetcher = (url: string) => fetch(url).then((r) => r.json())

export function DeployUsage() {
  const { data, isLoading, mutate } = useSWR<Usage>("/api/deploy/usage", fetcher, {
    revalidateOnFocus: false,
  })

  const used = data?.used ?? 0
  const limit = data?.limit ?? 100
  const remaining = data?.remaining ?? limit
  const pct = Math.min(100, Math.round((used / limit) * 100))
  const near = remaining <= 10

  return (
    <Card className="w-full">
      <CardContent className="flex flex-col gap-3 py-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Gauge className="size-4 text-muted-foreground" aria-hidden="true" />
            <span className="text-sm font-medium text-foreground">Daily deploys</span>
          </div>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label="Refresh usage"
            onClick={() => mutate()}
          >
            <RefreshCw className="size-4" aria-hidden="true" />
          </Button>
        </div>

        {data?.error ? (
          <p className="text-xs text-muted-foreground">{data.error}</p>
        ) : (
          <>
            <div className="flex items-baseline justify-between">
              <span className="text-sm text-muted-foreground">
                {isLoading ? "Loading…" : `${used} of ${limit} used in the last 24h`}
              </span>
              <span
                className={`text-sm font-medium ${near ? "text-destructive" : "text-foreground"}`}
              >
                {isLoading ? "" : `${remaining} left`}
              </span>
            </div>
            <div
              className="h-2 w-full overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-valuenow={used}
              aria-valuemin={0}
              aria-valuemax={limit}
            >
              <div
                className={`h-full rounded-full transition-all ${near ? "bg-destructive" : "bg-primary"}`}
                style={{ width: `${pct}%` }}
              />
            </div>
            {near && !isLoading && (
              <p className="text-xs text-destructive">
                {"You're close to the Hobby plan's daily limit. Upgrade to Vercel Pro for more."}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}

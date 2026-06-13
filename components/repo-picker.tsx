"use client"

import * as React from "react"
import useSWR from "swr"
import { GitBranch, ChevronsUpDown, Check, Lock, RefreshCw, AlertCircle } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"

interface Repo {
  fullName: string
  defaultBranch: string
  private: boolean
  updatedAt: string
}

const fetcher = async (url: string) => {
  const res = await fetch(url)
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || "Failed to load repositories.")
  return data.repos as Repo[]
}

export function RepoPicker({
  value,
  onSelect,
}: {
  value: string
  onSelect: (repo: { fullName: string; defaultBranch: string }) => void
}) {
  const { data, error, isLoading, mutate } = useSWR<Repo[]>("/api/github/repos", fetcher, {
    revalidateOnFocus: false,
  })

  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")
  const containerRef = React.useRef<HTMLDivElement>(null)

  // Close the dropdown when clicking outside.
  React.useEffect(() => {
    function onClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener("mousedown", onClick)
    return () => document.removeEventListener("mousedown", onClick)
  }, [])

  const filtered = React.useMemo(() => {
    if (!data) return []
    const q = query.trim().toLowerCase()
    if (!q) return data
    return data.filter((r) => r.fullName.toLowerCase().includes(q))
  }, [data, query])

  return (
    <div className="relative flex flex-col gap-2" ref={containerRef}>
      <Button
        type="button"
        variant="outline"
        className="w-full justify-between font-normal"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <span className={value ? "truncate text-foreground" : "truncate text-muted-foreground"}>
          {value || "Select a GitHub repo"}
        </span>
        <ChevronsUpDown className=" size-4 shrink-0 opacity-50" aria-hidden="true" />
      </Button>

      {open && (
        <div className="absolute top-full z-50 mt-1 w-full overflow-hidden rounded-lg border border-border bg-popover shadow-md">
          <div className="border-b border-border p-2">
            <Input
              autoFocus
              placeholder="Search repos..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="h-8"
            />
          </div>

          <div className="max-h-64 overflow-y-auto p-1" role="listbox">
            {isLoading && (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                Loading your repositories...
              </p>
            )}

            {error && (
              <div className="flex flex-col items-center gap-2 px-3 py-6 text-center">
                <AlertCircle className="size-5 text-destructive" aria-hidden="true" />
                <p className="text-sm text-muted-foreground">{error.message}</p>
                <Button type="button" size="sm" variant="outline" onClick={() => mutate()}>
                  <RefreshCw className="size-3.5" aria-hidden="true" />
                  Retry
                </Button>
              </div>
            )}

            {!isLoading && !error && filtered.length === 0 && (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                No repositories found.
              </p>
            )}

            {!isLoading &&
              !error &&
              filtered.map((repo) => {
                const selected = repo.fullName === value
                return (
                  <button
                    key={repo.fullName}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                    onClick={() => {
                      onSelect({ fullName: repo.fullName, defaultBranch: repo.defaultBranch })
                      setOpen(false)
                      setQuery("")
                    }}
                  >
                    <GitBranch className="size-3.5 shrink-0 opacity-60" aria-hidden="true" />
                    <span className="truncate">{repo.fullName}</span>
                    {repo.private && (
                      <Lock className="size-3 shrink-0 opacity-60" aria-hidden="true" />
                    )}
                    {selected && <Check className="ml-auto size-4 shrink-0" aria-hidden="true" />}
                  </button>
                )
              })}
          </div>
        </div>
      )}
    </div>
  )
}

"use client"

import * as React from "react"
import { Wallet, Plus, Trash2, ChevronDown } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  type CostAssumptions,
  DEFAULT_ASSUMPTIONS,
  NEON_PLAN_PRICES,
  VERCEL_PRO_PER_MEMBER,
  calcMonthlyCost,
  formatUSD,
} from "@/lib/pricing"

const STORAGE_KEY = "tbctools.cost-assumptions.v1"

function loadAssumptions(): CostAssumptions {
  if (typeof window === "undefined") return DEFAULT_ASSUMPTIONS
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_ASSUMPTIONS
    return { ...DEFAULT_ASSUMPTIONS, ...JSON.parse(raw) }
  } catch {
    return DEFAULT_ASSUMPTIONS
  }
}

export function CostTracker() {
  const [a, setA] = React.useState<CostAssumptions>(DEFAULT_ASSUMPTIONS)
  const [open, setOpen] = React.useState(false)

  React.useEffect(() => {
    setA(loadAssumptions())
  }, [])

  function update(patch: Partial<CostAssumptions>) {
    setA((prev) => {
      const next = { ...prev, ...patch }
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      } catch {
        // ignore persistence errors
      }
      return next
    })
  }

  const cost = calcMonthlyCost(a)

  return (
    <Card className="w-full">
      <CardContent className="flex flex-col gap-4 py-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Wallet className="size-4 text-muted-foreground" aria-hidden="true" />
            <span className="text-sm font-medium text-foreground">Monthly cost estimate</span>
          </div>
          <span className="text-lg font-bold text-foreground">{formatUSD(cost.total)}/mo</span>
        </div>

        {/* Breakdown */}
        <div className="flex flex-col gap-1.5 text-sm">
          <Row label="Vercel" value={cost.vercel} />
          <Row label="Neon database" value={cost.neon} />
          <Row label="Other services" value={cost.extras} />
        </div>

        {/* Prominent grand total for running everything */}
        <div className="flex items-center justify-between gap-3 rounded-lg border border-primary/30 bg-primary/5 px-4 py-3">
          <div className="flex flex-col">
            <span className="text-sm font-semibold text-foreground">
              Charging cost in total for running
            </span>
            <span className="text-xs text-muted-foreground">
              {"All services combined, billed monthly"}
            </span>
          </div>
          <div className="flex flex-col items-end">
            <span className="text-2xl font-bold text-foreground">{formatUSD(cost.total)}</span>
            <span className="text-xs text-muted-foreground">
              {`${formatUSD(cost.total * 12)}/yr`}
            </span>
          </div>
        </div>

        {cost.total === 0 && (
          <p className="text-xs text-muted-foreground">
            {"You're fully on free plans right now — nothing to pay. Adjust the assumptions below if you upgrade."}
          </p>
        )}

        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="justify-between"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          {open ? "Hide assumptions" : "Edit assumptions"}
          <ChevronDown
            className={`size-4 transition-transform ${open ? "rotate-180" : ""}`}
            aria-hidden="true"
          />
        </Button>

        {open && (
          <div className="flex flex-col gap-4 border-t pt-4">
            {/* Vercel */}
            <div className="flex flex-col gap-2">
              <Label className="text-xs font-semibold uppercase text-muted-foreground">
                Vercel
              </Label>
              <div className="flex gap-2">
                <PlanToggle
                  active={a.vercelPlan === "hobby"}
                  onClick={() => update({ vercelPlan: "hobby" })}
                  label="Hobby"
                  sub="Free"
                />
                <PlanToggle
                  active={a.vercelPlan === "pro"}
                  onClick={() => update({ vercelPlan: "pro" })}
                  label="Pro"
                  sub={`${formatUSD(VERCEL_PRO_PER_MEMBER)}/member`}
                />
              </div>
              {a.vercelPlan === "pro" && (
                <div className="flex items-center gap-2">
                  <Label htmlFor="members" className="text-sm">
                    Members
                  </Label>
                  <Input
                    id="members"
                    type="number"
                    min={1}
                    className="w-24"
                    value={a.vercelMembers}
                    onChange={(e) => update({ vercelMembers: Math.max(1, Number(e.target.value)) })}
                  />
                </div>
              )}
            </div>

            {/* Neon */}
            <div className="flex flex-col gap-2">
              <Label className="text-xs font-semibold uppercase text-muted-foreground">
                Neon database
              </Label>
              <div className="grid grid-cols-2 gap-2">
                {(["free", "launch", "scale", "custom"] as const).map((plan) => (
                  <PlanToggle
                    key={plan}
                    active={a.neonPlan === plan}
                    onClick={() => update({ neonPlan: plan })}
                    label={plan.charAt(0).toUpperCase() + plan.slice(1)}
                    sub={plan === "custom" ? "Set price" : formatUSD(NEON_PLAN_PRICES[plan])}
                  />
                ))}
              </div>
              {a.neonPlan === "custom" && (
                <div className="flex items-center gap-2">
                  <Label htmlFor="neon-custom" className="text-sm">
                    $/mo
                  </Label>
                  <Input
                    id="neon-custom"
                    type="number"
                    min={0}
                    className="w-28"
                    value={a.neonCustom}
                    onChange={(e) => update({ neonCustom: Math.max(0, Number(e.target.value)) })}
                  />
                </div>
              )}
            </div>

            {/* Extras */}
            <div className="flex flex-col gap-2">
              <Label className="text-xs font-semibold uppercase text-muted-foreground">
                Other recurring services
              </Label>
              {a.extras.map((e) => (
                <div key={e.id} className="flex items-center gap-2">
                  <Input
                    placeholder="Service name"
                    value={e.name}
                    onChange={(ev) =>
                      update({
                        extras: a.extras.map((x) =>
                          x.id === e.id ? { ...x, name: ev.target.value } : x,
                        ),
                      })
                    }
                  />
                  <Input
                    type="number"
                    min={0}
                    placeholder="0"
                    className="w-24"
                    value={e.monthly}
                    onChange={(ev) =>
                      update({
                        extras: a.extras.map((x) =>
                          x.id === e.id ? { ...x, monthly: Math.max(0, Number(ev.target.value)) } : x,
                        ),
                      })
                    }
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Remove service"
                    onClick={() => update({ extras: a.extras.filter((x) => x.id !== e.id) })}
                  >
                    <Trash2 className="size-4" aria-hidden="true" />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  update({
                    extras: [
                      ...a.extras,
                      { id: `x-${Date.now().toString(36)}`, name: "", monthly: 0 },
                    ],
                  })
                }
              >
                <Plus className="size-4" aria-hidden="true" />
                Add service
              </Button>
            </div>

            <p className="text-xs text-muted-foreground">
              {"Estimates use provider list prices and don't include usage-based overages (extra bandwidth, compute, or storage). Treat this as a baseline, not a final bill."}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function Row({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-foreground">{formatUSD(value)}</span>
    </div>
  )
}

function PlanToggle({
  active,
  onClick,
  label,
  sub,
}: {
  active: boolean
  onClick: () => void
  label: string
  sub: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-1 flex-col items-start rounded-md border px-3 py-2 text-left transition-colors ${
        active
          ? "border-primary bg-primary/5 text-foreground"
          : "border-border text-muted-foreground hover:border-foreground/30"
      }`}
      aria-pressed={active}
    >
      <span className="text-sm font-medium">{label}</span>
      <span className="text-xs">{sub}</span>
    </button>
  )
}

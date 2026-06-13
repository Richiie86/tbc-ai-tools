// Editable pricing assumptions for the cost tracker.
// These are list prices as reference defaults — adjust them in the UI to match
// your actual plans. All values are in USD per month unless noted.

export interface CostAssumptions {
  // Vercel
  vercelPlan: "hobby" | "pro"
  vercelMembers: number
  // Neon database
  neonPlan: "free" | "launch" | "scale" | "custom"
  neonCustom: number
  // Any other recurring services (domains, APIs, etc.)
  extras: { id: string; name: string; monthly: number }[]
}

// Reference list prices (USD/month). Update here if a provider changes pricing.
export const VERCEL_PRO_PER_MEMBER = 20
export const NEON_PLAN_PRICES: Record<CostAssumptions["neonPlan"], number> = {
  free: 0,
  launch: 19,
  scale: 69,
  custom: 0,
}

export const DEFAULT_ASSUMPTIONS: CostAssumptions = {
  vercelPlan: "hobby",
  vercelMembers: 1,
  neonPlan: "free",
  neonCustom: 0,
  extras: [],
}

export interface CostBreakdown {
  vercel: number
  neon: number
  extras: number
  total: number
}

/** Pure calculator: turns assumptions into a monthly cost breakdown. */
export function calcMonthlyCost(a: CostAssumptions): CostBreakdown {
  const vercel = a.vercelPlan === "pro" ? VERCEL_PRO_PER_MEMBER * Math.max(1, a.vercelMembers) : 0
  const neon = a.neonPlan === "custom" ? Math.max(0, a.neonCustom) : NEON_PLAN_PRICES[a.neonPlan]
  const extras = a.extras.reduce((sum, e) => sum + (Number.isFinite(e.monthly) ? e.monthly : 0), 0)
  return {
    vercel,
    neon,
    extras,
    total: vercel + neon + extras,
  }
}

export function formatUSD(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: n % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(n)
}

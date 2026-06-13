import { NextResponse } from "next/server"
import { getDeployUsage } from "@/lib/vercel-deploy"

export const dynamic = "force-dynamic"

export async function GET() {
  const token = process.env.VERCEL_API_TOKEN
  if (!token) {
    return NextResponse.json(
      { error: "VERCEL_API_TOKEN is not set." },
      { status: 400 },
    )
  }
  try {
    const usage = await getDeployUsage(token, process.env.VERCEL_TEAM_ID)
    return NextResponse.json(usage)
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not load deploy usage."
    return NextResponse.json({ error: message }, { status: 502 })
  }
}

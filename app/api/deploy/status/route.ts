import { type NextRequest, NextResponse } from "next/server"
import { getDeployStatus } from "@/lib/vercel-deploy"

export async function GET(request: NextRequest) {
  const token = process.env.VERCEL_API_TOKEN
  if (!token) {
    return NextResponse.json(
      { error: "VERCEL_API_TOKEN is not set. Add it in Project Settings → Vars." },
      { status: 500 },
    )
  }

  const { searchParams } = new URL(request.url)
  const deploymentId = searchParams.get("deploymentId")
  const projectName = searchParams.get("projectName")
  const domain = searchParams.get("domain")
  const teamId = searchParams.get("teamId") || process.env.VERCEL_TEAM_ID || undefined

  if (!deploymentId || !projectName || !domain) {
    return NextResponse.json(
      { error: "deploymentId, projectName, and domain are required." },
      { status: 400 },
    )
  }

  try {
    const status = await getDeployStatus(token, { deploymentId, projectName, domain, teamId })
    return NextResponse.json(status)
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not read deployment status."
    return NextResponse.json({ error: message }, { status: 502 })
  }
}

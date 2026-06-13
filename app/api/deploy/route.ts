import { type NextRequest, NextResponse } from "next/server"
import { deployToVercel, friendlyDeployError, type DeployRequest } from "@/lib/vercel-deploy"

export async function POST(request: NextRequest) {
  const token = process.env.VERCEL_API_TOKEN
  if (!token) {
    return NextResponse.json(
      { error: "VERCEL_API_TOKEN is not set. Add it in Project Settings → Vars." },
      { status: 500 },
    )
  }

  let body: Partial<DeployRequest>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 })
  }

  const { projectName, repo, domain, ref, repoType, teamId } = body

  if (!projectName || !repo || !domain) {
    return NextResponse.json(
      { error: "projectName, repo, and domain are required." },
      { status: 400 },
    )
  }

  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    return NextResponse.json(
      { error: 'repo must be in "owner/repo" format, e.g. "vercel/next.js".' },
      { status: 400 },
    )
  }

  try {
    const result = await deployToVercel(token, {
      projectName,
      repo,
      domain,
      ref,
      repoType,
      teamId: teamId || process.env.VERCEL_TEAM_ID,
    })
    return NextResponse.json(result)
  } catch (err) {
    return NextResponse.json({ error: friendlyDeployError(err) }, { status: 502 })
  }
}

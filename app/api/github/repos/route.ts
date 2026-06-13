import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"

interface GitHubRepo {
  full_name: string
  default_branch: string
  private: boolean
  updated_at: string
}

/**
 * Lists the authenticated user's GitHub repositories so they can be picked
 * instead of typed. Requires GITHUB_TOKEN (classic "repo" scope or a
 * fine-grained token with read-only Contents/Metadata access).
 */
export async function GET() {
  const token = process.env.GITHUB_TOKEN
  if (!token) {
    return NextResponse.json(
      { error: "GITHUB_TOKEN is not set. Add it in Project Settings -> Vars." },
      { status: 400 },
    )
  }

  try {
    // Fetch up to 3 pages (300 repos), most-recently-updated first.
    const repos: GitHubRepo[] = []
    for (let page = 1; page <= 3; page++) {
      const res = await fetch(
        `https://api.github.com/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          cache: "no-store",
        },
      )

      if (!res.ok) {
        const text = await res.text()
        return NextResponse.json(
          { error: `GitHub API error (${res.status}): ${text.slice(0, 200)}` },
          { status: res.status },
        )
      }

      const batch = (await res.json()) as GitHubRepo[]
      repos.push(...batch)
      if (batch.length < 100) break
    }

    const result = repos.map((r) => ({
      fullName: r.full_name,
      defaultBranch: r.default_branch,
      private: r.private,
      updatedAt: r.updated_at,
    }))

    return NextResponse.json({ repos: result })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to fetch repositories." },
      { status: 500 },
    )
  }
}

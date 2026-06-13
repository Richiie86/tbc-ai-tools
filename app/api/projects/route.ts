import { type NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { projects } from "@/lib/db/schema"
import { desc, eq } from "drizzle-orm"

export const dynamic = "force-dynamic"

/**
 * Programmatic API for your AI program.
 * Authenticate with: Authorization: Bearer <AI_API_KEY>
 *
 * GET  /api/projects            -> list all projects
 * POST /api/projects            -> create or update a project
 *      body: { id?, projectName, repo, domain, repoType?, gitRef? }
 */

function authorize(req: NextRequest): string | null {
  const expected = process.env.AI_API_KEY
  if (!expected) return "AI_API_KEY is not configured on the server."
  const header = req.headers.get("authorization") || ""
  const token = header.startsWith("Bearer ") ? header.slice(7) : ""
  if (!token || token !== expected) return "Unauthorized: invalid or missing API key."
  return null
}

function makeId(name: string) {
  const slug = String(name)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
  return `${slug || "project"}-${Date.now().toString(36)}`
}

export async function GET(req: NextRequest) {
  const err = authorize(req)
  if (err) return NextResponse.json({ error: err }, { status: 401 })
  const rows = await db.select().from(projects).orderBy(desc(projects.updatedAt))
  return NextResponse.json({ projects: rows })
}

export async function POST(req: NextRequest) {
  const err = authorize(req)
  if (err) return NextResponse.json({ error: err }, { status: 401 })

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 })
  }

  const projectName = typeof body.projectName === "string" ? body.projectName.trim() : ""
  const repo = typeof body.repo === "string" ? body.repo.trim() : ""
  const domain = typeof body.domain === "string" ? body.domain.trim() : ""
  const repoType = typeof body.repoType === "string" ? body.repoType : "github"
  const gitRef = typeof body.gitRef === "string" ? body.gitRef : null
  const id = typeof body.id === "string" && body.id ? body.id : null

  if (!projectName || !repo || !domain) {
    return NextResponse.json(
      { error: "projectName, repo, and domain are required." },
      { status: 400 },
    )
  }

  const now = new Date()

  if (id) {
    const [updated] = await db
      .update(projects)
      .set({ projectName, repo, domain, repoType, gitRef, updatedAt: now })
      .where(eq(projects.id, id))
      .returning()
    if (updated) return NextResponse.json({ project: updated })
  }

  const [created] = await db
    .insert(projects)
    .values({
      id: makeId(projectName),
      projectName,
      repo,
      domain,
      repoType,
      gitRef,
      createdAt: now,
      updatedAt: now,
    })
    .returning()

  return NextResponse.json({ project: created }, { status: 201 })
}

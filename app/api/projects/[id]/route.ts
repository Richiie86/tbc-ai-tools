import { type NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { projects } from "@/lib/db/schema"
import { eq } from "drizzle-orm"

export const dynamic = "force-dynamic"

/**
 * GET    /api/projects/:id  -> fetch one project
 * DELETE /api/projects/:id  -> delete a project
 * Authenticate with: Authorization: Bearer <AI_API_KEY>
 */

function authorize(req: NextRequest): string | null {
  const expected = process.env.AI_API_KEY
  if (!expected) return "AI_API_KEY is not configured on the server."
  const header = req.headers.get("authorization") || ""
  const token = header.startsWith("Bearer ") ? header.slice(7) : ""
  if (!token || token !== expected) return "Unauthorized: invalid or missing API key."
  return null
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const err = authorize(req)
  if (err) return NextResponse.json({ error: err }, { status: 401 })
  const { id } = await params
  const [row] = await db.select().from(projects).where(eq(projects.id, id))
  if (!row) return NextResponse.json({ error: "Project not found." }, { status: 404 })
  return NextResponse.json({ project: row })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const err = authorize(req)
  if (err) return NextResponse.json({ error: err }, { status: 401 })
  const { id } = await params
  await db.delete(projects).where(eq(projects.id, id))
  return NextResponse.json({ ok: true })
}

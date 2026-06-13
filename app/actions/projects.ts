"use server"

import { db } from "@/lib/db"
import { projects, type Project } from "@/lib/db/schema"
import { desc, eq } from "drizzle-orm"
import { revalidatePath } from "next/cache"

export interface ProjectInput {
  id?: string
  projectName: string
  repo: string
  repoType?: string
  gitRef?: string | null
  domain: string
}

function makeId(name: string) {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
  return `${slug || "project"}-${Date.now().toString(36)}`
}

export async function listProjects(): Promise<Project[]> {
  return db.select().from(projects).orderBy(desc(projects.updatedAt))
}

export async function upsertProject(input: ProjectInput): Promise<Project> {
  const now = new Date()
  if (input.id) {
    const [updated] = await db
      .update(projects)
      .set({
        projectName: input.projectName,
        repo: input.repo,
        repoType: input.repoType ?? "github",
        gitRef: input.gitRef ?? null,
        domain: input.domain,
        updatedAt: now,
      })
      .where(eq(projects.id, input.id))
      .returning()
    if (updated) {
      revalidatePath("/")
      return updated
    }
  }

  const [created] = await db
    .insert(projects)
    .values({
      id: makeId(input.projectName),
      projectName: input.projectName,
      repo: input.repo,
      repoType: input.repoType ?? "github",
      gitRef: input.gitRef ?? null,
      domain: input.domain,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
  revalidatePath("/")
  return created
}

export async function deleteProject(id: string): Promise<void> {
  await db.delete(projects).where(eq(projects.id, id))
  revalidatePath("/")
}

export async function recordDeployment(
  id: string,
  data: { deploymentId: string; deploymentUrl: string; readyState: string },
): Promise<void> {
  await db
    .update(projects)
    .set({
      lastDeploymentId: data.deploymentId,
      lastDeploymentUrl: data.deploymentUrl,
      lastReadyState: data.readyState,
      lastDeployedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(projects.id, id))
  revalidatePath("/")
}

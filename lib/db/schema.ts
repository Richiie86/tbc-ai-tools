import { pgTable, text, timestamp } from "drizzle-orm/pg-core"

export const projects = pgTable("projects", {
  id: text("id").primaryKey(),
  projectName: text("project_name").notNull(),
  repo: text("repo").notNull(),
  repoType: text("repo_type").notNull().default("github"),
  gitRef: text("git_ref"),
  domain: text("domain").notNull(),
  lastDeploymentId: text("last_deployment_id"),
  lastDeploymentUrl: text("last_deployment_url"),
  lastReadyState: text("last_ready_state"),
  lastDeployedAt: timestamp("last_deployed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

export type Project = typeof projects.$inferSelect
export type NewProject = typeof projects.$inferInsert

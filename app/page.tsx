import { DashboardTabs } from "@/components/dashboard-tabs"
import { listProjects } from "@/app/actions/projects"

export const dynamic = "force-dynamic"

export default async function Home() {
  const projects = await listProjects()

  return (
    <div className="flex min-h-screen items-center justify-center font-sans">
      <main className="flex w-full max-w-2xl flex-col items-center gap-8 px-6 py-16">
        <div className="flex flex-col gap-3 text-center">
          <h1 className="text-balance text-4xl font-bold tracking-tight">
            TBCTools Press Bottom Domain
          </h1>
          <p className="text-pretty text-lg text-muted-foreground">
            Add your projects once, then deploy or redeploy each to its tbctools.org domain with one
            press.
          </p>
        </div>
        <DashboardTabs initialProjects={projects} />
      </main>
    </div>
  )
}

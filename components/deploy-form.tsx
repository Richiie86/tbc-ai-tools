"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { GitBranch, History, Trash2, Pencil, Plus } from "lucide-react"
import { DeployButton } from "@/components/deploy-button"
import { upsertProject, deleteProject, recordDeployment } from "@/app/actions/projects"
import type { Project } from "@/lib/db/schema"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

const ROOT_DOMAIN = "tbctools.org"

/** Build a default subdomain from a project name, e.g. "My App" -> "my-app.tbctools.org". */
function suggestDomain(projectName: string) {
  const slug = projectName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug ? `${slug}.${ROOT_DOMAIN}` : ""
}

export function DeployForm({ initialProjects }: { initialProjects: Project[] }) {
  const router = useRouter()

  const [projectName, setProjectName] = React.useState("")
  const [repo, setRepo] = React.useState("")
  const [domain, setDomain] = React.useState("")
  const [ref, setRef] = React.useState("main")
  const [domainEdited, setDomainEdited] = React.useState(false)
  const [editingId, setEditingId] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState(false)

  const canSave = projectName.trim() && repo.trim() && domain.trim()

  // Auto-suggest a *.tbctools.org subdomain until the user edits the domain manually.
  function handleProjectNameChange(value: string) {
    setProjectName(value)
    if (!domainEdited) setDomain(suggestDomain(value))
  }

  function resetForm() {
    setProjectName("")
    setRepo("")
    setDomain("")
    setRef("main")
    setDomainEdited(false)
    setEditingId(null)
  }

  async function handleSaveProject() {
    if (!canSave) return
    setPending(true)
    try {
      await upsertProject({
        id: editingId ?? undefined,
        projectName: projectName.trim(),
        repo: repo.trim(),
        domain: domain.trim(),
        gitRef: ref.trim() || "main",
        repoType: "github",
      })
      resetForm()
      router.refresh()
    } finally {
      setPending(false)
    }
  }

  function editProject(p: Project) {
    setEditingId(p.id)
    setProjectName(p.projectName)
    setRepo(p.repo)
    setDomain(p.domain)
    setRef(p.gitRef || "main")
    setDomainEdited(true)
  }

  async function handleDelete(id: string) {
    await deleteProject(id)
    router.refresh()
  }

  return (
    <div className="flex w-full max-w-2xl flex-col gap-6">
      {/* Add / edit a project */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <GitBranch className="size-5" aria-hidden="true" />
            {editingId ? "Edit project" : "Add a project"}
          </CardTitle>
          <CardDescription>
            {`Add a GitHub repo and its ${ROOT_DOMAIN} domain. It is saved below where you can deploy or redeploy anytime.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="projectName">Project name</Label>
              <Input
                id="projectName"
                placeholder="my-portfolio"
                value={projectName}
                onChange={(e) => handleProjectNameChange(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="repo">GitHub repo</Label>
              <Input
                id="repo"
                placeholder="owner/repo"
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {"The "}
                <code className="rounded bg-muted px-1 py-0.5 text-[0.7rem]">owner/repo</code>
                {" from your GitHub URL, e.g. github.com/"}
                <span className="text-foreground">tbctools/my-app</span>
                {" → "}
                <code className="rounded bg-muted px-1 py-0.5 text-[0.7rem]">tbctools/my-app</code>
                {". Must be connected to your Vercel account."}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="domain">{`Domain (.${ROOT_DOMAIN})`}</Label>
              <Input
                id="domain"
                placeholder={`my-app.${ROOT_DOMAIN}`}
                value={domain}
                onChange={(e) => {
                  setDomain(e.target.value)
                  setDomainEdited(true)
                }}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="ref">Branch</Label>
              <Input id="ref" value={ref} onChange={(e) => setRef(e.target.value)} />
            </div>
          </div>

          <div className="flex items-center gap-2 pt-1">
            <Button
              type="button"
              className="gap-2"
              onClick={handleSaveProject}
              disabled={!canSave || pending}
            >
              {editingId ? (
                <>
                  <Pencil className="size-4" aria-hidden="true" />
                  Save changes
                </>
              ) : (
                <>
                  <Plus className="size-4" aria-hidden="true" />
                  Add project
                </>
              )}
            </Button>
            {editingId && (
              <Button type="button" variant="ghost" onClick={resetForm} disabled={pending}>
                Cancel
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Project list with per-project deploy / redeploy */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <History className="size-4" aria-hidden="true" />
            Your projects
          </CardTitle>
          <CardDescription>
            Press deploy on a new project, or redeploy to push the latest build.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {initialProjects.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              No projects yet. Add one above to get started.
            </p>
          ) : (
            initialProjects.map((p) => (
              <div
                key={p.id}
                className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate font-medium text-foreground">{p.projectName}</span>
                    <span className="truncate text-xs text-muted-foreground">{p.repo}</span>
                    <a
                      href={`https://${p.domain}`}
                      target="_blank"
                      rel="noreferrer"
                      className="truncate text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                    >
                      {p.domain}
                    </a>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label={`Edit ${p.projectName}`}
                      onClick={() => editProject(p)}
                    >
                      <Pencil className="size-4" aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label={`Remove ${p.projectName}`}
                      onClick={() => handleDelete(p.id)}
                    >
                      <Trash2 className="size-4" aria-hidden="true" />
                    </Button>
                  </div>
                </div>

                <DeployButton
                  projectName={p.projectName}
                  repo={p.repo}
                  domain={p.domain}
                  ref={p.gitRef || "main"}
                  repoType={(p.repoType as "github" | "gitlab" | "bitbucket") || "github"}
                  label={p.lastDeployedAt ? "Redeploy" : "Deploy"}
                  onDeployed={(result) =>
                    recordDeployment(p.id, {
                      deploymentId: result.deploymentId,
                      deploymentUrl: result.deploymentUrl,
                      readyState: "QUEUED",
                    }).then(() => router.refresh())
                  }
                />
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  )
}

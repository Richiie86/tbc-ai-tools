"use client"

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { DeployForm } from "@/components/deploy-form"
import { DeployUsage } from "@/components/deploy-usage"
import { CostTracker } from "@/components/cost-tracker"
import { Rocket, CreditCard } from "lucide-react"
import type { Project } from "@/lib/db/schema"

export function DashboardTabs({ initialProjects }: { initialProjects: Project[] }) {
  return (
    <Tabs defaultValue="deploy" className="w-full">
      <TabsList className="grid w-full grid-cols-2">
        <TabsTrigger value="deploy" className="flex items-center gap-2">
          <Rocket className="size-4" aria-hidden="true" />
          {"Deploy"}
        </TabsTrigger>
        <TabsTrigger value="payments" className="flex items-center gap-2">
          <CreditCard className="size-4" aria-hidden="true" />
          {"Payments"}
        </TabsTrigger>
      </TabsList>

      <TabsContent value="deploy" className="mt-6 flex flex-col gap-6">
        <DeployUsage />
        <DeployForm initialProjects={initialProjects} />
      </TabsContent>

      <TabsContent value="payments" className="mt-6 flex flex-col gap-6">
        <CostTracker />
      </TabsContent>
    </Tabs>
  )
}

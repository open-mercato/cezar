import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { TesterArmyE2eCard } from './tester-army-e2e-card'

/**
 * Settings → project → External integrations: third-party tools cezar can install and wire into
 * this project for you. One tab per kind of tool; each tool is a card that owns its own setup
 * (spec 2026-10-10-e2e-one-click-setup).
 */
export function IntegrationsSection() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4 md:p-6" data-slot="integrations-settings">
      <p className="text-sm text-muted-foreground">
        Tools cezar can set up in this project for you — each one as a task you review and merge.
      </p>
      <Tabs defaultValue="test-frameworks">
        <TabsList variant="line" data-slot="integrations-tabs">
          <TabsTrigger value="test-frameworks">Test frameworks</TabsTrigger>
        </TabsList>
        <TabsContent value="test-frameworks" className="pt-4">
          <TesterArmyE2eCard />
        </TabsContent>
      </Tabs>
    </div>
  )
}

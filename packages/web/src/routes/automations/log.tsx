import type { AutomationListEntry } from '@open-mercato/cezar-api-client'

/** Placeholder until phase 6 lands the log. */
export function AutomationLog({ automationId, automation }: {
  automationId: string
  automation?: AutomationListEntry
  timeZone?: string
  onBack: () => void
}) {
  return <div data-route="automations" className="p-5 text-sm text-muted-foreground">Log for {automation?.name ?? automationId}</div>
}

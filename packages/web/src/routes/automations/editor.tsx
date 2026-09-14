import type { AutomationListEntry, AutomationsResponse } from '@open-mercato/cezar-api-client'

import type { AutomationActions } from './use-automations'

/** Placeholder until phase 5 lands the editor. */
export function AutomationEditor({ automation }: {
  data: AutomationsResponse | undefined
  automation?: AutomationListEntry
  actions?: AutomationActions
  onBack: () => void
  onSaved: () => void
  onLog?: () => void
}) {
  return <div data-route="automations" className="p-5 text-sm text-muted-foreground">{automation ? `Edit ${automation.name}` : 'New automation'}</div>
}

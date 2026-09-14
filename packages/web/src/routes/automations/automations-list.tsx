import type { AutomationsResponse } from '@open-mercato/cezar-api-client'

import type { AutomationsView } from './automations-route'
import type { AutomationActions } from './use-automations'

/** Placeholder until phase 4 lands the list, rail and calendars. */
export function AutomationsList({ data, error, view }: {
  data: AutomationsResponse | undefined
  error?: string
  actions: AutomationActions
  view: AutomationsView
  onViewChange: (view: AutomationsView) => void
}) {
  return <div data-route="automations" className="p-5 text-sm text-muted-foreground">{error ?? (data ? `${data.automations.length} automations (${view})` : 'Loading automations…')}</div>
}

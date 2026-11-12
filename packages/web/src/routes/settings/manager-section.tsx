import { useQueryClient } from '@tanstack/react-query'

import { putWorkspaceUiState } from '@/api/client'
import { useWorkspaceUiState, workspaceQueryKeys } from '@/api/queries'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/components/ui/toaster'
import { actionConfirms, MANAGER_CONFIRM_TYPES } from '@/lib/managers'
import type { ManagerConfirm, WorkspaceUiState } from '@open-mercato/cezar-api-client'
import { FormRow, SettingsCard, useSavedFlash } from './form-row'

const SWITCHES: ReadonlyArray<{ type: (typeof MANAGER_CONFIRM_TYPES)[number]; label: string; description: string }> = [
  { type: 'merge-pr', label: 'Merges', description: 'Show the project, pull request, method and head commit first.' },
  { type: 'enable-automation', label: 'Automations', description: 'Show the name, revision and definition first.' },
  { type: 'add-job', label: 'Jobs', description: 'Show the name, interval and full prompt first.' },
]

/**
 * Settings → Behaviour → Manager (mobile spec, Confirmation setting): one answer per server, on
 * every device. GLOBAL, in `~/.cezar/ui-state.json`, and only ever a step in the cockpit: no
 * value lets a manager act alone.
 */
export function ManagerSection() {
  const queryClient = useQueryClient()
  const uiState = useWorkspaceUiState()
  const setting = uiState.data?.managerConfirm
  const [saved, flash] = useSavedFlash()

  const toggle = (type: keyof ManagerConfirm, next: boolean) => {
    // Written whole: the route merges top-level keys, and a type skipped here would read as on.
    // From the cache, not the render: a second switch tapped before it must keep the first.
    const current = queryClient.getQueryData<WorkspaceUiState>(workspaceQueryKeys.uiState)?.managerConfirm
    const managerConfirm = {
      ...Object.fromEntries(MANAGER_CONFIRM_TYPES.map((known) => [known, actionConfirms(current, known)])),
      [type]: next,
    }
    queryClient.setQueryData<WorkspaceUiState>(workspaceQueryKeys.uiState, (state) => ({ ...state, managerConfirm }))
    putWorkspaceUiState({ managerConfirm })
      .then(flash)
      .catch((error: unknown) => {
        toast(error instanceof Error ? error.message : String(error), { tone: 'danger' })
        void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.uiState })
      })
  }

  return (
    <SettingsCard
      slot="manager-confirm-settings"
      title="Manager approvals"
      description="Approve opens a summary to confirm. With a switch off, Approve sends straight away. The card still appears and still needs your tap: a manager never acts on its own."
    >
      {SWITCHES.map(({ type, label, description }) => (
        <FormRow key={type} label={label} description={description} saved={saved}>
          <Switch
            aria-label={label}
            checked={actionConfirms(setting, type)}
            disabled={uiState.data === undefined}
            onCheckedChange={(next) => toggle(type, next)}
          />
        </FormRow>
      ))}
    </SettingsCard>
  )
}

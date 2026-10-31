import { useQueryClient } from '@tanstack/react-query'

import { putWorkspaceUiState } from '@/api/client'
import { useWorkspaceUiState, workspaceQueryKeys } from '@/api/queries'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/components/ui/toaster'
import { actionConfirms, MANAGER_CONFIRM_TYPES } from '@/lib/managers'
import type { ManagerConfirm, WorkspaceUiState } from '@open-mercato/cezar-api-client'

const SWITCHES: ReadonlyArray<{ type: (typeof MANAGER_CONFIRM_TYPES)[number]; label: string; description: string }> = [
  { type: 'merge-pr', label: 'Merges', description: 'Show the project, pull request, method and head commit first.' },
  { type: 'enable-automation', label: 'Automations', description: 'Show the name, revision and definition first.' },
  { type: 'add-job', label: 'Jobs', description: 'Show the name, interval and full prompt first.' },
]

/**
 * Settings → Manager (mobile spec, Confirmation setting): one answer per server, on every device.
 * GLOBAL, in `~/.cezar/ui-state.json`, and only ever a step in the cockpit: no value lets a manager
 * act alone.
 */
export function ManagerSection() {
  const queryClient = useQueryClient()
  const uiState = useWorkspaceUiState()
  const setting = uiState.data?.managerConfirm

  const toggle = (type: keyof ManagerConfirm, next: boolean) => {
    // Written whole: the route merges top-level keys, and a type skipped here would read as on.
    const managerConfirm = {
      ...Object.fromEntries(MANAGER_CONFIRM_TYPES.map((known) => [known, actionConfirms(setting, known)])),
      [type]: next,
    }
    queryClient.setQueryData<WorkspaceUiState>(workspaceQueryKeys.uiState, (state) => ({ ...state, managerConfirm }))
    putWorkspaceUiState({ managerConfirm }).catch((error: unknown) => {
      toast(error instanceof Error ? error.message : String(error), { tone: 'danger' })
      void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.uiState })
    })
  }

  return (
    <div data-slot="manager-confirm-settings" className="flex max-w-2xl flex-col gap-4">
      <div>
        <h2 className="text-sm font-semibold">Confirm before approving</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Approve opens a summary to confirm. With a switch off, Approve sends straight away. The card still appears and still needs your tap: a manager never acts on its own.
        </p>
      </div>
      <ul className="flex flex-col gap-3">
        {SWITCHES.map(({ type, label, description }) => (
          <li key={type} className="flex items-center justify-between gap-4 rounded-lg border border-border bg-card p-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">{label}</p>
              <p className="text-xs text-muted-foreground">{description}</p>
            </div>
            <Switch
              aria-label={label}
              checked={actionConfirms(setting, type)}
              disabled={uiState.data === undefined}
              onCheckedChange={(next) => toggle(type, next)}
            />
          </li>
        ))}
      </ul>
    </div>
  )
}

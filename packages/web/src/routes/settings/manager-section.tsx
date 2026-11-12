import { useQueryClient } from '@tanstack/react-query'
import { useId, useState } from 'react'

import { managerKeys, updateManager, useManagers } from '@/api/managers'
import { useWorkspaceUiState } from '@/api/queries'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/components/ui/toaster'
import { actionConfirms, MANAGER_CONFIRM_TYPES, managerConfirmOf } from '@/lib/managers'
import type { ManagerConfirm, ManagerListResponse } from '@open-mercato/cezar-api-client'

/** A Record, so a confirm type added to the list cannot ship without its switch. */
const COPY: Record<(typeof MANAGER_CONFIRM_TYPES)[number], { label: string; description: string }> = {
  'merge-pr': { label: 'Merges', description: 'Show the project, pull request, method and head commit first.' },
  'enable-automation': { label: 'Automations', description: 'Show the name, revision and definition first.' },
  'add-job': { label: 'Jobs', description: 'Show the name, interval and full prompt first.' },
  'connector-call': { label: 'Connector calls', description: 'Show the connector, tool and full arguments first.' },
}
const SWITCHES = MANAGER_CONFIRM_TYPES.map((type) => ({ type, ...COPY[type] }))

/**
 * Settings → Manager (mobile spec, Confirmation setting): per manager, in `Manager.confirm`. The
 * global `managerConfirm` it replaced still answers any type a manager never set. Only ever a step
 * in the cockpit: no value lets a manager act alone.
 */
export function ManagerSection() {
  const queryClient = useQueryClient()
  const managers = useManagers()
  const global = useWorkspaceUiState().data?.managerConfirm
  const pickerLabel = useId()
  const list = managers.data?.managers ?? []
  const [picked, setPicked] = useState<string>()
  const manager = list.find((entry) => entry.id === picked) ?? list[0]
  const setting = manager ? managerConfirmOf(manager.confirm, global) : undefined

  const toggle = (id: string, type: keyof ManagerConfirm, next: boolean) => {
    // Written whole and from the cache: a second switch tapped before the first saved must keep it.
    const current = queryClient.getQueryData<ManagerListResponse>(managerKeys.list)?.managers.find((entry) => entry.id === id)
    const confirm = {
      ...Object.fromEntries(MANAGER_CONFIRM_TYPES.map((known) => [known, actionConfirms(managerConfirmOf(current?.confirm, global), known)])),
      [type]: next,
    }
    queryClient.setQueryData<ManagerListResponse>(managerKeys.list, (data) =>
      data ? { ...data, managers: data.managers.map((entry) => (entry.id === id ? { ...entry, confirm } : entry)) } : data)
    updateManager(id, { confirm }).catch((error: unknown) => {
      toast(error instanceof Error ? error.message : String(error), { tone: 'danger' })
      void queryClient.invalidateQueries({ queryKey: managerKeys.list })
    })
  }

  return (
    <div
      data-slot="manager-confirm-settings"
      className="mx-auto flex w-full max-w-2xl flex-col gap-7 p-4 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-6 md:pb-6"
    >
      <section className="flex flex-col gap-4">
        <div>
          <h2 className="text-sm font-semibold">Confirm before approving</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Approve opens a summary to confirm. With a switch off, Approve sends straight away. The card still appears and still needs your tap: a manager never acts on its own.
          </p>
        </div>
        {managers.isPending ? <p className="text-sm text-muted-foreground">Loading managers…</p> : null}
        {managers.isSuccess && list.length === 0 ? (
          <p data-slot="manager-confirm-empty" className="text-sm text-muted-foreground">No managers yet. Create one, then choose what it asks you to confirm.</p>
        ) : null}
        {manager && setting ? (
          <>
            <div className="flex items-center justify-between gap-4">
              <span id={pickerLabel} className="text-sm font-medium">Manager</span>
              <Select value={manager.id} onValueChange={setPicked}>
                <SelectTrigger aria-labelledby={pickerLabel} className="w-56"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {list.map((entry) => <SelectItem key={entry.id} value={entry.id}>{entry.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <ul className="flex flex-col gap-3">
              {SWITCHES.map(({ type, label, description }) => (
                <li key={type} className="flex items-center justify-between gap-4 rounded-lg border border-border bg-card p-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{label}</p>
                    <p className="text-xs text-muted-foreground">{description}</p>
                  </div>
                  <Switch aria-label={label} checked={actionConfirms(setting, type)} onCheckedChange={(next) => toggle(manager.id, type, next)} />
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </section>
    </div>
  )
}

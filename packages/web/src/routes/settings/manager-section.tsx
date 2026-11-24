import { useQueryClient } from '@tanstack/react-query'
import { useId, useState } from 'react'

import { managerKeys, orderManagers, updateManager, useManagers } from '@/api/managers'
import { useWorkspaceUiState } from '@/api/queries'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/components/ui/toaster'
import { actionConfirms, inactiveSinceLabel, isInactive, MANAGER_CONFIRM_TYPES, managerConfirmOf, splitByActivity } from '@/lib/managers'
import { useManagerActivityActions } from '@/routes/manager/manager-activity'
import { ManagerAvatar } from '@/routes/manager/manager-avatar'
import type { ManagerConfirm, ManagerListResponse } from '@open-mercato/cezar-api-client'
import { CardNote, FormRow, SettingsCard, useSavedFlash } from './form-row'

/** A Record, so a confirm type added to the list cannot ship without its switch. */
const COPY: Record<(typeof MANAGER_CONFIRM_TYPES)[number], { label: string; description: string }> = {
  'merge-pr': { label: 'Merges', description: 'Show the project, pull request, method and head commit first.' },
  'enable-automation': { label: 'Automations', description: 'Show the name, revision and definition first.' },
  'add-job': { label: 'Jobs', description: 'Show the name, interval and full prompt first.' },
  'connector-call': { label: 'Connector calls', description: 'Show the connector, tool and full arguments first.' },
}
const SWITCHES = MANAGER_CONFIRM_TYPES.map((type) => ({ type, ...COPY[type] }))

/**
 * Settings → Behaviour → Manager (mobile spec, Confirmation setting): per manager, in
 * `Manager.confirm`. The global `managerConfirm` it replaced still answers any type a manager never
 * set. Only ever a step in the cockpit: no value lets a manager act alone.
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
  const [saved, flash] = useSavedFlash()

  const toggle = (id: string, type: keyof ManagerConfirm, next: boolean) => {
    // Written whole and from the cache: a second switch tapped before the first saved must keep it.
    const current = queryClient.getQueryData<ManagerListResponse>(managerKeys.list)?.managers.find((entry) => entry.id === id)
    const confirm = {
      ...Object.fromEntries(MANAGER_CONFIRM_TYPES.map((known) => [known, actionConfirms(managerConfirmOf(current?.confirm, global), known)])),
      [type]: next,
    }
    queryClient.setQueryData<ManagerListResponse>(managerKeys.list, (data) =>
      data ? { ...data, managers: data.managers.map((entry) => (entry.id === id ? { ...entry, confirm } : entry)) } : data)
    updateManager(id, { confirm })
      .then(flash)
      .catch((error: unknown) => {
        toast(error instanceof Error ? error.message : String(error), { tone: 'danger' })
        void queryClient.invalidateQueries({ queryKey: managerKeys.list })
      })
  }

  return (
    <SettingsCard
      slot="manager-confirm-settings"
      title="Manager approvals"
      description="Approve opens a summary to confirm. With a switch off, Approve sends straight away. The card still appears and still needs your tap: a manager never acts on its own."
    >
      {managers.isPending ? <CardNote>Loading managers…</CardNote> : null}
      {managers.isSuccess && list.length === 0 ? (
        <CardNote slot="manager-confirm-empty">No managers yet. Create one, then choose what it asks you to confirm.</CardNote>
      ) : null}
      {manager && setting ? (
        <>
          <FormRow label={<span id={pickerLabel}>Manager</span>} description="Each manager keeps its own answers.">
            <Select value={manager.id} onValueChange={setPicked}>
              <SelectTrigger aria-labelledby={pickerLabel} className="w-56"><SelectValue /></SelectTrigger>
              <SelectContent>
                {list.map((entry) => <SelectItem key={entry.id} value={entry.id}>{entry.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </FormRow>
          {SWITCHES.map(({ type, label, description }) => (
            <FormRow key={type} label={label} description={description} saved={saved}>
              <Switch aria-label={label} checked={actionConfirms(setting, type)} onCheckedChange={(next) => toggle(manager.id, type, next)} />
            </FormRow>
          ))}
        </>
      ) : null}
    </SettingsCard>
  )
}

/**
 * Settings → Manager's on/off list (spec 2026-11-19-manager-deactivate): a switch per manager and
 * the bulk pair. Each switch opens the same confirm the gear does.
 */
export function ManagerActivitySection() {
  const managers = useManagers()
  const list = orderManagers(managers.data?.managers ?? [])
  const activity = useManagerActivityActions()
  const { active, inactive } = splitByActivity(list)
  if (list.length === 0) return null
  return (
    <SettingsCard
      slot="manager-activity-settings"
      title="Active managers"
      description="An inactive manager keeps its chat, memory and jobs, but runs nothing and makes no model calls until you switch it back on."
      action={
        <>
          <Button variant="outline" size="sm" data-slot="settings-deactivate-all" disabled={active.length === 0} onClick={() => void activity.deactivateAll(list)}>Deactivate all…</Button>
          <Button variant="outline" size="sm" data-slot="settings-reactivate-all" disabled={inactive.length === 0} onClick={() => void activity.reactivateAll(list)}>Reactivate all</Button>
        </>
      }
    >
      {list.map((manager) => (
        <FormRow
          key={manager.id}
          slot="manager-activity-row"
          label={<span className="flex items-center gap-2.5"><ManagerAvatar avatar={manager.avatar} mascot={manager.mascot} inactive={isInactive(manager)} className="size-7" sizes="28px" />{manager.name}</span>}
          description={isInactive(manager) ? inactiveSinceLabel(manager) : 'Active'}
        >
          <Switch aria-label={`${manager.name} active`} checked={!isInactive(manager)} onCheckedChange={() => void activity.toggle(manager)} />
        </FormRow>
      ))}
      {activity.dialog}
    </SettingsCard>
  )
}

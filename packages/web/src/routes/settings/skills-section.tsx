import { useMutation, useQueryClient } from '@tanstack/react-query'

import { putWorkspaceConfig } from '@/api/client'
import { useProjects, useSkillsUpdate, useWorkspaceConfig, workspaceQueryKeys } from '@/api/queries'
import type { SetWorkspaceConfigInput, WorkspaceConfigResponse } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/components/ui/toaster'
import { SettingsError, SettingsField, SettingsGroup, SettingsLoading, SettingsPane } from './settings-field'

export function SkillsSection() {
  const config = useWorkspaceConfig()
  const projects = useProjects()
  const projectId = projects.data?.bootProject ?? ''
  const update = useSkillsUpdate(projectId, Boolean(projectId))

  if (config.isPending) {
    return <SettingsLoading data-slot="skills-settings-loading" label="Loading skill settings…" />
  }
  if (config.isError) {
    return <SettingsError title="Skill settings did not load">{config.error.message}</SettingsError>
  }
  return <SkillsForm config={config.data} update={update.data} updateError={update.error} />
}

function SkillsForm({
  config,
  update,
  updateError,
}: {
  config: WorkspaceConfigResponse
  update?: ReturnType<typeof useSkillsUpdate>['data']
  updateError: Error | null
}) {
  const queryClient = useQueryClient()
  const save = useMutation({
    mutationFn: (patch: SetWorkspaceConfigInput) => putWorkspaceConfig(patch),
    onSuccess: (result) => queryClient.setQueryData(workspaceQueryKeys.config, result),
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  const inherited = config.skillsAutoUpdate === null
  const status = (() => {
    if (updateError) return 'Installation status is unavailable right now.'
    if (!update) return 'Checking tracked Open Mercato installations…'
    if (update.status === 'unavailable')
      return update.scopes.find((scope) => scope.reason)?.reason ?? 'Automatic skill updates are unavailable.'
    if (update.scopes.every((scope) => scope.skills.length === 0))
      return 'No tracked Open Mercato installation found.'
    const count = new Set(update.scopes.flatMap((scope) => scope.skills)).size
    return `${count} tracked Open Mercato skill${count === 1 ? '' : 's'} found.`
  })()

  return (
    <SettingsPane data-slot="skills-settings-section">
      <SettingsGroup title="Updates">
        <SettingsField
          title="Update Open Mercato skills automatically"
          htmlFor="skills-auto-update"
          hint="Checks installed Open Mercato skills in the background and applies available updates. Other skills and untracked folders are never changed."
          control={
            <>
              <span className="text-xs text-muted-foreground">
                {config.effectiveSkillsAutoUpdate ? 'On' : 'Off'}
                {inherited ? ' (default)' : ''}
              </span>
              <Switch
                id="skills-auto-update"
                data-slot="skills-auto-update"
                checked={config.effectiveSkillsAutoUpdate}
                disabled={save.isPending}
                onCheckedChange={(checked) => save.mutate({ skillsAutoUpdate: checked })}
              />
            </>
          }
        />
        <SettingsField
          title={inherited ? 'Using the default' : 'Workspace override saved'}
          hint={
            inherited ? (
              <>
                No override is saved.{' '}
                <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-[11px]">CEZ_SKILLS_AUTO_UPDATE</code>{' '}
                supplies the inherited default when set; otherwise it is on.
              </>
            ) : (
              'An explicit workspace override is saved.'
            )
          }
          control={
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-action="skills-use-default"
              disabled={inherited || save.isPending}
              onClick={() => save.mutate({ skillsAutoUpdate: null })}
            >
              Use default
            </Button>
          }
        />
        <SettingsField
          title="Installations"
          hint={
            <span
              data-slot="skills-installation-status"
              role={updateError || update?.status === 'unavailable' ? 'status' : undefined}
            >
              {status}
            </span>
          }
        />
      </SettingsGroup>
    </SettingsPane>
  )
}

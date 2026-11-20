import type { ConfigResponse } from '@open-mercato/cezar-api-client'
import { Switch } from '@/components/ui/switch'
import { FormRow, SettingsCard } from './form-row'
import { useConfigSave } from './use-config-save'

const LABEL = 'Skip all permission prompts (Claude Code)'

/**
 * Settings → Agents: the project's opt-in `bypassPermissions`. Off by default; the server ignores it
 * when `.ai/cezar/config.json` is tracked by git and says why (`bypassPermissionsBlocked`).
 */
export function BypassPermissionsField({ config }: { config: ConfigResponse }) {
  const save = useConfigSave()
  return (
    <SettingsCard id="permissions" slot="agents-permissions" title="Permissions">
      <FormRow
        saved={save.savedFor('bypassPermissions')}
        htmlFor="agents-bypass-permissions"
        label={LABEL}
        description={
          <>
            Claude Code tasks in this project run with <code>--permission-mode bypassPermissions</code>: every tool
            call is approved without asking, including commands outside the Claude Code Bash sandbox and tools a
            workflow step did not list. Use it only for a repository and agents you trust. Tasks a manager starts
            are included; read-only tasks and the manager's own turns never are. Off by default — Claude denies
            anything not approved.
            {config.bypassPermissionsBlocked ? (
              <span data-slot="agents-bypass-permissions-blocked" className="mt-1 block text-danger">
                {config.bypassPermissionsBlocked}
              </span>
            ) : null}
          </>
        }
      >
        <Switch
          id="agents-bypass-permissions"
          aria-label={LABEL}
          data-slot="agents-bypass-permissions"
          checked={config.bypassPermissions}
          disabled={save.isPending}
          onCheckedChange={(checked) => save.mutate({ bypassPermissions: checked ? true : null })}
        />
      </FormRow>
    </SettingsCard>
  )
}

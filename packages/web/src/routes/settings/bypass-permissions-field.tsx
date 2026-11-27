import type { ConfigResponse } from '@open-mercato/cezar-api-client'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { FormRow, SettingsCard } from './form-row'
import { useConfigSave } from './use-config-save'

const LABEL = 'Skip all permission prompts (Claude Code)'
const MODE_LABEL = 'Claude permission prompts'

type ClaudePermissionMode = NonNullable<ConfigResponse['claudePermissionMode']>

/** Radix Select refuses an empty item value; this stands in for "no mode set" (`null` on the wire). */
const DEFAULT_MODE = 'default'
const MODE_OPTIONS: ReadonlyArray<{ value: ClaudePermissionMode | typeof DEFAULT_MODE; label: string }> = [
  { value: DEFAULT_MODE, label: 'Deny anything not allowed (default)' },
  { value: 'manual', label: 'Ask me in the cockpit' },
  { value: 'acceptEdits', label: 'Ask me; accept file edits automatically' },
]

/**
 * Settings → Agents: the project's opt-in `bypassPermissions`. Off by default; the server ignores it
 * when `.ai/cezar/config.json` is tracked by git and says why (`bypassPermissionsBlocked`). Beside it,
 * `claudePermissionMode` lets Claude ask from the cockpit instead of denying (it never outranks the bypass).
 */
export function BypassPermissionsField({ config }: { config: ConfigResponse }) {
  const save = useConfigSave()
  // A blocked bypass is ignored by the server, so the permission mode still applies.
  const bypassActive = config.bypassPermissions && !config.bypassPermissionsBlocked
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
      <FormRow
        saved={save.savedFor('claudePermissionMode')}
        htmlFor="agents-claude-permission-mode"
        label={MODE_LABEL}
        description={
          <>
            Claude Code denies any tool a step's allow list does not name, MCP servers included. With "Ask me", Claude
            pauses, the task shows Needs you, and a card offers Allow once, Always allow or Reject. Autonomous and
            headless runs still deny. Accepting edits only applies to steps that already allow edits. Read-only tasks
            and managers are never affected.
            {bypassActive ? (
              <span data-slot="agents-claude-permission-mode-note" className="mt-1 block text-muted-foreground">
                "Skip all permission prompts" above overrides this setting.
              </span>
            ) : null}
          </>
        }
      >
        <Select
          value={config.claudePermissionMode ?? DEFAULT_MODE}
          disabled={save.isPending || bypassActive}
          onValueChange={(value) =>
            save.mutate({ claudePermissionMode: value === DEFAULT_MODE ? null : (value as ClaudePermissionMode) })
          }
        >
          <SelectTrigger
            id="agents-claude-permission-mode"
            size="sm"
            aria-label={MODE_LABEL}
            data-slot="agents-claude-permission-mode"
            data-value={config.claudePermissionMode ?? DEFAULT_MODE}
            className="min-w-44 max-w-72"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            {MODE_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormRow>
    </SettingsCard>
  )
}

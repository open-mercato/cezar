import type { AgentProfile, AgentSetupEntry, ProviderStatusResponse, Runner } from '@open-mercato/cezar-api-client'
import { AGENT_ROW_ACTION_LABEL, agentRowAction, agentVersionChip, type AgentRowAction } from '@/lib/agent-setup'
import { cn } from '@/lib/utils'
import { providerStatusFor } from '@/lib/provider-status'
import { RUNNERS } from '@/routes/new-task-form'

/**
 * "Which agent, and which of its logins" as ONE flat list (spec 2026-07-29-agent-profiles):
 *
 *     claude · Default
 *     claude · Klaudiusz
 *     codex
 *
 * The same shape the composer's runner pill uses, and shared by BOTH settings scopes — the repo's
 * default and the machine-wide one are the same question asked about a different subject, so they
 * must not drift into two controls that look alike but behave differently.
 *
 * An agent with a single login stays a single row, which is why a machine with no extra accounts
 * sees exactly the segmented control it always saw.
 */

export interface AgentPickerRow {
  runner: (typeof RUNNERS)[number]
  /** `null` is the discovered account — stored as absence, never the reserved `default` id. */
  account: string | null
  label: string
  desc: string
  missing: boolean
}

/** Build the rows once, so the caller's `checked` logic and the render agree by construction. */
export function agentPickerRows(profiles: readonly AgentProfile[]): AgentPickerRow[] {
  return RUNNERS.flatMap((runner) => {
    // A pending account (sign-in never finished) is not a choice yet.
    const logins = profiles.filter((p) => p.provider === runner.id && !p.pending)
    // One login is not a choice, so the agent is the row.
    if (logins.length < 2) {
      return [{ runner, account: null, label: runner.label, desc: runner.desc, missing: false }]
    }
    return logins.map((login) => ({
      runner,
      account: login.isDefault ? null : login.id,
      label: `${runner.label} · ${login.label}`,
      // The folder, because the labels are cezar's invention and the folder is the account. A
      // folder the CLI has not written yet is called out rather than left looking fine: a run under
      // it fails on auth BY DESIGN — it must not quietly fall back to another login — so the place
      // to say so is where the choice is made.
      desc: login.exists ? login.configDir : `${login.configDir} — folder not created yet`,
      missing: !login.exists,
    }))
  })
}

/** True once any agent has a second login — what turns the strip into a stacked list. */
export const hasAgentAccounts = (rows: readonly AgentPickerRow[]): boolean =>
  rows.length > RUNNERS.length

export function DefaultAgentPicker({
  rows,
  runner,
  accountFor,
  providerStatus,
  disabled = false,
  accountDisabled = false,
  setup,
  onAgentAction,
  onPick,
}: {
  rows: readonly AgentPickerRow[]
  runner: Runner
  /** The account currently in force for a runner, or null for the discovered one. */
  accountFor: (runner: Runner) => string | null
  providerStatus: {
    data?: ProviderStatusResponse
    isPending: boolean
    isError: boolean
  }
  disabled?: boolean
  /** Account rows only: the write target is not known yet (e.g. the project registry is loading). */
  accountDisabled?: boolean
  /** The setup catalog (spec 2026-11-25-agent-cli-install-and-update): with it, a row that is not
   *  ready offers Install, Sign in or Update, and an installed one shows its version state. */
  setup?: readonly AgentSetupEntry[]
  onAgentAction?: (runner: Runner, action: AgentRowAction) => void
  onPick: (runner: Runner, account: string | null, hasAccountChoice: boolean) => void
}) {
  const stacked = hasAgentAccounts(rows)
  return (
    <div
      role="radiogroup"
      aria-label="Default runner"
      data-slot="agents-runner"
      className={cn(
        'gap-0.5 rounded-md border border-border bg-card p-0.5',
        // Stacked once accounts are in play: `claude · Klaudiusz` beside its folder does not fit a
        // segmented strip, and the folder is the part that says WHICH login this is.
        stacked ? 'flex max-w-md flex-col' : 'inline-flex w-fit max-w-full flex-wrap',
      )}
    >
      {rows.map((row) => {
        const provider = providerStatusFor(providerStatus.data, row.runner.id)
        const providerConnected =
          !providerStatus.isPending &&
          !providerStatus.isError &&
          provider?.enabled === true &&
          provider.status === 'connected'
        const providerReason = providerStatus.isPending
          ? 'Checking provider authentication…'
          : providerStatus.isError
            ? 'Provider authentication could not be verified.'
            : provider?.enabled === false
              ? 'This provider is disabled. Enable it above or choose another provider.'
            : providerConnected
              ? undefined
              : 'Connect this provider before selecting it.'
        const entry = setup?.find((candidate) => candidate.provider === row.runner.id)
        // One action per agent: a second account row of the same agent would repeat it.
        const firstOfAgent = rows.find((other) => other.runner.id === row.runner.id) === row
        const action = onAgentAction && firstOfAgent && !providerStatus.isPending ? agentRowAction(entry, provider) : null
        const chip = firstOfAgent ? agentVersionChip(entry) : null
        const hasAccountChoice = rows.filter((other) => other.runner.id === row.runner.id).length > 1
        const checked = row.runner.id === runner && row.account === accountFor(row.runner.id)
        return (
          <span key={`${row.runner.id}:${row.account ?? ''}`} data-slot="agents-runner-row" className={cn('items-center gap-1', stacked ? 'flex' : 'inline-flex')}>
          <button
            type="button"
            role="radio"
            aria-checked={checked}
            data-value={row.runner.id}
            data-account={row.account ?? ''}
            title={providerReason ?? row.desc}
            disabled={
              disabled || !providerConnected || (hasAccountChoice && accountDisabled)
            }
            onClick={() => onPick(row.runner.id, row.account, hasAccountChoice)}
            className={cn(
              'rounded-sm px-3 py-1.5 text-left font-mono text-ui font-medium transition-colors disabled:opacity-50',
              checked ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {row.label}
            {stacked ? (
              <span
                data-slot={row.missing ? 'agents-account-missing' : 'agents-account-dir'}
                data-runner={row.runner.id}
                className="ml-2 font-sans text-meta text-soft-foreground"
              >
                {row.desc}
              </span>
            ) : null}
          </button>
          {chip ? (
            <span
              data-slot="agents-version-chip"
              data-runner={row.runner.id}
              data-tone={chip.tone}
              className={cn(
                'whitespace-nowrap rounded-full border px-1.5 text-meta',
                chip.tone === 'danger' ? 'border-danger/40 text-danger' : chip.tone === 'warn' ? 'border-pending/50 text-pending-strong' : 'border-border text-muted-foreground',
              )}
            >
              {chip.label}
            </span>
          ) : null}
          {action ? (
            <button
              type="button"
              data-slot="agents-runner-action"
              data-runner={row.runner.id}
              data-action={action}
              onClick={() => onAgentAction?.(row.runner.id, action)}
              className={cn(
                'whitespace-nowrap rounded-sm px-2 py-1 text-meta font-medium transition-colors',
                action === 'install' ? 'bg-primary text-primary-foreground hover:bg-primary/90' : 'border border-border text-foreground hover:bg-muted',
              )}
            >
              {AGENT_ROW_ACTION_LABEL[action]}
            </button>
          ) : null}
          </span>
        )
      })}
    </div>
  )
}

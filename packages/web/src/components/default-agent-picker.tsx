import type { AgentProviderEntry, AgentProfile, AgentSetupEntry, ProviderStatusResponse, Runner } from '@open-mercato/cezar-api-client'
import { AGENT_ROW_ACTION_LABEL, agentRowAction, agentVersionChip, type AgentRowAction } from '@/lib/agent-setup'
import { accountSelection, canUseAgent, servingMethods } from '@/lib/agent-providers'
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
  profile?: AgentProfile
}

/** Build the rows once, so the caller's `checked` logic and the render agree by construction. */
export function agentPickerRows(profiles: readonly AgentProfile[]): AgentPickerRow[] {
  return RUNNERS.flatMap<AgentPickerRow>((runner) => {
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
      profile: login,
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
  entries,
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
  entries?: AgentProviderEntry[]
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
  const ready = !providerStatus.isPending && !providerStatus.isError
  const connected = (row: AgentPickerRow) => {
    const provider = providerStatusFor(providerStatus.data, row.runner.id)
    return ready && canUseAgent(entries?.find(entry => entry.runner === row.runner.id), provider, accountSelection(row.profile))
  }
  const isChecked = (row: AgentPickerRow) => row.runner.id === runner && row.account === accountFor(row.runner.id)
  // With the setup catalog, the strip holds only what can be picked; every agent that needs a step
  // gets a row in the grouped list below (spec 2026-11-25-agent-cli-install-and-update).
  const setupAware = setup !== undefined && onAgentAction !== undefined && ready
  const shown = setupAware && !entries ? rows.filter((row) => connected(row) || isChecked(row)) : rows
  const strip = (
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
      {shown.map((row) => {
        const provider = providerStatusFor(providerStatus.data, row.runner.id)
        const entry = entries?.find(e => e.runner === row.runner.id)
        const providerConnected = connected(row)
        const providerReason = providerStatus.isPending
          ? 'Checking provider authentication…'
          : providerStatus.isError
            ? 'Provider authentication could not be verified.'
            : provider?.enabled === false
              ? 'This provider is disabled. Enable it above or choose another provider.'
            : providerConnected
              ? undefined
              : 'Connect this provider before selecting it.'
        const hasAccountChoice = rows.filter((other) => other.runner.id === row.runner.id).length > 1
        const checked = isChecked(row)
        return (
          <button
            key={`${row.runner.id}:${row.account ?? ''}`}
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
            {row.label}{entry && !providerConnected && !servingMethods(entry).length && ' · no provider'}
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
        )
      })}
    </div>
  )
  if (!setupAware) return strip
  return (
    <div className="flex flex-col gap-4">
      {strip}
      <AgentSetupGroups setup={setup} entries={entries} providerStatus={providerStatus.data} onAgentAction={onAgentAction} />
    </div>
  )
}

type GroupId = 'update' | 'sign-in' | 'install' | 'off'

const GROUP_TITLE: Record<GroupId, string> = {
  update: 'Updates',
  'sign-in': 'Not signed in',
  install: 'Not installed',
  off: 'Turned off',
}

/** One list per kind of next step, like the Providers card: name and state on the left, the one
 *  button on the right. */
function AgentSetupGroups({
  setup,
  entries,
  providerStatus,
  onAgentAction,
}: {
  setup: readonly AgentSetupEntry[]
  entries?: AgentProviderEntry[]
  providerStatus: ProviderStatusResponse | undefined
  onAgentAction: (runner: Runner, action: AgentRowAction) => void
}) {
  const groups: Record<GroupId, Array<{ runner: (typeof RUNNERS)[number]; action: AgentRowAction | null; detail: string; runs?: boolean }>> = {
    update: [], 'sign-in': [], install: [], off: [],
  }
  for (const runner of RUNNERS) {
    const entry = setup.find((candidate) => candidate.provider === runner.id)
    const status = providerStatusFor(providerStatus, runner.id)
    if (status?.enabled === false) {
      groups.off.push({ runner, action: null, detail: 'Turned off in Providers above.' })
      continue
    }
    const action = agentRowAction(entry, status)
    if (action === 'update') {
      const chip = agentVersionChip(entry)
      const detail = chip?.tone === 'danger' ? `${entry?.version} installed, ${chip.label}` : `${entry?.version} → ${entry?.latestVersion}`
      groups.update.push({ runner, action, detail, runs: entry?.update?.runnable === true })
    } else if (action === 'sign-in' && !canUseAgent(entries?.find(e => e.runner === runner.id), status)) {
      groups['sign-in'].push({ runner, action, detail: `${entry?.version ? `${entry.version} installed` : 'Installed'}, not signed in` })
    } else if (action === 'install' || action === 'how-to-install') {
      groups.install.push({ runner, action, detail: action === 'install' ? runner.desc : `${runner.desc} · install it yourself`, runs: action === 'install' })
    }
  }
  // What cezar installs in one click first; the copy-only ones after.
  groups.install.sort((a, b) => Number(b.runs ?? false) - Number(a.runs ?? false))
  const order: GroupId[] = ['update', 'sign-in', 'install', 'off']
  if (order.every((id) => groups[id].length === 0)) return null
  return (
    <div data-slot="agents-setup-groups" className="flex flex-col gap-3">
      {order.filter((id) => groups[id].length > 0).map((id) => (
        <section key={id} data-slot="agents-setup-group" data-group={id} aria-label={GROUP_TITLE[id]}>
          <h4 className="mb-1.5 text-meta font-medium text-muted-foreground">{GROUP_TITLE[id]}</h4>
          <ul className="divide-y divide-border overflow-hidden rounded-md border border-border bg-card">
            {groups[id].map(({ runner, action, detail, runs }) => (
              <li key={runner.id} data-slot="agents-setup-row" data-runner={runner.id} className="flex items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-ui text-foreground">{runner.label}</div>
                  <div className={cn('text-meta', id === 'update' && detail.includes('required') ? 'text-danger' : 'text-muted-foreground')}>{detail}</div>
                </div>
                {action ? (
                  <button
                    type="button"
                    data-slot="agents-runner-action"
                    data-runner={runner.id}
                    data-action={action}
                    onClick={() => onAgentAction(runner.id, action)}
                    className={cn(
                      'shrink-0 whitespace-nowrap rounded-sm px-2.5 py-1 text-meta font-medium transition-colors',
                      runs
                        ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                        : 'border border-border text-foreground hover:bg-muted',
                    )}
                  >
                    {AGENT_ROW_ACTION_LABEL[action]}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

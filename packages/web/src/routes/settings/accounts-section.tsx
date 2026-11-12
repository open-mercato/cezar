import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ExternalLinkIcon, IdCardIcon } from 'lucide-react'
import { Fragment, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router'

import { ApiError, putWorkspaceConfig } from '@/api/client'

import {
  useAgentAccountDetails,
  useAgentProfiles,
  useHealth,
  useAgentAccountStatus,
  useConnectAgentAccount,
  useRecheckAgentAccount,
  useOpenAgentAccountFile,
  useOpenTargets,
  useProviderStatus,
  useRemoveAgentProfile,
  useRunnerModelCatalogs,
  useSelectAgentProfile,
  useUpdateAgentProfile,
  useWorkspaceConfig,
  workspaceQueryKeys,
} from '@/api/queries'
import {
  agentAccountRouteId,
  type AgentProfile,
  type AgentProfilesResponse,
  type BackendCheck,
  type ProviderId,
  type Runner,
  type SetWorkspaceConfigInput,
} from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { StatusDot, type StatusDotTone } from '@/components/status-dot'
import { RUNNER_ORDER } from '@/lib/provider-status'
import { toast } from '@/components/ui/toaster'
import { OpenInMenu, cliTargetRunner } from '@/components/open-in-menu'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { DefaultAgentPicker, agentPickerRows } from '@/components/default-agent-picker'
import { LoadingState, SettingsSkeleton } from '@/components/loading-state'
import { modelCatalogStatus, modelsForRunner, RUNNERS } from '@/routes/new-task-form'
import { cn } from '@/lib/utils'
import { AddAccountDialog } from './add-account-dialog'
import { CardNote, FormRow, SavedIndicator, SettingsCard, useSavedFlash } from './form-row'

/**
 * Settings → Agents, the two account cards (spec `.ai/specs/2026-07-29-agent-profiles.md`;
 * design doc Proposal 8): "Installed on this machine" — the agents this machine has, first,
 * each with its version and its default model, the rest folded behind "Show N not installed" —
 * and "Accounts", every login across every agent.
 *
 * Global, for the same reason Projects and Behaviour are: a config dir describes the person and
 * the machine, never a repo.
 *
 * ## Identity is opt-in, and "hidden" means absent
 *
 * "Manage" reveals the email, organization and plan an account is signed in as. That is a
 * deliberate, narrow exception to the boundary `provider-auth.ts` keeps — "credentials, account
 * identity, and raw CLI output never cross this boundary" — so it is built to stay narrow: the data
 * is NOT a field on the accounts listing, it comes from its own on-demand route
 * (`useAgentAccountDetails`, `enabled` only once the row is expanded), and it is refused in hosted
 * mode unless remote account management is explicitly enabled.
 *
 * Rename and Remove live in that same panel rather than on the collapsed row: a row is a reading
 * surface, and Remove sitting on it put a destructive action one stray click from a list you scan.
 *
 * ## Three decisions worth reading
 *
 * 1. **The discovered account is listed but not editable.** It is what `agentHomePaths()` finds —
 *    which honours the vendors' own env vars — so it is a fact, not a setting.
 * 2. **A folder that does not exist yet is not an error.** The documented flow is *add the account
 *    → Connect → the CLI creates the folder*. What must NOT happen is falling back to another
 *    account at run time, and that refusal lives server-side.
 * 3. **Remove only ever DEREGISTERS.** No directory is touched, no session deleted.
 */

export const PROVIDER_LABEL: Record<ProviderId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  junie: 'Junie',
  opencode: 'OpenCode',
  cursor: 'Cursor',
  pi: 'pi',
  copilot: 'GitHub Copilot CLI',
  omp: 'OMP',
  antigravity: 'Antigravity',
  gemini: 'Gemini CLI',
  kimi: 'Kimi Code',
}

/** The vendor's own install/login instruction, shown when the CLI is not on this machine. */
const PROVIDER_INSTALL: Record<ProviderId, string> = {
  claude: 'curl -fsSL https://claude.ai/install.sh | bash',
  codex: 'npm i -g @openai/codex',
  junie: 'https://www.jetbrains.com/junie/',
  opencode: 'https://opencode.ai',
  cursor: 'curl https://cursor.com/install -fsS | bash',
  pi: 'https://github.com/badlogic/pi-mono',
  copilot: 'npm i -g @github/copilot',
  omp: 'brew install can1357/tap/omp',
  antigravity: 'https://antigravity.google/docs/cli/',
  gemini: 'npm i -g @google/gemini-cli',
  kimi: 'https://moonshotai.github.io/kimi-code/',
}

/** Same vocabulary the Providers card uses — one wording for "is this logged in?". */
const STATUS_PRESENTATION = {
  connected: { label: 'Connected', tone: 'success' },
  disconnected: { label: 'Not connected', tone: 'pending' },
  'not-installed': { label: 'Not installed', tone: 'neutral' },
  unknown: { label: 'Could not verify', tone: 'danger' },
} as const satisfies Record<string, { label: string; tone: StatusDotTone }>

/** Radix Select refuses an empty item value, and `''` IS cezar's "auto" (no `--model`). */
const AUTO_MODEL = '__auto__'

export function AccountsCards() {
  const profiles = useAgentProfiles()

  if (profiles.isPending) {
    return (
      <LoadingState label="Loading agent accounts…" data-slot="accounts-loading"><SettingsSkeleton /></LoadingState>
    )
  }
  if (profiles.isError) {
    return (
      <CenteredState
        icon={<IdCardIcon />}
        tone="danger"
        title="Agent accounts did not load"
        subtitle={profiles.error.message}
        heading="h2"
      />
    )
  }
  return <AccountsPane data={profiles.data} />
}

/** Installed agents first, by `/api/v1/health`'s probe; an agent health has not answered for
 *  is neither — it is "Checking…", and listed with the installed ones so it is not folded away
 *  on the strength of a guess. Exported for the test that pins the order. */
export function splitInstalled(
  providers: readonly ProviderId[],
  checks: readonly BackendCheck[] | undefined,
): { installed: ProviderId[]; notInstalled: ProviderId[] } {
  const installed: ProviderId[] = []
  const notInstalled: ProviderId[] = []
  for (const provider of providers) {
    const check = checks?.find((c) => c.name === provider)
    ;(check?.available === false ? notInstalled : installed).push(provider)
  }
  return { installed, notInstalled }
}

function AccountsPane({ data }: { data: AgentProfilesResponse }) {
  const health = useHealth()
  const [adding, setAdding] = useState<ProviderId | null>(null)
  const [confirming, setConfirming] = useState<AgentProfile | null>(null)
  const remove = useRemoveAgentProfile()

  // Every agent is listed, including one that cannot carry a second login: this card is where
  // its install state lives, and hiding OpenCode would just move "is OpenCode set up?" elsewhere.
  const providers: readonly ProviderId[] = RUNNER_ORDER
  const checks = health.data?.checks
  const { installed, notInstalled } = splitInstalled(providers, checks)
  // `?agent=<id>` names an agent — the Tools menu's "Set up →" deep link for a missing CLI: its
  // row must be visible, so the fold opens when the named agent is behind it.
  const [searchParams] = useSearchParams()
  const requested = searchParams.get('agent')
  const [showAll, setShowAll] = useState(false)
  useEffect(() => {
    if (requested && notInstalled.includes(requested as ProviderId)) setShowAll(true)
  }, [requested, notInstalled.join(',')])
  const capable = data.profileCapableProviders ?? []
  const defaultRunner = useDefaultRunner() ?? 'claude'

  if (!data.editable) {
    return (
      <SettingsCard title="Accounts" slot="accounts-section">
        <CardNote slot="accounts-hosted">
          Agent accounts are disabled for remote access. On a trusted, authenticated self-hosted
          deployment, set CEZ_REMOTE_AGENT_ACCOUNTS=1 and restart cezar.
        </CardNote>
      </SettingsCard>
    )
  }

  const shown = showAll ? [...installed, ...notInstalled] : installed
  const accounts = [...installed, ...notInstalled].flatMap((provider) =>
    (data.profiles ?? []).filter((p) => p.provider === provider),
  )
  const singleOnly = providers.filter((provider) => !capable.includes(provider))

  return (
    <div data-slot="accounts-section" className="flex flex-col gap-5">
      <SettingsCard
        id="installed"
        slot="accounts-installed"
        title={
          <span className="flex items-center gap-2">
            Installed on this machine
            <Badge variant="ghost" data-slot="accounts-installed-count" className="text-micro text-muted-foreground">
              {checks === undefined ? '…' : installed.length}
            </Badge>
          </span>
        }
        action={
          notInstalled.length > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-action="accounts-show-not-installed"
              aria-expanded={showAll}
              onClick={() => setShowAll((on) => !on)}
            >
              {showAll ? `Hide ${notInstalled.length} not installed` : `Show ${notInstalled.length} not installed`}
            </Button>
          ) : null
        }
      >
        <DefaultsForNewProjects profiles={data} />
        {shown.map((provider) => (
          <InstalledAgentRow
            key={provider}
            provider={provider}
            // `checks` is read defensively: health is also patched in place from the WS topic and
            // seeded by route gates, so a partially-populated cache entry is a real state.
            check={checks?.find((c) => c.name === provider)}
            accounts={(data.profiles ?? []).filter((p) => p.provider === provider)}
            isDefault={provider === defaultRunner}
          />
        ))}
      </SettingsCard>

      <SettingsCard
        slot="accounts-logins"
        title="Accounts"
        action={
          capable.length > 0 ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-action="accounts-add"
              data-provider={capable[0]}
              onClick={() => setAdding(capable[0] ?? null)}
            >
              Add account
            </Button>
          ) : null
        }
      >
        {accounts.map((account) => (
          <AccountRow key={`${account.provider}:${account.id}`} account={account} onRemove={() => setConfirming(account)} />
        ))}
        <CardNote>
          {capable.length > 0
            ? 'Add a second login to keep a work account beside a personal one; each project picks which it uses in its own Agents settings.'
            : null}
          {singleOnly.length > 0 ? (
            <span data-slot="accounts-single-only" className="block">
              {singleOnly.map((p) => PROVIDER_LABEL[p]).join(', ')} can only hold one account here: they keep
              their credentials outside their config folder, so a second folder would change settings without
              changing the login — which would say “work account” while billing the other one.
            </span>
          ) : null}
        </CardNote>
      </SettingsCard>

      {/* Keyed by provider so reopening under a different agent starts from a clean form rather
          than the previous agent's half-typed folder. */}
      {adding !== null ? (
        <AddAccountDialog
          key={adding}
          open
          onOpenChange={(open) => !open && setAdding(null)}
          providers={capable}
          initialProvider={adding}
        />
      ) : null}

      <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        <AlertDialogContent data-slot="accounts-remove-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>Remove “{confirming?.label}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This only forgets the account. Nothing in {confirming?.configDir} is deleted — not
              your login, not your sessions. Projects using it fall back to the default account,
              and tasks that ran under it can no longer be resumed from here.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-action="accounts-remove-confirm"
              disabled={remove.isPending}
              onClick={() => {
                const target = confirming
                if (!target) return
                remove.mutate(target.id, {
                  onSuccess: () => {
                    setConfirming(null)
                    toast(`Removed ${target.label}`)
                  },
                  // The server's own words: a 409 explains something this pane cannot infer.
                  onError: (error) => toast(error.message, { tone: 'danger' }),
                })
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/** The machine-wide default runner, `claude` when the config has no opinion (what an
 *  unconfigured project runs). `undefined` while the config is loading. */
function useDefaultRunner(): Runner | undefined {
  const config = useWorkspaceConfig()
  if (config.data === undefined) return undefined
  return config.data.agentDefaults.runner ?? 'claude'
}

/** One agent on this machine: what the binary is, which logins it has, its default model. */
function InstalledAgentRow({
  provider,
  check,
  accounts,
  isDefault,
}: {
  provider: ProviderId
  /** The `/api/v1/health` probe for this CLI — the ONE place a version can honestly come from. */
  check: BackendCheck | undefined
  accounts: AgentProfile[]
  isDefault: boolean
}) {
  const installed = check?.available === true
  const facts = [
    isDefault ? 'Default agent for new projects' : null,
    accounts.length === 1 ? '1 account' : `${accounts.length} accounts`,
  ].filter(Boolean)
  return (
    <FormRow
      slot="accounts-provider"
      label={
        <span id={`agent-${provider}`} data-slot="accounts-provider-row" data-provider={provider} className="flex items-center gap-2">
          {PROVIDER_LABEL[provider]}
          {check === undefined ? (
            <span data-slot="agent-installed" className="text-meta font-normal text-muted-foreground">Checking…</span>
          ) : installed ? (
            <>
              <span data-slot="agent-installed" className="sr-only">Yes</span>
              {check.version ? (
                <Badge variant="ghost" data-slot="agent-version" className="font-mono text-micro text-muted-foreground">
                  {check.version}
                </Badge>
              ) : null}
            </>
          ) : null}
        </span>
      }
      description={
        check !== undefined && !installed ? (
          <span data-slot="agent-installed">
            Not installed — <code className="text-label">{PROVIDER_INSTALL[provider]}</code>
          </span>
        ) : (
          facts.join(' · ')
        )
      }
    >
      {installed || check === undefined ? <DefaultModelSelect runner={provider} /> : null}
    </FormRow>
  )
}

/**
 * One agent's default model (spec 2026-07-29-agent-profiles): saves on change, "Saved" inline.
 * `null` clears the key back to "no opinion" — absence cannot say that in a partial patch, and
 * a stale value would keep seeding every unconfigured project.
 */
function DefaultModelSelect({ runner }: { runner: Runner }) {
  const queryClient = useQueryClient()
  const config = useWorkspaceConfig()
  const catalogs = useRunnerModelCatalogs()
  const [saved, flash] = useSavedFlash()
  const save = useMutation({
    mutationFn: (patch: SetWorkspaceConfigInput) => putWorkspaceConfig(patch),
    onSuccess: (result) => {
      queryClient.setQueryData(workspaceQueryKeys.config, result)
      flash()
    },
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  if (config.data === undefined) return null
  const models = config.data.agentDefaults.models ?? {}
  const current = models[runner] ?? ''
  const label = RUNNERS.find((entry) => entry.id === runner)?.label ?? runner
  const status = modelCatalogStatus(runner, catalogs[runner].data, catalogs[runner].isError)
  return (
    <div className="flex items-center gap-2">
      <Select
        value={current === '' ? AUTO_MODEL : current}
        disabled={save.isPending}
        onValueChange={(value) =>
          save.mutate({
            agentDefaults: {
              models: { [runner]: value === AUTO_MODEL ? null : value } as Partial<Record<Runner, string | null>>,
            },
          })
        }
      >
        <SelectTrigger
          size="sm"
          aria-label={`Default model for ${label}`}
          data-slot="accounts-default-model"
          data-runner={runner}
          data-value={current}
          className="max-w-56"
        >
          <span className="text-muted-foreground">Model:</span>
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper">
          {modelsForRunner(runner, catalogs[runner].data, [current]).map((model) => (
            <SelectItem key={model.id || AUTO_MODEL} value={model.id || AUTO_MODEL}>
              {model.id === '' ? 'auto' : model.label}
            </SelectItem>
          ))}
          {status ? <SelectItem value="__status__" disabled>{status}</SelectItem> : null}
        </SelectContent>
      </Select>
      <SavedIndicator visible={saved} />
    </div>
  )
}

/**
 * What a project that has chosen nothing runs (spec 2026-07-29-agent-profiles): the default
 * agent, and for an agent with several logins, which one.
 *
 * DEFAULTS, never overrides. A project's own `.ai/cezar/config.json` still wins key by key, and a
 * project that has already picked an account keeps it. Two stores for one click, the same split
 * the rest of the feature makes: the runner goes to `~/.cezar/config.json`, the account to
 * `~/.cezar/agent-accounts.json`. Neither is committable — that is the point of them being here.
 */
function DefaultsForNewProjects({ profiles }: { profiles: AgentProfilesResponse }) {
  const queryClient = useQueryClient()
  const config = useWorkspaceConfig()
  const providerStatus = useProviderStatus()
  const select = useSelectAgentProfile()
  const [saved, flash] = useSavedFlash()

  const save = useMutation({
    mutationFn: (patch: SetWorkspaceConfigInput) => putWorkspaceConfig(patch),
    onSuccess: (result) => {
      queryClient.setQueryData(workspaceQueryKeys.config, result)
      flash()
    },
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })

  if (config.data === undefined) return null

  const rows = agentPickerRows(profiles.profiles ?? [])
  // Absent means "no opinion", and the built-in fallback is claude — the same answer a project with
  // no config gets today. Showing it checked is honest: it IS what an unconfigured project runs.
  const runner = config.data.agentDefaults.runner ?? 'claude'

  return (
    <FormRow
      slot="accounts-defaults"
      stacked
      saved={saved}
      label="Default agent for new projects"
      description="What a project runs when it has not chosen for itself — set once instead of per repository. A project that has chosen keeps its own."
    >
      <DefaultAgentPicker
        rows={rows}
        runner={runner}
        accountFor={(id) => profiles.defaults?.[id] ?? null}
        providerStatus={providerStatus}
        disabled={save.isPending}
        accountDisabled={select.isPending}
        onPick={(picked, account, hasAccountChoice) => {
          if (picked !== runner) save.mutate({ agentDefaults: { runner: picked } })
          // `projectId: null` targets the machine-wide default rather than one repo. Only for an
          // agent that HAS a choice of accounts: a single-login agent must not write a selection.
          if (hasAccountChoice) {
            select.mutate(
              { projectId: null, provider: picked, profileId: account },
              { onSuccess: flash, onError: (error: Error) => toast(error.message, { tone: 'danger' }) },
            )
          }
        }}
      />
    </FormRow>
  )
}

function AccountRow({ account, onRemove }: { account: AgentProfile; onRemove: () => void }) {
  const [showDetails, setShowDetails] = useState(false)
  const routeId = agentAccountRouteId(account)
  const connect = useConnectAgentAccount()
  const recheck = useRecheckAgentAccount()
  // The listing carries a status whenever the server has one cached — which, after its boot warm,
  // is the normal case. Only ask for a probe when it does not. Either way the row renders at once.
  const probed = useAgentAccountStatus(routeId, account.status === undefined)
  const status = account.status ?? probed.data?.status
  const presentation = status ? STATUS_PRESENTATION[status.status] : undefined

  return (
    <div
      data-slot="account-row"
      data-account={account.id}
      data-provider={account.provider}
      className="flex flex-col gap-2 px-4 py-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-ui">
            <span className="font-medium text-foreground">{account.label}</span>
            <span className="text-muted-foreground">· {PROVIDER_LABEL[account.provider]}</span>
            {account.isDefault ? (
              <Badge variant="ghost" className="shrink-0 text-micro text-muted-foreground">
                discovered
              </Badge>
            ) : null}
          </div>
          <p
            data-slot="account-path"
            className="mt-0.5 truncate font-mono text-meta text-soft-foreground"
            title={account.path}
          >
            {account.configDir}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {/* "Checking…" is a real, distinct state from any probe RESULT: the answer is not in
                yet. Showing `unknown` here would claim a verification that never ran. */}
            <StatusDot tone={presentation?.tone ?? 'neutral'} pulse={presentation === undefined} />
            <span data-slot="account-status">{presentation?.label ?? 'Checking…'}</span>
            {!account.exists ? (
              <span data-slot="account-missing">— folder not created yet; Connect will make it</span>
            ) : !account.looksValid ? (
              <span data-slot="account-unrecognised">
                — this folder does not look like {PROVIDER_LABEL[account.provider]} config yet
              </span>
            ) : null}
          </div>
          {status?.status === 'not-installed' && status.hint ? (
            <p data-slot="account-install-hint" className="mt-1 text-xs text-soft-foreground">
              {status.hint}
            </p>
          ) : null}
        </div>

        {/* The collapsed row is a READING surface. Connect and Check again are the two
            exceptions, deliberately: they are how an account becomes usable at all. */}
        <div className="flex shrink-0 items-center gap-2">
          {/* No Connect for a CLI that is not installed: the login it opens cannot run, and the
              server only answers its install hint (telemetry 23976d8d) — the row shows that. */}
          {status?.status !== 'connected' && status?.status !== 'not-installed' ? (
            <Button
              type="button"
              size="sm"
              data-action="account-connect"
              disabled={connect.isPending}
              onClick={() =>
                connect.mutate(
                  { provider: account.provider, ...(account.isDefault ? {} : { profileId: account.id }) },
                  {
                    onSuccess: (result) =>
                      toast(result.opened
                        ? 'Finish signing in in the terminal, then Check again.'
                        : 'This account is already connected.'),
                    // A 409 with a command is a login cezar could not open — not installed, hosted —
                    // which the server already counts (`trackLoginNotOpened`); not an error report.
                    onError: (error: Error) =>
                      error instanceof ApiError && error.command
                        ? toast(`${error.message} — run: ${error.command}`, { tone: 'danger', expected: true })
                        : toast(error.message, { tone: 'danger' }),
                  },
                )
              }
            >
              Connect
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-action="account-recheck"
            disabled={recheck.isPending}
            title="Re-probe this account's login now, instead of waiting for the cached answer"
            onClick={() =>
              recheck.mutate(routeId, {
                onError: (error: Error) => toast(error.message, { tone: 'danger' }),
              })
            }
          >
            Check again
          </Button>
          {/* Identity is opt-in: nothing is requested until this is pressed, so an email is absent
              from the page rather than merely unrendered. */}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-action="account-details-toggle"
            aria-expanded={showDetails}
            onClick={() => setShowDetails((on) => !on)}
          >
            {showDetails ? 'Close' : 'Manage'}
          </Button>
        </div>
      </div>

      {showDetails ? (
        <AccountDetails account={account} routeId={routeId} onRemove={onRemove} />
      ) : null}
    </div>
  )
}

/** The opt-in half of a row: who this login is, its own config files, and managing it. */
function AccountDetails({
  account,
  routeId,
  onRemove,
}: {
  account: AgentProfile
  routeId: string
  onRemove: () => void
}) {
  const health = useHealth()
  const details = useAgentAccountDetails(routeId, true)
  const open = useOpenAgentAccountFile()
  const targets = useOpenTargets()
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(account.label)
  const rename = useUpdateAgentProfile()
  // Wait for health before offering desktop actions. Once loaded, preserve the older-server
  // fallback for responses that predate capabilities.
  const localHandoff = health.data ? (health.data.capabilities?.localHandoff ?? true) : false

  // Which detected apps can actually act on each thing — the same rule the route enforces, so the
  // menu never offers something that would come back a 400.
  const detected = targets.data?.targets ?? []
  const fileChoices = detected
    .filter((t) => cliTargetRunner(t.id) === undefined && t.id !== 'terminal' && t.id !== 'finder')
    .map((target) => ({ target }))
  const folderChoices = detected
    .filter((t) => cliTargetRunner(t.id) === undefined)
    .map((target) => ({ target }))

  const openPath = (file: string, label: string, target?: string) =>
    open.mutate(
      { routeId, file, ...(target ? { target } : {}) },
      {
        // The server's own words: "this account has no settings.json yet", "could not open …".
        onError: (error) => toast(error.message, { tone: 'danger' }),
        onSuccess: () => toast(`Opened ${label}`),
      },
    )

  return (
    <div data-slot="account-details" className="rounded-md border border-border/60 bg-muted/30 p-3">
      {details.isPending ? (
        <p className="text-xs text-muted-foreground">Reading account details…</p>
      ) : details.isError ? (
        <p data-slot="account-details-error" className="text-xs text-danger">
          {details.error.message}
        </p>
      ) : details.data.available ? (
        <dl data-slot="account-identity" className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
          {details.data.fields.map((field) => (
            <Fragment key={field.label}>
              <dt className="text-muted-foreground">{field.label}</dt>
              <dd className="min-w-0 truncate text-foreground" title={field.value}>
                {field.value}
              </dd>
            </Fragment>
          ))}
        </dl>
      ) : (
        // Honest about WHY there is nothing, rather than an empty panel.
        <p data-slot="account-identity-unavailable" className="text-xs text-muted-foreground">
          {details.data.reason ?? 'No account details to show.'}
        </p>
      )}

      {localHandoff ? (
        <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-border/60 pt-2.5">
          <span className="mr-1 text-xs text-muted-foreground">Config files</span>
          {(account.files ?? []).map((file) => (
            <OpenInMenu
              key={file.id}
              slot="account-open-file"
              label={file.label}
              triggerVariant="outline"
              disabled={open.isPending}
              // A file the agent has not written yet is offered but says so, because "Connect then
              // it appears" is the normal path and a hidden button would look like a missing feature.
              title={file.exists ? file.path : `${file.path} — not created yet`}
              choices={fileChoices}
              onPick={(target) => openPath(file.id, file.label, target)}
              leading={
                <DropdownMenuItem
                  data-target="system"
                  onSelect={() => openPath(file.id, file.label)}
                >
                  <ExternalLinkIcon aria-hidden="true" />
                  System default
                </DropdownMenuItem>
              }
            />
          ))}
          <OpenInMenu
            slot="account-open-folder"
            label="Folder"
            disabled={open.isPending}
            title={account.path}
            choices={folderChoices}
            onPick={(target) => openPath('folder', 'folder', target)}
            leading={
              <DropdownMenuItem data-target="system" onSelect={() => openPath('folder', 'folder')}>
                <ExternalLinkIcon aria-hidden="true" />
                System default
              </DropdownMenuItem>
            }
          />
        </div>
      ) : null}

      {/* The discovered account carries no Rename/Remove at all — it is what cezar found, so either
          would imply a setting that does not exist. */}
      {account.isDefault ? null : (
        <div
          data-slot="account-manage"
          className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/60 pt-2.5"
        >
          <span className="mr-1 text-xs text-muted-foreground">Account</span>
          {renaming ? (
            <>
              <input
                type="text"
                autoFocus
                aria-label={`Name for ${account.label}`}
                data-slot="account-rename-input"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                className="w-48 rounded-md border border-input bg-card px-2 py-1 text-xs outline-none focus-visible:border-ring"
              />
              <Button
                type="button"
                size="sm"
                data-action="account-rename-save"
                disabled={rename.isPending || draft.trim() === '' || draft.trim() === account.label}
                onClick={() =>
                  rename.mutate(
                    { id: account.id, label: draft.trim() },
                    {
                      onSuccess: () => setRenaming(false),
                      onError: (error) => toast(error.message, { tone: 'danger' }),
                    },
                  )
                }
              >
                Save
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setDraft(account.label)
                  setRenaming(false)
                }}
              >
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-action="account-rename"
                onClick={() => setRenaming(true)}
              >
                Rename
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-action="account-remove"
                onClick={onRemove}
                className={cn('text-danger')}
              >
                Remove
              </Button>
              {/* The label is cezar's own; the folder is the account. */}
              <span className="text-xs text-muted-foreground">
                Renaming changes what cezar calls this account, not its folder.
              </span>
            </>
          )}
        </div>
      )}
    </div>
  )
}

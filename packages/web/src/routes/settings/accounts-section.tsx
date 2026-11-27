import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ChevronRightIcon, ExternalLinkIcon, IdCardIcon, StarIcon } from 'lucide-react'
import { Fragment, useEffect, useState, type ReactNode } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router'

import { ApiError, putWorkspaceConfig } from '@/api/client'

import {
  useAgentAccountDetails,
  useAgentProviders,
  useRunnerModels,
  useAgentProfiles,
  useAgentSetup,
  useHealth,
  useAgentAccountStatus,
  useConnectAgentAccount,
  useRecheckAgentAccount,
  useOpenAgentAccountFile,
  useOpenTargets,
  useProviderStatus,
  useRemoveAgentProfile,
  useSelectAgentProfile,
  useUpdateAgentProfile,
  useWorkspaceConfig,
  workspaceQueryKeys,
} from '@/api/queries'
import {
  agentAccountRouteId,
  type AgentProviderEntry,
  type AgentSetupEntry,
  type AgentProfile,
  type AgentProfilesResponse,
  type BackendCheck,
  type ProviderId,
  type Runner,
  type SetWorkspaceConfigInput,
} from '@open-mercato/cezar-api-client'
import { useAgentSetupSheet } from '@/components/agent-setup-sheet'
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
import { Button, buttonVariants } from '@/components/ui/button'
import { IconTooltip } from '@/components/ui/icon-tooltip'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { StatusDot, type StatusDotTone } from '@/components/status-dot'
import { RUNNER_ORDER } from '@/lib/provider-status'
import { toast } from '@/components/ui/toaster'
import { OpenInMenu, cliTargetRunner } from '@/components/open-in-menu'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { LoadingState, SettingsSkeleton } from '@/components/loading-state'
import { modelCatalogStatus, modelsForRunner, RUNNERS } from '@/routes/new-task-form'
import { useAddAccount } from '@/components/add-account/add-account-host'
import { canUseAgent, methodSummary, servingMethods } from '@/lib/agent-providers'
import { agentRowAction, AGENT_ROW_ACTION_LABEL } from '@/lib/agent-setup'
import { AGENT_DESCRIPTORS } from './agent-descriptors'
import { ProviderMethods } from './provider-methods'
import { CursorConnection } from './cursor-connection'
import { CardNote, FormRow, SavedIndicator, SettingsCard, useSavedFlash } from './form-row'
import { AccountPlanUsage } from './account-plan-usage'

/** Workspace agent settings. Account identity is requested only after Manage is opened. */
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
  const methods = useAgentProviders()
  const setup = useAgentSetup({ latest: true })
  const sheet = useAgentSetupSheet()
  const status = useProviderStatus()
  const client = useQueryClient()
  const saveDefault = useMutation({
    mutationFn: (runner: Runner) => putWorkspaceConfig({ agentDefaults: { runner } }),
    onSuccess: result => client.setQueryData(workspaceQueryKeys.config, result),
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  // A paired phone gets no host paths (spec 2026-11-24-add-account-in-cockpit).
  const hostPaths = data.hostPaths !== false
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
  const { hash } = useLocation()
  const requested = hash.startsWith('#agent-') ? hash.slice(7) : searchParams.get('agent')
  const [showAll, setShowAll] = useState(false)
  useEffect(() => {
    if (requested && notInstalled.includes(requested as ProviderId)) setShowAll(true)
  }, [requested, notInstalled.join(',')])
  // A default model saved for an agent that is no longer installed still seeds new projects — open
  // the fold so it can be seen and cleared.
  const storedModels = useWorkspaceConfig().data?.agentDefaults.models ?? {}
  const stale = notInstalled.filter((provider) => Boolean(storedModels[provider as Runner]))
  useEffect(() => {
    if (stale.length > 0) setShowAll(true)
  }, [stale.join(',')])
  // …and the named row is scrolled to once it renders. A frame later, so the shell's `#accounts`
  // scroll (a parent effect, which runs after this one) does not win.
  const requestedShown = requested !== null && (showAll || installed.includes(requested as ProviderId))
  useEffect(() => {
    if (!requestedShown) return
    const frame = requestAnimationFrame(() =>
      document.getElementById(`agent-${requested}`)?.scrollIntoView?.({ block: 'center' }),
    )
    return () => cancelAnimationFrame(frame)
  }, [requested, requestedShown])
  const capable = data.profileCapableProviders ?? []
  const defaultRunner = useDefaultRunner()

  const shown = showAll ? [...installed, ...notInstalled] : installed
  return (
    <div data-slot="accounts-section" className="flex flex-col gap-5">
      <SettingsCard
        id="installed"
        slot="accounts-installed"
        title={
          <span className="flex items-center gap-2">
            Agents
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
        {methods.data?.editable === false && <CardNote slot="providers-hosted">Read-only. Set keys and methods on the host with <code>cezar providers</code> or <code>serve --providers</code>.</CardNote>}
        {methods.isError && <CardNote tone="danger">Provider settings could not be loaded.</CardNote>}

        {shown.map((provider) => (
          <InstalledAgentRow
            key={provider}
            provider={provider}
            // `checks` is read defensively: health is also patched in place from the WS topic and
            // seeded by route gates, so a partially-populated cache entry is a real state.
            check={checks?.find((c) => c.name === provider)}
            subscription={data.editable && (methods.data?.editable === true || (methods.error instanceof ApiError && methods.error.status === 404)) ? <SubscriptionAccounts
              provider={provider} accounts={(data.profiles ?? []).filter(p => p.provider === provider)}
              capable={capable.includes(provider)} selected={data.defaults?.[provider]} hostPaths={hostPaths}
              onRemove={setConfirming} /> : undefined}
            entry={methods.data?.agents.find(agent => agent.runner === provider)}
            setup={setup.data?.agents.find(agent => agent.provider === provider)}
            onSetup={sheet.open}
            editable={methods.data?.editable === true}
            onStar={() => saveDefault.mutate(provider)}
            canStar={defaultRunner !== undefined && !saveDefault.isPending && canUseAgent(methods.data?.agents.find(agent => agent.runner === provider), status.data?.providers.find(row => row.provider === provider))}
            staleModel={stale.includes(provider)}
            isDefault={provider === (defaultRunner ?? 'claude')}
            highlighted={provider === requested}
          />
        ))}
      </SettingsCard>

      {sheet.element}
      {!data.editable && <CardNote slot="accounts-hosted">Agent accounts are disabled for remote access. Account management requires CEZ_REMOTE_AGENT_ACCOUNTS=1.</CardNote>}

      <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        <AlertDialogContent data-slot="accounts-remove-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>Remove “{confirming?.label}”?</AlertDialogTitle>
            {confirming?.managed ? (
              <AlertDialogDescription data-slot="accounts-remove-managed">
                cezar signs this account out and deletes the folder it made for it
                {hostPaths && confirming.path ? <> ({confirming.path})</> : null}, with its settings and
                sessions. Projects using it fall back to the default account, and tasks that ran under
                it can no longer be resumed from here.
              </AlertDialogDescription>
            ) : (
            <AlertDialogDescription>
              This removes the account from cezar's list — it cannot be undone from here; add the
              folder again to bring it back. Nothing in {confirming?.configDir} is deleted — not
              your login, not your sessions. Projects using it fall back to the default account,
              and tasks that ran under it can no longer be resumed from here.
            </AlertDialogDescription>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-action="accounts-remove-confirm"
              className={buttonVariants({ variant: 'destructive' })}
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
function InstalledAgentRow({ provider, check, entry, setup, editable, onSetup, isDefault, highlighted, canStar, onStar, staleModel, subscription }: {
  provider: ProviderId
  check: BackendCheck | undefined
  subscription?: ReactNode
  entry?: AgentProviderEntry
  setup?: AgentSetupEntry
  editable: boolean
  onSetup: ReturnType<typeof useAgentSetupSheet>['open']
  canStar: boolean
  onStar: () => void
  isDefault: boolean
  highlighted: boolean
  staleModel: boolean
}) {
  const [open, setOpen] = useState(provider === 'claude' || highlighted || staleModel)
  useEffect(() => { if (highlighted || staleModel) setOpen(true) }, [highlighted, staleModel])
  const label = PROVIDER_LABEL[provider]
  const installed = check?.available
  const action = agentRowAction(setup, undefined)
  const usable = entry && servingMethods(entry).length > 0
  const summary = installed === false ? 'Not installed' : entry ? methodSummary(entry) : 'Checking…'
  return (
    <section id={`agent-${provider}`} data-slot="accounts-provider" data-highlighted={highlighted ? '' : undefined}
      className={`scroll-mt-16 px-4 py-2 ${highlighted ? 'bg-primary/5' : ''}`}>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" aria-expanded={open} aria-controls={`methods-${provider}`} onClick={() => setOpen(!open)}
          data-slot="accounts-provider-row" data-provider={provider}
          className="flex min-w-0 flex-1 flex-wrap items-center gap-2 rounded-sm py-1.5 text-left text-ui focus-visible:ring-2">
          <ChevronRightIcon className={`size-4 text-muted-foreground ${open ? 'rotate-90' : ''}`} />
          <span className="font-medium">{label}</span>
          {installed && <span data-slot="agent-installed" className="sr-only">Yes</span>}
          {check?.version && <Badge variant="ghost" data-slot="agent-version" className="font-mono text-micro">{check.version}</Badge>}
          <StatusDot tone={usable ? 'success' : 'neutral'} />
          <span className="text-label text-muted-foreground">{summary}</span>
          {entry && <Badge variant="outline" className="text-micro">{entry.mode === 'one' ? 'One at a time' : 'Any combination'}</Badge>}
        </button>
        <Button type="button" size="icon-sm" variant="ghost" aria-label={`Start new projects with ${label}`} aria-pressed={isDefault}
          disabled={!editable || !canStar || installed === false} onClick={onStar}>
          <StarIcon className={isDefault ? 'fill-current text-primary' : ''} />
          {isDefault && <span className="sr-only">Default agent for new projects</span>}
        </Button>
      </div>
      {installed === false && <div data-slot="agent-installed" className="flex flex-wrap items-center gap-2 text-label text-muted-foreground">
        <code>{setup?.install.command ?? PROVIDER_INSTALL[provider]}</code>
        {editable && setup && <Button size="sm" variant="outline" onClick={() => onSetup(provider, setup.install.runnable ? 'install' : 'how-to-install')}>
          {setup.install.runnable ? 'Install' : 'How to install'}
        </Button>}
      </div>}
      {open && <div id={`methods-${provider}`} className="space-y-3 py-2 sm:pl-6">
        {entry && <ProviderMethods agent={entry} editable={editable} subscription={subscription} />}
        {!entry?.methods.some(m => m.kind === 'subscription') && subscription}
        <DefaultModelSelect runner={provider} readOnly={!editable} entry={entry} />
        <footer className="flex flex-wrap items-center gap-2 text-label text-muted-foreground">
          {check?.version && <span>Installed {check.version}</span>}
          {editable && action === 'update' && <Button size="sm" variant="ghost" onClick={() => onSetup(provider, action)}>{AGENT_ROW_ACTION_LABEL[action]} {setup?.latestVersion}</Button>}
          {AGENT_DESCRIPTORS.some(d => d.id === provider) && <Link to={`/settings/agent-config?agent=${provider}`} className="ml-auto underline">Config files and MCP</Link>}
        </footer>
      </div>}
    </section>
  )
}

/**
 * One agent's default model (spec 2026-07-29-agent-profiles): saves on change, "Saved" inline.
 * `null` clears the key back to "no opinion" — absence cannot say that in a partial patch, and
 * a stale value would keep seeding every unconfigured project.
 */
function DefaultModelSelect({ runner, entry, readOnly }: { runner: Runner; entry?: AgentProviderEntry; readOnly: boolean }) {
  const queryClient = useQueryClient()
  const config = useWorkspaceConfig()
  const catalog = useRunnerModels(runner)
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
  const status = modelCatalogStatus(runner, catalog.data, catalog.isError)
  const unavailable = entry && servingMethods(entry).length === 0
  const options = unavailable ? [] : modelsForRunner(runner, catalog.data, [current], entry)
  const missing = current && !options.some(m => m.id === current)
  return (
    <div className="flex items-center gap-2">
      <Select
        value={current === '' ? AUTO_MODEL : current}
        disabled={readOnly || save.isPending || (!!unavailable && !current)}
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
          <span className="text-muted-foreground">Default model</span>
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper">
          {missing && <SelectItem value={current} disabled>{current} · no longer offered</SelectItem>}
          {unavailable && <SelectItem value={AUTO_MODEL}>auto</SelectItem>}
          {options.map((model) => (
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

/** The default account is personal, and changing it never changes a project's runner. */
function SubscriptionAccounts({ provider, accounts, selected, capable, hostPaths, onRemove }: {
  provider: ProviderId
  accounts: AgentProfile[]
  selected?: string
  capable: boolean
  hostPaths: boolean
  onRemove: (account: AgentProfile) => void
}) {
  const select = useSelectAgentProfile()
  const add = useAddAccount()
  const ready = accounts.filter(account => !account.pending)
  const current = ready.find(account => account.id === selected) ?? ready.find(account => account.isDefault)
  return (
    <div className="mt-2 space-y-2">
      {(capable || ready.length > 0) && <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline" aria-label={`Account for ${PROVIDER_LABEL[provider]}`}>{current?.label ?? 'Account'}{ready.length > 1 && ` +${ready.length - 1}`}</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>Account new projects use</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={current?.id ?? ''} onValueChange={id => {
            const account = ready.find(row => row.id === id)
            if (account && account !== current) select.mutate({ projectId: null, provider, profileId: account.isDefault ? null : id },
              { onError: (error: Error) => toast(error.message, { tone: 'danger' }) })
          }}>
            {ready.map(account => <DropdownMenuRadioItem key={account.id} value={account.id} disabled={select.isPending}>{account.label}</DropdownMenuRadioItem>)}
          </DropdownMenuRadioGroup>
          {capable && <><DropdownMenuSeparator /><DropdownMenuItem data-action="accounts-add" disabled={!add}
            onSelect={() => add?.open({ provider })}>Add another account</DropdownMenuItem></>}
        </DropdownMenuContent>
      </DropdownMenu>}
      {accounts.length > 0 && <details>
        <summary className="w-fit cursor-pointer rounded-sm text-label text-muted-foreground">Manage logins</summary>
        {accounts.map(account => <AccountRow key={account.id} account={account} hostPaths={hostPaths} onRemove={() => onRemove(account)} />)}
        <p className="px-4 text-label text-muted-foreground">To sign out of a vendor login, use the agent’s own sign-out command.</p>
      </details>}
    </div>
  )
}

function AccountRow({ account, hostPaths, onRemove }: { account: AgentProfile; hostPaths: boolean; onRemove: () => void }) {
  const addAccount = useAddAccount()
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
            {account.pending ? (
              <Badge variant="ghost" data-slot="account-pending" className="shrink-0 text-micro text-pending-strong">
                not signed in yet
              </Badge>
            ) : null}
          </div>
          {/* Stored spelling in the text, the expanded absolute path in the tooltip. */}
          {hostPaths ? (
            <IconTooltip label={account.path}>
              <p data-slot="account-path" className="mt-0.5 w-fit max-w-full truncate font-mono text-meta text-soft-foreground">
                {account.configDir}
              </p>
            </IconTooltip>
          ) : null}
          <div className="mt-1 flex flex-wrap items-center gap-2 text-label text-muted-foreground">
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
          {status?.status !== 'connected' && status?.hint ? (
            <p data-slot="account-install-hint" className="mt-1 text-label text-muted-foreground">
              {status.hint}
            </p>
          ) : null}
        </div>

        {/* The collapsed row is a READING surface. Connect and Check again are the two
            exceptions, deliberately: they are how an account becomes usable at all. */}
        <div className="flex shrink-0 items-center gap-2">
          {/* No Connect for a CLI that is not installed: the login it opens cannot run, and the
              server only answers its install hint (telemetry 23976d8d) — the row shows that. */}
          {account.pending && addAccount ? (
            <Button type="button" size="sm" data-action="account-finish-sign-in" onClick={() => addAccount.open({ resume: account })}>
              Finish signing in
            </Button>
          ) : hostPaths && account.provider !== 'cursor' && status?.status !== 'connected' && status?.status !== 'not-installed' ? (
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
            onClick={() =>
              recheck.mutate(routeId, {
                onSuccess: (result) => {
                  if (account.provider === 'cursor') toast(`Cursor connection check: ${STATUS_PRESENTATION[result.status.status].label.toLowerCase()}.`)
                },
                onError: (error: Error) => toast(error.message, { tone: 'danger' }),
              })
            }
          >
            {account.provider === 'cursor' ? (recheck.isPending ? 'Verifying…' : 'Verify connection') : 'Check again'}
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

      {account.provider === 'cursor' ? <CursorConnection status={status} installCommand={PROVIDER_INSTALL.cursor} /> : null}

      {showDetails ? (
        <AccountDetails account={account} routeId={routeId} hostPaths={hostPaths} onRemove={onRemove} />
      ) : null}
    </div>
  )
}

/** The opt-in half of a row: who this login is, its own config files, and managing it. */
function AccountDetails({
  account,
  routeId,
  hostPaths,
  onRemove,
}: {
  account: AgentProfile
  routeId: string
  hostPaths: boolean
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
        <p className="text-label text-muted-foreground">Reading account details…</p>
      ) : details.isError ? (
        <p data-slot="account-details-error" className="text-label text-danger">
          {details.error.message}
        </p>
      ) : details.data.available ? (
        <dl data-slot="account-identity" className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-label">
          {details.data.fields.map((field) => (
            <Fragment key={field.label}>
              <dt className="text-muted-foreground">{field.label}</dt>
              <dd className="min-w-0 break-all text-foreground">
                {field.value}
              </dd>
            </Fragment>
          ))}
        </dl>
      ) : (
        // Honest about WHY there is nothing, rather than an empty panel.
        <p data-slot="account-identity-unavailable" className="text-label text-muted-foreground">
          {details.data.reason ?? 'No account details to show.'}
        </p>
      )}

      {account.provider === 'claude' || account.provider === 'codex' ? (
        <AccountPlanUsage provider={account.provider} accountId={account.id} />
      ) : null}

      {localHandoff ? (
        <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-border/60 pt-2.5">
          <span className="mr-1 text-label text-muted-foreground">Config files</span>
          {(account.files ?? []).map((file) => (
            <OpenInMenu
              key={file.id}
              slot="account-open-file"
              // A file the agent has not written yet is offered but says so, because "Connect then
              // it appears" is the normal path and a hidden button would look like a missing feature.
              label={file.exists ? file.label : `${file.label} (not created yet)`}
              triggerVariant="outline"
              disabled={open.isPending}
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
      {/* A phone may only remove an account cezar made; renaming stays on the computer. */}
      {account.isDefault || (!hostPaths && !account.managed) ? null : (
        <div
          data-slot="account-manage"
          className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/60 pt-2.5"
        >
          <span className="mr-1 text-label text-muted-foreground">Account</span>
          {renaming ? (
            <>
              <Input
                type="text"
                autoFocus
                aria-label={`Name for ${account.label}`}
                data-slot="account-rename-input"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                className="h-[30px] w-48 text-label"
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
              {hostPaths ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  data-action="account-rename"
                  onClick={() => setRenaming(true)}
                >
                  Rename
                </Button>
              ) : null}
              <Button
                type="button"
                variant="danger-ghost"
                size="sm"
                data-action="account-remove"
                onClick={onRemove}
              >
                Remove
              </Button>
              {/* The label is cezar's own; the folder is the account. */}
              <span hidden={!hostPaths} className="text-label text-muted-foreground">
                Renaming changes what cezar calls this account, not its folder.
              </span>
            </>
          )}
        </div>
      )}
    </div>
  )
}

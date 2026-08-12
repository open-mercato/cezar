import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ExternalLinkIcon, IdCardIcon } from 'lucide-react'
import { Fragment, useState } from 'react'

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
  useRunnerModels,
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
import { StatusDot, type StatusDotTone } from '@/components/status-dot'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { toast } from '@/components/ui/toaster'
import { OpenInMenu, cliTargetRunner } from '@/components/open-in-menu'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { DefaultAgentPicker, agentPickerRows } from '@/components/default-agent-picker'
import { modelCatalogStatus, modelsForRunner, RUNNERS } from '@/routes/new-task-form'
import { AddAccountDialog } from './add-account-dialog'

/**
 * Global settings → Agent accounts (spec `.ai/specs/2026-07-29-agent-profiles.md`).
 *
 * One tab per agent, because the questions a reader has are per agent — is it installed, which
 * version, am I signed in, which folder, and which logins do I have. Stacking every agent on one
 * scroll made the answer to "what's up with Codex" something you had to hunt for.
 *
 * Global, for the same reason Projects and Resources are: a config dir describes the person and
 * the machine, never a repo.
 *
 * ## Identity is opt-in, and "hidden" means absent
 *
 * "Show details" reveals the email, organization and plan an account is signed in as. That is a
 * deliberate, narrow exception to the boundary `provider-auth.ts` keeps — "credentials, account
 * identity, and raw CLI output never cross this boundary" — so it is built to stay narrow: the data
 * is NOT a field on the accounts listing, it comes from its own on-demand route
 * (`useAgentAccountDetails`, `enabled` only once the row is expanded), and it is refused in hosted
 * mode. Nothing fetches it until a person asks, which is what makes "hidden by default" mean the
 * data is absent from the page rather than merely unrendered.
 *
 * Rename and Remove live in that same panel rather than on the collapsed row. A row is a reading
 * surface — which account, where, signed in or not — and Remove sitting on it put a destructive
 * action one stray click from a list you scan. Behind "Show details" it is one deliberate click,
 * beside the folder and identity it actually applies to.
 *
 * ## Three decisions worth reading
 *
 * 1. **The discovered account is listed but not editable.** It is what `agentHomePaths()` finds —
 *    which honours the vendors' own env vars — so it is a fact, not a setting.
 * 2. **A folder that does not exist yet is not an error.** The documented flow is *add the account
 *    → Connect → the CLI creates the folder*. What must NOT happen is falling back to another
 *    account at run time, and that refusal lives server-side.
 * 3. **Remove only ever DEREGISTERS.** No directory is touched, no session deleted. The confirm
 *    says so out loud, because "Remove" next to a path reads as "delete my folder".
 */

const PROVIDER_LABEL: Record<ProviderId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
}

/** The vendor's own install/login instruction, shown when the CLI is not on this machine. */
const PROVIDER_INSTALL: Record<ProviderId, string> = {
  claude: 'npm i -g @anthropic-ai/claude-code',
  codex: 'npm i -g @openai/codex',
  opencode: 'https://opencode.ai',
}

/** Same vocabulary the Providers card uses — one wording for "is this logged in?". */
const STATUS_PRESENTATION = {
  connected: { label: 'Connected', tone: 'success' },
  disconnected: { label: 'Not connected', tone: 'pending' },
  'not-installed': { label: 'Not installed', tone: 'neutral' },
  unknown: { label: 'Could not verify', tone: 'danger' },
} as const satisfies Record<string, { label: string; tone: StatusDotTone }>

export function AccountsSection() {
  const profiles = useAgentProfiles()

  if (profiles.isPending) {
    return (
      <p data-slot="accounts-loading" className="p-4 text-[13px] text-soft-foreground md:p-6">
        Loading agent accounts…
      </p>
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

function AccountsPane({ data }: { data: AgentProfilesResponse }) {
  const health = useHealth()
  const [adding, setAdding] = useState<ProviderId | null>(null)
  const [confirming, setConfirming] = useState<AgentProfile | null>(null)
  const remove = useRemoveAgentProfile()

  // Every agent gets a tab, including one that cannot carry a second login: the tab is where its
  // install state and config folder live, and hiding OpenCode would just move the question
  // "is OpenCode set up?" somewhere else.
  const providers: ProviderId[] = ['claude', 'codex', 'opencode']

  if (!data.editable) {
    return (
      <div
        data-slot="accounts-section"
        className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4 md:p-6"
      >
        <h2 className="text-sm font-semibold text-foreground">Agent accounts</h2>
        <p data-slot="accounts-hosted" className="text-[13px] text-soft-foreground">
          Agent accounts are managed from the machine that owns the checkout — this cockpit runs in
          hosted mode.
        </p>
      </div>
    )
  }

  return (
    <div
      data-slot="accounts-section"
      className="mx-auto flex w-full max-w-2xl flex-col gap-5 p-4 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-6 md:pb-6"
    >
      <div>
        <h2 className="text-sm font-semibold text-foreground">Agent accounts</h2>
        <p className="text-[13px] text-muted-foreground">
          One agent per tab: whether it is installed, and which logins you have. Add a second
          config folder to keep a work account beside a personal one; each project picks which it
          uses in its own Agents settings.
        </p>
      </div>

      <DefaultsForNewProjects profiles={data} />

      <Tabs defaultValue="claude">
        <TabsList variant="line" data-slot="accounts-tabs">
          {providers.map((provider) => (
            <TabsTrigger key={provider} value={provider} data-provider={provider}>
              {PROVIDER_LABEL[provider]}
            </TabsTrigger>
          ))}
        </TabsList>

        {providers.map((provider) => (
          <TabsContent key={provider} value={provider} className="pt-4">
            <AgentTab
              provider={provider}
              // `checks` is read defensively: health is also patched in place from the WS topic and
              // seeded by route gates, so a partially-populated cache entry is a real state — and
              // "Checking…" is the honest thing to show for it.
              check={health.data?.checks?.find((c) => c.name === provider)}
              accounts={data.profiles.filter((p) => p.provider === provider)}
              canCarryAccounts={data.profileCapableProviders.includes(provider)}
              onAdd={() => setAdding(provider)}
              onRemove={setConfirming}
            />
          </TabsContent>
        ))}
      </Tabs>

      {/* Keyed by provider so reopening under a different agent starts from a clean form rather
          than the previous agent's half-typed folder. */}
      {adding !== null ? (
        <AddAccountDialog
          key={adding}
          open
          onOpenChange={(open) => !open && setAdding(null)}
          providers={data.profileCapableProviders}
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

/** One agent: what the machine has, then the logins configured for it. */
function AgentTab({
  provider,
  check,
  accounts,
  canCarryAccounts,
  onAdd,
  onRemove,
}: {
  provider: ProviderId
  /** The `/api/v1/health` probe for this CLI — the ONE place a version can honestly come from. */
  check: BackendCheck | undefined
  accounts: AgentProfile[]
  canCarryAccounts: boolean
  onAdd: () => void
  onRemove: (account: AgentProfile) => void
}) {
  const installed = check?.available === true

  return (
    <div data-slot="accounts-provider" data-provider={provider} className="flex flex-col gap-4">
      {/* Facts about the BINARY, not about any one account: a version and an install are shared by
          every login of the same CLI, so they belong here rather than repeated on each row. */}
      <dl className="divide-y divide-border/60 overflow-hidden rounded-md border border-border bg-card text-[13px]">
        <Row label="Installed">
          {check === undefined ? (
            <span className="text-muted-foreground">Checking…</span>
          ) : installed ? (
            <span data-slot="agent-installed">Yes</span>
          ) : (
            <span data-slot="agent-installed" className="text-muted-foreground">
              No — <code className="text-[12px]">{PROVIDER_INSTALL[provider]}</code>
            </span>
          )}
        </Row>
        {installed && check?.version ? (
          <Row label="Version">
            <span data-slot="agent-version" className="font-mono text-[12.5px]">
              {check.version}
            </span>
          </Row>
        ) : null}
        <Row label="Accounts">
          <span>
            {accounts.length === 1
              ? 'the discovered one'
              : `${accounts.length} (1 discovered, ${accounts.length - 1} added)`}
          </span>
        </Row>
      </dl>

      <div className="flex items-center justify-between gap-3">
        <h3 className="text-[13px] font-semibold text-foreground">Logins</h3>
        {canCarryAccounts ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-action="accounts-add"
            data-provider={provider}
            onClick={onAdd}
          >
            Add account
          </Button>
        ) : null}
      </div>

      <ul className="divide-y divide-border/60 rounded-md border border-border bg-card">
        {accounts.map((account) => (
          <AccountRow key={account.id} account={account} onRemove={() => onRemove(account)} />
        ))}
      </ul>

      {!canCarryAccounts ? (
        <p data-slot="accounts-single-only" className="text-[11.5px] text-soft-foreground">
          {PROVIDER_LABEL[provider]} can only hold one account here: it keeps its credentials
          outside its config folder, so a second folder would change settings without changing the
          login — which would say “work account” while billing the other one.
        </p>
      ) : null}
    </div>
  )
}


/**
 * What a project that has chosen nothing runs (spec 2026-07-29-agent-profiles).
 *
 * Lives on THIS page rather than one of its own: it is the same subject — the logins on this
 * machine — and a second page would mean setting up an account here and then going elsewhere to say
 * "use it". Above the tabs because it is a cross-agent answer; splitting it into the per-agent tabs
 * would mean visiting all three to read one fact.
 *
 * DEFAULTS, never overrides. A project's own `.ai/cezar/config.json` still wins key by key, and a
 * project that has already picked an account keeps it — so changing these can never quietly
 * re-point work someone already configured onto another subscription. The copy says so, because
 * "default" alone does not distinguish the two.
 *
 * Two stores for one click, the same split the rest of the feature makes: the runner and models go
 * to `~/.cezar/config.json`, the account to `~/.cezar/agent-accounts.json`. Neither is committable —
 * that is the point of them being here rather than in a repo's settings.
 */
function DefaultsForNewProjects({ profiles }: { profiles: AgentProfilesResponse }) {
  const queryClient = useQueryClient()
  const config = useWorkspaceConfig()
  const providerStatus = useProviderStatus()
  const catalog = useRunnerModels()
  const select = useSelectAgentProfile()

  const save = useMutation({
    mutationFn: (patch: SetWorkspaceConfigInput) => putWorkspaceConfig(patch),
    onSuccess: (result) => queryClient.setQueryData(workspaceQueryKeys.config, result),
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })

  if (config.data === undefined) return null

  const rows = agentPickerRows(profiles.profiles)
  // Absent means "no opinion", and the built-in fallback is claude — the same answer a project with
  // no config gets today. Showing it checked is honest: it IS what an unconfigured project runs.
  const runner = config.data.agentDefaults.runner ?? 'claude'
  const models = config.data.agentDefaults.models ?? {}

  return (
    <section data-slot="accounts-defaults" className="flex flex-col gap-3 rounded-lg border border-border bg-card/40 p-3.5">
      <div>
        <h3 className="text-[13px] font-semibold text-foreground">Defaults for new projects</h3>
        <p className="text-[13px] text-muted-foreground">
          What a project runs when it has not chosen for itself — set once instead of per
          repository. A project that has chosen keeps its own.
        </p>
      </div>

      <DefaultAgentPicker
        rows={rows}
        runner={runner}
        accountFor={(id) => profiles.defaults[id] ?? null}
        providerStatus={providerStatus}
        disabled={save.isPending}
        accountDisabled={select.isPending}
        onPick={(picked, account, hasAccountChoice) => {
          if (picked !== runner) save.mutate({ agentDefaults: { runner: picked } })
          // `projectId: null` targets the machine-wide default rather than one repo. Only for an
          // agent that HAS a choice of accounts: a single-login agent must not write a selection,
          // or the store fills up with rows that say nothing.
          if (hasAccountChoice) {
            select.mutate(
              { projectId: null, provider: picked, profileId: account },
              { onError: (error: Error) => toast(error.message, { tone: 'danger' }) },
            )
          }
        }}
      />

      <div className="flex flex-col gap-2">
        <span className="text-xs text-muted-foreground">Default model per agent</span>
        {RUNNERS.map((entry) => (
          <label key={entry.id} className="flex items-center gap-3">
            <span className="w-24 shrink-0 font-mono text-xs text-muted-foreground">{entry.label}</span>
            <select
              aria-label={`Default model for ${entry.label}`}
              data-slot="accounts-default-model"
              data-runner={entry.id}
              value={models[entry.id] ?? ''}
              disabled={save.isPending}
              onChange={(event) =>
                save.mutate({
                  // `null` clears the key back to "no opinion" — absence cannot say that in a
                  // partial patch, and a stale value would keep seeding every unconfigured project.
                  agentDefaults: {
                    models: { [entry.id]: event.target.value || null } as Partial<
                      Record<Runner, string | null>
                    >,
                  },
                })
              }
              className="block w-full max-w-xs rounded-md border border-input bg-card px-3 py-1.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
            >
              {modelsForRunner(entry.id, catalog.data, [models[entry.id]]).map((model) => (
                <option key={model.id} value={model.id}>
                  {model.id === '' ? 'auto (default)' : model.label}
                </option>
              ))}
              {modelCatalogStatus(entry.id, catalog.data, catalog.isError) ? (
                <option disabled>{modelCatalogStatus(entry.id, catalog.data, catalog.isError)}</option>
              ) : null}
            </select>
          </label>
        ))}
      </div>
    </section>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3 px-3.5 py-2.5">
      <dt className="w-28 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1">{children}</dd>
    </div>
  )
}

function AccountRow({ account, onRemove }: { account: AgentProfile; onRemove: () => void }) {
  const [showDetails, setShowDetails] = useState(false)
  const routeId = agentAccountRouteId(account)
  const connect = useConnectAgentAccount()
  const recheck = useRecheckAgentAccount()
  // The listing carries a status whenever the server has one cached — which, after its boot warm,
  // is the normal case. Only ask for a probe when it does not: an account added mid-session, or a
  // cache that has aged out. Either way the row renders immediately.
  const probed = useAgentAccountStatus(routeId, account.status === undefined)
  const status = account.status ?? probed.data?.status
  const presentation = status ? STATUS_PRESENTATION[status.status] : undefined

  return (
    <li
      data-slot="account-row"
      data-account={account.id}
      className="flex flex-col gap-2 px-3.5 py-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-medium text-foreground">{account.label}</span>
            {account.isDefault ? (
              <Badge variant="ghost" className="shrink-0 text-[10px] text-muted-foreground">
                discovered
              </Badge>
            ) : null}
          </div>
          <p
            data-slot="account-path"
            className="mt-0.5 truncate font-mono text-[11.5px] text-soft-foreground"
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
        </div>

        {/* The collapsed row is a READING surface — which account, where, is it signed in. Every
            action that CHANGES or DESTROYS something lives one deliberate click away, inside the
            panel below. Connect and Check again are the two exceptions, and deliberately so: they
            are how an account becomes usable at all, and the row's own "folder not created yet"
            copy points at Connect. Burying the only sign-in path behind "Show details" is what left
            an added account with no way to log in. */}
        <div className="flex shrink-0 items-center gap-2">
          {status?.status !== 'connected' ? (
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
                    // The server answers a copyable command when it cannot open a terminal (hosted
                    // mode, no emulator, a folder it refuses to embed). Showing it is the whole
                    // point of failing closed rather than running the bare login.
                    onError: (error: Error) =>
                      toast(error instanceof ApiError && error.command
                        ? `${error.message} — run: ${error.command}`
                        : error.message, { tone: 'danger' }),
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
            {showDetails ? 'Hide details' : 'Show details'}
          </Button>
        </div>
      </div>

      {showDetails ? (
        <AccountDetails account={account} routeId={routeId} onRemove={onRemove} />
      ) : null}
    </li>
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
  const details = useAgentAccountDetails(routeId, true)
  const open = useOpenAgentAccountFile()
  const targets = useOpenTargets()
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(account.label)
  const rename = useUpdateAgentProfile()

  // Which detected apps can actually act on each thing — the same rule the route enforces, so the
  // menu never offers something that would come back a 400. A `cli:<runner>` handoff opens a task
  // worktree, not a config folder; a terminal runs `cd <path>`, which is meaningless for a file.
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

      <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-border/60 pt-2.5">
        <span className="mr-1 text-xs text-muted-foreground">Config files</span>
        {account.files.map((file) => (
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

      {/* The discovered account carries no Rename/Remove at all — it is what cezar found, so either
          would imply a setting that does not exist. Nothing is rendered for it, not a disabled
          control, because a greyed-out Remove reads as "not allowed yet" rather than "not a thing". */}
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
              >
                Remove
              </Button>
              {/* The label is cezar's own; the folder is the account. Saying so here is what keeps
                  Rename from reading as "point this at a different directory". */}
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

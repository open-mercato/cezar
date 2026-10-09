import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  BotIcon,
  BugIcon,
  CheckIcon,
  CopyIcon,
  CpuIcon,
  FileTextIcon,
  FolderIcon,
  GitBranchIcon,
  GitCommitHorizontalIcon,
  GitForkIcon,
  ListPlusIcon,
  SlidersHorizontalIcon,
  SplitIcon,
  ZapIcon,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useParams, useSearchParams } from 'react-router'

import { Link, useNavigate } from '@/lib/project-router'

import { createRun, getLaunchKey, putConfig, putUiState } from '@/api/client'
import { useProjectScope } from '@/api/project-scope-context'
import { hasAccountChoice, useAgentAccounts } from '@/api/agent-accounts'
import {
  queryKeys,
  useConfig,
  useHealth,
  useProviderStatus,
  useProjects,
  useRepo,
  useRunnerModels,
  useSkills,
  useUiState,
  useWorkspaceConfig,
  useWorkflows,
} from '@/api/queries'
import type {
  AttachmentInput,
  DispatchIntent,
  ProjectListEntry,
  RepoResponse,
  Runner,
} from '@open-mercato/cezar-api-client'
import { Composer, type ComposerHandle } from '@/components/composer/composer'
import { DispatchToggle } from '@/components/dispatch-toggle'
import { PickerPill, RunnerPill, chevron, chipClass } from '@/components/picker-pill'
import { PromptTemplateMenu } from '@/components/prompt-template-menu'
import { SourcePill } from '@/components/source-pill'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Item, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item'
import { Kbd } from '@/components/ui/kbd'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { toast } from '@/components/ui/toaster'
import {
  autoApplyText,
  availablePromptTemplates,
  normalizePromptTemplates,
  resolveAutoApply,
} from '@/lib/prompt-templates'
import {
  bumpSkillUsage,
  orderSkillsByUsage,
} from '@/lib/skills'
import { submitShortcutHint } from '@/lib/use-submit-shortcut'
import { cn } from '@/lib/utils'
import { usableRunners } from '@/lib/provider-status'

import {
  bookmarkletRunBody,
  deepLinkToast,
  unknownSkillPrefillText,
  type DeepLinkNotice,
} from './new-task-autostart'
import {
  clearStartedDraft,
  composerRunModeNote,
  handOffComposition,
  readAttachments,
  readDraft,
  resolveComposerRunMode,
  writeAttachments,
  writeDraft,
  type NewTaskDraft,
} from './new-task-draft'
import {
  buildCreateRunBody,
  modelsForRunner,
  modelCatalogStatus,
  pushRecentSource,
  resolveModel,
  resolveRunner,
  resolveSource,
  startedRunPath,
  type TaskSource,
} from './new-task-form'
import { Button } from '@/components/ui/button'
import { parseNewTaskParams } from './new-task-params'

/**
 * `/new` — the full-screen new-task hero (spec §"New task (full-screen, #386)"; visual
 * contract docs/mockups/new-task.html): centered composer card on the twinkle surface, the
 * picker pill row inside the card below the textarea, suggested-task ghost chips underneath.
 * This route also owns the saved-bookmarklet contract (spec 011, BACKWARD_COMPATIBILITY.md):
 * a full document load of `/new?skill=&ref=&auto=1&key=` auto-starts a run unattended when the
 * key matches `GET /api/launch-key`, and only prefills otherwise — `handleDeepLink()` in
 * web/app.js, verbatim (see new-task-autostart.ts for the verified semantics).
 */
export function NewTaskRoute() {
  const [search] = useSearchParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  // The composer's project (multi-project spec, step 3.4). TWO ids, deliberately:
  //  - `urlProjectId` is what the URL names — always a real project, boot included. It is the
  //    pill's selected value and what a swap navigates away from.
  //  - `scope.projectId` is the API/cache scope, which is NULL for the boot project (the
  //    step-3.1 invariant). It keys the draft, so the boot project keeps the bare legacy
  //    storage key and a draft typed before this upgrade survives it.
  // Both are absent when this route renders outside a `/p/:projectId` prefix (a component
  // test), and everything below degrades to exactly the single-project behavior.
  const { projectId: urlProjectId } = useParams()
  const draftProjectId = useProjectScope().projectId
  const projects = useProjects()

  // The deep-link params, captured ONCE: the mount effect below strips them from the URL
  // (legacy's `history.replaceState` — the launch key must not survive in history or survive
  // a reload to re-trigger), so live search params would vanish under us.
  const [deepLink] = useState(() => parseNewTaskParams(search))

  const health = useHealth()
  const workflows = useWorkflows()
  const skills = useSkills()
  const repo = useRepo()
  const uiState = useUiState()
  // Settings → Agents runner/model policy for this project. `/api/health` is boot-bound and
  // cannot answer these per-project defaults when another project is active (#699).
  const config = useConfig()
  const workspaceConfig = useWorkspaceConfig()

  // The draft survives navigation (module store); explicit deep-link params beat it — a
  // pasted `/new?skill=&ref=` link states intent, a leftover draft only remembers it.
  const [draft, setDraft] = useState<NewTaskDraft>(() => {
    const stored = readDraft(draftProjectId)
    return {
      ...stored,
      ...(deepLink.ref !== '' ? { text: deepLink.ref } : {}),
      ...(deepLink.skill !== ''
        ? { source: { source: 'skill', ref: deepLink.skill } as TaskSource }
        : {}),
    }
  })
  useEffect(() => {
    writeDraft(draft, draftProjectId)
  }, [draft, draftProjectId])
  const update = (patch: Partial<NewTaskDraft>) =>
    setDraft((current) => ({ ...current, ...patch }))

  // The composer's attachments, controlled from here (#1018). `/new` used to leave them to the
  // composer's own uncontrolled state, which meant a pasted screenshot lived only as long as the
  // component — and swapping the project pill REMOUNTS this route (`NewTaskProjectRoute` keys on
  // the id), so the picture vanished with the prompt. The store behind this is in-memory and
  // per-project: multi-MB base64 still has no business in localStorage, but surviving a scope
  // swap costs nothing.
  const [images, setImages] = useState(() => readAttachments(draftProjectId))
  useEffect(() => {
    writeAttachments(images, draftProjectId)
  }, [images, draftProjectId])

  // ---- effective picker values (rules in new-task-form.ts, mirrored from legacy) -----------
  const recentSources = uiState.data?.recentSources
  // Memoized so the picker gets a STABLE array identity across renders that don't actually
  // change the catalog or the usage stats (#408 — a raw `orderSkillsByUsage(...)` call here
  // would create a new array on EVERY render, including ones unrelated to skills/usage).
  const skillsData = skills.data
  const skillUsage = uiState.data?.skillUsage
  const skillList = useMemo(
    () => orderSkillsByUsage(skillsData ?? [], skillUsage),
    [skillsData, skillUsage],
  )
  const workflowList = workflows.data?.workflows ?? []
  // The registry the project pill offers. Empty while it loads or when it errors — the pill
  // simply does not render, which is the honest state: there is no second project to offer.
  const projectList = projects.data?.projects ?? []
  /**
   * A URL project id → the id the draft and attachment stores are keyed by.
   *
   * The boot project mounts UNSCOPED (the step-3.1 invariant), so its key is `null` — the same
   * rule `ProjectScopeRoute` applies on the way in. Resolved from the same `bootProject` field
   * both sides read, so the hand-off below cannot write the departing composition under a key
   * the arriving mount will not look at.
   */
  const scopeKeyOf = (id: string): string | null =>
    projects.data?.bootProject === id ? null : id
  const sourcesReady =
    skills.data !== undefined && workflows.data !== undefined && !uiState.isPending
  // The draft's pick alone — a fresh `/new` selects nothing (see `resolveSource` for what the
  // persisted `lastTask` preselection was load-bearing for, and why it is gone).
  const source = resolveSource(draft.source, skillList, workflowList)
  const selectedSkill = source?.source === 'skill'
    ? skillList.find((skill) => skill.name === source.ref)
    : undefined

  // ---- prompt templates (#413 follow-up) ----------------------------------------------------
  // The same list the GitHub hand-over and Inbox composers read. Two ways in here: the footer's
  // icon trigger inserts one by hand at the caret, and a skill whose templates are assigned to it
  // applies them on selection — but only into a box the user has not typed in (`resolveAutoApply`).
  const composerRef = useRef<ComposerHandle>(null)
  const templates = useMemo(
    () =>
      availablePromptTemplates(
        normalizePromptTemplates(uiState.data?.promptTemplates),
        health.data?.capabilities,
      ),
    [uiState.data?.promptTemplates, health.data?.capabilities],
  )
  const autoText = autoApplyText(templates, source?.source === 'skill' ? [source.ref] : [])
  const draftTextRef = useRef(draft.text)
  draftTextRef.current = draft.text
  const autoAppliedRef = useRef('')
  useEffect(() => {
    // Wait for the pickers' data: before it lands `source` is still a provisional guess, and
    // auto-applying against it would flash text in for a skill the user may not end up on.
    if (!sourcesReady) return
    const resolved = resolveAutoApply(draftTextRef.current, autoAppliedRef.current, autoText)
    autoAppliedRef.current = resolved.applied
    if (resolved.text !== draftTextRef.current) update({ text: resolved.text })
    // `autoText` is a derived STRING — this fires when the assigned set changes, not every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoText, sourcesReady])

  const providers = useProviderStatus()
  const runners = usableRunners(providers.data)
  const defaultRunner = config.data?.defaultRunner
  const preferredRunner = defaultRunner ?? 'claude'
  const runner = runners.length > 0 ? resolveRunner(draft.runner, runners, preferredRunner) : null
  const displayRunner = runner ?? preferredRunner
  const providersReady = providers.isSuccess && runners.length > 0
  const catalog = useRunnerModels(displayRunner)
  const modelsLocked = config.data?.modelsLocked === true
  const models = runner === null
    ? []
    : modelsForRunner(runner, catalog.data, [draft.model, config.data?.defaultModels?.[runner]])
  const model = runner === null
    ? ''
    : resolveModel(modelsLocked ? null : draft.model, runner, config.data?.defaultModels, catalog.data)
  // Agent accounts (spec 2026-07-29-agent-profiles). These are rows of the RUNNER pill rather than
  // a pill of their own — `claude · Default` / `claude · Klaudiusz` / `codex` — so what will run is
  // readable at a glance instead of assembled from two controls. An agent with a single login stays
  // a single row, which is why a host with no extra accounts sees the list it always saw.
  const { accounts: accountChoices, repoAccount } = useAgentAccounts()
  // A draft account belonging to ANOTHER runner is ignored rather than sent: switching runner must
  // not silently carry a foreign account along.
  const agentProfile = accountChoices.some(
    (choice) => choice.provider === displayRunner && choice.id === draft.agentProfile,
  )
    ? draft.agentProfile
    : null

  // A cold /new load mounts the textarea disabled while provider status is checked. Restore
  // the route's autofocus contract once that check enables the form, but never steal focus if
  // the user already moved elsewhere while it was pending.
  const providersWereReady = useRef(false)
  useEffect(() => {
    const becameReady = providersReady && !providersWereReady.current
    providersWereReady.current = providersReady
    if (becameReady && document.activeElement === document.body) {
      document
        .querySelector<HTMLTextAreaElement>('textarea[aria-label="Describe a task for the agent"]')
        ?.focus()
    }
  }, [providersReady])

  // Parallel variants need a worktree per variant, hence git (the server 409s without it).
  // Read it from the PROJECT-scoped `/repo` above, never from `/api/health.repo`: health is bound
  // to the boot folder, so booting outside a git repo hid the worktree controls for every
  // registered project (#791) — the same per-project sweep as #700 (forge) and #699 (runner
  // defaults). Loading still assumes git so the controls do not flicker.
  const hasGit = repo.data === undefined || repo.data.info !== null
  const variants = hasGit ? draft.variants : 1

  // Worktree opt-out (#worktree-toggle): any ordinary run in a git repo may use the current
  // checkout. Parallel variants are the one hard constraint because each competing run needs
  // its own tree; a non-git repo already runs in place.
  const worktreeToggleShown = hasGit

  // Dispatch (spec 2026-09-10-dispatch): this task may fan work out to subtasks. Offered only
  // while the server has it on (`CEZ_DISPATCH=0` hides it — the routes 409 then) and in a git
  // repo: a child forks off the parent's committed branch, so there is nothing to fork without
  // one. A draft toggled on under a server that has since turned it off sends nothing.
  const dispatchAvailable = health.data?.capabilities.dispatch === true && hasGit
  const dispatch: DispatchIntent | null = dispatchAvailable ? draft.dispatch : null
  const dispatchOn = dispatch !== null
  // The hint line under the composer: up for 6 s after every change of the toggle or its
  // settings, and the whole time the settings surface is open.
  const [dispatchHintFlash, setDispatchHintFlash] = useState(false)
  const [dispatchSettingsOpen, setDispatchSettingsOpen] = useState(false)
  const dispatchHintTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const changeDispatch = (next: DispatchIntent | null) => {
    update({ dispatch: next })
    if (dispatchHintTimer.current !== null) clearTimeout(dispatchHintTimer.current)
    dispatchHintTimer.current = null
    setDispatchHintFlash(next !== null)
    if (next !== null) {
      dispatchHintTimer.current = setTimeout(() => setDispatchHintFlash(false), 6_000)
    }
  }
  useEffect(
    () => () => {
      if (dispatchHintTimer.current !== null) clearTimeout(dispatchHintTimer.current)
    },
    [],
  )

  // Worktree is forced by parallel variants (one tree per competing run) and by dispatch (the
  // server forces it too: subtasks fork off this task's commits).
  const worktreeForced = variants > 1 || dispatchOn

  // Autonomous (#autonomous): the run never pauses for the user. An explicit toggle this session
  // wins; then an interactive skill recommends handing the ball back; otherwise the configured
  // workspace default applies ('source-dependent' → skills default ON, everything else OFF).
  const runMode = resolveComposerRunMode({
    hasGit,
    variants,
    explicitAutonomous: draft.autonomous,
    explicitWorktree: draft.worktree,
    interactive: selectedSkill?.interactive,
    configuredAutonomous:
      workspaceConfig.data?.composerDefaults?.autonomous
      ?? workspaceConfig.data?.composerDefaults?.inheritedAutonomous
      ?? 'source-dependent',
    configuredWorktree:
      workspaceConfig.data?.composerDefaults?.worktree
      ?? workspaceConfig.data?.composerDefaults?.inheritedWorktree
      ?? true,
    // Nothing picked runs the plain built-in workflow, and the 'source-dependent' autonomy
    // default keys off exactly that: skills default autonomous, everything else does not.
    source: source?.source ?? 'workflow',
    dispatch: dispatchOn,
  })
  const worktreeOn = runMode.worktree
  const autonomousOn = runMode.autonomous

  // Follow-up generation (#444) is offered only while the server has the global inbox on
  // (#471, `CEZ_FOLLOWUPS=1`) — there is no inbox for the follow-ups to land in otherwise, and
  // the server pins the flag to false regardless, so a toggle would be a lie. Hidden, the value
  // is false, matching what the server will do. Health unknown → assume offered, the `hasGit`
  // rule above: the composer must not flicker its controls while health is in flight.
  const followupsToggleShown = health.data === undefined || health.data.capabilities.followups
  // Within an enabled server it stays opt-out: a draft choice wins, then the remembered UI
  // preference; absent state from older installs keeps the historical enabled behavior.
  const generateFollowupsOn = followupsToggleShown
    ? (draft.generateFollowups ?? uiState.data?.lastGenerateFollowups ?? true)
    : false

  // ---- bookmarklet deep-link (spec 011 — legacy handleDeepLink, verbatim) -------------------
  // `auto=1` with a ref arms the unattended start; the composer stays hidden behind a
  // "Starting…" surface until the key check + POST settle (or fail into the prefill path).
  const [autoStarting, setAutoStarting] = useState(() => deepLink.auto && deepLink.ref !== '')
  const [notice, setNotice] = useState<DeepLinkNotice | null>(() =>
    !deepLink.auto && deepLink.ref !== '' ? { kind: 'prefill' } : null,
  )
  const deepLinkUrlCleaned = useRef(false)
  const deepLinkHandled = useRef(false)
  useEffect(() => {
    if (deepLinkUrlCleaned.current) return
    deepLinkUrlCleaned.current = true
    // Legacy cleans the URL FIRST (`history.replaceState({}, '', '/')` — before anything
    // async): the launch key never lingers in the address bar or history, and a reload can
    // never re-trigger the start. Same move here, staying on this route. (The router's own
    // search, not window.location — MemoryRouter under test never touches the window.)
    if (search.toString() !== '') void navigate('/new', { replace: true })
    // mount-only: search is intentionally the initial URL, captured before the replace
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (deepLinkHandled.current) return
    if (!deepLink.auto || deepLink.ref === '') return
    if (providers.isPending) return
    if (!providersReady || runner === null) {
      deepLinkHandled.current = true
      // Authentication could not be established: keep the deep-link intent in the disabled
      // composer and let the provider gate explain whether this is an error or missing setup.
      setNotice({ kind: 'prefill' })
      setAutoStarting(false)
      return
    }
    // Provider status often resolves before project config on a cold load. The protected
    // bookmarklet body may omit runner only against that scoped authoritative default, never
    // our display fallback; a failed config read degrades to the prefilled composer.
    if (config.isPending) return
    deepLinkHandled.current = true
    if (defaultRunner === undefined) {
      setNotice({ kind: 'prefill' })
      setAutoStarting(false)
      return
    }
    // A saved bookmarklet has no runner choice of its own: it implicitly targets the
    // project's configured default. `resolveRunner` deliberately falls back to another
    // connected runner for the editable composer, but that fallback must not turn an
    // unattended launch into a task on a different subscription (or hide an unauthorized
    // default behind a successful-looking start). Leave the prompt in the composer so the
    // user can explicitly choose what should run.
    if (runner !== defaultRunner) {
      setNotice({ kind: 'prefill' })
      setAutoStarting(false)
      return
    }
    void (async () => {
      let launchKey = ''
      try {
        launchKey = (await getLaunchKey()).key
      } catch {
        // key endpoint unreachable → the blocked path, exactly like legacy
      }
      if (launchKey !== '' && deepLink.key === launchKey) {
        try {
          const created = await createRun(bookmarkletRunBody(deepLink, runner, defaultRunner))
          clearStartedDraft(draftProjectId)
          void queryClient.invalidateQueries({ queryKey: queryKeys.runs.all })
          void navigate(startedRunPath(created))
          return
        } catch (error) {
          setNotice({
            kind: 'failed',
            message: error instanceof Error ? error.message : String(error),
          })
        }
      } else {
        // Wrong or missing key: a drive-by page guessing the URL gets a form, never a run.
        setNotice({ kind: 'blocked' })
      }
      setAutoStarting(false)
    })()
  }, [config.isPending, defaultRunner, providers.isPending, providersReady, runner]) // eslint-disable-line react-hooks/exhaustive-deps
  // The prefill toast waits for the pickers' data: whether the skill exists decides the
  // wording, and the unknown-skill case rewrites the draft the way legacy did (intent into
  // the text, quick-task as the source — its planner resolves skills from prose).
  useEffect(() => {
    if (notice === null || !sourcesReady) return
    setNotice(null)
    const unknownSkill =
      deepLink.skill !== '' && !skillList.some((s) => s.name === deepLink.skill)
        ? deepLink.skill
        : ''
    if (unknownSkill !== '') {
      // Legacy put the intent into the text and ran quick-task; `null` IS that run now, and
      // needs no catalog lookup to say so.
      update({ text: unknownSkillPrefillText(deepLink.skill, deepLink.ref), source: null })
    }
    const { message, tone } = deepLinkToast(notice, unknownSkill)
    toast(message, { tone })
    // Legacy focused the Run button so a bare Enter submits the reviewed form.
    document
      .querySelector<HTMLButtonElement>(
        '[data-slot="composer"] button[aria-label="Start task"]',
      )
      ?.focus()
  }, [notice, sourcesReady]) // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (text: string, submitted: AttachmentInput[]) => {
    if (!providersReady || runner === null) {
      throw new Error(
        providers.isPending
          ? 'Checking agent providers…'
          : providers.isError
            ? 'Provider authentication could not be verified.'
            : 'Connect an agent provider before starting a task.',
      )
    }
    if (!sourcesReady) {
      // Rejection restores the draft — nothing typed is lost to a race with the pickers.
      throw new Error('Still loading workflows and skills — try again in a second.')
    }
    const created = await createRun(
      buildCreateRunBody({
        task: text,
        source,
        model,
        modelsLocked,
        runner,
        runnerExplicit: draft.runner !== null,
        agentProfile,
        defaultRunner,
        variants,
        images: submitted,
        worktree: worktreeOn,
        autonomous: autonomousOn,
        generateFollowups: generateFollowupsOn,
        // #374: when the Inbox's "Run" sent us here, hand the entry's id back so the server
        // records this run on it and it leaves the inbox — the audit trail the old
        // POST /api/todos/:id/start kept, minus the blind launch. Empty otherwise.
        // Deliberately not gated on generateFollowupsOn (#444): turning off follow-up
        // generation for THIS task must not stop the entry it came from being marked started.
        todoId: deepLink.todo,
        dispatch,
      }),
    )
    // Remember what was actually run so the next visit preselects it (legacy
    // `saveLastTaskSource`) and float it to the top of the picker next time
    // (recency sort) — fire-and-forget: a failed write only costs the convenience.
    void putUiState({
      // `null` when nothing was picked — an honest record of a plain run, and the value that
      // stops an older cockpit (which still preselects `lastTask`) restoring a stale skill.
      lastTask: source,
      // Recency is a list of PICKS: a task that chose nothing did not pick quick-task, and
      // filling the list with the default would push real choices out of it.
      ...(source ? { recentSources: pushRecentSource(recentSources, source) } : {}),
      ...(followupsToggleShown ? { lastGenerateFollowups: generateFollowupsOn } : {}),
      // Frequency sort (#408): only a SKILL pick counts — the map is keyed by skill name, and a
      // workflow choice here doesn't select one directly. Gated on the CURRENT map being known:
      // the PUT merge is shallow, so bumping off an errored ui-state query (`sourcesReady` only
      // rules out `isPending`, not a failed fetch) would send a one-entry map and wipe every
      // accumulated count.
      ...(source?.source === 'skill' && uiState.data !== undefined
        ? { skillUsage: bumpSkillUsage(uiState.data.skillUsage, source.ref) }
        : {}),
    })
      .then(() => queryClient.invalidateQueries({ queryKey: queryKeys.uiState }))
      .catch(() => {})
    clearStartedDraft(draftProjectId)
    void queryClient.invalidateQueries({ queryKey: queryKeys.runs.all })
    navigate(startedRunPath(created))
  }

  // The unattended bookmarklet start in flight: no composer, no params echoed anywhere —
  // just an honest "working on it" until the POST answers (success navigates to the thread;
  // failure drops back to the prefilled composer with a toast).
  if (autoStarting) {
    return (
      <div
        data-route="new"
        className="relative isolate flex min-h-full flex-col items-center justify-center overflow-x-clip px-6"
      >
        <HeroGlow />
        <div data-slot="auto-starting" role="status" className="flex flex-col items-center text-center">
          <Spinner className="mb-4 size-5 text-muted-foreground" />
          <h1 className="text-[22px] font-semibold tracking-tight">Starting task…</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Launched from a bookmarklet — taking you to the run.
          </p>
        </div>
      </div>
    )
  }

  const worktreeDisabledReason = dispatchOn
    ? "Dispatch forks this task's commits — subtasks need a worktree."
    : 'Parallel variants always use isolated worktrees.'
  // The two choices that change what a run COSTS or how many runs appear — worth a mark on the
  // closed Options button, where the everyday switches are not.
  const optionsMarked = variants > 1 || dispatchOn

  return (
    <div
      data-route="new"
      className="relative isolate flex min-h-full flex-col items-center overflow-x-clip px-4 pt-[clamp(28px,13vh,150px)] pb-16 max-md:pt-8 sm:px-6"
    >
      <HeroGlow />

      <div className="w-full max-w-[800px]">
        <header className="mb-7 text-center max-md:mb-5">
          <h1 className="text-[28px] leading-9 font-semibold tracking-tight text-balance max-md:text-[22px] max-md:leading-7">
            What should the agent work on?
          </h1>
          {/* Follows the resolved run mode (#793). Printing the isolation promise
              unconditionally made this line false for every run the user opted out of — and
              for a non-git folder, where there is no worktree to opt into. */}
          <p data-slot="run-mode-note" className="mx-auto mt-2 max-w-xl text-sm text-pretty text-muted-foreground max-md:text-[13px]">
            {composerRunModeNote({
              worktree: worktreeOn,
              hasGit,
              dispatch: dispatchOn,
              autonomous: autonomousOn,
            })}
          </p>
        </header>

        <Composer
          ref={composerRef}
          size="hero"
          onSubmit={submit}
          value={draft.text}
          onValueChange={(text) => update({ text })}
          images={images}
          onImagesChange={setImages}
          autoFocus
          placeholder="Describe the task — type / to use a skill…"
          ariaLabel="Describe a task for the agent"
          sendAriaLabel="Start task"
          sendLabel="Start task"
          disabled={!providersReady}
          disabledReason={
            providers.isPending
              ? 'Checking agent providers…'
              : providers.isError
                ? 'Provider authentication could not be verified.'
                : 'Connect an agent provider before starting a task.'
          }
          autocompleteSkills
          footerStart={
            <>
              {/* Beside the paperclip: both ADD something to the prompt. */}
              <PromptTemplateMenu
                templates={templates}
                iconOnly
                onInsert={(text) => composerRef.current?.insertAtCaret(text)}
              />
              {/* The three choices people change most, left to right: "in this project, run
                  this skill, with this agent and model". The project control renders only once
                  the workspace holds more than one project — with a single one it offers
                  nothing, the same rule the sidebar's project groups follow. */}
              {projectList.length > 1 && urlProjectId !== undefined ? (
                <ProjectPill
                  projects={projectList}
                  projectId={urlProjectId}
                  // An explicit `/p/<id>` target: the scoped navigate wrapper passes already
                  // scoped paths through untouched, so this is a genuine cross-project jump.
                  onPick={(next) => {
                    // What is in the box comes along (#1018). Before the navigate, because the
                    // route remounts on the way in and reads the arriving project's draft the
                    // moment it does. `handOffComposition` decides whether the move happens —
                    // it refuses to overwrite an unsent draft already waiting over there.
                    const result = handOffComposition(draftProjectId, scopeKeyOf(next))
                    if (!result.moved && result.reason === 'destination-busy') {
                      // `draftProjectId` is the API scope key, so null means the boot project.
                      // Resolve both ends through the registry: the user needs to know where
                      // their composition remains as well as which destination was occupied.
                      const departingName =
                        projectList.find(
                          (project) => project.id === (draftProjectId ?? projects.data?.bootProject),
                        )?.name ?? urlProjectId
                      const destinationName = projectList.find((project) => project.id === next)?.name ?? next
                      toast(
                        `Kept your draft in ${departingName}; ${destinationName} already has an unsent draft.`,
                        { tone: 'danger' },
                      )
                    }
                    navigate(`/p/${encodeURIComponent(next)}/new`, { replace: true })
                  }}
                />
              ) : null}
              {/* Two pickers, not one list: how the work is staged, and what playbook the agent
                  follows. A task still runs one or the other, and each pill says what it replaces. */}
              <SourcePill
                only="workflow"
                source={source}
                ready={sourcesReady}
                skills={skillList}
                skillUsage={skillUsage}
                workflows={workflowList}
                onPick={(next) => update({ source: next })}
              />
              <SourcePill
                only="skill"
                source={source}
                ready={sourcesReady}
                skills={skillList}
                skillUsage={skillUsage}
                workflows={workflowList}
                onPick={(next) => update({ source: next })}
              />
              {/* Shown when there is a choice to make: more than one runner, or more than one
                  login for one of them. A host with neither sees no control, exactly as before. */}
              {runners.length > 1 || runners.some((id) => hasAccountChoice(accountChoices, id)) ? (
                <RunnerPill
                  runners={runners}
                  value={displayRunner}
                  accounts={accountChoices}
                  account={agentProfile}
                  repoAccount={repoAccount}
                  icon={<BotIcon aria-hidden="true" className="size-3.5 shrink-0 text-soft-foreground" />}
                  className="text-foreground"
                  // Changing the AGENT clears the model pin: presets are per-runner, so a kept
                  // model would be one the new runner does not have. Changing only the account
                  // keeps it — the model catalog is the same either way.
                  onPick={(next, picked) =>
                    update({
                      runner: next,
                      agentProfile: picked,
                      ...(next === displayRunner ? {} : { model: null }),
                    })
                  }
                  disabled={!providersReady}
                />
              ) : null}
              <PickerPill
                slot="model-pill"
                ariaLabel="Model"
                hint="Which model the agent runs on"
                icon={<CpuIcon aria-hidden="true" className="size-3.5 shrink-0 text-soft-foreground" />}
                className="text-foreground"
                label={
                  <>
                    <span className="font-normal text-muted-foreground">Model </span>
                    {models.find((m) => m.id === model)?.label ?? 'auto'}
                  </>
                }
                value={model}
                disabled={!providersReady}
                readOnly={modelsLocked}
                disabledHint={
                  modelsLocked
                    ? 'Model selection is locked to native coding-agent settings.'
                    : undefined
                }
                onPick={(next) => update({ model: next })}
                options={models.map((m) => ({ value: m.id, label: m.label, desc: m.desc }))}
                status={modelCatalogStatus(displayRunner, catalog.data, catalog.isError)}
              />
              {/* Everything else about HOW the run happens, one click away and each with a line
                  that says what it does. */}
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    data-slot="run-options-trigger"
                    aria-label="Run options"
                    title="Variants, worktree, autonomy, dispatch and base branch"
                    className={cn(chipClass, 'border-transparent bg-transparent')}
                  >
                    <SlidersHorizontalIcon aria-hidden="true" className="size-3.5 shrink-0" />
                    Options
                    {optionsMarked ? (
                      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-primary" />
                    ) : null}
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  align="start"
                  sideOffset={8}
                  data-slot="run-options"
                  className="max-h-(--radix-popover-content-available-height) w-[400px] max-w-[calc(100vw-2rem)] overflow-y-auto p-0"
                >
                  <h2 className="px-4 pt-3.5 pb-0.5 text-[15px] font-semibold text-foreground">Run options</h2>
                  <div className="divide-y divide-border px-4 pb-1.5">
                    <OptionRow
                      slot="variants-option"
                      icon={CopyIcon}
                      title="Parallel variants"
                      description={
                        hasGit
                          ? 'Run it several times in parallel and keep the diff you like.'
                          : 'Needs a git repository — each variant runs in its own worktree.'
                      }
                    >
                      <ToggleGroup
                        type="single"
                        variant="outline"
                        size="sm"
                        aria-label="Parallel variants"
                        data-slot="variants-pill"
                        disabled={!hasGit}
                        value={String(variants)}
                        // Radix sends '' when the pressed item is pressed again; a count cannot be empty.
                        onValueChange={(next) => (next === '' ? undefined : update({ variants: Number(next) }))}
                      >
                        {['1', '2', '3'].map((count) => (
                          <ToggleGroupItem
                            key={count}
                            value={count}
                            aria-label={count === '1' ? 'One run' : `${count} competing runs`}
                            className="w-9 tabular-nums data-[state=on]:bg-primary/15 data-[state=on]:text-foreground"
                          >
                            ×{count}
                          </ToggleGroupItem>
                        ))}
                      </ToggleGroup>
                    </OptionRow>
                    {worktreeToggleShown ? (
                      <OptionRow
                        icon={GitForkIcon}
                        title="Isolated worktree"
                        description={
                          worktreeForced
                            ? worktreeDisabledReason
                            : worktreeOn
                              ? 'Works on its own branch, in its own folder.'
                              : 'Off — runs directly in your checkout.'
                        }
                      >
                        <Switch
                          aria-label="Worktree"
                          data-slot="worktree-toggle"
                          checked={worktreeOn}
                          disabled={worktreeForced}
                          onCheckedChange={(on) => update({ worktree: on })}
                        />
                      </OptionRow>
                    ) : null}
                    <OptionRow
                      icon={ZapIcon}
                      title="Autonomous"
                      description={
                        autonomousOn
                          ? 'Runs to completion without pausing for you.'
                          : 'Off — the agent can stop and ask you.'
                      }
                    >
                      <Switch
                        aria-label="Autonomous"
                        data-slot="autonomous-toggle"
                        checked={autonomousOn}
                        onCheckedChange={(on) => update({ autonomous: on })}
                      />
                    </OptionRow>
                    {followupsToggleShown ? (
                      <OptionRow
                        icon={ListPlusIcon}
                        title="Follow-ups"
                        description={
                          generateFollowupsOn
                            ? 'Agents can add newly discovered work to the task inbox.'
                            : 'Off — agents still keep the handoff journal.'
                        }
                      >
                        <Switch
                          aria-label="Follow-ups"
                          data-slot="generate-followups-toggle"
                          checked={generateFollowupsOn}
                          onCheckedChange={(on) => update({ generateFollowups: on })}
                        />
                      </OptionRow>
                    ) : null}
                    {dispatchAvailable ? (
                      <OptionRow
                        icon={SplitIcon}
                        title="Dispatch"
                        description="Let the task split itself into subtasks."
                      >
                        <DispatchToggle
                          available={dispatchAvailable}
                          value={dispatch}
                          onChange={changeDispatch}
                          onSettingsOpenChange={setDispatchSettingsOpen}
                          runners={runners}
                          parentRunner={displayRunner}
                          // The composer's own catalog, already fetched for the runner this task runs
                          // as — the list "same as parent" resolves to. A subtask runner the user
                          // changes to discovers its own inside the toggle.
                          parentModels={models}
                        />
                      </OptionRow>
                    ) : null}
                    {repo.data?.info ? (
                      <OptionRow
                        icon={GitBranchIcon}
                        title="Base branch"
                        description="Tasks fork from it; pull requests target it."
                      >
                        <BaseBranchPill repo={repo.data} />
                      </OptionRow>
                    ) : null}
                  </div>
                </PopoverContent>
              </Popover>
            </>
          }
          footerEnd={
            <>
              {!providersReady && !providers.isPending ? (
                <Link
                  to="/settings/agents#providers"
                  className="text-[13px] font-medium text-foreground underline underline-offset-4"
                >
                  Configure providers
                </Link>
              ) : null}
            </>
          }
        />

        <p aria-hidden="true" data-slot="composer-tips" className="mt-2.5 flex flex-wrap items-center justify-center gap-x-1.5 gap-y-1 text-xs text-soft-foreground max-md:hidden">
          <Kbd>{submitShortcutHint()}</Kbd> to start
          <span className="mx-1">·</span>
          <Kbd>/</Kbd> for skills
          <span className="mx-1">·</span>
          paste or drop files to attach
        </p>

        {selectedSkill?.interactive && (draft.autonomous === null || draft.worktree === null) ? (
          <p className="mt-2.5 px-1 text-[13px] text-muted-foreground" data-slot="interactive-skill-hint">
            This skill recommends an interactive run in the current checkout. You can change either in Options.
          </p>
        ) : null}

        {dispatchOn && (dispatchSettingsOpen || dispatchHintFlash) ? (
          <p
            data-slot="dispatch-hint"
            className="mt-2.5 rounded-lg bg-primary/15 px-3 py-2 text-[13px] text-muted-foreground"
          >
            <strong className="font-semibold text-foreground">Dispatch is on.</strong> Splits this
            task into subtasks it runs as separate tasks. Worktree stays on. Set limits under
            Options.
          </p>
        ) : null}

        <Suggestions onPick={(text) => update({ text })} />
      </div>
    </div>
  )
}

/** The hero's only decoration: a soft lime wash from the top edge, fading out well above the
 *  composer's footer so it never competes with it. */
function HeroGlow() {
  return (
    <div
      aria-hidden="true"
      data-slot="hero-glow"
      className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[460px] bg-radial-[ellipse_60%_100%_at_50%_0%] from-primary/20 to-transparent dark:from-primary/10"
    />
  )
}

/** One line of the Options popover: what it is, what it does, and its control. */
function OptionRow({
  icon: Icon,
  title,
  description,
  slot,
  children,
}: {
  icon: LucideIcon
  title: string
  description: string
  slot?: string
  children: ReactNode
}) {
  return (
    <div data-slot={slot ?? 'run-option'} className="flex items-start gap-3 py-2.5">
      <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] font-medium text-foreground">{title}</div>
        <p className="mt-0.5 text-xs leading-relaxed text-pretty text-muted-foreground">{description}</p>
      </div>
      <div className="flex shrink-0 items-center pt-0.5">{children}</div>
    </div>
  )
}

/**
 * Rank the registry against the pill's search box.
 *
 * Ranked in JS with cmdk's own filtering off (#484 — cmdk's score-sort does not re-order these
 * pickers reliably). Registry order is `lastOpenedAt`, so an empty search shows the same
 * recency the sidebar does; a typed query floats name/id PREFIX matches above mid-string ones,
 * each group still in recency order.
 */
function matchProjects(
  projects: readonly ProjectListEntry[],
  search: string,
): ProjectListEntry[] {
  const query = search.trim().toLowerCase()
  if (query === '') return [...projects]
  const rank = (project: ProjectListEntry): number => {
    const name = project.name.toLowerCase()
    const id = project.id.toLowerCase()
    if (name.startsWith(query) || id.startsWith(query)) return 0
    if (name.includes(query) || id.includes(query)) return 1
    return 2
  }
  return projects
    .map((project, index) => ({ project, rank: rank(project), index }))
    .filter((entry) => entry.rank < 2)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.project)
}

/**
 * The project pill (multi-project spec §"New task"; mockup new-task-project.html) — the
 * composer's scope selector, preselected from the URL.
 *
 * Picking a project NAVIGATES to that project's composer rather than swapping local state:
 * `/p/<id>/new` is the single place the scope is decided (the step-3.2 route gate), and every
 * part of this screen that must re-resolve already keys off it — the skill/workflow picker and
 * `/`-autocomplete (`/api/p/<id>/skills`), the runner and model probes, the base-branch pill,
 * the per-project draft, and the `POST /api/p/<id>/runs` submit target. Doing it any other way
 * would mean a second, parallel notion of "the active project" living in this component.
 *
 * `replace`: a scope swap corrects where you are, it is not a place to go Back to — Back stays
 * whatever brought you to the composer.
 */
function ProjectPill({
  projects,
  projectId,
  onPick,
}: {
  projects: readonly ProjectListEntry[]
  projectId: string
  onPick: (projectId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const selected = projects.find((project) => project.id === projectId)
  const matched = matchProjects(projects, search)

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setSearch('')
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          data-slot="project-pill"
          aria-label="Project"
          title="Which project this task runs in — its skills, workflows, settings and draft"
          className={cn(chipClass, 'text-foreground')}
        >
          <FolderIcon aria-hidden="true" className="size-3.5 shrink-0 text-soft-foreground" />
          {/* The registry is authoritative for the display name; the raw id is the fallback
              while it is still loading, so the pill never renders an empty label. */}
          <span className="max-w-40 truncate">{selected?.name ?? projectId}</span>
          {chevron}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={8}
        className="w-[300px] max-w-[calc(100vw-2rem)] p-0"
      >
        <Command shouldFilter={false}>
          <CommandInput placeholder="search projects…" value={search} onValueChange={setSearch} />
          {/* Same 3rem headroom rule as the source picker: the list must not eat the search box. */}
          <CommandList
            data-slot="project-menu"
            className="max-h-[min(18rem,calc(var(--radix-popover-content-available-height)-3rem))]"
          >
            {matched.length === 0 ? <CommandEmpty>Nothing matches.</CommandEmpty> : null}
            {matched.map((project) => (
              <CommandItem
                key={project.id}
                value={project.id}
                keywords={[project.name]}
                data-slot="project-option"
                data-project-id={project.id}
                // A `missing` folder has nothing to run a task in. The entry stays listed (the
                // sidebar owns removing it) but cannot be picked — better than navigating into
                // a project whose every request 4xxs.
                disabled={project.status === 'missing'}
                onSelect={() => {
                  onPick(project.id)
                  setOpen(false)
                }}
              >
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{project.name}</span>
                {project.status === 'missing' ? (
                  <span className="shrink-0 text-xs text-soft-foreground">folder not found</span>
                ) : project.branch !== undefined ? (
                  <span className="shrink-0 font-mono text-[11px] text-soft-foreground">
                    {project.branch}
                  </span>
                ) : null}
                {project.id === projectId ? (
                  <CheckIcon aria-hidden="true" className="size-3.5 shrink-0 text-primary-strong" />
                ) : null}
              </CommandItem>
            ))}
          </CommandList>
          {/* The mockup's `dd-note`. Worth the two lines: picking here does far more than
              relabel a pill, and nothing else on screen says so. */}
          <p className="border-t border-border px-3 py-2 text-xs leading-snug text-muted-foreground">
            Skills, workflows, settings and the draft re-resolve against the selected project.
          </p>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/** Base-branch picker: worktrees fork from it and PRs target it. It is repo-level CONFIG
 *  (`PUT /api/config`, exactly the legacy Repo tab's picker), not a per-run flag — so it
 *  mutates the server and refetches, rather than living in the draft. Hidden without git. */
function BaseBranchPill({ repo }: { repo: RepoResponse }) {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: (baseBranch: string | null) => putConfig({ baseBranch }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.repo })
      toast(
        result.baseBranch
          ? `New tasks will branch off "${result.baseBranch}" (PRs target it too).`
          : 'Base branch cleared — new tasks fork from the checked-out branch.',
      )
    },
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  if (!repo.info) return null
  const current = repo.baseBranch ?? repo.info.branch
  return (
    <PickerPill
      slot="base-pill"
      ariaLabel="Base branch"
      className="max-w-36"
      label={<span className="font-mono text-xs">{current}</span>}
      value={repo.baseBranch ?? ''}
      onPick={(value) => mutation.mutate(value === '' ? null : value)}
      searchPlaceholder="Search branches…"
      options={[
        { value: '', label: `follow checked-out branch (${repo.info.branch})`, desc: 'New task worktrees fork from whatever branch is checked out' },
        ...repo.branches.map((branch) => ({ value: branch, label: branch })),
      ]}
    />
  )
}

/** Honest static starters: they only fill the textarea — the user still aims and submits. */
const SUGGESTIONS: ReadonlyArray<{ text: string; hint: string; icon: LucideIcon }> = [
  { text: 'Fix a failing or flaky test', hint: 'Find it, reproduce it, make it green', icon: BugIcon },
  {
    text: 'Summarize recent commits on this branch',
    hint: 'A short read of what changed and why',
    icon: GitCommitHorizontalIcon,
  },
  { text: 'Update the README for recent changes', hint: 'Bring the docs back in line with the code', icon: FileTextIcon },
]

function Suggestions({ onPick }: { onPick: (text: string) => void }) {
  return (
    <section aria-label="Suggestions" className="mt-10 max-md:mt-7">
      <h2 className="mb-2 px-1 text-[13px] font-medium text-muted-foreground">Or start from an idea</h2>
      <ItemGroup className="gap-2 sm:grid sm:grid-cols-3">
        {SUGGESTIONS.map(({ text, hint, icon: Icon }) => (
          <Item key={text} asChild variant="outline" size="sm" className="items-start gap-2.5 rounded-xl bg-card/60 px-3.5 text-left hover:bg-muted/60">
            <Button
              type="button"
              variant="ghost"
              data-slot="suggested-chip"
              onClick={() => onPick(text)}
              className="h-auto justify-start font-normal whitespace-normal text-foreground"
            >
              <ItemMedia>
                <Icon aria-hidden="true" className="size-4 text-muted-foreground" />
              </ItemMedia>
              <ItemContent className="gap-0.5">
                <ItemTitle className="text-[13.5px] leading-snug text-pretty">{text}</ItemTitle>
                <ItemDescription className="text-xs text-pretty">{hint}</ItemDescription>
              </ItemContent>
            </Button>
          </Item>
        ))}
      </ItemGroup>
    </section>
  )
}

import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  CheckIcon,
  ChevronDownIcon,
  CircleSlashIcon,
  EyeIcon,
  FolderOpenIcon,
  PlusIcon,
  SparklesIcon,
  SquareIcon,
  WorkflowIcon,
  XIcon,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useParams, useSearchParams } from 'react-router'

import { Link, useNavigate } from '@/lib/project-router'

import { createRun, getLaunchKey, postPlan, putConfig, putUiState } from '@/api/client'
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
  ImageInput,
  ProjectListEntry,
  RepoResponse,
  Runner,
  Skill,
  WorkflowDef,
} from '@open-mercato/cezar-api-client'
import { TwinkleBackdrop } from '@/components/centered-state'
import { Composer, type ComposerHandle } from '@/components/composer/composer'
import { GhostCodeBackdrop } from '@/components/ghost-code-backdrop'
import { PickerPill, RunnerPill, chevron, chipClass } from '@/components/picker-pill'
import { PromptTemplateMenu } from '@/components/prompt-template-menu'
import { SkillPreviewDialog } from '@/components/skill-detail'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { toast } from '@/components/ui/toaster'
import {
  autoApplyText,
  normalizePromptTemplates,
  resolveAutoApply,
} from '@/lib/prompt-templates'
import {
  bumpSkillUsage,
  isProjectSkill,
  orderSkillsByUsage,
  partitionSkillsForDisplay,
  queryScore,
  searchSkills,
  searchWorkflows,
  skillKeywords,
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
  readDraft,
  resolveComposerRunMode,
  writeDraft,
  type NewTaskDraft,
} from './new-task-draft'
import {
  buildCreateRunBody,
  modelsForRunner,
  modelCatalogStatus,
  pushRecentSource,
  QUICK_TASK,
  resolveModel,
  resolveRunner,
  resolveSource,
  startedRunPath,
  type TaskSource,
} from './new-task-form'
import { parseNewTaskParams } from './new-task-params'
import { buildPlannedRunBody, pendingPlanOf, type PendingPlan } from './new-task-plan'
import { PlanReview } from './plan-review'

/**
 * `/new` — the full-screen new-task hero (spec §"New task (full-screen, #386)"; visual
 * contract docs/mockups/new-task.html): centered composer card on the twinkle surface, the
 * picker pill row inside the card below the textarea, suggested-task ghost chips underneath.
 * In plan-first mode (#383, the `Start | Plan first` segment) submit runs `POST /api/plan`
 * and opens the review overlay (plan-review.tsx) instead of starting a run.
 *
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
    () => normalizePromptTemplates(uiState.data?.promptTemplates),
    [uiState.data?.promptTemplates],
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
  const worktreeForced = variants > 1

  // Autonomous (#autonomous): the run never pauses for the user. An explicit toggle this session
  // wins; then an interactive skill recommends handing the ball back; otherwise the configured
  // workspace default applies ('source-dependent' → skills default ON, everything else OFF).
  // Plan-first forces it OFF (and disables the toggle): planning is inherently interactive, so
  // the run must be able to hand the ball back.
  const runMode = resolveComposerRunMode({
    hasGit,
    variants,
    planFirst: draft.planFirst,
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

  // ---- plan mode (#383 + spec 008) ----------------------------------------------------------
  const [plan, setPlan] = useState<PendingPlan | null>(null)
  const [planning, setPlanning] = useState(false)
  const [starting, setStarting] = useState(false)

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
        '[data-slot="composer"] button[aria-label="Start task"], [data-slot="composer"] button[aria-label="Plan task"]',
      )
      ?.focus()
  }, [notice, sourcesReady]) // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (text: string, images: ImageInput[]) => {
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
    if (draft.planFirst) {
      // Plan mode: submit means PLAN. A rejection propagates — the composer toasts and
      // restores the draft; a success restores the text ourselves (the composer already
      // cleared optimistically) so Discard hands back exactly what was typed. The review
      // overlay is deliberate: it's where steps are edited and saved as a reusable chain.
      setPlanning(true)
      try {
        setPlan(pendingPlanOf(text, images, await postPlan(text)))
        update({ text })
      } finally {
        setPlanning(false)
      }
      return
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
        images,
        worktree: worktreeOn,
        autonomous: autonomousOn,
        generateFollowups: generateFollowupsOn,
        // #374: when the Inbox's "Run" sent us here, hand the entry's id back so the server
        // records this run on it and it leaves the inbox — the audit trail the old
        // POST /api/todos/:id/start kept, minus the blind launch. Empty otherwise.
        // Deliberately not gated on generateFollowupsOn (#444): turning off follow-up
        // generation for THIS task must not stop the entry it came from being marked started.
        todoId: deepLink.todo,
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

  /** ▶ Start on the reviewed plan: the (possibly edited) steps go INLINE, with the composer's
   *  current picker choices — legacy `startPlannedRun` semantics on the new surface. */
  const startPlanned = async () => {
    if (plan === null || plan.steps.length === 0 || starting || !providersReady || runner === null) return
    setStarting(true)
    try {
      const created = await createRun(
        buildPlannedRunBody({
          task: plan.task,
          steps: plan.steps,
          model,
          modelsLocked,
          runner,
          runnerExplicit: draft.runner !== null,
          defaultRunner,
          variants,
          images: plan.images,
          generateFollowups: generateFollowupsOn,
          todoId: deepLink.todo, // #374: planning first must not lose the inbox entry
        }),
      )
      // Run-mode choices live in the current draft; stable defaults come from workspace policy.
      // persisting the forced `false` would overwrite their real preference, so turning
      // CEZ_FOLLOWUPS back on later would silently come up off.
      if (followupsToggleShown) {
        void putUiState({ lastGenerateFollowups: generateFollowupsOn })
          .then(() => queryClient.invalidateQueries({ queryKey: queryKeys.uiState }))
          .catch(() => {})
      }
      clearStartedDraft(draftProjectId)
      setPlan(null)
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs.all })
      navigate(startedRunPath(created))
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), { tone: 'danger' })
    } finally {
      setStarting(false)
    }
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
        <TwinkleBackdrop />
        <div data-slot="auto-starting" role="status" className="text-center">
          <h1 className="animate-pulse text-lg font-semibold tracking-tight">Starting task…</h1>
          <p className="mt-1.5 text-[13.5px] text-muted-foreground">
            Launched from a bookmarklet — taking you to the run.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div
      data-route="new"
      className="relative isolate flex min-h-full flex-col items-center overflow-x-clip px-6 pt-[clamp(32px,7vh,84px)] pb-16 max-md:px-3.5 max-md:pt-7"
    >
      <TwinkleBackdrop />
      <GhostCodeBackdrop />

      <div className="w-full max-w-[720px]">
        <header className="mb-6 text-center max-md:mb-4">
          <h1 className="text-lg font-semibold tracking-tight max-md:text-base">
            What should the agent work on?
          </h1>
          {/* Follows the resolved run mode (#793). Printing the isolation promise
              unconditionally made this line false for every run the user opted out of — and
              for a non-git folder, where there is no worktree to opt into. */}
          <p data-slot="run-mode-note" className="mt-1.5 text-[13.5px] text-muted-foreground max-md:text-xs">
            {composerRunModeNote({ worktree: worktreeOn, hasGit })}
          </p>
        </header>

        <Composer
          ref={composerRef}
          onSubmit={submit}
          value={draft.text}
          onValueChange={(text) => update({ text })}
          autoFocus
          placeholder="Describe a task for the agent — / for skills…"
          ariaLabel="Describe a task for the agent"
          sendAriaLabel={draft.planFirst ? 'Plan task' : 'Start task'}
          disabled={!providersReady || starting}
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
              {/* The project pill LEADS the row (mockup new-task-project.html): everything to
                  its right is resolved against it, so it reads left-to-right as "in this
                  project, run this skill, with this model". Rendered only once the workspace
                  actually holds more than one project — with a single one the control offers
                  nothing and the composer keeps the shape it has always had, the same rule the
                  sidebar's project groups follow. */}
              {projectList.length > 1 && urlProjectId !== undefined ? (
                <ProjectPill
                  projects={projectList}
                  projectId={urlProjectId}
                  // An explicit `/p/<id>` target: the scoped navigate wrapper passes already
                  // scoped paths through untouched, so this is a genuine cross-project jump.
                  onPick={(next) => navigate(`/p/${encodeURIComponent(next)}/new`, { replace: true })}
                />
              ) : null}
              <SourcePill
                source={source}
                ready={sourcesReady}
                skills={skillList}
                skillUsage={skillUsage}
                workflows={workflowList}
                onPick={(next) => update({ source: next })}
              />
              {/* Icon-only: this row already carries source/runner/model/variants/worktree/
                  autonomous/branch, and templates is the least-used of them. */}
              <PromptTemplateMenu
                templates={templates}
                iconOnly
                onInsert={(text) => composerRef.current?.insertAtCaret(text)}
              />
              {/* Shown when there is a choice to make: more than one runner, or more than one
                  login for one of them. A host with neither sees no pill, exactly as before. */}
              {runners.length > 1 || runners.some((id) => hasAccountChoice(accountChoices, id)) ? (
                <RunnerPill
                  runners={runners}
                  value={displayRunner}
                  accounts={accountChoices}
                  account={agentProfile}
                  repoAccount={repoAccount}
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
                label={models.find((m) => m.id === model)?.label ?? 'auto'}
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
              <PickerPill
                slot="variants-pill"
                ariaLabel="Parallel variants"
                label={variants > 1 ? `×${variants} variants` : '×1'}
                value={String(variants)}
                onPick={(next) => update({ variants: Number(next) })}
                disabled={!hasGit}
                hint="How many times to run this task in parallel — each variant gets its own worktree, and you pick the diff you keep. ×1 runs it once."
                disabledHint="Parallel variants need a git repository — each variant runs in its own worktree."
                options={[
                  { value: '1', label: '×1', desc: 'One run' },
                  { value: '2', label: '×2 variants', desc: 'Two competing runs — pick the diff you keep' },
                  { value: '3', label: '×3 variants', desc: 'Three competing runs — pick the diff you keep' },
                ]}
              />
              {worktreeToggleShown ? (
                <WorktreeToggle
                  on={worktreeOn}
                  disabled={worktreeForced}
                  disabledReason="Parallel variants always use isolated worktrees"
                  onChange={(on) => update({ worktree: on })}
                />
              ) : null}
              <AutonomousToggle
                on={autonomousOn}
                disabled={draft.planFirst}
                onChange={(on) => update({ autonomous: on })}
              />
              {selectedSkill?.interactive && (draft.autonomous === null || draft.worktree === null) ? (
                <p className="basis-full text-xs text-muted-foreground" data-slot="interactive-skill-hint">
                  This skill recommends an interactive run in the current checkout. You can change either setting.
                </p>
              ) : null}
              {followupsToggleShown ? (
                <GenerateFollowupsToggle
                  on={generateFollowupsOn}
                  onChange={(on) => update({ generateFollowups: on })}
                />
              ) : null}
              {repo.data ? <BaseBranchPill repo={repo.data} /> : null}
            </>
          }
          footerEnd={
            <>
              {!providersReady && !providers.isPending ? (
                <Link
                  to="/settings/agents#providers"
                  className="text-xs font-medium text-foreground underline underline-offset-4"
                >
                  Configure providers
                </Link>
              ) : null}
              <ModeSegment
                planFirst={draft.planFirst}
                planning={planning}
                onModeChange={(planFirst) => update({ planFirst })}
              />
              <kbd
                aria-hidden="true"
                className="rounded-[5px] border border-b-2 border-border bg-card px-[5px] py-px font-mono text-[10.5px] font-medium text-muted-foreground"
              >
                {submitShortcutHint()}
              </kbd>
            </>
          }
        />

        <SuggestedChips onPick={(text) => update({ text })} />
      </div>

      {plan !== null ? (
        <PlanReview
          plan={plan}
          starting={starting}
          startAvailable={providersReady}
          startUnavailableReason={
            providers.isPending
              ? 'Checking agent providers…'
              : providers.isError
                ? 'Provider authentication could not be verified.'
                : 'Connect an agent provider before starting a task.'
          }
          startUnavailableAction={
            !providers.isPending ? (
              <Link to="/settings/agents#providers">Configure providers</Link>
            ) : undefined
          }
          onStepsChange={(steps) => setPlan((current) => (current ? { ...current, steps } : current))}
          onStart={() => void startPlanned()}
          onDiscard={() => setPlan(null)}
        />
      ) : null}
    </div>
  )
}

/** Worktree opt-out toggle (#worktree-toggle): a checkbox-style chip for ordinary runs.
 *  Checked = isolated worktree (the default); unchecked = run in the repo working tree. */
function WorktreeToggle({
  on,
  disabled,
  disabledReason,
  onChange,
}: {
  on: boolean
  disabled?: boolean
  disabledReason?: string
  onChange: (on: boolean) => void
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      disabled={disabled}
      data-slot="worktree-toggle"
      onClick={() => onChange(!on)}
      title={
        disabled
          ? disabledReason
          : on
          ? 'Runs in an isolated worktree — uncheck to run in the repo working tree'
          : 'Runs in the repo working tree — check to isolate in a worktree'
      }
      className={cn(chipClass, on && 'border-primary/60 text-foreground')}
    >
      {on ? (
        <CheckIcon aria-hidden="true" className="size-3 shrink-0 text-primary" />
      ) : (
        <SquareIcon aria-hidden="true" className="size-3 shrink-0 text-soft-foreground" />
      )}
      Worktree
    </button>
  )
}

/** Autonomous toggle (#autonomous): checked = the run never pauses for you, auto-continuing
 *  until the agent is done. No "needs you" is ever raised. */
function AutonomousToggle({
  on,
  disabled,
  onChange,
}: {
  on: boolean
  disabled?: boolean
  onChange: (on: boolean) => void
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      disabled={disabled}
      data-slot="autonomous-toggle"
      onClick={() => onChange(!on)}
      title={
        disabled
          ? 'Plan-first runs are interactive — autonomous is unavailable'
          : on
            ? 'Autonomous — the agent runs to completion without pausing for you'
            : 'Runs interactively — check to let the agent finish without pausing for you'
      }
      className={cn(chipClass, on && !disabled && 'border-primary/60 text-foreground')}
    >
      {on ? (
        <CheckIcon aria-hidden="true" className="size-3 shrink-0 text-primary" />
      ) : (
        <SquareIcon aria-hidden="true" className="size-3 shrink-0 text-soft-foreground" />
      )}
      Autonomous
    </button>
  )
}

/** Follow-up toggle: checked lets agents append newly discovered work to the task inbox.
 *  Handoff journaling remains active either way. */
function GenerateFollowupsToggle({
  on,
  onChange,
}: {
  on: boolean
  onChange: (on: boolean) => void
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      data-slot="generate-followups-toggle"
      onClick={() => onChange(!on)}
      title={
        on
          ? 'Agents can add newly discovered follow-up work to the task inbox'
          : 'Follow-up generation is off; agents still maintain the handoff journal'
      }
      className={cn(chipClass, on && 'border-primary/60 text-foreground')}
    >
      {on ? (
        <CheckIcon aria-hidden="true" className="size-3 shrink-0 text-primary" />
      ) : (
        <SquareIcon aria-hidden="true" className="size-3 shrink-0 text-soft-foreground" />
      )}
      Follow-ups
    </button>
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
        <button
          type="button"
          data-slot="project-pill"
          aria-label="Project"
          title="Which project this task runs in — its skills, workflows, settings and draft"
          className={cn(chipClass, 'border-foreground/60 font-semibold text-foreground')}
        >
          <FolderOpenIcon aria-hidden="true" className="size-3 shrink-0 text-soft-foreground" />
          {/* The registry is authoritative for the display name; the raw id is the fallback
              while it is still loading, so the pill never renders an empty label. */}
          <span className="max-w-40 truncate">{selected?.name ?? projectId}</span>
          {chevron}
        </button>
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
                <span className="min-w-0 flex-1 truncate text-xs font-medium">{project.name}</span>
                {project.status === 'missing' ? (
                  <span className="shrink-0 text-[11px] text-soft-foreground">folder not found</span>
                ) : project.branch !== undefined ? (
                  <span className="shrink-0 font-mono text-[11px] text-soft-foreground">
                    {project.branch}
                  </span>
                ) : null}
                {project.id === projectId ? (
                  <CheckIcon aria-hidden="true" className="size-3.5 shrink-0 text-primary" />
                ) : null}
              </CommandItem>
            ))}
          </CommandList>
          {/* The mockup's `dd-note`. Worth the two lines: picking here does far more than
              relabel a pill, and nothing else on screen says so. */}
          <p className="border-t border-border px-3 py-2 text-[11px] leading-snug text-soft-foreground">
            Skills, workflows, settings and the draft re-resolve against the selected project.
          </p>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/**
 * The workflow/skill picker (#385's searchable cmdk dropdown, #519's tier ordering): ONE pill
 * for both kinds of source — and one that can be EMPTY.
 *
 * `null` — no skill, no workflow — is a first-class state rather than a hidden default. It is
 * what a fresh `/new` opens on, and there are three ways back to it: the ✕ on the pill (one
 * click, no menu), picking the selected row again (the toggle the GitHub hand-off's workflow
 * row already had — this picker was the one that swallowed the second click), and the "No
 * skill" row at the head of the list. Before that the only exit was picking the `quick-task`
 * WORKFLOW, which reads as a third mode to learn rather than as "none of the above" — the
 * report this fixes was a user hunting for it.
 *
 * `quick-task` is therefore not a row of its own: it IS the run an empty picker performs, and
 * one run behind two names is what made the exit invisible. The "No skill" row carries the
 * catalog's own description for it, so a workspace whose file shadows the built-in still
 * describes what it will actually run.
 *
 * Groups render No skill, Most used (skills picked before, frequency descending), Project
 * skills (bold), Workflows, then Global.
 */
function SourcePill({
  source,
  ready,
  skills,
  skillUsage,
  workflows,
  onPick,
}: {
  source: TaskSource | null
  ready: boolean
  skills: readonly Skill[]
  skillUsage: Readonly<Record<string, number>> | undefined
  workflows: readonly WorkflowDef[]
  onPick: (source: TaskSource | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [preview, setPreview] = useState<Skill | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // #484: rank in JS (cmdk's own score-sort does not re-order reliably here), then split the
  // ranked matches into the #519 display tiers so each group stays match-ordered.
  const matched = searchSkills(skills, search, skillUsage)
  const { mostUsed, project, global } = partitionSkillsForDisplay(matched, skillUsage)
  const quickTask = workflows.find((workflow) => workflow.name === QUICK_TASK)
  const matchedWorkflows = searchWorkflows(workflows, search).filter((w) => w.name !== QUICK_TASK)
  // The empty row answers to what people type when they mean "none of these" — including the
  // built-in's own name, which is no longer a row of its own. Same match signal as every other
  // row, so one query ranks the whole list.
  const noneMatches =
    queryScore('no skill', `none plain ${QUICK_TASK} ${quickTask?.description ?? ''}`, search) > 0
  const nothingMatches =
    !noneMatches
    && mostUsed.length === 0
    && project.length === 0
    && global.length === 0
    && matchedWorkflows.length === 0
  const pick = (next: TaskSource | null) => {
    onPick(next)
    setOpen(false)
  }
  /** Picking what is already picked CLEARS it — the gesture every other toggle in the cockpit
   *  answers to, and the one the report asked for by name. */
  const toggle = (next: TaskSource) =>
    pick(source?.source === next.source && source.ref === next.ref ? null : next)

  const skillItem = (skill: Skill, emphasized: boolean) => {
    const selected = source?.source === 'skill' && source.ref === skill.name
    return (
      <CommandItem
        key={skill.path}
        // The path suffix keeps values unique when a project skill shadows a global one.
        value={`skill ${skill.name} ${skill.path}`}
        keywords={skillKeywords(skill.name, skill.description)}
        data-slot="source-option"
        data-source-kind="skill"
        data-source-ref={skill.name}
        onSelect={() => toggle({ source: 'skill', ref: skill.name })}
      >
        <span className={cn('shrink-0 font-mono text-xs', emphasized && 'font-semibold')}>
          {skill.name}
        </span>
        {skill.description ? (
          <span className="min-w-0 flex-1 truncate text-xs text-soft-foreground">
            {skill.description}
          </span>
        ) : null}
        {/* Read-only "View skill" (spec §Skills) — the Settings catalog's detail component
            as a dialog. stopPropagation: viewing must not pick the source. */}
        <button
          type="button"
          data-slot="source-skill-view"
          aria-label={`View skill ${skill.name}`}
          title="View skill"
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            setPreview(skill)
          }}
          className="ml-auto shrink-0 rounded-sm p-0.5 text-soft-foreground transition-colors hover:text-foreground"
        >
          <EyeIcon aria-hidden="true" className="size-3.5" />
        </button>
        {selected ? <CheckIcon aria-hidden="true" className="size-3.5 shrink-0 text-primary" /> : null}
      </CommandItem>
    )
  }

  const SourceIcon = source === null ? PlusIcon : source.source === 'skill' ? SparklesIcon : WorkflowIcon
  // An empty picker looks empty: dashed, quiet, an invitation rather than a value. Every other
  // pill in this row shows a resolved choice, so a filled-looking pill that nobody chose was
  // read as one that could not be changed.
  const trigger = (
    <button
      type="button"
      data-slot="source-pill"
      data-source-kind={source?.source ?? 'none'}
      aria-label="Choose a skill or workflow"
      title={
        source === null
          ? 'No skill — the task runs as one plain agent step. Pick a skill or workflow to change that.'
          : `Runs the ${source.source} "${source.ref}" — pick it again, or press ✕, to run without it`
      }
      disabled={!ready}
      onKeyDown={(event) => {
        // A filled pill clears like a token in a tag field. Modifiers stay out of it: ⌘⌫ is a
        // text gesture in the composer this row belongs to, not a picker one.
        if (source === null || event.metaKey || event.ctrlKey || event.altKey) return
        if (event.key !== 'Backspace' && event.key !== 'Delete') return
        event.preventDefault()
        onPick(null)
      }}
      className={cn(
        chipClass,
        'font-mono text-[11.5px]',
        source === null
          ? 'border-dashed text-soft-foreground'
          : 'rounded-r-none border-r-0 border-foreground/60 pr-1.5 font-semibold text-foreground',
      )}
    >
      <SourceIcon
        aria-hidden="true"
        className={cn('size-3 shrink-0', source === null ? 'text-soft-foreground' : 'text-violet')}
      />
      <span className="max-w-44 truncate">{!ready ? '…' : (source?.ref ?? 'Skill')}</span>
      {chevron}
    </button>
  )

  return (
    <>
      <SkillPreviewDialog skill={preview} onClose={() => setPreview(null)} />
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) setSearch('')
        }}
      >
        {/* Split control, not a button inside a button: the trigger owns the menu, the ✕ owns
            the clear, and the seam between them is the ✕'s left border. */}
        <span className="inline-flex items-center">
          <PopoverTrigger asChild>{trigger}</PopoverTrigger>
          {source !== null && ready ? (
            <button
              type="button"
              data-slot="source-pill-clear"
              aria-label={`Clear the ${source.source} ${source.ref}`}
              title="Run without it"
              onClick={() => onPick(null)}
              className={cn(
                chipClass,
                'rounded-l-none border-foreground/60 pl-1.5 pr-2 text-soft-foreground hover:text-foreground',
              )}
            >
              <XIcon aria-hidden="true" className="size-3" />
            </button>
          ) : null}
        </span>
        <PopoverContent
          align="start"
          sideOffset={8}
          className="w-[336px] max-w-[calc(100vw-2rem)] p-0"
        >
          <Command shouldFilter={false}>
            <CommandInput
              placeholder="search skills & workflows…"
              value={search}
              onValueChange={setSearch}
              onInput={() => listRef.current?.scrollTo(0, 0)}
            />
            {/* The 3rem headroom is the CommandInput row: the popper's available-height var
                covers the whole popover, and the list must leave the search box visible. */}
            <CommandList
              ref={listRef}
              data-slot="source-menu"
              className="max-h-[min(18rem,calc(var(--radix-popover-content-available-height)-3rem))]"
            >
              {nothingMatches ? <CommandEmpty>Nothing matches.</CommandEmpty> : null}
              {/* Heading-less and first: "run it plain" is not a kind of skill, and the way out
                  of a selection has to be the thing you see when the list opens. */}
              {noneMatches ? (
                <CommandGroup>
                  <CommandItem
                    value="none no-skill"
                    keywords={['none', 'plain', ...skillKeywords(QUICK_TASK)]}
                    data-slot="source-option"
                    data-source-kind="none"
                    onSelect={() => pick(null)}
                  >
                    <CircleSlashIcon aria-hidden="true" className="size-3.5 shrink-0 text-soft-foreground" />
                    <span className="shrink-0 text-xs font-medium">No skill</span>
                    <span className="min-w-0 flex-1 truncate text-xs text-soft-foreground">
                      {quickTask?.description ?? 'One agent run on your task — no ceremony.'}
                    </span>
                    {source === null ? (
                      <CheckIcon aria-hidden="true" className="ml-auto size-3.5 shrink-0 text-primary" />
                    ) : null}
                  </CommandItem>
                </CommandGroup>
              ) : null}
              {/* Most used leads (#519), then Project skills before Global — the closer a
                  skill lives to the repo, the more likely it's the one being picked. */}
              {mostUsed.length > 0 ? (
                <CommandGroup heading="Most used">
                  {mostUsed.map((skill) => skillItem(skill, isProjectSkill(skill)))}
                </CommandGroup>
              ) : null}
              {project.length > 0 ? (
                <CommandGroup heading="Project skills">
                  {project.map((skill) => skillItem(skill, true))}
                </CommandGroup>
              ) : null}
              {matchedWorkflows.length > 0 ? (
                <CommandGroup heading="Workflows">
                  {matchedWorkflows.map((workflow) => {
                    const selected = source?.source === 'workflow' && source.ref === workflow.name
                    return (
                      <CommandItem
                        key={workflow.name}
                        value={`workflow ${workflow.name}`}
                        keywords={skillKeywords(workflow.name, workflow.description)}
                        data-slot="source-option"
                        data-source-kind="workflow"
                        data-source-ref={workflow.name}
                        onSelect={() => toggle({ source: 'workflow', ref: workflow.name })}
                      >
                        <span className="shrink-0 font-mono text-xs">{workflow.name}</span>
                        {workflow.description ? (
                          <span className="min-w-0 flex-1 truncate text-xs text-soft-foreground">
                            {workflow.description}
                          </span>
                        ) : null}
                        {selected ? (
                          <CheckIcon aria-hidden="true" className="ml-auto size-3.5 shrink-0 text-primary" />
                        ) : null}
                      </CommandItem>
                    )
                  })}
                </CommandGroup>
              ) : null}
              {global.length > 0 ? (
                <CommandGroup heading="Global">{global.map((skill) => skillItem(skill, false))}</CommandGroup>
              ) : null}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </>
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
      label={<span className="font-mono text-[11.5px]">base: {current}</span>}
      value={repo.baseBranch ?? ''}
      onPick={(value) => mutation.mutate(value === '' ? null : value)}
      options={[
        { value: '', label: `follow checked-out branch (${repo.info.branch})`, desc: 'New task worktrees fork from whatever branch is checked out' },
        ...repo.branches.map((branch) => ({ value: branch, label: branch })),
      ]}
    />
  )
}

/** The `Start | Plan first` segment (#383): a real toggle with an UNMISTAKABLE selected state.
 *  "Start" selected keeps the quiet card fill; "Plan first" selected takes the mockup's
 *  contrast fill + focus ring (`.seg .plan-active`) — plan mode must never be ambient. The
 *  active plan segment doubles as the busy indicator while `POST /api/plan` is in flight. */
function ModeSegment({
  planFirst,
  planning,
  onModeChange,
}: {
  planFirst: boolean
  planning: boolean
  onModeChange: (planFirst: boolean) => void
}) {
  return (
    <div
      data-slot="mode-seg"
      role="radiogroup"
      aria-label="Run mode"
      className="inline-flex items-center gap-0.5 rounded-lg bg-muted p-[3px]"
    >
      <button
        type="button"
        role="radio"
        aria-checked={!planFirst}
        onClick={() => onModeChange(false)}
        className={cn(
          'h-6 rounded-md px-2 text-xs transition-colors',
          !planFirst
            ? 'bg-card font-semibold text-foreground shadow-xs'
            : 'font-medium text-muted-foreground hover:text-foreground',
        )}
      >
        Start
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={planFirst}
        aria-busy={planning || undefined}
        data-slot="mode-plan"
        onClick={() => onModeChange(true)}
        className={cn(
          'h-6 rounded-md px-2 text-xs transition-colors',
          planFirst
            ? 'bg-contrast font-semibold text-contrast-foreground ring-2 ring-ring/55'
            : 'font-medium text-muted-foreground hover:text-foreground',
          planning && 'animate-pulse',
        )}
      >
        {planning ? 'Planning…' : 'Plan first'}
      </button>
    </div>
  )
}

/** Honest static starters (the mockup's ghost chips): they only fill the textarea — the user
 *  still aims and submits. */
const SUGGESTIONS = [
  'Fix a failing or flaky test',
  'Summarize recent commits on this branch',
  'Update the README for recent changes',
]

function SuggestedChips({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="mt-7 flex flex-wrap justify-center gap-2 max-md:justify-start">
      {SUGGESTIONS.map((suggestion) => (
        <button
          key={suggestion}
          type="button"
          data-slot="suggested-chip"
          onClick={() => onPick(suggestion)}
          className="inline-flex h-[30px] items-center gap-1.5 rounded-full border border-border px-3 text-[12.5px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <SparklesIcon aria-hidden="true" className="size-3 shrink-0 text-soft-foreground" />
          {suggestion}
        </button>
      ))}
    </div>
  )
}

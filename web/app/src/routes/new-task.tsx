import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  CheckIcon,
  EyeIcon,
  FolderOpenIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  WorkflowIcon,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useParams, useSearchParams } from 'react-router'

import { Link, useNavigate } from '@/lib/project-router'

import { createRun, getLaunchKey, postPlan, putConfig, putUiState } from '@/api/client'
import { useProjectScope } from '@/api/project-scope-context'
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
  RunnerModelCatalogResponse,
  Skill,
  WorkflowDef,
} from '@/api/types'
import { CheckChip } from '@/components/check-chip'
import { Composer } from '@/components/composer/composer'
import { Kbd } from '@/components/kbd'
import { chevron, chipClass } from '@/components/picker-pill'
import { ProviderGate, providerDisabledReason } from '@/components/provider-gate'
import { SkillPreviewDialog } from '@/components/skill-detail'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
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
  clearDraftText,
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
  resolveModel,
  resolveRunner,
  resolveSource,
  RUNNERS,
  startedRunPath,
  type TaskSource,
} from './new-task-form'
import { parseNewTaskParams } from './new-task-params'
import { buildPlannedRunBody, pendingPlanOf, type PendingPlan } from './new-task-plan'
import { PlanReview } from './plan-review'

/**
 * `/new` — the full-screen new-task hero (spec §"New task (full-screen, #386)"; visual
 * contract docs/mockups/new-task.html): centered composer card, the four-pill picker row
 * inside the card below the textarea (Project · Source · Model · Run options), suggested-task
 * ghost chips underneath. In plan-first mode (#383, the `Start | Plan first` segment) submit
 * runs `POST /api/plan` and opens the review overlay (plan-review.tsx) instead of starting a
 * run.
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
  // Settings → Agents `defaultModels` (R6 1.5): the per-runner preset the Model pill starts on.
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
  const source = resolveSource([draft.source, uiState.data?.lastTask], skillList, workflowList)
  const selectedWorkflow = source.source === 'workflow'
    ? workflowList.find((workflow) => workflow.name === source.ref)
    : undefined
  const selectedSkill = source.source === 'skill'
    ? skillList.find((skill) => skill.name === source.ref)
    : undefined

  // ---- prompt templates (#413 follow-up) ----------------------------------------------------
  // The same list the GitHub hand-over and Inbox composers read. Two ways in here: the
  // composer's "+" menu inserts one by hand at the caret, and a skill whose templates are
  // assigned to it applies them on selection — but only into a box the user has not typed in
  // (`resolveAutoApply`).
  const templates = useMemo(
    () => normalizePromptTemplates(uiState.data?.promptTemplates),
    [uiState.data?.promptTemplates],
  )
  const autoText = autoApplyText(templates, source.source === 'skill' ? [source.ref] : [])
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
  const defaultRunner = health.data?.defaultRunner
  const preferredRunner = defaultRunner ?? 'claude'
  const runner = runners.length > 0 ? resolveRunner(draft.runner, runners, preferredRunner) : null
  const displayRunner = runner ?? preferredRunner
  const providersReady = providers.isSuccess && runners.length > 0
  const catalog = useRunnerModels()
  const model = runner === null
    ? ''
    : resolveModel(draft.model, runner, config.data?.defaultModels, catalog.data)

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
  const hasGit = health.data === undefined || health.data.repo !== null
  const variants = hasGit ? draft.variants : 1

  // Worktree opt-out (#worktree-toggle): only offered for a single skill run in a git repo —
  // workflows and variants always isolate, and a non-git repo already runs in place. The choice
  // is remembered (draft → last-used → default on).
  const singleStepSource = source.source === 'skill'
    || source.ref === 'quick-task'
    || selectedWorkflow?.steps.length === 1
  const worktreeToggleShown = hasGit
  const worktreeForced = !singleStepSource || variants > 1

  // Autonomous (#autonomous): the run never pauses for the user. An explicit toggle this session
  // wins; then an interactive skill recommends handing the ball back; otherwise the configured
  // workspace default applies ('source-dependent' → skills default ON, everything else OFF).
  // Plan-first forces it OFF (and disables the toggle): planning is inherently interactive, so
  // the run must be able to hand the ball back.
  const runModeInput = {
    hasGit,
    variants,
    forceWorktree: !singleStepSource,
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
    source: source.source,
  }
  const runMode = resolveComposerRunMode(runModeInput)
  const defaultRunMode = resolveComposerRunMode({
    ...runModeInput,
    explicitAutonomous: null,
    explicitWorktree: null,
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

  const runOptionDeviations =
    (worktreeToggleShown && worktreeOn !== defaultRunMode.worktree ? 1 : 0)
    + (autonomousOn !== defaultRunMode.autonomous ? 1 : 0)
    + (followupsToggleShown && !generateFollowupsOn ? 1 : 0)
    + (variants > 1 ? 1 : 0)
    + (repo.data?.baseBranch != null ? 1 : 0)

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
    // Provider status often resolves before health on a cold load. The protected bookmarklet
    // body may omit runner only against the server's authoritative default, never our display
    // fallback; a failed health check degrades to the prefilled composer instead of guessing.
    if (health.isPending) return
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
          clearDraftText(draftProjectId)
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
  }, [defaultRunner, health.isPending, providers.isPending, providersReady, runner]) // eslint-disable-line react-hooks/exhaustive-deps
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
      update({
        text: unknownSkillPrefillText(deepLink.skill, deepLink.ref),
        ...(workflowList.some((w) => w.name === 'quick-task')
          ? { source: { source: 'workflow', ref: 'quick-task' } as TaskSource }
          : {}),
      })
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
        providerDisabledReason({ pending: providers.isPending, error: providers.isError }),
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
        runner,
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
      lastTask: source,
      recentSources: pushRecentSource(recentSources, source),
      ...(followupsToggleShown ? { lastGenerateFollowups: generateFollowupsOn } : {}),
      // Frequency sort (#408): only a SKILL pick counts — the map is keyed by skill name, and a
      // workflow choice here doesn't select one directly. Gated on the CURRENT map being known:
      // the PUT merge is shallow, so bumping off an errored ui-state query (`sourcesReady` only
      // rules out `isPending`, not a failed fetch) would send a one-entry map and wipe every
      // accumulated count.
      ...(source.source === 'skill' && uiState.data !== undefined
        ? { skillUsage: bumpSkillUsage(uiState.data.skillUsage, source.ref) }
        : {}),
    })
      .then(() => queryClient.invalidateQueries({ queryKey: queryKeys.uiState }))
      .catch(() => {})
    clearDraftText(draftProjectId)
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
          runner,
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
      clearDraftText(draftProjectId)
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
        className="flex min-h-full flex-col items-center justify-center overflow-x-clip px-6"
      >
        <div data-slot="auto-starting" role="status" className="text-center">
          <h1 className="animate-pulse text-lg font-semibold tracking-tight">Starting task…</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Launched from a bookmarklet — taking you to the run.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div
      data-route="new"
      className="flex min-h-full flex-col items-center overflow-x-clip px-6 pt-[clamp(32px,7vh,84px)] pb-16 max-md:px-3.5 max-md:pt-7"
    >
      <div className="w-full max-w-[720px]">
        <header className="mb-6 text-center max-md:mb-4">
          <h1 className="text-lg font-semibold tracking-tight max-md:text-base">
            What should the agent work on?
          </h1>
          <p className="mt-1.5 text-sm text-muted-foreground max-md:text-xs">
            Runs in an isolated worktree — review everything before it lands.
          </p>
        </header>

        <Composer
          onSubmit={submit}
          value={draft.text}
          onValueChange={(text) => update({ text })}
          autoFocus
          placeholder="Describe a task for the agent — / for skills…"
          ariaLabel="Describe a task for the agent"
          sendAriaLabel={draft.planFirst ? 'Plan task' : 'Start task'}
          disabled={!providersReady || starting}
          disabledReason={providerDisabledReason({
            pending: providers.isPending,
            error: providers.isError,
          })}
          templates={templates}
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
              <ModelPill
                runners={runners}
                runner={displayRunner}
                model={model}
                defaultModels={config.data?.defaultModels}
                catalog={catalog.data}
                catalogFailed={catalog.isError}
                disabled={!providersReady}
                onPick={(nextRunner, nextModel) => update({ runner: nextRunner, model: nextModel })}
              />
              <RunOptionsMenu deviations={runOptionDeviations}>
                <div className="flex flex-wrap items-center gap-1.5">
                  {worktreeToggleShown ? (
                    <CheckChip
                      slot="worktree-toggle"
                      label="Worktree"
                      on={worktreeOn}
                      disabled={worktreeForced}
                      titleOn="Runs in an isolated worktree — uncheck to run in the repo working tree"
                      titleOff="Runs in the repo working tree — check to isolate in a worktree"
                      disabledTitle={variants > 1
                        ? 'Parallel variants always use isolated worktrees'
                        : 'Multi-step workflows require an isolated worktree'}
                      onChange={(on) => update({ worktree: on })}
                    />
                  ) : null}
                  <CheckChip
                    slot="autonomous-toggle"
                    label="Autonomous"
                    on={autonomousOn}
                    disabled={draft.planFirst}
                    titleOn="Autonomous — the agent runs to completion without pausing for you"
                    titleOff="Runs interactively — check to let the agent finish without pausing for you"
                    disabledTitle="Plan-first runs are interactive — autonomous is unavailable"
                    onChange={(on) => update({ autonomous: on })}
                  />
                  {followupsToggleShown ? (
                    <CheckChip
                      slot="generate-followups-toggle"
                      label="Follow-ups"
                      on={generateFollowupsOn}
                      titleOn="Agents can add newly discovered follow-up work to the task inbox"
                      titleOff="Follow-up generation is off; agents still maintain the handoff journal"
                      onChange={(on) => update({ generateFollowups: on })}
                    />
                  ) : null}
                </div>
                {selectedSkill?.interactive && (draft.autonomous === null || draft.worktree === null) ? (
                  <p className="text-xs text-muted-foreground" data-slot="interactive-skill-hint">
                    This skill recommends an interactive run in the current checkout. You can change either setting.
                  </p>
                ) : null}
                <VariantsPicker
                  variants={variants}
                  hasGit={hasGit}
                  onPick={(next) => update({ variants: next })}
                />
                {repo.data ? <BaseBranchPicker repo={repo.data} /> : null}
              </RunOptionsMenu>
            </>
          }
          footerEnd={
            <>
              {!providersReady ? (
                <ProviderGate pending={providers.isPending} error={providers.isError} />
              ) : null}
              <ModeSegment
                planFirst={draft.planFirst}
                planning={planning}
                onModeChange={(planFirst) => update({ planFirst })}
              />
              <Kbd aria-hidden="true">{submitShortcutHint()}</Kbd>
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
          startUnavailableReason={providerDisabledReason({
            pending: providers.isPending,
            error: providers.isError,
          })}
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

function ModelPill({
  runners,
  runner,
  model,
  defaultModels,
  catalog,
  catalogFailed,
  disabled = false,
  onPick,
}: {
  runners: readonly Runner[]
  runner: Runner
  model: string
  defaultModels?: Partial<Record<Runner, string>>
  catalog?: RunnerModelCatalogResponse
  catalogFailed: boolean
  disabled?: boolean
  onPick: (runner: Runner, model: string) => void
}) {
  const groups = (runners.length > 0 ? runners : [runner]).map((id) => ({
    id,
    label: RUNNERS.find((entry) => entry.id === id)?.label ?? id,
    models: modelsForRunner(id, catalog, [id === runner ? model : defaultModels?.[id]]),
    status: modelCatalogStatus(id, catalog, catalogFailed),
  }))
  const currentModels = groups.find((group) => group.id === runner)?.models ?? []
  const trigger = (
    <button
      type="button"
      data-slot="model-pill"
      aria-label="Model"
      disabled={disabled}
      title="Which agent backend and model run this task"
      className={chipClass}
    >
      <span className="flex min-w-0 flex-col items-start gap-px text-left">
        <span className="max-w-36 truncate text-2xs leading-none font-medium">
          {currentModels.find((m) => m.id === model)?.label ?? 'auto'}
        </span>
        <span className="text-2xs leading-none text-soft-foreground">
          {RUNNERS.find((entry) => entry.id === runner)?.label ?? runner}
        </span>
      </span>
      {chevron}
    </button>
  )
  if (disabled) return <span className="inline-flex">{trigger}</span>
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" data-testid="model-pill-menu">
        {groups.map((group) => (
          <DropdownMenuGroup key={group.id}>
            {groups.length > 1 ? (
              <DropdownMenuLabel className="label-caps">{group.label}</DropdownMenuLabel>
            ) : null}
            <DropdownMenuRadioGroup
              value={group.id === runner ? model : '__none__'}
              onValueChange={(next) => onPick(group.id, next)}
            >
              {group.models.map((m) => (
                <DropdownMenuRadioItem
                  key={`${group.id}:${m.id}`}
                  value={m.id}
                  data-slot="model-option"
                  data-runner={group.id}
                  data-model={m.id}
                  className="gap-2.5"
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="text-xs font-medium">{m.label}</span>
                    {m.desc ? (
                      <span className="text-xs text-muted-foreground">{m.desc}</span>
                    ) : null}
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            {group.status ? (
              <DropdownMenuItem
                disabled
                className="border-t border-border text-xs text-muted-foreground"
              >
                {group.status}
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuGroup>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function RunOptionsMenu({
  deviations,
  children,
}: {
  deviations: number
  children: ReactNode
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-slot="run-options-pill"
          aria-label="Run options"
          title="Worktree, autonomy, follow-ups, parallel variants and the base branch"
          className={cn(chipClass, deviations > 0 && 'border-foreground/60 font-semibold text-foreground')}
        >
          <SlidersHorizontalIcon aria-hidden="true" className="size-3 shrink-0 text-soft-foreground" />
          Options{deviations > 0 ? ` · ${deviations}` : ''}
          {chevron}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={8}
        data-slot="run-options-menu"
        className="flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-3 p-3"
      >
        {children}
      </PopoverContent>
    </Popover>
  )
}

function VariantsPicker({
  variants,
  hasGit,
  onPick,
}: {
  variants: number
  hasGit: boolean
  onPick: (variants: number) => void
}) {
  return (
    <div data-slot="variants-picker" className="flex flex-col gap-1.5">
      <p className="label-caps">Parallel variants</p>
      <div
        role="radiogroup"
        aria-label="Parallel variants"
        title={hasGit
          ? 'How many times to run this task in parallel — each variant gets its own worktree, and you pick the diff you keep. ×1 runs it once.'
          : 'Parallel variants need a git repository — each variant runs in its own worktree.'}
        className="flex items-center gap-1.5"
      >
        {[1, 2, 3].map((count) => (
          <button
            key={count}
            type="button"
            role="radio"
            aria-checked={variants === count}
            disabled={!hasGit}
            data-slot="variants-option"
            data-variants={count}
            onClick={() => onPick(count)}
            className={cn(chipClass, variants === count && 'border-primary/60 text-foreground')}
          >
            ×{count}
          </button>
        ))}
      </div>
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
            className="max-h-[min(18rem,calc(var(--available-height)-3rem))]"
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
                  <span className="shrink-0 text-2xs text-soft-foreground">folder not found</span>
                ) : project.branch !== undefined ? (
                  <span className="shrink-0 font-mono text-2xs text-soft-foreground">
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
          <p className="border-t border-border px-3 py-2 text-2xs leading-snug text-soft-foreground">
            Skills, workflows, settings and the draft re-resolve against the selected project.
          </p>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/**
 * The workflow/skill picker (#385's searchable cmdk dropdown, #519's tier ordering): ONE pill
 * for both kinds of source. Groups render Most used (skills picked before, frequency
 * descending), Project skills (bold), Workflows, then Global.
 */
function SourcePill({
  source,
  ready,
  skills,
  skillUsage,
  workflows,
  onPick,
}: {
  source: TaskSource
  ready: boolean
  skills: readonly Skill[]
  skillUsage: Readonly<Record<string, number>> | undefined
  workflows: readonly WorkflowDef[]
  onPick: (source: TaskSource) => void
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [preview, setPreview] = useState<Skill | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // #484: rank in JS (cmdk's own score-sort does not re-order reliably here), then split the
  // ranked matches into the #519 display tiers so each group stays match-ordered.
  const matched = searchSkills(skills, search, skillUsage)
  const { mostUsed, project, global } = partitionSkillsForDisplay(matched, skillUsage)
  const matchedWorkflows = searchWorkflows(workflows, search)
  const nothingMatches =
    mostUsed.length === 0 && project.length === 0 && global.length === 0 && matchedWorkflows.length === 0
  const pick = (next: TaskSource) => {
    onPick(next)
    setOpen(false)
  }

  const skillItem = (skill: Skill, emphasized: boolean) => {
    const selected = source.source === 'skill' && source.ref === skill.name
    return (
      <CommandItem
        key={skill.path}
        // The path suffix keeps values unique when a project skill shadows a global one.
        value={`skill ${skill.name} ${skill.path}`}
        keywords={skillKeywords(skill.name, skill.description)}
        data-slot="source-option"
        data-source-kind="skill"
        data-source-ref={skill.name}
        onSelect={() => pick({ source: 'skill', ref: skill.name })}
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
        <PopoverTrigger asChild>
          <button
            type="button"
            data-slot="source-pill"
            aria-label="Choose a skill or workflow"
            disabled={!ready}
            className={cn(chipClass, 'border-foreground/60 font-mono text-xs font-semibold text-foreground')}
          >
            {source.source === 'skill' ? (
              <SparklesIcon aria-hidden="true" className="size-3 shrink-0 text-violet" />
            ) : (
              <WorkflowIcon aria-hidden="true" className="size-3 shrink-0 text-violet" />
            )}
            <span className="max-w-44 truncate">{ready ? source.ref : '…'}</span>
            {chevron}
          </button>
        </PopoverTrigger>
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
              className="max-h-[min(18rem,calc(var(--available-height)-3rem))]"
            >
              {nothingMatches ? <CommandEmpty>Nothing matches.</CommandEmpty> : null}
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
                    const selected = source.source === 'workflow' && source.ref === workflow.name
                    return (
                      <CommandItem
                        key={workflow.name}
                        value={`workflow ${workflow.name}`}
                        keywords={skillKeywords(workflow.name, workflow.description)}
                        data-slot="source-option"
                        data-source-kind="workflow"
                        data-source-ref={workflow.name}
                        onSelect={() => pick({ source: 'workflow', ref: workflow.name })}
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
function BaseBranchPicker({ repo }: { repo: RepoResponse }) {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: (baseBranch: string | null) => putConfig({ baseBranch }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.repo })
      toast(
        result.baseBranch
          ? `New tasks will branch off "${result.baseBranch}" (PRs target it too).`
          : 'Base branch cleared — tasks follow the current checkout.',
      )
    },
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  if (!repo.info) return null
  const options = [
    {
      value: '',
      label: `current checkout (${repo.info.branch})`,
      desc: 'Follow whatever is checked out',
    },
    ...repo.branches.map((branch) => ({ value: branch, label: branch, desc: undefined })),
  ]
  return (
    <div data-slot="base-branch" className="flex flex-col gap-1.5">
      <p className="label-caps">Base branch</p>
      <div
        role="radiogroup"
        aria-label="Base branch"
        className="flex max-h-40 flex-col gap-0.5 overflow-y-auto"
      >
        {options.map((option) => {
          const selected = (repo.baseBranch ?? '') === option.value
          return (
            <button
              key={option.value === '' ? '(checkout)' : option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={mutation.isPending}
              data-slot="base-branch-option"
              data-branch={option.value}
              onClick={() => mutation.mutate(option.value === '' ? null : option.value)}
              className="flex h-7 shrink-0 items-center gap-2 rounded-sm px-2 text-left text-xs outline-none transition-colors hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset"
            >
              <span className="min-w-0 flex-1 truncate font-mono">{option.label}</span>
              {option.desc ? (
                <span className="shrink-0 text-2xs text-soft-foreground">{option.desc}</span>
              ) : null}
              {selected ? (
                <CheckIcon aria-hidden="true" className="size-3.5 shrink-0 text-primary" />
              ) : null}
            </button>
          )
        })}
      </div>
    </div>
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
      className="inline-flex h-8 items-center gap-0.5 rounded-full bg-muted p-[3px]"
    >
      <button
        type="button"
        role="radio"
        aria-checked={!planFirst}
        onClick={() => onModeChange(false)}
        className={cn(
          'h-6.5 rounded-full px-2.5 text-xs transition-colors',
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
          'h-6.5 rounded-full px-2.5 text-xs transition-colors',
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
          className="inline-flex h-7.5 items-center rounded-full border border-border px-3 text-xs font-medium text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          {suggestion}
        </button>
      ))}
    </div>
  )
}

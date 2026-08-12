import type {
  BackendCheck,
  CreateRunInput,
  CreateRunResponse,
  ImageInput,
  Runner,
  RunnerModelCatalogResponse,
  Skill,
  UiState,
  WorkflowDef,
} from '@open-mercato/cezar-api-client'

/**
 * The new-task form's picker rules and its POST body, as pure functions — the exact semantics
 * of the legacy form (web/app.js: `RUNNERS`, `MODELS_BY_RUNNER`, `renderChrome`,
 * `defaultTaskSource`, the submit handler), kept apart from the component so every rule is
 * table-testable and so drift from legacy is a diff in ONE file, not a scavenger hunt.
 */

/** What the composer runs: a named workflow or a single skill. The same shape the server's
 *  `ui-state.json` stores as `lastTask`, so persistence needs no mapping. */
export type TaskSource = NonNullable<UiState['lastTask']>

/** Prepend `source` to the recency list (newest first), dropping any earlier occurrence of the
 *  same source+ref, and cap the length. Pure so the picker's recency sort is table-testable. */
export function pushRecentSource(
  recent: readonly TaskSource[] | undefined,
  source: TaskSource,
  cap = 24,
): TaskSource[] {
  const rest = (recent ?? []).filter((s) => !(s.source === source.source && s.ref === source.ref))
  return [source, ...rest].slice(0, cap)
}

export interface RunnerOption {
  id: Runner
  label: string
  desc: string
}

/** The agent-backend catalog (legacy `RUNNERS`). Installation-only compatibility surfaces use
 *  `availableRunners`; the new-task composer filters this catalog by connected provider status. */
export const RUNNERS: readonly RunnerOption[] = [
  { id: 'claude', label: 'claude', desc: 'Claude Code CLI' },
  { id: 'codex', label: 'codex', desc: 'OpenAI Codex (app-server)' },
  { id: 'opencode', label: 'opencode', desc: 'OpenCode (serve)' },
]

export interface ModelPreset {
  id: string
  label: string
  desc: string
}

/** Static model presets per runner. `id: ''` is always "auto" —
 *  no model flag, the runner decides. Claude takes tier aliases + pinned versions; Codex takes
 *  Codex entries are supplied by host discovery; OpenCode takes `provider/model` ids. */
export const MODELS_BY_RUNNER: Record<Runner, readonly ModelPreset[]> = {
  claude: [
    { id: '', label: 'auto', desc: 'Pick the best model per step' },
    { id: 'opus', label: 'opus', desc: 'Deep reasoning for hard tasks' },
    { id: 'sonnet', label: 'sonnet', desc: 'Fast and cheap' },
    { id: 'haiku', label: 'haiku', desc: 'Fastest — simple, scoped tasks' },
    { id: 'claude-fable-5', label: 'Fable 5', desc: 'Most capable — the Claude 5 family' },
    { id: 'claude-opus-4-8', label: 'Opus 4.8', desc: 'Pinned version' },
    { id: 'claude-sonnet-5', label: 'Sonnet 5', desc: 'Pinned version' },
    { id: 'claude-haiku-4-5', label: 'Haiku 4.5', desc: 'Pinned version' },
  ],
  codex: [
    { id: '', label: 'auto', desc: 'Use your Codex default model' },
  ],
  opencode: [
    { id: '', label: 'auto', desc: 'Use your OpenCode default model' },
    { id: 'anthropic/claude-opus-4-8', label: 'claude-opus-4.8', desc: 'via Anthropic' },
    { id: 'anthropic/claude-sonnet-5', label: 'claude-sonnet-5', desc: 'via Anthropic' },
    { id: 'openai/gpt-5.1', label: 'gpt-5.1', desc: 'via OpenAI' },
    { id: 'openai/gpt-5.1-codex', label: 'gpt-5.1-codex', desc: 'via OpenAI' },
  ],
}

/** Keep recognized presets from another backend out of a runner's custom-model escape hatch
 * (#480).
 * Unknown ids remain valid custom models; only a known cross-runner mismatch is discarded. */
export function modelConflictsWithRunner(model: string, runner: Runner): boolean {
  if (!model || MODELS_BY_RUNNER[runner].some((preset) => preset.id === model)) return false
  return Object.entries(MODELS_BY_RUNNER).some(
    ([other, presets]) =>
      other !== runner && presets.some((preset) => preset.id !== '' && preset.id === model),
  )
}

export function modelsForRunner(
  runner: Runner,
  catalog?: RunnerModelCatalogResponse,
  customIds: readonly (string | null | undefined)[] = [],
): readonly ModelPreset[] {
  const base = [...(MODELS_BY_RUNNER[runner] ?? MODELS_BY_RUNNER.claude)]
  const seen = new Set(base.map((model) => model.id))
  if (runner === 'codex') {
    for (const model of catalog?.models ?? []) {
      if (!model.id || seen.has(model.id)) continue
      seen.add(model.id)
      base.push({ id: model.id, label: model.label || model.id, desc: model.description })
    }
  }
  // Native settings may contain a provider-specific/custom id that is not in
  // cezar's static catalog. Keep it representable so the initial selection
  // matches the agent's own configured default on every backend.
  for (const id of customIds) {
    if (!id || seen.has(id) || modelConflictsWithRunner(id, runner)) continue
    seen.add(id)
    base.push({ id, label: id, desc: 'Custom or legacy model' })
  }
  return base
}

export function modelCatalogStatus(
  runner: Runner,
  catalog: RunnerModelCatalogResponse | undefined,
  failed = false,
): string | undefined {
  if (runner !== 'codex') return undefined
  if (catalog?.stale) return 'Using cached Codex model list'
  if (failed || catalog?.source === 'unavailable') return 'Latest Codex models unavailable'
  return undefined
}

/** Which runners the pill offers, from the health checks (legacy `renderChrome`). The `claude`
 *  fallback when nothing is detected is deliberate legacy behavior: the form must always have
 *  a runner, and claude is the default engine. */
export function availableRunners(checks: readonly BackendCheck[]): Runner[] {
  const available = RUNNERS.map((r) => r.id).filter((id) =>
    checks.some((c) => c.name === id && c.available),
  )
  return available.length > 0 ? available : ['claude']
}

/** The effective runner: the user's pick when still installed, else the configured default
 *  when installed, else the first available (legacy preselection order). */
export function resolveRunner(
  picked: Runner | null,
  available: readonly Runner[],
  preferred: Runner,
): Runner {
  if (picked !== null && available.includes(picked)) return picked
  if (available.includes(preferred)) return preferred
  return available[0] ?? 'claude'
}

/** The runner field shared by every NEW-run surface. Explicit/sticky intent always rides the
 * request; only an untouched pick matching the active project's known default may be omitted. */
export function runnerOverride(
  runner: Runner,
  defaultRunner: Runner | undefined,
  explicit = false,
): Runner | undefined {
  return !explicit && runner === defaultRunner ? undefined : runner
}

/** The effective model: the user's pick when it exists in the selected runner's presets, else
 *  the configured per-runner default (Settings → Agents `defaultModels`, R6 1.5) when IT is a
 *  known preset, else auto (`''`). An explicit pick — including picking auto — always beats
 *  the configured default (`picked: ''` is a pick; only `null` means "never touched").
 *  Deliberately STRICTER than legacy, which kept a stale `taskModel` in state while displaying
 *  auto — here what is displayed is what is sent. */
export function resolveModel(
  picked: string | null,
  runner: Runner,
  defaults?: Partial<Record<Runner, string>>,
  catalog?: RunnerModelCatalogResponse,
): string {
  const models = modelsForRunner(runner, catalog, [picked, defaults?.[runner]])
  if (picked !== null && models.some((m) => m.id === picked)) return picked
  const preset = defaults?.[runner]
  if (preset !== undefined && models.some((m) => m.id === preset)) return preset
  return ''
}

export function sourceExists(
  source: TaskSource,
  skills: readonly Skill[],
  workflows: readonly WorkflowDef[],
): boolean {
  return source.source === 'skill'
    ? skills.some((s) => s.name === source.ref)
    : workflows.some((w) => w.name === source.ref)
}

/**
 * The effective source: the first candidate that still exists (the draft pick, then the
 * persisted `lastTask`), else the zero-config cold default: built-in quick-task.
 */
export function resolveSource(
  candidates: ReadonlyArray<TaskSource | null | undefined>,
  skills: readonly Skill[],
  workflows: readonly WorkflowDef[],
): TaskSource {
  for (const candidate of candidates) {
    if (candidate && sourceExists(candidate, skills, workflows)) return candidate
  }
  if (workflows.some((workflow) => workflow.name === 'quick-task')) {
    return { source: 'workflow', ref: 'quick-task' }
  }
  const firstSkill = skills[0]
  if (firstSkill) return { source: 'skill', ref: firstSkill.name }
  return { source: 'workflow', ref: workflows[0]?.name ?? 'quick-task' }
}

/**
 * The exact `POST /api/runs` body the legacy form sends:
 *  - a skill runs as a one-step inline chain (spec 008's API — the same shape the inbox and
 *    the bookmarklet auto-start use): `steps: [{ id: 'task', name, skill, prompt: '{{task}}' }]`;
 *  - a workflow goes by name;
 *  - an explicit/sticky `runner` always rides the request; an untouched runner is omitted only
 *    when it equals the active project's known default (unknown defaults and connected fallbacks
 *    stay explicit);
 *  - `model`/`variants`/`images` only when they say something (`''`/1/empty mean "default").
 */
export function buildCreateRunBody(opts: {
  task: string
  source: TaskSource
  model: string
  /** Native coding-agent settings stay visible, but a locked model is never a request override. */
  modelsLocked?: boolean
  runner: Runner
  /** True when the draft contains a sticky/user runner choice rather than an untouched default. */
  runnerExplicit?: boolean
  defaultRunner?: Runner
  /** Per-task agent account (spec 2026-07-29-agent-profiles) — the composer's override of the
   *  project's own selection, applying to `runner`. Absent/empty follows the project. */
  agentProfile?: string | null
  variants: number
  images: readonly ImageInput[]
  /** false → run in the repo working tree, no worktree (single runs only). Sent only when
   *  explicitly off; the default (isolated worktree) stays implicit. */
  worktree?: boolean
  /** true → autonomous run (never pauses for the user). Sent only when on. */
  autonomous?: boolean
  /** false → do not ask the agent for follow-up todos. Sent only when off. */
  generateFollowups?: boolean
  /** The inbox entry this composer was prefilled from (`/new?…&todo=`, #374) — sent back so
   *  the server records the started run on it. Empty/absent for every other launch.
   *  Independent of `generateFollowups`: starting a task FROM a follow-up still marks that
   *  entry started, even when the new task itself won't generate follow-ups of its own. */
  todoId?: string
}): CreateRunInput {
  const {
    task,
    source,
    model,
    modelsLocked,
    runner,
    runnerExplicit,
    defaultRunner,
    agentProfile,
    variants,
    images,
    worktree,
    autonomous,
    generateFollowups,
    todoId,
  } = opts
  return {
    task,
    ...(source.source === 'skill'
      ? { steps: [{ id: 'task', name: source.ref, skill: source.ref, prompt: '{{task}}' }] }
      : { workflow: source.ref }),
    model: modelsLocked ? undefined : model || undefined,
    runner: runnerOverride(runner, defaultRunner, runnerExplicit),
    // Sent only when the user picked one — an absent key is "follow the project", which is what
    // every launch that never touched the control means.
    agentProfile: agentProfile || undefined,
    variants: variants > 1 ? variants : undefined,
    images: images.length > 0 ? [...images] : undefined,
    // Off only matters for a single run — variants always isolate.
    worktree: worktree === false && variants <= 1 ? false : undefined,
    autonomous: autonomous === true ? true : undefined,
    generateFollowups: generateFollowups === false ? false : undefined,
    todoId: todoId || undefined,
  }
}

/** The automation editor persists the exact New task serialization, with only the transport-
 * specific `task` key renamed to `prompt`. Images and inbox provenance are deliberately absent:
 * an automation is a reusable template, not one browser submission. */
export function buildAutomationTask(
  opts: Parameters<typeof buildCreateRunBody>[0],
): Omit<CreateRunInput, 'task' | 'images' | 'todoId'> & { prompt: string } {
  const { task, images: _images, todoId: _todoId, ...body } = buildCreateRunBody(opts)
  return { prompt: task, ...body }
}

/** Where a successful POST navigates: the run's thread — for ×2/×3 the FIRST variant's thread,
 *  exactly what legacy `handleStarted` selects. */
export function startedRunPath(response: CreateRunResponse): string {
  const first = 'runs' in response ? response.runs[0] : response
  return first ? `/tasks/${first.id}` : '/'
}

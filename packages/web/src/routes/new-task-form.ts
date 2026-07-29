import type {
  BackendCheck,
  CreateRunInput,
  CreateRunResponse,
  HarnessModelRef,
  HarnessPreset,
  HarnessProbeResponse,
  HarnessProfile,
  HarnessRoles,
  HarnessStatusResponse,
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
  // claude has no discovery adapter — its tier presets ARE the catalog.
  if (runner === 'claude') return base
  const seen = new Set(base.map((model) => model.id))
  // Merge live discovery only from the catalog fetched FOR this runner — a
  // codex catalog must never leak entries into the opencode picker.
  if (catalog?.runner === runner) {
    for (const model of catalog.models) {
      if (!model.id || seen.has(model.id)) continue
      seen.add(model.id)
      base.push({ id: model.id, label: model.label || model.id, desc: model.description })
    }
  }
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
  if (runner === 'claude') return undefined
  if (catalog && catalog.runner !== runner) return undefined
  const name = runner === 'codex' ? 'Codex' : 'OpenCode'
  if (catalog?.stale) return `Using cached ${name} model list`
  if (failed || catalog?.source === 'unavailable') return `Latest ${name} models unavailable`
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

// ---- cez-harness (spec 2026-07-23-harness-orchestration) -------------------------------------

/** The built-in staged multi-model workflows. Mirrors `src/harness/workflows.ts` — the server
 *  is authoritative; these names gate only which composer shows the harness panel. */
export const HARNESS_WORKFLOWS = ['harness-fix-issue', 'harness-implement-feature'] as const

/** The Configure-models prefill (the harness dialog's primary action): the interactive
 *  `cez-setup-harness` task, staged **in the repo working tree** — setup writes
 *  `.ai/agentic.config.json` + hooks for the human to review, and a throwaway worktree
 *  would strand them on a `cez/` branch (a stale worktree base once hid the config
 *  entirely: run 9788d87f). */
export function harnessSetupPrefill(): {
  composerMode: 'task'
  source: TaskSource
  text: string
  worktree: false
} {
  return {
    composerMode: 'task',
    source: { source: 'skill', ref: 'cez-setup-harness' },
    text: 'Configure the multi-model agent harness for this repository — detect and bind the reviewer and worker models I actually have access to.',
    worktree: false,
  }
}

/** The harness workflow a source selects, or null — the switch that shows the harness panel,
 *  sends the `harness` body field, and swaps the suggestion row. */
export function harnessWorkflowName(source: TaskSource): string | null {
  return source.source === 'workflow' && (HARNESS_WORKFLOWS as readonly string[]).includes(source.ref)
    ? source.ref
    : null
}

export interface HarnessProfileOption {
  id: HarnessProfile
  label: string
  desc: string
}

/**
 * The five operating profiles of the repo's `agentHarness.profiles`, in escalation order.
 * `id` is the om-config wire name and never changes; `label`/`desc` are the human surface.
 *
 * DISPLAY ONLY since 2026-07-27 (user feedback): the composer no longer offers a profile —
 * every Multi-model run is a custom lineup. This list survives as the label map for
 * Settings → Harness, which reports which profiles the repo config declares.
 */
export const HARNESS_PROFILE_OPTIONS: readonly HarnessProfileOption[] = [
  { id: 'standard', label: 'Claude solo', desc: 'Claude writes the code; a second, fresh Claude context reviews it. Works with zero setup.' },
  { id: 'optimized', label: 'Worker offload', desc: 'A sandboxed worker model (e.g. Codex) writes the code; Claude directs and reviews.' },
  { id: 'multi', label: 'Review council', desc: 'Several independent models (DeepSeek, Kimi, GLM…) each review the diff; findings are merged.' },
  { id: 'multi-optimized', label: 'Council + worker', desc: 'The worker writes the code and the full multi-model council reviews it.' },
  { id: 'high-assurance', label: 'High assurance', desc: 'Bounded work packets, blind risk-scaled reviews, and evidence gates — maximum rigor.' },
]

export interface HarnessMode {
  id: 'fix-issue' | 'implement-feature'
  workflow: string
  label: string
  desc: string
}

/** The two things the multi-model tab can run — plain names over the workflow ids. Built for
 *  long, one-shot builds (a whole module) and end-to-end issue fixes, always staged-only. */
export const HARNESS_MODES: readonly HarnessMode[] = [
  {
    id: 'fix-issue',
    workflow: 'harness-fix-issue',
    label: 'Fix an issue',
    desc: 'Qualify, diagnose, fix, validate, and review a tracker issue end to end.',
  },
  {
    id: 'implement-feature',
    workflow: 'harness-implement-feature',
    label: 'Build a feature',
    desc: 'Spec first, then implement — sized for big one-shot builds like a whole module.',
  },
]

/** The Task tab's workflow catalog: harness workflows live in the Multi-model tab only, so
 *  the ordinary picker never shows them (user feedback 2026-07-23: two entry points confuse). */
export function withoutHarnessWorkflows(workflows: readonly WorkflowDef[]): WorkflowDef[] {
  return workflows.filter((w) => !(HARNESS_WORKFLOWS as readonly string[]).includes(w.name))
}

/* ---- role-based selection (user feedback 2026-07-24) ---------------------------------- */

/** One pickable model for a harness role, with its provider family precomputed. */
export interface HarnessModelOption extends HarnessModelRef {
  label: string
  family: string
}

/** Gateways that resell other vendors' weights: the `provider/` prefix of such an
 *  id is a routing detail, never a family. */
const GATEWAY_PREFIXES: ReadonlySet<string> = new Set(['opencode', 'openrouter', 'zen'])

/** Weight lineage by model name — two models behind one gateway can be genuinely
 *  different, and one vendor reached through two gateways is still one vendor. */
const FAMILY_BY_NAME: ReadonlyArray<[RegExp, string]> = [
  [/^glm/i, 'zhipu'],
  [/^kimi/i, 'moonshot'],
  [/^deepseek/i, 'deepseek'],
  [/^mimo/i, 'xiaomi'],
  [/^qwen/i, 'alibaba'],
  [/^gpt|^o[0-9]|^codex/i, 'openai'],
  [/^claude/i, 'anthropic'],
  [/^gemini/i, 'google'],
  [/^grok/i, 'xai'],
  [/^llama/i, 'meta'],
  [/^mistral|^magistral/i, 'mistral'],
  [/^nemotron/i, 'nvidia'],
  [/^ling|^ring/i, 'inclusionai'],
]

/**
 * The provider family a (runner, model) pair belongs to — the diversity axis of the
 * multi-model rule.
 *
 * BYTE-FAITHFUL MIRROR of `providerFamilyOf` in `src/harness/model-family.ts`
 * (the browser cannot import server code). The two must change together: when
 * they disagreed, the composer admitted a lineup the driver's quorum then counted
 * differently — `claude/sonnet` + `opencode/claude-sonnet-4-5` passed as two
 * families while being one vendor (review 2026-07-27).
 */
export function modelFamilyOf(ref: HarnessModelRef): string {
  // Advisor refs (spec 2026-07-24-advisor-reviewers) carry their provider
  // family from /harness/status — kimi→moonshot, glm→zhipu.
  if (ref.runner === 'harness') return ref.family ?? 'harness'

  const slash = ref.model.indexOf('/')
  const prefix = slash > 0 ? ref.model.slice(0, slash) : ''
  const bare = slash > 0 ? ref.model.slice(slash + 1) : ref.model

  // A non-gateway prefix IS the provider; trust it over the name table.
  if (prefix && !GATEWAY_PREFIXES.has(prefix.toLowerCase())) return prefix.toLowerCase()

  // The runner implies the vendor for the first-party CLIs — but only as a
  // FALLBACK, so gateway-resold Anthropic still collapses into `anthropic`.
  const runnerFallback =
    ref.runner === 'claude' ? 'anthropic'
    : ref.runner === 'codex' ? 'openai'
    : prefix.toLowerCase() || ref.runner

  for (const [pattern, family] of FAMILY_BY_NAME) if (pattern.test(bare)) return family
  return runnerFallback
}

/** Reviewer options from the configured `agentHarness` bindings (`/harness/status`):
 *  DeepSeek via API, kimi via its subscription CLI, Zen presets — executed by the
 *  runtime's review council, not a runner session (spec 2026-07-24-advisor-reviewers).
 *  Reviewer-only: the other roles filter these out. */
export function advisorHarnessOptions(status?: HarnessStatusResponse): HarnessModelOption[] {
  return (status?.models ?? [])
    .filter((m) => m.adapter !== undefined && m.adapter !== 'host' && m.roles.includes('reviewer'))
    .map((m) => ({
      runner: 'harness' as const,
      model: m.id,
      label: m.model ? `${m.id} · ${m.model}` : m.id,
      family: m.family ?? 'harness',
    }))
}

const sameRef = (a: HarnessModelRef, b: HarnessModelRef) => a.runner === b.runner && a.model === b.model

/**
 * Why a role selection cannot run, or null when it is sound. The tab is STRICTLY
 * multi-model: 2–5 reviewers, all unique, spanning at least two model families — a
 * single-voice council is exactly what this surface exists to prevent.
 */
export function harnessRolesIssue(roles: HarnessRoles): string | null {
  if (roles.reviewers.length < 2) return 'Pick at least 2 reviewers — multi-model means more than one voice.'
  if (roles.reviewers.length > 5) return 'Pick at most 5 reviewers.'
  for (let i = 0; i < roles.reviewers.length; i += 1) {
    for (let j = i + 1; j < roles.reviewers.length; j += 1) {
      if (sameRef(roles.reviewers[i]!, roles.reviewers[j]!)) return 'Reviewers must be unique models.'
    }
  }
  const families = new Set(roles.reviewers.map(modelFamilyOf))
  if (families.size < 2) {
    return 'Reviewers must span at least two different model families (e.g. Anthropic + OpenAI).'
  }
  return null
}

/** One provider-family group of the model picker (user feedback 2026-07-24: the flat list
 *  does not scale — group by provider, searchable). Anthropic and OpenAI lead (the two
 *  backends every setup starts from); the rest follow alphabetically. */
export interface HarnessOptionGroup {
  family: string
  options: HarnessModelOption[]
}

export function groupHarnessOptions(options: readonly HarnessModelOption[]): HarnessOptionGroup[] {
  const byFamily = new Map<string, HarnessModelOption[]>()
  for (const option of options) {
    const list = byFamily.get(option.family) ?? []
    list.push(option)
    byFamily.set(option.family, list)
  }
  const LEAD = ['anthropic', 'openai']
  const families = [...byFamily.keys()].sort((a, b) => {
    const la = LEAD.indexOf(a)
    const lb = LEAD.indexOf(b)
    if (la !== -1 || lb !== -1) return (la === -1 ? LEAD.length : la) - (lb === -1 ? LEAD.length : lb)
    return a.localeCompare(b)
  })
  return families.map((family) => ({ family, options: byFamily.get(family)! }))
}

/** Structural equality of two role selections — the "is this preset active" test. Reviewer
 *  order matters (it is the council's run order), and effort counts: a preset restores the
 *  whole dial, not just the models. Uniqueness (`sameRef`) deliberately ignores effort. */
const sameSelection = (a: HarnessModelRef, b: HarnessModelRef) =>
  sameRef(a, b) && a.effort === b.effort

export function rolesEqual(a: HarnessRoles, b: HarnessRoles): boolean {
  return (
    sameSelection(a.orchestrator, b.orchestrator) &&
    sameSelection(a.implementer, b.implementer) &&
    a.reviewers.length === b.reviewers.length &&
    a.reviewers.every((r, i) => sameSelection(r, b.reviewers[i]!))
  )
}

/** Saved role lineups from loose ui-state data (the store is passthrough by design):
 *  malformed entries drop, the list caps at 12. The cap is EXPLICIT — saving past it is
 *  refused with guidance (see `canSaveHarnessPreset`), never a silent eviction: presets are
 *  quick-switch chips, and past a dozen they stop being quick. */
export const HARNESS_PRESETS_MAX = 12

/** How many preset chips render inline in the lineup header; the rest live in the
 *  "+N more" overflow menu so the header keeps one stable row at any count. */
export const HARNESS_PRESETS_VISIBLE = 3

/** Whether a save is allowed: under the cap, or replacing an existing name (no growth). */
export function canSaveHarnessPreset(
  presets: readonly HarnessPreset[],
  name: string,
): { ok: true } | { ok: false; reason: string } {
  const replaces = presets.some((p) => p.name === name)
  if (replaces || presets.length < HARNESS_PRESETS_MAX) return { ok: true }
  return {
    ok: false,
    reason: `${HARNESS_PRESETS_MAX} presets max — delete one first, or reuse an existing name to replace it.`,
  }
}

/** The header's chip split: the first few presets inline, everything else in the overflow —
 *  and the ACTIVE preset (the one matching `roles`) always stays visible, pulled out of the
 *  overflow when needed so "which lineup am I on" never hides behind a menu. */
export function visibleHarnessPresets(
  presets: readonly HarnessPreset[],
  roles: HarnessRoles | null,
): { visible: HarnessPreset[]; overflow: HarnessPreset[] } {
  const visible = presets.slice(0, HARNESS_PRESETS_VISIBLE)
  const rest = presets.slice(HARNESS_PRESETS_VISIBLE)
  if (roles !== null) {
    const active = rest.find((p) => rolesEqual(p.roles, roles))
    if (active !== undefined) {
      return { visible: [...visible, active], overflow: rest.filter((p) => p.id !== active.id) }
    }
  }
  return { visible, overflow: rest }
}

export function normalizeHarnessPresets(raw: unknown): HarnessPreset[] {
  if (!Array.isArray(raw)) return []
  const out: HarnessPreset[] = []
  for (const entry of raw) {
    if (out.length >= HARNESS_PRESETS_MAX) break
    if (!entry || typeof entry !== 'object') continue
    const preset = entry as HarnessPreset
    if (typeof preset.id !== 'string' || typeof preset.name !== 'string' || preset.name === '') continue
    const roles = preset.roles as HarnessRoles | undefined
    if (
      !roles ||
      !isModelRefShape(roles.orchestrator) ||
      !isModelRefShape(roles.implementer) ||
      !Array.isArray(roles.reviewers) ||
      !roles.reviewers.every(isModelRefShape)
    ) {
      continue
    }
    out.push({
      id: preset.id,
      name: preset.name,
      roles: {
        orchestrator: sanitizeRef(roles.orchestrator),
        implementer: sanitizeRef(roles.implementer),
        reviewers: roles.reviewers.map(sanitizeRef),
      },
    })
  }
  return out
}

const HARNESS_EFFORTS: readonly string[] = ['low', 'medium', 'high', 'max']

/** Copy a ref keeping only a VALID effort — stale/hand-edited values drop silently.
 *  An advisor ref's `family` is preserved: it IS the ref's identity (the
 *  diversity axis), and dropping it turned a saved advisor reviewer into an
 *  unresolvable one. */
function sanitizeRef(ref: HarnessModelRef): HarnessModelRef {
  const effort = typeof ref.effort === 'string' && HARNESS_EFFORTS.includes(ref.effort) ? ref.effort : undefined
  return {
    runner: ref.runner,
    model: ref.model,
    ...(ref.runner === 'harness' && typeof ref.family === 'string' ? { family: ref.family } : {}),
    ...(effort ? { effort } : {}),
  }
}

/**
 * Every runner a saved lineup may name — INCLUDING `harness`, the configured
 * advisor reviewers (deepseek-api, kimi-subscription…).
 *
 * Omitting it silently destroyed data (review 2026-07-27): saving a preset whose
 * council contained an advisor wrote it to ui-state, the refetch ran this
 * normaliser, the whole preset failed the shape check, and the chip vanished a
 * moment after the user named it — with no error, because the write path
 * swallows failures. `new-task-draft.ts` already accepted all four runners, so
 * the draft kept the very lineup the preset could not.
 */
function isModelRefShape(raw: unknown): raw is HarnessModelRef {
  if (!raw || typeof raw !== 'object') return false
  const ref = raw as HarnessModelRef
  if (typeof ref.model !== 'string') return false
  if (ref.runner === 'harness') {
    // An advisor without its family cannot be resolved back to a binding.
    return typeof ref.family === 'string' && ref.family !== ''
  }
  return ['claude', 'codex', 'opencode'].includes(ref.runner)
}

/**
 * A sound default selection from what this workspace actually offers, or null when fewer
 * than two families exist — the "configure more models first" modal case. Orchestrator
 * prefers claude (the long-context host); implementer prefers a different family; reviewers
 * take one model from each of the first two families.
 */
/**
 * Warn when a free-tier gateway model is bound to a reviewer slot.
 *
 * Free tiers are throughput-limited and routinely cannot finish a full review
 * inside its budget — observed live: `mimo-v2.5-free` burned two consecutive
 * 60-minute budgets on one spec review without ever producing a result, and the
 * council lost that voice. The run now survives it (quorum), but the user is
 * better off knowing before they spend the tokens. Returns null when nothing
 * needs saying.
 */
export function freeTierReviewerWarning(roles: HarnessRoles | null): string | null {
  if (!roles) return null
  // The `-free` suffix is the OpenCode Zen catalog's own marker for the tier.
  const free = roles.reviewers.filter((r) => /-free$/.test(r.model))
  if (free.length === 0) return null
  const names = [...new Set(free.map((r) => r.model))].join(', ')
  return `${names} ${free.length > 1 ? 'are free-tier models' : 'is a free-tier model'} — free tiers often cannot finish a full review in time. The council continues without a reviewer that fails, but you lose its perspective.`
}

export function defaultHarnessRoles(allOptions: readonly HarnessModelOption[]): HarnessRoles | null {
  // Defaults stay runner-backed: advisors are an explicit, configured choice.
  const options = allOptions.filter((o) => o.runner !== 'harness')
  const families = [...new Set(options.map((o) => o.family))]
  if (families.length < 2 || options.length < 2) return null
  const byFamily = (family: string) => options.filter((o) => o.family === family)
  const anthropic = byFamily('anthropic')
  // The orchestrator reads the most — prefer the long-context tier (sonnet
  // carries the 1M window) over the family's generic first entry.
  const orchestrator = anthropic.find((o) => o.model === 'sonnet') ?? anthropic[0] ?? options[0]!
  const otherFamily = families.find((f) => f !== orchestrator.family)!
  const implementer = byFamily(otherFamily)[0]!
  const reviewers = [
    byFamily(orchestrator.family).find((o) => !sameRef(o, orchestrator)) ?? orchestrator,
    implementer,
  ]
  return {
    orchestrator: { runner: orchestrator.runner, model: orchestrator.model },
    implementer: { runner: implementer.runner, model: implementer.model },
    reviewers: reviewers.map((r) => ({ runner: r.runner, model: r.model })),
  }
}

/**
 * Why the Start button must hold, from the profile's probe — or null to allow.
 * Loading, errors, and missing evidence all block. The server repeats the exact
 * probe before creating a worktree; this client gate keeps the start surface
 * truthful while that fail-closed check is pending.
 */
export function harnessStartBlock(
  probe: HarnessProbeResponse | undefined,
  pending = false,
  failed = false,
): string | null {
  if (pending) return 'Checking every selected model binding…'
  if (failed) return 'Model readiness could not be verified.'
  if (!probe) return 'Model readiness has not been verified yet.'
  if (probe.ready) return null
  return probe.reason ?? `profile "${probe.profile}" is not ready`
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
  runner: Runner
  /** True when the draft contains a sticky/user runner choice rather than an untouched default. */
  runnerExplicit?: boolean
  defaultRunner?: Runner
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
  /** The role lineup the panel composed. Sent only when `source` IS a harness workflow —
   *  the server 400s a `harness` field anywhere else, so the rule lives here, once.
   *  (The named `profile` alternative was dropped from the composer 2026-07-27; the server
   *  still accepts it from scripted callers.) */
  harnessRoles?: HarnessRoles
  harnessBaseAcknowledgement?: {
    configuredBase: string
    remoteDefault: string
    reason: string
  }
}): CreateRunInput {
  const {
    task,
    source,
    model,
    runner,
    runnerExplicit,
    defaultRunner,
    variants,
    images,
    worktree,
    autonomous,
    generateFollowups,
    todoId,
    harnessRoles,
    harnessBaseAcknowledgement,
  } = opts
  return {
    task,
    ...(source.source === 'skill'
      ? { steps: [{ id: 'task', name: source.ref, skill: source.ref, prompt: '{{task}}' }] }
      : { workflow: source.ref }),
    model: model || undefined,
    runner: runnerOverride(runner, defaultRunner, runnerExplicit),
    variants: variants > 1 ? variants : undefined,
    images: images.length > 0 ? [...images] : undefined,
    // Off only matters for a single run — variants always isolate.
    worktree: worktree === false && variants <= 1 ? false : undefined,
    autonomous: autonomous === true ? true : undefined,
    generateFollowups: generateFollowups === false ? false : undefined,
    todoId: todoId || undefined,
    harness:
      harnessWorkflowName(source) !== null
        ? harnessRoles || harnessBaseAcknowledgement
          ? {
              ...(harnessRoles ? { roles: harnessRoles } : {}),
              ...(harnessBaseAcknowledgement
                ? { baseAcknowledgement: harnessBaseAcknowledgement }
                : {}),
            }
          : undefined
        : undefined,
  }
}

/** Where a successful POST navigates: the run's thread — for ×2/×3 the FIRST variant's thread,
 *  exactly what legacy `handleStarted` selects. */
export function startedRunPath(response: CreateRunResponse): string {
  const first = 'runs' in response ? response.runs[0] : response
  return first ? `/tasks/${first.id}` : '/'
}

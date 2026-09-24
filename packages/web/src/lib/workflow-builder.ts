import type { PlanResponse, SaveWorkflowInput, WorkflowStepDef } from '@open-mercato/cezar-api-client'

/**
 * The workflow builder's pure rules (R6 Step 1.6, spec §"Skills, Workflows, Inbox"), ported
 * from the legacy `web/app.js` builder (spec 012) so the React canvas and the unit suite share
 * one source of truth. Everything here is data-in/data-out — the dnd-kit wiring stays in the
 * route, the invariants stay testable without a DOM.
 *
 * The server owns the real validation (`src/workflows/types.ts`): a step is agent XOR check,
 * a file is `steps` XOR the portable `skills` shorthand, and at most 8 steps save/run. The
 * mirrors here exist so the GUI can speak before the round-trip, never instead of it.
 */

/** The server's save/run step limit (`saveWorkflowSchema` `.max(8)`). */
export const WB_MAX_STEPS = 8

/**
 * Client mirror of the server's `skillStackOf()`: when every step is a plain "apply this
 * skill to the task" agent step, the workflow serializes in the portable compact `skills:`
 * form. Anything richer (checks, custom prompts, per-step models/tools, loops) answers null
 * and serializes as full `steps:`.
 */
export function skillStack(steps: readonly WorkflowStepDef[]): string[] | null {
  const skills: string[] = []
  for (const s of steps) {
    if (s.command || !s.skill) return null
    if (s.prompt !== undefined && s.prompt !== '{{task}}') return null
    if (s.name !== undefined && s.name !== s.skill) return null
    if (s.model || s.runner || s.allowedTools || s.bashAllowlist || s.onFail) return null
    skills.push(s.skill)
  }
  return skills.length ? skills : null
}

/** One palette drop → one agent step. Ids stay unique by suffixing (`skill`, `skill-2`, …) —
 *  the same rule as the server's `skillsToSteps`. */
export function skillStep(skill: string, steps: readonly WorkflowStepDef[]): WorkflowStepDef {
  const used = new Set(steps.map((s) => s.id))
  let id = skill
  for (let n = 2; used.has(id); n++) id = `${skill}-${n}`
  return { id, name: skill, skill, prompt: '{{task}}' }
}

/** Insert `step` at `at`, immutably. `at` clamps into range so a stale drop index cannot
 *  corrupt the list. */
export function insertStep(
  steps: readonly WorkflowStepDef[],
  step: WorkflowStepDef,
  at: number,
): WorkflowStepDef[] {
  const next = [...steps]
  next.splice(Math.max(0, Math.min(at, next.length)), 0, step)
  return next
}

/** Reorder immutably (dnd-kit's arrayMove semantics). Out-of-range indexes answer the list
 *  unchanged — a cancelled drag must be a no-op, never a crash. */
export function moveStep(
  steps: readonly WorkflowStepDef[],
  from: number,
  to: number,
): WorkflowStepDef[] {
  if (from === to) return [...steps]
  if (from < 0 || from >= steps.length || to < 0 || to >= steps.length) return [...steps]
  const next = [...steps]
  const [moved] = next.splice(from, 1)
  if (moved === undefined) return [...steps]
  next.splice(to, 0, moved)
  return next
}

export function removeStep(steps: readonly WorkflowStepDef[], index: number): WorkflowStepDef[] {
  return steps.filter((_, i) => i !== index)
}

/** Quote only when the plain form would be ambiguous YAML — special characters, or a scalar
 *  YAML would read as a boolean/number/null instead of a string. JSON strings are valid YAML
 *  double-quoted scalars, so JSON.stringify is the escape hatch. (Legacy `yamlScalar`.) */
function yamlScalar(v: unknown): string {
  const s = String(v)
  const plain = /^[A-Za-z0-9._][A-Za-z0-9 ._/-]*$/.test(s) && !s.endsWith(' ')
  const looksTyped = /^(true|false|yes|no|on|off|null|~)$/i.test(s) || /^[-+.]?\d/.test(s)
  return plain && !looksTyped ? s : JSON.stringify(s)
}

function yamlBlock(key: string, text: string, indent: number): string[] {
  const pad = ' '.repeat(indent)
  if (!text.includes('\n')) return [`${pad}${key}: ${yamlScalar(text)}`]
  return [`${pad}${key}: |`, ...text.split('\n').map((l) => `${pad}  ${l}`)]
}

/**
 * The `workflow.yaml` text the preview shows, Export downloads and Copy copies — byte-for-byte
 * the legacy `wbYamlText()` serialization. Pure skill stacks emit the portable compact form
 * (`name` + `skills:`); anything richer emits full `steps:`; an empty canvas emits `skills: []`
 * so the preview is always valid-looking YAML.
 */
export function workflowYaml(
  name: string,
  description: string,
  steps: readonly WorkflowStepDef[],
): string {
  const lines = [`name: ${yamlScalar(name.trim() || 'my-workflow')}`]
  if (description.trim()) lines.push(...yamlBlock('description', description.trim(), 0))
  const stack = skillStack(steps)
  if (stack) {
    lines.push('skills:')
    for (const s of stack) lines.push(`  - ${yamlScalar(s)}`)
  } else if (steps.length) {
    lines.push('steps:')
    for (const s of steps) {
      lines.push(`  - id: ${yamlScalar(s.id)}`)
      if (s.name && s.name !== s.id) lines.push(`    name: ${yamlScalar(s.name)}`)
      if (s.skill) lines.push(`    skill: ${yamlScalar(s.skill)}`)
      if (s.prompt) lines.push(...yamlBlock('prompt', s.prompt, 4))
      if (s.model) lines.push(`    model: ${yamlScalar(s.model)}`)
      if (s.runner) lines.push(`    runner: ${yamlScalar(s.runner)}`)
      if (s.allowedTools) lines.push(`    allowedTools: [${s.allowedTools.map(yamlScalar).join(', ')}]`)
      if (s.bashAllowlist) lines.push(`    bashAllowlist: [${s.bashAllowlist.map(yamlScalar).join(', ')}]`)
      if (s.command) lines.push(...yamlBlock('command', s.command, 4))
      if (s.onFail) {
        lines.push('    onFail:', `      retry: ${yamlScalar(s.onFail.retry)}`, `      max: ${s.onFail.max ?? 2}`)
      }
    }
  } else {
    lines.push('skills: []')
  }
  return `${lines.join('\n')}\n`
}

/** The Export download's file name — the same slug rule the server uses for the saved path. */
export function workflowSlug(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'workflow'
  )
}

/** "3 skills" for a pure stack, "3 steps" once anything richer is aboard — legacy wording. */
export function stepCountLabel(steps: readonly WorkflowStepDef[]): string {
  const noun = skillStack(steps) ? 'skill' : 'step'
  return `${steps.length} ${noun}${steps.length === 1 ? '' : 's'}`
}

/**
 * The canvas draft an approved auto-chain plan (`POST /api/plan`, #414) lands on: the planner's
 * proposed `name` when it named one (else the current name is kept, never blanked), and its steps
 * capped at the server's `WB_MAX_STEPS` limit with ids re-deduped so a repaired plan can never
 * seed a duplicate-id canvas the server would reject. Pure so the "build me a chain" flow is
 * table-testable without a runner.
 */
export function draftFromPlan(
  plan: Pick<PlanResponse, 'name' | 'steps'>,
  currentName: string,
): { name: string; steps: WorkflowStepDef[] } {
  const used = new Set<string>()
  const steps: WorkflowStepDef[] = []
  for (const step of plan.steps.slice(0, WB_MAX_STEPS)) {
    const base = step.id || 'step'
    let id = base
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`
    used.add(id)
    steps.push({ ...step, id })
  }
  return { name: plan.name?.trim() || currentName, steps }
}

/** The `POST /api/workflows` body: compact `skills` for pure stacks, full `steps` otherwise —
 *  exactly what the legacy Save sent, so the saved file lands in the portable form. */
export function saveBody(
  name: string,
  description: string,
  steps: readonly WorkflowStepDef[],
): SaveWorkflowInput {
  const stack = skillStack(steps)
  return {
    name: name.trim(),
    ...(description.trim() ? { description: description.trim() } : {}),
    ...(stack ? { skills: stack } : { steps: [...steps] }),
  }
}

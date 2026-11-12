/**
 * Composer tips (spec 2026-10-26-first-run-onboarding, § Composer tips). The `/new` screen
 * carries a dozen controls, and a tour of all of them teaches none. Each visit explains at most
 * `TIPS_PER_VISIT` of them, in the order below, skipping the ones the user has already closed and
 * the ones whose control is not on screen (no git, one runner, no templates). Everything here is
 * pure; the component measures the anchors and the workspace ui-state remembers what was shown.
 *
 * Since design Proposal 5 the row holds three value pills and "Options ⌄"; everything else sits
 * in that popover, which is portaled and closed, so a tip can only point at the trigger. The
 * settings worth a tip of their own (isolation, mode) keep theirs, anchored there; the rest share
 * one tip about the panel.
 */

/** Where every setting that is not a value pill lives — the anchor of the panel's tips. */
export const OPTIONS_TRIGGER_ANCHOR = '[data-slot="composer-options-trigger"]'

export type TipPictureId =
  | 'slash'
  | 'source'
  | 'model'
  | 'variants'
  | 'worktree'
  | 'autonomous'
  | 'schedule'
  | 'attachments'
  | 'dispatch'
  | 'base'
  | 'templates'
  | 'followups'
  | 'project'
  | 'ask'

export interface ComposerTip {
  /** Stable id; a closed id never shows again. Name a new one for a new control. */
  id: string
  title: string
  body: string
  /** A CSS selector, resolved inside the composer, for the control the tip points at. */
  anchor: string
  picture: TipPictureId
}

/** Teaching order: what everyone uses first, then what changes how a task runs, then the rest. */
export const COMPOSER_TIPS: readonly ComposerTip[] = [
  {
    id: 'slash-skills',
    title: 'Type / for a skill',
    body: 'A skill is a playbook the agent follows for one kind of job. Type / in the box to pick one as you write.',
    anchor: 'textarea',
    picture: 'slash',
  },
  {
    id: 'source',
    title: 'Skills and workflows',
    body: 'Nothing picked runs the built-in quick task. A workflow chains steps with checks between them: plan, build, review.',
    anchor: '[data-slot="source-pill"]',
    picture: 'source',
  },
  {
    id: 'worktree',
    title: 'Each task in its own worktree',
    body: 'Options → Isolation: the agent works on a branch in a separate checkout, so your working tree stays yours. Pick "in place" to work in the checkout itself.',
    anchor: OPTIONS_TRIGGER_ANCHOR,
    picture: 'worktree',
  },
  {
    id: 'autonomous',
    title: 'Autonomous runs do not wait',
    body: 'Options → Mode: autonomous carries on without asking you anything until it is done; supervised stops when it needs you.',
    anchor: OPTIONS_TRIGGER_ANCHOR,
    picture: 'autonomous',
  },
  {
    id: 'model',
    title: 'Pick the model',
    body: 'auto follows the agent’s own default. Choose a larger model for hard work and a faster one for small fixes.',
    anchor: '[data-slot="model-pill"]',
    picture: 'model',
  },
  {
    id: 'attachments',
    title: 'Paste a screenshot',
    body: 'Drop or paste images and files into the box. The agent sees them with the task.',
    anchor: '[aria-label="Attach files"]',
    picture: 'attachments',
  },
  {
    id: 'options',
    title: 'Everything else is under Options',
    body: 'Run ×2 or ×3 variants and keep the better diff, change the base branch, start the task later, let it fan out into subtasks, or ask a question without changing anything. Your choices are remembered per project.',
    anchor: OPTIONS_TRIGGER_ANCHOR,
    picture: 'variants',
  },
  {
    id: 'templates',
    title: 'Prompt templates',
    body: 'Insert a saved piece of text at the caret. A template assigned to a skill applies itself when you pick the skill.',
    anchor: '[data-slot="prompt-template-trigger"]',
    picture: 'templates',
  },
  {
    id: 'project',
    title: 'Which project',
    body: 'Skills, workflows, settings and the draft all follow the project picked here.',
    anchor: '[data-slot="project-pill"]',
    picture: 'project',
  },
]

export const TIPS_PER_VISIT = 2

/**
 * The tips for this visit: the first `TIPS_PER_VISIT` the user has not closed whose control is
 * on screen. `replay` walks every present tip from the start, closed or not, for the "Show tips"
 * link. Nothing when the user turned tips off, unless they asked for a replay.
 */
export function tipsForVisit(input: {
  seen: readonly string[] | undefined
  off: boolean | undefined
  /** `anchor` selectors that resolve to an element right now. */
  present: ReadonlySet<string>
  replay?: boolean
}): ComposerTip[] {
  const onScreen = COMPOSER_TIPS.filter((tip) => input.present.has(tip.anchor))
  if (input.replay) return onScreen
  if (input.off) return []
  const closed = new Set(input.seen ?? [])
  return onScreen.filter((tip) => !closed.has(tip.id)).slice(0, TIPS_PER_VISIT)
}

/** The seen list after closing `id`: bounded, oldest first out, the way the schema caps it. */
export function markTipSeen(seen: readonly string[] | undefined, id: string): string[] {
  const next = [...(seen ?? []).filter((entry) => entry !== id), id]
  return next.slice(-50)
}

/** Whether every tip that could show on this screen has been closed — then the quiet link offers a replay. */
export function allTipsSeen(seen: readonly string[] | undefined, present: ReadonlySet<string>): boolean {
  const closed = new Set(seen ?? [])
  return COMPOSER_TIPS.filter((tip) => present.has(tip.anchor)).every((tip) => closed.has(tip.id))
}

/**
 * Composer tips (spec 2026-10-26-first-run-onboarding, § Composer tips). The `/new` screen
 * carries a dozen controls, and a tour of all of them teaches none. Each visit explains at most
 * `TIPS_PER_VISIT` of them, in the order below, skipping the ones the user has already closed and
 * the ones whose control is not on screen (no git, one runner, no templates). Everything here is
 * pure; the component measures the anchors and the workspace ui-state remembers what was shown.
 */

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
    body: 'The agent works on a branch in a separate checkout, so your working tree stays yours. Uncheck to work in place.',
    anchor: '[data-slot="worktree-toggle"]',
    picture: 'worktree',
  },
  {
    id: 'autonomous',
    title: 'Autonomous runs do not wait',
    body: 'Checked, the agent carries on without asking you anything until it is done. Unchecked, it stops when it needs you.',
    anchor: '[data-slot="autonomous-toggle"]',
    picture: 'autonomous',
  },
  {
    id: 'variants',
    title: 'Run it twice, keep the better one',
    body: '×2 or ×3 runs the same task in parallel, each in its own worktree. You compare the diffs and keep one.',
    anchor: '[data-slot="variants-pill"]',
    picture: 'variants',
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
    id: 'schedule',
    title: 'Start it later',
    body: 'The arrow beside Start schedules the task: tonight, tomorrow morning, or when your usage limit resets.',
    anchor: '[data-slot="start-time-trigger"]',
    picture: 'schedule',
  },
  {
    id: 'dispatch',
    title: 'Let the task fan out',
    body: 'With dispatch on, the agent can split the work into subtasks that run as their own tasks, and merges what it accepts.',
    anchor: '[data-slot="dispatch-toggle"]',
    picture: 'dispatch',
  },
  {
    id: 'ask',
    title: 'Just ask',
    body: 'Ask answers a question from the checkout and changes nothing: no branch, no worktree, nothing to review.',
    anchor: '[data-slot="ask-toggle"]',
    picture: 'ask',
  },
  {
    id: 'base-branch',
    title: 'Where it forks from',
    body: 'Tasks branch off the base branch and pull requests target it. Change it here for every task that follows.',
    anchor: '[data-slot="base-pill"]',
    picture: 'base',
  },
  {
    id: 'followups',
    title: 'Follow-ups land in the inbox',
    body: 'The agent may note work it found but did not do. Those notes land in the Inbox, ready to run later.',
    anchor: '[data-slot="generate-followups-toggle"]',
    picture: 'followups',
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

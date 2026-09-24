import type { CreateRunInput, GithubItem, WorkflowStepDef } from '@open-mercato/cezar-api-client'

/**
 * The GitHub tab's hand-to-agent contract, ported verbatim from the legacy tab
 * (`web/app.js` `ghTaskPrompt` / `runOnGithub` / `wbSkillStep`) so a run started from the
 * redesigned tab is byte-for-byte the run the legacy tab would have started — same prompt,
 * same `POST /api/runs` body. Pure functions, because the three-way body rule is the part
 * worth pinning independently of any dropdown.
 */

/** A skills-as-chain run carries at most 8 steps — the workflow builder's own limit. */
export const MAX_CHAIN_STEPS = 8

/**
 * The item's IDENTITY alone — verb, `#N`, title, URL — with no body quoted (#524). This is the
 * irreducible context: without it "port this one to develop" names nothing, and `extractTaskRefs`
 * (`src/runs/task-refs.ts`) has no `#N` or URL to recover the run's PR/issue attribution from.
 *
 * The wording is load-bearing, not decorative: `task-refs.ts`'s tier-2 patterns were written to
 * match "Address GitHub pull request #N" / "Fix GitHub issue #N" verbatim. Rewording this without
 * updating those regexes silently costs every run its PR/issue chip and its `#N` title prefix.
 */
export function githubTaskRef(item: GithubItem): string {
  return `${item.kind === 'pr' ? 'Address GitHub pull request' : 'Fix GitHub issue'} #${item.number}: ${item.title}\n\n${item.url}`
}

/**
 * The full auto-generated prompt: the ref block plus the item's body quoted below a rule —
 * the drag-into-the-composer path's text, and the fallback when a hand-off carries no prompt of
 * its own. `skillNames` ride along as a hint ONLY on workflow runs (legacy rule: when the skills
 * ARE the chain, the steps already carry them).
 *
 * The hand-off composer no longer defaults to THIS — it pre-fills the editable box with
 * `githubTaskRef` alone, per #524: a wall of quoted issue body is unreadable in a textarea the
 * user is meant to edit, and the agent can read the item itself from the URL.
 */
export function githubTaskPrompt(item: GithubItem, skillNames: readonly string[] = []): string {
  let task = githubTaskRef(item)
  if (item.body?.trim()) task += `\n\n---\n\n${item.body.trim()}`
  if (skillNames.length) task += skillsHint(skillNames)
  return task
}

function skillsHint(skillNames: readonly string[]): string {
  return `\n\nUse these skills where relevant: ${skillNames.join(', ')}.`
}

/**
 * Substitute the item tokens a custom prompt may use — `{{number}}` → `#N`, `{{title}}`,
 * `{{url}}`. Purely a convenience for placing the reference mid-sentence ("rebase {{number}}
 * onto develop"); it is NEVER what makes the context reach the agent. `composeGithubTask`
 * attaches the ref block regardless, because a user who was never told a token exists cannot be
 * expected to reach for one (#524).
 */
export function applyItemTokens(text: string, item: GithubItem): string {
  // Replacer FUNCTIONS, not replacement strings: a `$` sequence in a replacement string is
  // special (`$&`, `` $` ``, `$'`, `$$`, `$1`), and an issue title is arbitrary user text — a
  // title like "Cost $$ doubled" would otherwise substitute as "Cost $ doubled".
  return text
    .replace(/\{\{\s*number\s*\}\}/gi, () => `#${item.number}`)
    .replace(/\{\{\s*title\s*\}\}/gi, () => item.title)
    .replace(/\{\{\s*url\s*\}\}/gi, () => item.url)
}

/**
 * Does this text already carry the item's reference in a form that survives round-tripping?
 *
 * The bar is deliberately what `src/runs/task-refs.ts` keys on, not merely "the number appears":
 * either the item URL (its tier-1 match) or the KIND-qualified wording — "issue 142", "PR #142",
 * "pull request 142" (its tier-2 match). A bare `#142` is explicitly NOT enough: `extractTaskRefs`
 * degrades it to `ambiguousNumber`, so the run would still lose its issue/PR chip. Trimming the
 * pre-filled box down to "fix #142 on develop" is an ordinary edit, and it must still get the ref
 * block attached.
 *
 * `\b` after the digits keeps `#142` from being satisfied by `#1420` (digits are word characters,
 * so there is no boundary between "142" and "0").
 */
export function mentionsItem(text: string, item: GithubItem): boolean {
  if (text.includes(item.url)) return true
  const worded =
    item.kind === 'pr'
      ? String.raw`(?:pull\s+request|pr)`
      : String.raw`issue`
  return new RegExp(String.raw`\b${worded}\s*#?\s*${item.number}\b`, 'i').test(text)
}

/**
 * The final task text for a hand-off — the fix for #524.
 *
 * The rule that matters: a custom prompt EXTENDS the item context, it never replaces it. The
 * ref block is attached unconditionally unless the prompt already carries the reference itself
 * (the pre-filled box's own text does, so keeping the default costs no duplicate).
 *
 * Ordering is context FIRST, the user's instruction LAST, so their words are the most recent
 * thing the agent reads. The skills hint keeps its place at the very end, as it always had.
 *
 * A blank or whitespace-only prompt yields byte-for-byte the previous default text.
 */
export function composeGithubTask(
  item: GithubItem,
  skillNames: readonly string[],
  customPrompt?: string,
): string {
  const raw = (customPrompt ?? '').trim()
  if (!raw) return githubTaskPrompt(item, skillNames)
  const ref = githubTaskRef(item)
  // Substitute tokens only in what the USER contributed. The box is pre-filled with `ref`, which
  // embeds `item.title` — and a title may itself contain a token ("Support {{url}} in prompt
  // templates"), which would otherwise be rewritten inside our own reference block.
  const custom = raw.startsWith(ref)
    ? ref + applyItemTokens(raw.slice(ref.length), item)
    : applyItemTokens(raw, item)
  const task = mentionsItem(custom, item) ? custom : `${ref}\n\n${custom}`
  return skillNames.length ? task + skillsHint(skillNames) : task
}

/**
 * Skills → a workflow chain (spec 008): one `{{task}}` step per skill, ids deduped the way
 * the legacy builder deduped them (`om-fix`, `om-fix-2`, …), capped at `MAX_CHAIN_STEPS`.
 */
export function skillChainSteps(names: readonly string[]): WorkflowStepDef[] {
  const steps: WorkflowStepDef[] = []
  for (const name of names.slice(0, MAX_CHAIN_STEPS)) {
    const used = new Set(steps.map((step) => step.id))
    let id = name
    for (let n = 2; used.has(id); n++) id = `${name}-${n}`
    steps.push({ id, name, skill: name, prompt: '{{task}}' })
  }
  return steps
}

/**
 * The `POST /api/runs` body for one issue/PR, given what the pickers hold:
 *  - a workflow selected → that workflow (skills ride along as a prompt hint);
 *  - no workflow but skills toggled → the skills ARE the chain (spec 008);
 *  - nothing selected → quick-task.
 *
 * `backend` (#401) is the already-resolved runner/model/account triple —
 * `engineRunBody(useResolvedEngine(…))` from components/engine-pills. It arrives pre-shaped rather
 * than raw on purpose: the omit rules are subtle enough to be worth having in exactly one place,
 * and this stays a pure body builder. Omit it and the body is the pre-#401 one.
 */
export function githubRunBody(
  item: GithubItem,
  workflow: string | null,
  skills: readonly string[],
  customPrompt?: string,
  backend: Pick<CreateRunInput, 'model' | 'runner' | 'agentProfile'> = {},
): CreateRunInput {
  // A custom prompt EXTENDS the item context rather than replacing it (#524) — see
  // `composeGithubTask`. The workflow/skill routing and the #401 `backend` spread are unchanged;
  // only the task text is.
  if (workflow) return { ...backend, workflow, task: composeGithubTask(item, skills, customPrompt) }
  if (skills.length) {
    return {
      ...backend,
      steps: skillChainSteps(skills),
      task: composeGithubTask(item, [], customPrompt),
    }
  }
  return { ...backend, workflow: 'quick-task', task: composeGithubTask(item, [], customPrompt) }
}

import type { UiToolItem } from '@open-mercato/cezar-api-client'

import type { ThreadEntry, ThreadNote } from './thread-state'

/**
 * Pure display grouping over one turn's reduced entries (spec §"Task thread"; the opencode
 * `groupParts()` consensus). A pre-filter (plan-kind tools are the plan dock's, never the
 * thread's — #382), then three passes, in this order:
 *
 *  1. **Sub-agent nesting** — entries whose `parentItemId` names a tool item in the same turn
 *     move under that tool's card (one level; an orphaned parent id renders at top level).
 *  2. **Activity groups** — ≥2 consecutive tool calls between two pieces of prose collapse into
 *     one row with a deterministic summary ("Read 3 files, searched 2 times, ran 4 commands");
 *     reasoning sandwiched between them folds in too. A tool that adopted children (a Task card)
 *     stays its own card. The prose is the thread; the tools are one click away.
 *  3. **Note groups** — ≥2 consecutive lifecycle notes collapse into one summary row ("Set up:
 *     worktree … · installed deps · runner Claude"). Warnings stay visible beside it; danger
 *     notes, failure summaries and notes carrying an action never fold.
 *
 * Pure and total: components render the blocks, they never re-derive the rules.
 */

export interface EntryBlock {
  kind: 'entry'
  id: string
  entry: ThreadEntry
}

export interface ToolCardBlock {
  kind: 'tool-card'
  id: string
  item: UiToolItem
  /** Sub-agent items (`parentItemId` → this tool), in stream order. One level deep. */
  children: ThreadEntry[]
}

export interface ActivityGroupBlock {
  kind: 'activity'
  id: string
  /** The folded members in stream order: tool cards and the reasoning between them. */
  blocks: Array<ToolCardBlock | EntryBlock>
  tools: UiToolItem[]
  /** "Read 3 files, searched 2 times, ran 4 commands". */
  summary: string
  /** The newest call still running, which the collapsed row shows instead of the summary. */
  current?: UiToolItem
  failed: number
}

export interface NoteGroupBlock {
  kind: 'note-group'
  id: string
  notes: ThreadNote[]
  /** Notes the collapsed row keeps on screen (a naming fallback, a diverged base…). */
  warnings: ThreadNote[]
  summary: string
}

export type ThreadBlock = EntryBlock | ToolCardBlock | ActivityGroupBlock | NoteGroupBlock

const isTool = (entry: ThreadEntry): entry is UiToolItem => entry.kind === 'tool'

const plural = (n: number, noun: string, nouns: string): string => `${n} ${n === 1 ? noun : nouns}`
const times = (n: number): string => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`)

/** The file a read/edit touched, for distinct-file counts; the title's detail when no location. */
function toolPath(item: UiToolItem): string | undefined {
  return item.locations?.[0]?.path ?? item.diffs?.[0]?.path ?? splitToolTitle(item.title).detail
}

/**
 * "Read 3 files, searched twice, ran 4 commands" — one clause per kind, in the order the kinds
 * first appear, so the sentence follows what the agent did. Files count distinct paths.
 */
export function activitySummary(tools: readonly UiToolItem[]): string {
  const clauses = new Map<string, { calls: number; paths: Set<string>; names: Set<string> }>()
  for (const item of tools) {
    const kind = item.toolKind
    const clause = clauses.get(kind) ?? { calls: 0, paths: new Set<string>(), names: new Set<string>() }
    clause.calls += 1
    clause.paths.add(toolPath(item) ?? `#${item.id}`)
    clause.names.add(item.toolKind === 'skill' ? (splitToolTitle(item.title).detail ?? item.name) : item.name)
    clauses.set(kind, clause)
  }
  const parts: string[] = []
  for (const [kind, { calls, paths, names }] of clauses) {
    switch (kind) {
      case 'read': parts.push(`read ${plural(paths.size, 'file', 'files')}`); break
      case 'edit': parts.push(`edited ${plural(paths.size, 'file', 'files')}`); break
      case 'delete': parts.push(`deleted ${plural(paths.size, 'file', 'files')}`); break
      case 'move': parts.push(`moved ${plural(paths.size, 'file', 'files')}`); break
      case 'search': parts.push(`searched ${times(calls)}`); break
      case 'execute': parts.push(`ran ${plural(calls, 'command', 'commands')}`); break
      case 'fetch': parts.push(`fetched ${plural(calls, 'page', 'pages')}`); break
      case 'think': parts.push(`thought ${times(calls)}`); break
      case 'task': parts.push(`started ${plural(calls, 'sub-agent', 'sub-agents')}`); break
      case 'skill':
        parts.push(names.size === 1 ? `used skill ${[...names][0]}` : `used ${plural(names.size, 'skill', 'skills')}`)
        break
      default: parts.push(`used ${plural(calls, 'tool', 'tools')}`)
    }
  }
  const text = parts.join(', ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

// ---- lifecycle notes ------------------------------------------------------------------------

/** Engine failure summaries (thread-state's FAILURE_PREFIX): never folded away. */
const FAILURE_NOTE = /^(?:continue failed|run failed|run stopped|step (?:"[^"]+"|\S+) failed)(?: — |: )/
/** Dim notes that report a degraded path: kept visible beside the folded row. */
const WARNING_NOTE = /\b(?:diverged|unavailable|could not|cannot|did not|not reported|failed|skipped|missing|limit reached)\b/i

const RUNNER_NAMES: Record<string, string> = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', omp: 'OMP', pi: 'pi' }
const runnerName = (id: string): string => RUNNER_NAMES[id] ?? id.charAt(0).toUpperCase() + id.slice(1)

const isFoldableNote = (entry: ThreadEntry): entry is ThreadNote =>
  entry.kind === 'note' && entry.tone !== 'danger' && entry.action === undefined && !FAILURE_NOTE.test(entry.text)

export const isWarningNote = (note: ThreadNote): boolean => note.tone === 'info' || WARNING_NOTE.test(note.text)

/**
 * "Set up: worktree cez/571c15ae from origin/main · installed deps · runner Claude" when the
 * notes are the run's setup; otherwise the notes themselves, joined (the row truncates).
 */
export function noteGroupSummary(notes: readonly ThreadNote[]): string {
  let worktree: string | undefined
  let runner: string | undefined
  let skills: string | undefined
  const commands: string[] = []
  let setup = false
  const rest: string[] = []
  for (const note of notes) {
    const text = note.text
    let match: RegExpMatchArray | null
    if ((match = /^worktree ready — branch (\S+) \(base ([^)]+)\)/.exec(text))) {
      worktree = `worktree ${match[1]} from ${match[2]}`
      setup = true
    } else if ((match = /^run (?:started|resumed) — workflow "[^"]*" \(runner: ([^)]+)\)/.exec(text))) {
      runner = `runner ${runnerName(match[1]!)}`
      setup = true
    } else if (/^worktree on — /.test(text) || /^resuming in the existing task worktree/.test(text)) {
      setup = true
    } else if ((match = /^skills installed in the task's workspace: (.+)$/.exec(text))) {
      skills = `skills ${match[1]}`
    } else if ((match = /^\$ (.+)$/.exec(text))) {
      commands.push(/^(?:npm|pnpm|yarn|bun) (?:ci|install|i)\b/.test(match[1]!) ? 'installed deps' : `ran ${match[1]}`)
    } else if (!isWarningNote(note)) {
      rest.push(text)
    }
  }
  if (!setup) {
    const shown = notes.filter((note) => !isWarningNote(note)).map((note) => note.text)
    return (shown.length > 0 ? shown : notes.map((note) => note.text)).join(' · ')
  }
  const parts = [worktree, ...new Set(commands), skills, runner, ...rest].filter((part): part is string => part !== undefined)
  return parts.length > 0 ? `Set up: ${parts.join(' · ')}` : 'Set up'
}

/**
 * Split a protocol-computed tool title ("Ran npm test") into the bold verb and the mono
 * detail for the card trigger. The verb set is exactly what `toolDisplay()` emits; anything
 * else (MCP "server.tool", unknown-tool names) renders whole, as the verb.
 */
const TITLE_VERBS = ['Web search', 'Ran', 'Edit', 'Write', 'Read', 'Search', 'Fetch', 'Task:', 'Skill:'] as const

export function splitToolTitle(title: string): { verb: string; detail?: string } {
  for (const verb of TITLE_VERBS) {
    if (title.startsWith(`${verb} `) && title.length > verb.length + 1) {
      // The colon belongs to the title's grammar, not to the verb chip — "Task: review the
      // store layer" reads as a bold **Task** and a mono detail, and so does "Skill: …".
      return { verb: verb.endsWith(':') ? verb.slice(0, -1) : verb, detail: title.slice(verb.length + 1) }
    }
  }
  return { verb: title }
}

export function groupThreadItems(allEntries: ThreadEntry[]): ThreadBlock[] {
  // Pass 0 — plan-kind tools (TodoWrite / todoList / todowrite) never render in the thread:
  // the plan dock is their surface (#382); a card here would only duplicate the checklist as
  // raw input JSON. Filtering the flat list drops them from children lists too.
  // Blank reasoning items go with them (#528): an interrupted or delta-only item can carry no
  // text, and dropping it here — rather than at the leaf — keeps it out of row counts, children
  // lists, and the always-rendered `thread-row` wrapper, which would otherwise reserve a blank
  // ~3rem gap. A live item that is still empty simply appears once its first delta lands.
  const entries = allEntries.filter(
    (entry) =>
      !(entry.kind === 'tool' && entry.toolKind === 'plan') &&
      !(entry.kind === 'reasoning' && entry.text.trim() === ''),
  )

  // Pass 1 — nesting. Children keep stream order; only tool items can be parents.
  const toolIds = new Set(entries.filter(isTool).map((item) => item.id))
  const childrenOf = new Map<string, ThreadEntry[]>()
  const top: ThreadEntry[] = []
  for (const entry of entries) {
    const parentId =
      (entry.kind === 'message' || entry.kind === 'reasoning' || entry.kind === 'tool') &&
      entry.parentItemId !== undefined &&
      entry.parentItemId !== entry.id &&
      toolIds.has(entry.parentItemId)
        ? entry.parentItemId
        : undefined
    if (parentId === undefined) {
      top.push(entry)
    } else {
      const siblings = childrenOf.get(parentId)
      if (siblings) siblings.push(entry)
      else childrenOf.set(parentId, [entry])
    }
  }

  // Pass 2 — activity groups. `held` is reasoning seen after a tool: it joins the run only when
  // another tool follows, so a turn's trailing thought stays on screen.
  const blocks: ThreadBlock[] = []
  let run: Array<ToolCardBlock | EntryBlock> = []
  let held: EntryBlock[] = []
  const flushRun = () => {
    const tools = run.flatMap((block) => (block.kind === 'tool-card' ? [block.item] : []))
    if (tools.length >= 2) {
      const current = [...tools].reverse().find((item) => item.status === 'running' || item.status === 'pending')
      blocks.push({
        kind: 'activity',
        id: `activity:${tools[0]!.id}`,
        blocks: run,
        tools,
        summary: activitySummary(tools),
        ...(current !== undefined ? { current } : {}),
        failed: tools.filter((item) => item.status === 'failed').length,
      })
    } else {
      blocks.push(...run)
    }
    blocks.push(...held)
    run = []
    held = []
  }
  for (const entry of top) {
    // A tool that adopted children is a container (a Task card) — never grouped away.
    if (isTool(entry) && !childrenOf.has(entry.id)) {
      run.push(...held, { kind: 'tool-card', id: entry.id, item: entry, children: [] })
      held = []
    } else if (entry.kind === 'reasoning' && run.length > 0) {
      held.push({ kind: 'entry', id: entry.id, entry })
    } else {
      flushRun()
      if (isTool(entry)) {
        blocks.push({ kind: 'tool-card', id: entry.id, item: entry, children: childrenOf.get(entry.id) ?? [] })
      } else {
        blocks.push({ kind: 'entry', id: entry.id, entry })
      }
    }
  }
  flushRun()

  // Pass 3 — note groups.
  const out: ThreadBlock[] = []
  let notes: ThreadNote[] = []
  const flushNotes = () => {
    if (notes.length >= 2) {
      out.push({
        kind: 'note-group',
        id: `notes:${notes[0]!.id}`,
        notes,
        warnings: notes.filter(isWarningNote),
        summary: noteGroupSummary(notes),
      })
    } else {
      out.push(...notes.map((note): EntryBlock => ({ kind: 'entry', id: note.id, entry: note })))
    }
    notes = []
  }
  for (const block of blocks) {
    if (block.kind === 'entry' && isFoldableNote(block.entry)) {
      notes.push(block.entry)
    } else {
      flushNotes()
      out.push(block)
    }
  }
  flushNotes()

  return out
}

import type { UiToolItem } from '@open-mercato/cezar-api-client'

import type { ThreadEntry } from './thread-state'

/**
 * Pure display grouping over one turn's reduced entries (spec §"Task thread"; the opencode
 * `groupParts()` consensus). A pre-filter (plan-kind tools are the plan dock's, never the
 * thread's — #382), then three passes, in this order:
 *
 *  1. **Sub-agent nesting** — entries whose `parentItemId` names a tool item in the same turn
 *     move under that tool's card (one level; an orphaned parent id renders at top level).
 *  2. **Context groups** — ≥2 CONSECUTIVE completed read/search tools collapse into one
 *     "Explored N files · M searches" row. Edits and commands never group: the desktop-apps
 *     research consensus is edits/commands visible, exploration folded.
 *  3. **Tool streaks** (the legacy web/app.js behavior, kept) — within a consecutive run of
 *     folded-eligible blocks (completed tool cards and context groups), everything beyond the
 *     last `STREAK_TAIL` folds under "▸ N earlier tool calls". Running/failed/declined cards
 *     are never hidden — they break the run, exactly like any non-tool entry.
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

export interface ContextGroupBlock {
  kind: 'context-group'
  id: string
  tools: UiToolItem[]
  files: number
  searches: number
  label: string
}

export interface StreakBlock {
  kind: 'streak'
  id: string
  /** Individual tool calls folded away (context groups count their members). */
  count: number
  blocks: Array<ToolCardBlock | ContextGroupBlock>
}

export type ThreadBlock = EntryBlock | ToolCardBlock | ContextGroupBlock | StreakBlock

/** How many trailing tool blocks stay visible before older ones fold (legacy STREAK_TAIL). */
export const STREAK_TAIL = 3

const isTool = (entry: ThreadEntry): entry is UiToolItem => entry.kind === 'tool'

/** Context-group membership: exploration tools only, and only once they finished. */
const isGroupable = (item: UiToolItem): boolean =>
  (item.toolKind === 'read' || item.toolKind === 'search') && item.status === 'completed'

const plural = (n: number, noun: string, nouns: string): string => `${n} ${n === 1 ? noun : nouns}`

/** "Explored 2 files · 1 search" — the mockup's ctx-group line. */
export function contextGroupLabel(files: number, searches: number): string {
  const parts: string[] = []
  if (files > 0) parts.push(plural(files, 'file', 'files'))
  if (searches > 0) parts.push(plural(searches, 'search', 'searches'))
  return `Explored ${parts.join(' · ')}`
}

/** "3 earlier tool calls" — the legacy streak toggle line (chevron is the component's). */
export function streakLabel(count: number): string {
  return `${count} earlier tool call${count === 1 ? '' : 's'}`
}

/**
 * Split a protocol-computed tool title ("Ran npm test") into the bold verb and the mono
 * detail for the card trigger. The verb set is exactly what `toolDisplay()` emits; anything
 * else (MCP "server.tool", unknown-tool names) renders whole, as the verb.
 */
const TITLE_VERBS = ['Web search', 'Ran', 'Edit', 'Write', 'Read', 'Search', 'Fetch', 'Task:'] as const

export function splitToolTitle(title: string): { verb: string; detail?: string } {
  for (const verb of TITLE_VERBS) {
    if (title.startsWith(`${verb} `) && title.length > verb.length + 1) {
      return { verb: verb === 'Task:' ? 'Task' : verb, detail: title.slice(verb.length + 1) }
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

  // Pass 2 — context groups over the top level.
  const blocks: ThreadBlock[] = []
  let run: UiToolItem[] = []
  const flushRun = () => {
    if (run.length >= 2) {
      const files = run.filter((item) => item.toolKind === 'read').length
      blocks.push({
        kind: 'context-group',
        id: `group:${run[0]!.id}`,
        tools: run,
        files,
        searches: run.length - files,
        label: contextGroupLabel(files, run.length - files),
      })
    } else {
      for (const item of run) {
        blocks.push({ kind: 'tool-card', id: item.id, item, children: childrenOf.get(item.id) ?? [] })
      }
    }
    run = []
  }
  for (const entry of top) {
    // A tool that adopted children is a container (a Task card) — never groupable away.
    if (isTool(entry) && isGroupable(entry) && !childrenOf.has(entry.id)) {
      run.push(entry)
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

  // Pass 3 — streak folding.
  const foldable = (block: ThreadBlock): block is ToolCardBlock | ContextGroupBlock =>
    block.kind === 'context-group' || (block.kind === 'tool-card' && block.item.status === 'completed')
  const calls = (block: ToolCardBlock | ContextGroupBlock): number =>
    block.kind === 'context-group' ? block.tools.length : 1

  const folded: ThreadBlock[] = []
  let streak: Array<ToolCardBlock | ContextGroupBlock> = []
  const flushStreak = () => {
    if (streak.length > STREAK_TAIL) {
      const hidden = streak.slice(0, streak.length - STREAK_TAIL)
      folded.push({
        kind: 'streak',
        id: `streak:${hidden[0]!.id}`,
        count: hidden.reduce((sum, block) => sum + calls(block), 0),
        blocks: hidden,
      })
      folded.push(...streak.slice(streak.length - STREAK_TAIL))
    } else {
      folded.push(...streak)
    }
    streak = []
  }
  for (const block of blocks) {
    if (foldable(block)) {
      streak.push(block)
    } else {
      flushStreak()
      folded.push(block)
    }
  }
  flushStreak()

  return folded
}

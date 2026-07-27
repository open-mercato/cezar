import type { ToolStatus, UiItem, UiToolItem } from '@open-mercato/cezar-api-client'

import { splitToolTitle } from './thread-groups'
import type { ThreadEntry, ThreadTurn } from './thread-state'

/**
 * The Agents dock's data (spec `.ai/specs/2026-07-20-grouped-subagent-display.md` §Collector,
 * issue #474): pure derivation of "which sub-agents belong to the current fan-out, and what is
 * each one doing" from the reduced turns the thread already renders.
 *
 * A sub-agent is any **parent-less** `toolKind: 'task'` item (spec Q3) — claude `Task`/`Agent`,
 * opencode `subtask`, codex review mode. A task item that itself carries a `parentItemId` is a
 * sub-agent's own spawn, one level down; it is never a dock row. No backend name reaches this
 * module: parity comes from the protocol seam (`AGENT_PROTOCOL.md`), not from per-backend code.
 *
 * Pure and total, like `groupThreadItems` — it keys on the same `parentItemId` relation the
 * thread's nesting pass uses, so the dock and the transcript can never disagree about who owns
 * what.
 */

/** Longest activity line the dock will carry; the row truncates visually on top of this. */
const ACTIVITY_MAX = 120

export interface SubagentSummary {
  /** The task tool item's id — also the sheet's selection key. */
  id: string
  /** "Review the store layer" — the detail half of "Task: …", else the whole title. */
  title: string
  /** claude `subagent_type`/`subagentType`, opencode `agent`; absent for codex. */
  agentType?: string
  status: ToolStatus
  /** Children of kind `tool` — what the row's "N tools" count shows. */
  toolCalls: number
  /** One-line readout from the most recent child; `undefined` ⇒ the row renders "starting…". */
  activity?: string
  /**
   * The agent never finished and never will: it was still `running`/`pending` when the run
   * itself reached a terminal state (cancelled, failed, done).
   *
   * Nothing in the reducer settles in-flight items on `session.ended` — a cancelled run keeps
   * `status: 'running'` in its persisted stream forever. Without this, reopening a cancelled
   * run shows a pulsing `Agents · 0/1` above a dead transcript that can never advance. The
   * status is NOT rewritten (that would fabricate an outcome the wire never reported); the row
   * is marked stalled and rendered as interrupted rather than live.
   */
  stalled?: boolean
}

/** A settled agent is done moving: the dock stops treating the fan-out as live (spec Q6). */
const isSettled = (status: ToolStatus): boolean => status !== 'pending' && status !== 'running'

const isTaskItem = (entry: ThreadEntry): entry is UiToolItem =>
  entry.kind === 'tool' && entry.toolKind === 'task'

/** Dock rows are the parent-less task items only — a nested spawn belongs to its parent's sheet. */
const isRootTaskItem = (entry: ThreadEntry): entry is UiToolItem =>
  isTaskItem(entry) && entry.parentItemId === undefined

/**
 * What can be an agent's child. Mirrors `groupThreadItems` Pass 0: plan-kind tools are the
 * plan dock's, never the thread's (#382) — so a sub-agent's `TodoWrite` must not inflate the
 * row's tool count above what its Task card shows, become the activity line, or render as a
 * raw-JSON card in the sheet.
 */
const isChildCandidate = (entry: ThreadEntry): entry is UiItem =>
  (entry.kind === 'message' || entry.kind === 'reasoning' || entry.kind === 'tool') &&
  !(entry.kind === 'tool' && entry.toolKind === 'plan')

/** The first turn holding any of the given roots — where child scanning must begin. */
function indexOfFirstRoot(turns: ThreadTurn[], rootIds: ReadonlySet<string>): number {
  for (let i = 0; i < turns.length; i += 1) {
    if (turns[i]!.items.some((entry) => isRootTaskItem(entry) && rootIds.has(entry.id))) return i
  }
  return 0
}

/**
 * The agent's declared type, from whichever key the backend used. Read defensively: `input` is
 * raw backend JSON that may still be arriving incrementally, so anything non-string is dropped
 * rather than rendered.
 */
function agentTypeOf(item: UiToolItem): string | undefined {
  const input = item.input
  if (typeof input !== 'object' || input === null) return undefined
  const record = input as Record<string, unknown>
  for (const key of ['subagent_type', 'subagentType', 'agent']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

/** Collapse a child entry to the single line the dock shows as "what this agent is doing now". */
function activityOf(child: ThreadEntry): string | undefined {
  if (child.kind === 'tool') return truncate(child.title)
  if (child.kind === 'message' || child.kind === 'reasoning') {
    // The LAST non-empty line: streamed text grows at the tail, so the newest line is the
    // honest "right now" — the first line froze several deltas ago.
    const lines = child.text.split('\n')
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i]!.trim()
      if (line !== '') return truncate(line)
    }
  }
  return undefined
}

function truncate(text: string): string {
  return text.length > ACTIVITY_MAX ? `${text.slice(0, ACTIVITY_MAX - 1).trimEnd()}…` : text
}

/**
 * The dock's rows, in stream order — or `[]` when there is nothing to dock.
 *
 * The **anchor** is the most recent turn holding parent-less task items. It yields rows only
 * while it is the latest turn *or* any of its agents is still unsettled (spec Q6): a steering
 * message mid-fan-out opens a new turn, and the dock must not vanish while agents still run.
 * Once every agent settles and a newer turn exists, the dock yields to the transcript.
 *
 * Children are gathered from the first turn that contributes a row through the last turn —
 * output produced after a steering message still belongs to the agent that produced it, and a
 * carried-over agent owns children recorded back in its original turn.
 */
export function collectSubagents(turns: ThreadTurn[], runIsTerminal = false): SubagentSummary[] {
  const anchorIndex = findLastIndex(turns, (turn) => turn.items.some(isRootTaskItem))
  if (anchorIndex === -1) return []

  // The anchor turn's agents, plus earlier turns that are still working.
  //
  // Anchoring on the newest turn alone would drop a live fan-out the moment the main agent
  // spawned one more `Task` in a later turn — the dock would read `0/1` while three agents
  // were still running, which is precisely what Q6 exists to prevent. But the carry-over has
  // to obey two rules that are easy to get wrong:
  //
  //  - **Whole turns, never individual items.** Carrying only the *unsettled* items would make
  //    a row vanish the instant it finished and the denominator count DOWN (3 → 2 → 1, never
  //    reaching N/N), and a `failed` agent would disappear instead of keeping its glyph. The
  //    spec asks for stable rows and an odometer that only grows.
  //
  //    The guarantee this buys is monotonicity **within a fan-out episode**, not across the
  //    whole run: when the carried turn finally settles in full, the walk stops carrying it and
  //    the dock re-scopes to the current fan-out (`1/3` → `0/1`). That step is deliberate — the
  //    earlier fan-out really is history at that point — and it happens at a turn boundary
  //    rather than mid-flight, which is what made the per-item version incoherent.
  //  - **Bounded by the last finished fan-out.** Walking the whole transcript would let a
  //    single stranded agent (overlapping opencode subtasks can leave one `running` forever —
  //    a known mapper limitation) inject itself into every later fan-out, pin the dock open
  //    for the rest of the run, and hijack the collapsed head with its stale activity. Stop at
  //    the first earlier turn whose fan-out is entirely settled: that turn is history.
  const live = (item: UiToolItem): boolean => !runIsTerminal && !isSettled(item.status)
  const carried: UiToolItem[] = []
  for (let i = anchorIndex - 1; i >= 0; i -= 1) {
    const turnRoots = turns[i]!.items.filter(isRootTaskItem)
    if (turnRoots.length === 0) continue // a steering turn carries no agents — look past it
    if (!turnRoots.some(live)) break // a finished fan-out bounds the lookback
    carried.unshift(...turnRoots)
  }
  const roots = [...carried, ...turns[anchorIndex]!.items.filter(isRootTaskItem)]
  const isLatestTurn = anchorIndex === turns.length - 1
  if (!isLatestTurn && !roots.some(live)) return []

  // Children by parent id. Scanned from the FIRST turn that contributes a row (not the
  // anchor): an agent carried over from an earlier turn owns children recorded back there
  // too. An id that names no root is ignored — exactly as `groupThreadItems` renders such an
  // orphan at top level.
  const rootIds = new Set(roots.map((item) => item.id))
  const firstIndex = carried.length > 0 ? indexOfFirstRoot(turns, rootIds) : anchorIndex
  const childrenOf = new Map<string, ThreadEntry[]>()
  for (let i = firstIndex; i < turns.length; i += 1) {
    for (const entry of turns[i]!.items) {
      if (!isChildCandidate(entry)) continue
      const parentId = entry.parentItemId
      if (parentId === undefined || !rootIds.has(parentId)) continue
      const siblings = childrenOf.get(parentId)
      if (siblings) siblings.push(entry)
      else childrenOf.set(parentId, [entry])
    }
  }

  return roots.map((item) => summarize(item, childrenOf.get(item.id) ?? [], runIsTerminal))
}

/** The one place a `SubagentSummary` is built — the dock and the sheet must never disagree. */
function summarize(item: UiToolItem, children: ThreadEntry[], runIsTerminal: boolean): SubagentSummary {
  const summary: SubagentSummary = {
    id: item.id,
    title: splitToolTitle(item.title).detail ?? item.title,
    status: item.status,
    toolCalls: children.filter((child) => child.kind === 'tool').length,
  }
  const agentType = agentTypeOf(item)
  if (agentType !== undefined) summary.agentType = agentType
  if (runIsTerminal && !isSettled(item.status)) summary.stalled = true
  // Walk back from the newest child: a child that carries no line (an image, a blank
  // message) must not blank the row when an older child still has something to say.
  for (let i = children.length - 1; i >= 0; i -= 1) {
    const activity = activityOf(children[i]!)
    if (activity !== undefined) {
      summary.activity = activity
      break
    }
  }
  return summary
}

/**
 * The collapsed head's "N/M" odometer. `failed`/`declined` agents count toward the denominator
 * but never the numerator — a fan-out that lost an agent must not read as fully done, and the
 * row keeps its danger glyph either way (spec §Edge Cases).
 */
export function subagentCounts(agents: SubagentSummary[]): { done: number; total: number } {
  return {
    done: agents.filter((agent) => agent.status === 'completed').length,
    total: agents.length,
  }
}

/**
 * The one-line readout for an agent, used by BOTH the collapsed head and the expanded row so
 * the two can never tell different stories about the same agent. A stalled agent is not
 * starting — the run ended under it, and the transcript will never move again.
 */
export function subagentActivityText(agent: SubagentSummary): string {
  return agent.activity ?? (agent.stalled === true ? 'never finished' : 'starting…')
}

/**
 * What the collapsed head names: the first agent still working, else the first row.
 *
 * Deliberately NOT stalled-aware: `stalled` is only ever set when the run is terminal, and on a
 * terminal run every agent is either settled or stalled — so a "skip the stalled ones" filter
 * could never change the outcome. The head and the row are kept consistent by both rendering
 * `subagentActivityText`, not by picking a different agent.
 */
export function activeSubagent(agents: SubagentSummary[]): SubagentSummary | undefined {
  return agents.find((agent) => !isSettled(agent.status)) ?? agents[0]
}

/** `Array.prototype.findLastIndex` needs a newer lib target than the cockpit's tsconfig sets. */
function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (predicate(items[i]!)) return i
  }
  return -1
}

/**
 * One agent by id, WITHOUT the dock's visibility rule.
 *
 * The sheet must outlive the dock: a user who opens a drill-down and then sends a message
 * opens a new turn, which can hide the dock (Q6) — and reading the open panel out from under
 * them because a *different* surface decided to yield would be inexcusable. So the sheet
 * resolves its agent from the turns directly, and closes only when the user closes it.
 */
export function findSubagent(
  turns: ThreadTurn[],
  id: string,
  runIsTerminal = false,
): SubagentSummary | undefined {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const item = turns[i]!.items.find((entry): entry is UiToolItem => entry.id === id && isRootTaskItem(entry))
    if (item === undefined) continue
    // The SAME summarizer the dock row uses — the sheet's header must not disagree with the
    // row the user clicked (and must carry `activity` rather than a structural blank).
    return summarize(item, subagentChildren(turns, id), runIsTerminal)
  }
  return undefined
}

/**
 * The children the sheet renders for one agent — the same cross-turn relation the dock counts,
 * exposed so the drill-down and the row count can never drift apart.
 */
export function subagentChildren(turns: ThreadTurn[], parentId: string): ThreadEntry[] {
  const anchorIndex = turns.findIndex((turn) =>
    turn.items.some((entry) => entry.id === parentId && isRootTaskItem(entry)),
  )
  if (anchorIndex === -1) return []
  const children: ThreadEntry[] = []
  for (let i = anchorIndex; i < turns.length; i += 1) {
    for (const entry of turns[i]!.items) {
      if (!isChildCandidate(entry)) continue
      if (entry.parentItemId === parentId && entry.id !== parentId) children.push(entry)
    }
  }
  return children
}

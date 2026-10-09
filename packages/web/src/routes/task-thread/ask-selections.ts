import type { ThreadAsk } from './thread-state'

/**
 * The picks on an unanswered multi-question ask card (#1247), held outside the card.
 *
 * The card is a thread row, and a row does not live as long as its question: a virtualized
 * thread unmounts every row that scrolls out of view, crossing the virtualization threshold
 * replaces the rows container, and leaving the task unmounts the whole thread. Component state
 * died with each of those, so a four-question card came back with its earlier picks silently
 * gone and Send disabled for a reason nobody could see.
 *
 * In memory for the life of the tab, keyed by run and ask: a remount within the SPA is the
 * failure, and a reload re-renders the card fresh, which is honest. An entry is dropped when
 * its ask resolves, so the map holds only questions still waiting for an answer.
 *
 * The key carries the questions themselves, not only the ask id: Codex names its asks
 * `codex-<rpc id>`, and that counter restarts with every app-server process, so a Continue can
 * mint a second `codex-0` in the same run. Without the questions in the key, the old card's
 * picks would seed the new one and resolving either would wipe the other.
 */

export type AskSelections = Record<number, string[]>

const store = new Map<string, AskSelections>()

const keyOf = (runId: string, ask: ThreadAsk) =>
  JSON.stringify([
    runId,
    ask.id,
    ask.questions.map((q) => [q.header, q.question, q.options.map((o) => o.label)]),
  ])

export function readAskSelections(runId: string, ask: ThreadAsk): AskSelections {
  return store.get(keyOf(runId, ask)) ?? {}
}

export function writeAskSelections(runId: string, ask: ThreadAsk, selections: AskSelections): void {
  store.set(keyOf(runId, ask), selections)
}

export function forgetAskSelections(runId: string, ask: ThreadAsk): void {
  store.delete(keyOf(runId, ask))
}

/** Test isolation. */
export function resetAskSelections(): void {
  store.clear()
}

import { useCallback, useRef, useState } from 'react'

/**
 * State that survives a remount, keyed by whatever identifies the view instance.
 *
 * The workspace needs this because switching saved layouts UNMOUNTS the columns of the layout
 * you left (spec `.ai/specs/2026-10-07-task-workspace.md` §5.4 asks that each layout's view state
 * — scroll position, file selection — come back when you switch to it again), and keeping every
 * layout's columns mounted is not an option: a Conversation column subscribes to a transcript.
 *
 * The thread already solves its half this way (`thread-scroll.ts` keeps a module-level scroll
 * memory, and `run-header.tsx` keeps its phone-disclosure map the same way, for the same reason).
 * This is that pattern, generalised, so the file-tree selections do not each invent it.
 *
 * Session-lifetime only. Nothing here is persisted: it is where you were looking, not what you
 * chose, and a reload legitimately starts fresh.
 */
const memory = new Map<string, unknown>()

/** Forget everything remembered for a key prefix — for a task that was deleted. */
export function forgetViewMemory(prefix: string): void {
  for (const key of [...memory.keys()]) if (key.startsWith(prefix)) memory.delete(key)
}

/** Test seam: start from nothing. */
export function resetViewMemory(): void {
  memory.clear()
}

/**
 * `useState`, but written through to the shared memory when `key` is given.
 *
 * An absent key means "do not remember" — which is what every caller outside a workspace column
 * passes, so the standalone routes behave exactly as they always did.
 */
export function useRememberedState<T>(key: string | undefined, initial: T): [T, (value: T) => void] {
  const read = () => (key !== undefined && memory.has(key) ? (memory.get(key) as T) : initial)
  const [value, setValue] = useState<T>(read)
  // The key can change WITHOUT a remount — a layout renamed, a column reordered — and the old
  // value must not then be written under the new name. Re-read during render rather than in an
  // effect, so the column never paints the previous key's answer for a frame.
  const seen = useRef(key)
  if (seen.current !== key) {
    seen.current = key
    setValue(read())
  }
  const set = useCallback(
    (next: T) => {
      if (key !== undefined) memory.set(key, next)
      setValue(next)
    },
    [key],
  )
  return [value, set]
}

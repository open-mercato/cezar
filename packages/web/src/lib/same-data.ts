/**
 * Structural equality for the plain data the transcript reducers hand to the renderers.
 *
 * WHY IT EXISTS: `reduceThread` is a pure fold over the whole event list, so every live frame
 * (deltas coalesce at ~40 ms server-side) rebuilds the ENTIRE tree — new turn objects, new item
 * objects, new arrays — even though all but the last item are byte-identical to the previous
 * pass. Reference equality therefore says "everything changed" and React re-renders every row of
 * a long thread ~25×/s while an agent works, which is what makes phone scrolling stutter.
 *
 * This compares by VALUE so a memoized row can skip that work. It is deliberately small and
 * fast rather than general:
 *  - `Object.is` first, so unchanged sub-trees (the reducer carries wire objects and strings
 *    through by reference) cost one pointer compare, not a walk;
 *  - plain objects and arrays only — the transcript's data is JSON off the wire, so there are no
 *    cycles, no Dates/Maps/Sets, and never a React element (rendering happens above this).
 *
 * Anything else (a class instance, a function) falls back to reference equality, which is the
 * safe answer for a memo comparator: "not equal" only costs a render.
 */
export function sameData(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    for (let index = 0; index < a.length; index += 1) {
      if (!sameData(a[index], b[index])) return false
    }
    return true
  }

  // Only plain objects: a comparator that walked a class instance's fields could report two
  // different instances equal, and nothing in the transcript is one.
  if (!isPlainObject(a) || !isPlainObject(b)) return false

  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  for (const key of keys) {
    if (!Object.hasOwn(b, key)) return false
    if (!sameData(a[key], b[key])) return false
  }
  return true
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

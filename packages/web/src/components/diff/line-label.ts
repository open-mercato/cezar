import type { DiffLineEnd } from './types'

/**
 * "line 12", "removed line 4", "lines 10–14", "removed line 3 – line 5" — how a line comment names
 * what it covers: in the diff, on its composer chip (spoken), and in the review the agent reads.
 * Its own module, free of React, so a host can use it without pulling the lazy renderer chunk in.
 */
export function describeLines(end: DiffLineEnd, start?: DiffLineEnd): string {
  const one = (at: DiffLineEnd) => `${at.side === 'old' ? 'removed ' : ''}line ${at.line}`
  if (!start || (start.side === end.side && start.line === end.line)) return one(end)
  if (start.side === end.side) return `${end.side === 'old' ? 'removed ' : ''}lines ${start.line}–${end.line}`
  return `${one(start)} – ${one(end)}`
}

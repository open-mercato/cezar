import type { ChangesQuery } from '@open-mercato/cezar-contract';

/** `?base=` → the anchor `collectChanges` takes (#2248). `merge-base` and an absent value are not
 *  an override: each route keeps its own default anchor. */
export function changesAnchor(base: ChangesQuery['base']): { kind: 'worktree' } | { kind: 'ref'; ref: string } | undefined {
  if (base === undefined || base === 'merge-base') return undefined;
  if (base === 'worktree') return { kind: 'worktree' };
  return { kind: 'ref', ref: base };
}

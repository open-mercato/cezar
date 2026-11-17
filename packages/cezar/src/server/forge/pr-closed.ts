/**
 * The moment a GitHub read shows a pull request merged or closed. Reads that already happen (chip
 * statuses, merge state, automation polls) report here; nothing asks GitHub on this bus's behalf.
 * Managers listen to close their merge cards for that PR (#2241 follow-up).
 */
export type ClosedPrState = 'merged' | 'closed';

/** `verify`: the read named its repo by remote, not as the card's reads do, so confirm first. */
type Listener = (root: string, number: number, state: ClosedPrState, verify: boolean) => void;

const listeners = new Set<Listener>();

export function onPrClosed(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function reportPrClosed(root: string, number: number, state: ClosedPrState, { verify = false }: { verify?: boolean } = {}): void {
  for (const listener of listeners) {
    try {
      listener(root, number, state, verify);
    } catch {
      // A listener's failure is its own; the read that reported it must not fail.
    }
  }
}

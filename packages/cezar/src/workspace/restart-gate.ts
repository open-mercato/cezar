/**
 * What "restart when idle" waits for, and the hold that keeps new work from starting meanwhile.
 *
 * The parallel-cap count (`WorkspaceSemaphore.idle`) answered this before, and it is the wrong
 * question: a task monitoring its CI or its children holds no slot, a manager turn holds none,
 * and neither does a setup terminal — so a restart "when idle" cut all three off. Each kind of
 * work registers a source here instead, and the restart fires only when every source is empty.
 */
export type RestartBlockerKind = 'task' | 'manager' | 'setup';

/** One kind of busy work, merged across sources: `names` are the first few of `count`. */
export interface RestartBlocker {
  kind: RestartBlockerKind;
  count: number;
  names: string[];
}

const KIND_NOUN: Record<RestartBlockerKind, [string, string]> = {
  task: ['task', 'tasks'],
  manager: ['manager', 'managers'],
  setup: ['agent setup', 'agent setups'],
};

/** How the cockpit reads one blocker: `2 tasks (Fix login, Docs)`, `5 tasks (A, B, C and 2 more)`. */
export function describeRestartBlocker({ kind, count, names }: RestartBlocker): string {
  const [one, many] = KIND_NOUN[kind];
  const more = count - names.length;
  const listed = names.length > 0 ? ` (${names.join(', ')}${more > 0 ? ` and ${more} more` : ''})` : '';
  return `${count} ${count === 1 ? one : many}${listed}`;
}

/** One source's work: a kind and the names of what is busy (one entry per item). */
export interface RestartBlockerItems {
  kind: RestartBlockerKind;
  names: readonly string[];
}

/** Names kept per kind on the wire — the line reads "Fix login, Docs and 3 more". */
const NAMES_SHOWN = 3;
const ORDER: readonly RestartBlockerKind[] = ['task', 'manager', 'setup'];

export class RestartGate {
  private readonly sources = new Set<() => readonly RestartBlockerItems[]>();
  private readonly releaseListeners = new Set<() => void>();
  private held = false;

  /** Join the idle check. Returns the unregister handle. */
  addSource(source: () => readonly RestartBlockerItems[]): () => void {
    this.sources.add(source);
    return () => {
      this.sources.delete(source);
    };
  }

  /** Everything a restart would interrupt now, merged by kind. A throwing source counts as busy:
   *  a check that cannot answer must not let a restart through. */
  blockers(): RestartBlocker[] {
    const byKind = new Map<RestartBlockerKind, string[]>();
    for (const source of this.sources) {
      let items: readonly RestartBlockerItems[];
      try {
        items = source();
      } catch {
        items = [{ kind: 'task', names: ['(could not check)'] }];
      }
      for (const item of items) {
        if (item.names.length === 0) continue;
        byKind.set(item.kind, [...(byKind.get(item.kind) ?? []), ...item.names]);
      }
    }
    return ORDER.flatMap((kind) => {
      const names = byKind.get(kind);
      return names ? [{ kind, count: names.length, names: names.slice(0, NAMES_SHOWN) }] : [];
    });
  }

  idle(): boolean {
    return this.blockers().length === 0;
  }

  /** A restart is pending: new tasks and timed manager turns wait until it fires or is cancelled. */
  get holding(): boolean {
    return this.held;
  }

  hold(): void {
    this.held = true;
  }

  /** Cancelled or failed: let held work start again. */
  release(): void {
    if (!this.held) return;
    this.held = false;
    for (const listener of [...this.releaseListeners]) {
      try {
        listener();
      } catch {
        // one listener must not keep the others' work held
      }
    }
  }

  onRelease(listener: () => void): () => void {
    this.releaseListeners.add(listener);
    return () => {
      this.releaseListeners.delete(listener);
    };
  }
}

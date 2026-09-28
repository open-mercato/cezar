import { randomUUID } from 'node:crypto';
import type { TrackerFailure, TrackerWatchInput, TrackerWatchHandle, TrackerWatchSnapshot } from '@open-mercato/cezar-contract';
import type { SocketHub } from '../ws.ts';
import type { TrackerDriver } from './types.ts';

type Project = { root: string; dataDir: string };
type Service = { driver(root: string, dataDir: string): Promise<TrackerDriver | TrackerFailure> };
type Entry = {
  id: string; key: string; project: Project; input: TrackerWatchInput;
  state: TrackerWatchSnapshot; listeners: Set<() => void>;
  timer?: ReturnType<typeof setTimeout>; expiry?: ReturnType<typeof setTimeout>;
  removeTopic?: () => void; pending?: Promise<void>; nextAt: number;
  failures: number; terminal: boolean; dead: boolean;
};
const INTERVAL = 60_000;
const changed = (): TrackerFailure => ({ available: false, code: 'source_changed', reason: 'The project connection changed. Reopen the tracker list.' });
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** One publisher per project/revision/filter set, shared by WS and authenticated HTTP readers. */
export class TrackerWatches {
  private entries = new Map<string, Entry>();
  constructor(private service: Service, private hub?: SocketHub) {}

  async open(project: Project, input: TrackerWatchInput): Promise<TrackerWatchHandle> {
    const driver = await this.service.driver(project.root, project.dataDir);
    if ('available' in driver || !same(driver.association, input.association)) throw new Error('Tracker connection changed. Reload this view.');
    const normalized = { ...input, association: driver.association, query: input.query.trim(), labels: [...new Set(input.labels)].sort() };
    const key = JSON.stringify([project.root, project.dataDir, normalized]);
    let entry = [...this.entries.values()].find(e => e.key === key && !e.terminal);
    if (!entry) {
      if (this.entries.size >= 100) throw new Error('Too many tracker views. Close an unused view and retry.');
      entry = { id: randomUUID(), key, project, input: normalized, state: { version: 0, checking: false, checkedAt: null, result: null }, listeners: new Set(), nextAt: 0, failures: 0, terminal: false, dead: false };
      this.entries.set(entry.id, entry);
      const current = entry;
      if (this.hub) current.removeTopic = this.hub.registerTopic(`tracker:${current.id}`, {
        snapshot: async () => ({ version: current.state.version }),
        start: publish => this.subscribe(current.id, () => publish({ version: current.state.version })),
      });
      this.expire(current);
    }
    return { id: entry.id, topic: `tracker:${entry.id}` };
  }

  snapshot(project: Project, id: string): TrackerWatchSnapshot | null {
    const entry = this.entries.get(id);
    return entry && entry.project.root === project.root && entry.project.dataDir === project.dataDir ? entry.state : null;
  }

  /** Revalidate even retained snapshots: external credential edits must not expose an old page. */
  async read(project: Project, id: string): Promise<TrackerWatchSnapshot | null> {
    const entry = this.entries.get(id);
    if (!entry || !this.snapshot(project, id)) return null;
    if (!entry.terminal && !await this.current(entry)) this.invalidate(entry);
    return this.snapshot(project, id);
  }

  subscribe(id: string, listener: () => void): () => void {
    const entry = this.entries.get(id);
    if (!entry) return () => {};
    clearTimeout(entry.expiry);
    entry.listeners.add(listener);
    if (entry.listeners.size === 1) this.arm(entry);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.listeners.delete(listener);
      if (!entry.listeners.size) { clearTimeout(entry.timer); this.expire(entry); }
    };
  }

  /** HTTP long read owns demand only until change, timeout or request cancellation. */
  async wait(project: Project, id: string, after: number, signal: AbortSignal): Promise<TrackerWatchSnapshot | null> {
    if (signal.aborted || !await this.read(project, id)) return null;
    await new Promise<void>(resolve => {
      let off = () => {};
      const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); off(); resolve(); };
      const timer = setTimeout(done, 25_000);
      off = this.subscribe(id, () => { if (this.snapshot(project, id)?.version !== after) done(); });
      signal.addEventListener('abort', done, { once: true });
      if (signal.aborted || this.snapshot(project, id)?.version !== after) done();
    });
    return this.read(project, id);
  }

  async refresh(project: Project, id: string): Promise<TrackerWatchSnapshot | null> {
    const entry = this.entries.get(id);
    if (!entry || !await this.read(project, id)) return null;
    // Manual refresh bypasses normal cadence, never an error cooldown or an in-flight request.
    if (!entry.terminal && (!entry.failures || Date.now() >= entry.nextAt)) await this.check(entry);
    return this.snapshot(project, id);
  }

  invalidateProject(root: string): void {
    for (const entry of this.entries.values()) if (entry.project.root === root) this.invalidate(entry);
  }
  close(): void { for (const entry of [...this.entries.values()]) this.remove(entry); }

  private emit(entry: Entry, patch: Partial<TrackerWatchSnapshot>): void {
    if (entry.dead) return;
    entry.state = { ...entry.state, ...patch, version: entry.state.version + 1 };
    for (const listener of [...entry.listeners]) listener();
  }
  private async current(entry: Entry): Promise<boolean> {
    const driver = await this.service.driver(entry.project.root, entry.project.dataDir);
    return !('available' in driver) && same(driver.association, entry.input.association);
  }
  private invalidate(entry: Entry): void {
    entry.terminal = true;
    clearTimeout(entry.timer);
    this.emit(entry, { checking: false, result: changed(), checkedAt: null });
  }
  private expire(entry: Entry): void {
    clearTimeout(entry.expiry);
    entry.expiry = setTimeout(() => this.remove(entry), 120_000);
    entry.expiry.unref?.();
  }
  private remove(entry: Entry): void {
    entry.dead = true; clearTimeout(entry.timer); clearTimeout(entry.expiry);
    this.entries.delete(entry.id); entry.removeTopic?.(); entry.listeners.clear();
    clearTimeout(entry.expiry);
  }
  private arm(entry: Entry): void {
    clearTimeout(entry.timer);
    if (entry.dead || entry.terminal || entry.pending || !entry.listeners.size) return;
    entry.timer = setTimeout(() => { void this.check(entry); }, Math.max(0, entry.nextAt - Date.now()));
    entry.timer.unref?.();
  }
  private check(entry: Entry): Promise<void> {
    if (entry.pending) return entry.pending;
    if (entry.dead || entry.terminal) return Promise.resolve();
    clearTimeout(entry.timer);
    this.emit(entry, { checking: true });
    entry.pending = (async () => {
      try {
        const driver = await this.service.driver(entry.project.root, entry.project.dataDir);
        if ('available' in driver || !same(driver.association, entry.input.association)) { this.invalidate(entry); return; }
        const query = { state: entry.input.state, labels: entry.input.labels, limit: 50, refresh: '1' as const };
        const result = entry.input.query ? await driver.searchItems({ ...query, q: entry.input.query }) : await driver.listIssues(query);
        if (entry.dead || entry.terminal) return;
        if (!await this.current(entry)) { this.invalidate(entry); return; }
        if (entry.dead || entry.terminal) return;
        const response = !result.available && result.code === 'invalid_cursor'
          ? { available: false as const, code: 'unavailable' as const, reason: 'Could not refresh this list.' } : result;
        entry.failures = response.available ? 0 : entry.failures + 1;
        const delay = response.available ? INTERVAL : Math.max(Math.min(INTERVAL * 2 ** (entry.failures - 1), 300_000), (response.retryAfterSeconds ?? 0) * 1000);
        entry.nextAt = Date.now() + delay;
        this.emit(entry, { checking: false, result: response, ...(response.available ? { checkedAt: new Date().toISOString() } : {}) });
      } catch {
        entry.failures++;
        entry.nextAt = Date.now() + Math.min(INTERVAL * 2 ** (entry.failures - 1), 300_000);
        this.emit(entry, { checking: false, result: { available: false, code: 'unavailable', reason: 'Could not check the tracker. Retrying automatically.' } });
      }
    })().finally(() => { entry.pending = undefined; this.arm(entry); });
    return entry.pending;
  }
}

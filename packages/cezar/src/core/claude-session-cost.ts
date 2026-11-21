import { closeSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Claude's `total_cost_usd` is the SESSION's running total: it carries over `--resume` and grows
 * across turns of one process. cezar sums it per turn, so a resumed session reported its whole
 * history as each turn's cost (spec 2026-11-21-manager-short-sessions-and-memory § 1.5).
 * `ClaudeSessionCost` turns those totals into this process's own increments.
 */

/** Last total seen per session in this server process; bounded, oldest out first. */
const lastTotals = new Map<string, number>();
const LAST_TOTALS_CAP = 1000;
/** A turn's `cost-state` record is written at its end, so the transcript's tail holds the last one. */
const TAIL_BYTES = 1024 * 1024;

function remember(sessionId: string, total: number): void {
  lastTotals.delete(sessionId);
  lastTotals.set(sessionId, total);
  if (lastTotals.size > LAST_TOTALS_CAP) lastTotals.delete(lastTotals.keys().next().value!);
}

/** Claude's project directory name for a cwd: every non-alphanumeric character becomes `-`. */
export const claudeProjectSlug = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-');

/** The session's last recorded `totalCostUSD`, read from its transcript tail; undefined when unknown. */
export function transcriptCostTotal(sessionId: string, cwd: string, configDir: string | undefined): number | undefined {
  const root = join(configDir || join(homedir(), '.claude'), 'projects');
  const cwds = [cwd];
  try {
    const real = realpathSync(cwd);
    if (real !== cwd) cwds.push(real);
  } catch {
    // a vanished cwd: try the path as given
  }
  for (const dir of cwds) {
    const total = lastCostState(join(root, claudeProjectSlug(dir), `${sessionId}.jsonl`), sessionId);
    if (total !== undefined) return total;
  }
  return undefined;
}

function lastCostState(path: string, sessionId: string): number | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      if (!line.includes('"cost-state"')) continue;
      try {
        const entry = JSON.parse(line) as { type?: unknown; sessionId?: unknown; totalCostUSD?: unknown };
        if (entry.type === 'cost-state' && entry.sessionId === sessionId && typeof entry.totalCostUSD === 'number' && Number.isFinite(entry.totalCostUSD)) {
          return entry.totalCostUSD;
        }
      } catch {
        // the first line of the tail may be cut
      }
    }
  } catch {
    // no transcript: the caller falls back
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return undefined;
}

export class ClaudeSessionCost {
  private last: number | undefined;

  constructor(
    private sessionId: string | undefined,
    resume: boolean,
    cwd: string,
    configDir: string | undefined,
  ) {
    if (!sessionId) this.last = 0;
    else if (!resume) this.last = 0;
    else this.last = lastTotals.get(sessionId) ?? transcriptCostTotal(sessionId, cwd, configDir);
  }

  /** The session id Claude reported, when cezar did not pin one. */
  identify(sessionId: string): void {
    this.sessionId ??= sessionId;
  }

  /** This result's own cost. An unknown baseline keeps the total (the old behavior); a total below
   *  the baseline means Claude started counting afresh. */
  increment(total: number): number {
    const base = this.last;
    this.last = total;
    if (this.sessionId) remember(this.sessionId, total);
    if (base === undefined || total < base) return total;
    return total - base;
  }
}

/** Test seam: forget every remembered total. */
export function resetClaudeSessionCosts(): void {
  lastTotals.clear();
}

import { closeSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Claude's `total_cost_usd` and `modelUsage` are the SESSION's running totals: they carry over
 * `--resume` and grow across turns of one process. cezar sums them per turn, so a resumed session
 * reported its whole history as each turn's cost (spec 2026-11-21-manager-short-sessions-and-memory § 1.5).
 * `ClaudeSessionCost` turns those totals into this process's own increments.
 */

/** Per-model running totals, as Claude's `modelUsage` and `cost-state` records spell them. */
export type ClaudeModelTotals = Record<string, Record<string, unknown>>;
interface SessionTotals {
  total: number;
  models?: ClaudeModelTotals;
}

/** Last totals seen per session in this server process; bounded, oldest out first. */
const lastTotals = new Map<string, SessionTotals>();
const LAST_TOTALS_CAP = 1000;
/** A turn's `cost-state` record is written at its end, so the transcript's tail holds the last one. */
const TAIL_BYTES = 1024 * 1024;

function remember(sessionId: string, totals: SessionTotals): void {
  lastTotals.delete(sessionId);
  lastTotals.set(sessionId, totals);
  if (lastTotals.size > LAST_TOTALS_CAP) lastTotals.delete(lastTotals.keys().next().value!);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isTotal = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function modelTotals(raw: unknown): ClaudeModelTotals | undefined {
  if (!isRecord(raw)) return undefined;
  const models: ClaudeModelTotals = {};
  for (const [model, entry] of Object.entries(raw)) if (isRecord(entry)) models[model] = entry;
  return models;
}

/** Claude's project directory name for a cwd: every non-alphanumeric character becomes `-`.
 *  Claude shortens very long paths; a missed transcript only falls back to the old behavior. */
export const claudeProjectSlug = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-');

/** The session's last recorded `totalCostUSD`, read from its transcript tail; undefined when unknown. */
export function transcriptCostTotal(sessionId: string, cwd: string, configDir: string | undefined): number | undefined {
  return transcriptTotals(sessionId, cwd, configDir)?.total;
}

function transcriptTotals(sessionId: string, cwd: string, configDir: string | undefined): SessionTotals | undefined {
  const root = join(configDir || join(homedir(), '.claude'), 'projects');
  const cwds = [cwd];
  try {
    const real = realpathSync(cwd);
    if (real !== cwd) cwds.push(real);
  } catch {
    // a vanished cwd: try the path as given
  }
  for (const dir of cwds) {
    const totals = lastCostState(join(root, claudeProjectSlug(dir), `${sessionId}.jsonl`), sessionId);
    if (totals !== undefined) return totals;
  }
  return undefined;
}

function lastCostState(path: string, sessionId: string): SessionTotals | undefined {
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
        const entry = JSON.parse(line) as { type?: unknown; sessionId?: unknown; totalCostUSD?: unknown; modelUsage?: unknown };
        if (entry.type === 'cost-state' && entry.sessionId === sessionId && isTotal(entry.totalCostUSD)) {
          const models = modelTotals(entry.modelUsage);
          return { total: entry.totalCostUSD, ...(models ? { models } : {}) };
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

/** The running counters in a `modelUsage` entry; `contextWindow` and `maxOutputTokens` are limits, not totals. */
const MODEL_COUNTERS = new Set(['inputTokens', 'outputTokens', 'thinkingTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'webSearchRequests', 'costUSD']);

/** Each counter of each model minus its baseline; a field without a usable baseline stays as reported. */
function modelIncrements(models: ClaudeModelTotals, base: ClaudeModelTotals | undefined): ClaudeModelTotals {
  const out: ClaudeModelTotals = {};
  for (const [model, entry] of Object.entries(models)) {
    const before = base?.[model];
    const next: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(entry)) {
      const prior = before?.[key];
      next[key] = MODEL_COUNTERS.has(key) && isTotal(value) && isTotal(prior) && value >= prior ? value - prior : value;
    }
    out[model] = next;
  }
  return out;
}

export class ClaudeSessionCost {
  private last: SessionTotals | undefined;

  constructor(
    private sessionId: string | undefined,
    resume: boolean,
    cwd: string,
    configDir: string | undefined,
  ) {
    if (!sessionId || !resume) this.last = { total: 0 };
    else this.last = lastTotals.get(sessionId) ?? transcriptTotals(sessionId, cwd, configDir);
  }

  /** The session id Claude reported, when cezar did not pin one. */
  identify(sessionId: string): void {
    this.sessionId ??= sessionId;
  }

  /** This result's own cost. An unknown baseline keeps the total (the old behavior); a total below
   *  the baseline means Claude started counting afresh. */
  increment(total: number): number {
    return this.turn(total, undefined).usd;
  }

  /** A `result` frame with `total_cost_usd` and `modelUsage` rewritten as this turn's increments. */
  result<T extends { total_cost_usd?: unknown; modelUsage?: unknown }>(msg: T): T {
    if (!isTotal(msg.total_cost_usd)) return msg;
    const { usd, models } = this.turn(msg.total_cost_usd, modelTotals(msg.modelUsage));
    return { ...msg, total_cost_usd: usd, ...(models ? { modelUsage: models } : {}) };
  }

  private turn(total: number, models: ClaudeModelTotals | undefined): { usd: number; models?: ClaudeModelTotals } {
    const base = this.last;
    // `models` absent: keep the baseline's, so a later frame that carries them still diffs correctly.
    this.last = { total, ...((models ?? base?.models) ? { models: models ?? base?.models } : {}) };
    if (this.sessionId) remember(this.sessionId, this.last);
    if (base === undefined || total < base.total) return { usd: total, ...(models ? { models } : {}) };
    return { usd: total - base.total, ...(models ? { models: modelIncrements(models, base.models) } : {}) };
  }
}

/** Test seam: forget every remembered total. */
export function resetClaudeSessionCosts(): void {
  lastTotals.clear();
}

/**
 * The manager's agent chain (spec 2026-11-25-manager-agent-chain): row #1 is the manager's own
 * runner/account/model/effort, rows #2–#4 its `backups`. Pure decisions only; the engine owns state.
 */
import type { Manager, ManagerAgentSwitchReason, ManagerEffort } from '@open-mercato/cezar-contract';
import type { ManagerFailureKind } from './failure.ts';

export interface ChainRow {
  slot: number;
  /** Absent on #1 when the manager follows the workspace default runner. */
  runner?: string;
  agentProfile?: string;
  model?: string;
  effort?: ManagerEffort;
}

/** Why a row cannot answer right now; `until` is when it may be tried again. */
export interface ChainHold {
  until: string;
  reason: Exclude<ManagerAgentSwitchReason, 'back' | 'manual'>;
  /** Failures without a reset in a row: the retry backoff grows with it. */
  streak?: number;
  /** `runner:account`, the queue's key; set on usage limits so tasks see the hold too. */
  accountKey?: string;
}

/** A manager with no backups is today's manager: no chain logic runs at all. */
export const hasChain = (manager: Pick<Manager, 'backups'>): boolean => (manager.backups?.length ?? 0) > 0;

export function chainOf(manager: Pick<Manager, 'runner' | 'agentProfile' | 'model' | 'effort' | 'backups'>): ChainRow[] {
  const first: ChainRow = {
    slot: 0,
    ...(manager.runner ? { runner: manager.runner } : {}),
    ...(manager.agentProfile ? { agentProfile: manager.agentProfile } : {}),
    ...(manager.model ? { model: manager.model } : {}),
    ...(manager.effort ? { effort: manager.effort } : {}),
  };
  return [first, ...(manager.backups ?? []).map((backup, index) => ({ ...backup, slot: index + 1 }))];
}

/** The manager as one row runs it: `drive` reads exactly these four fields. */
export function withRow<T extends Pick<Manager, 'runner' | 'agentProfile' | 'model' | 'effort'>>(manager: T, row: ChainRow): T {
  const { runner: _runner, agentProfile: _agentProfile, model: _model, effort: _effort, ...rest } = manager;
  return {
    ...rest,
    ...(row.runner ? { runner: row.runner } : {}),
    ...(row.agentProfile ? { agentProfile: row.agentProfile } : {}),
    ...(row.model ? { model: row.model } : {}),
    ...(row.effort ? { effort: row.effort } : {}),
  } as T;
}

/** The session key `drive` uses: a transcript belongs to one runner and account. */
export const rowKey = (runner: string, agentProfile: string | undefined): string => `${runner}|${agentProfile ?? ''}`;

/** Failures another account can get around. Anything else (network, busy, a stop) stays on the row. */
export function failoverReason(kind: ManagerFailureKind, limited: boolean): ChainHold['reason'] | undefined {
  if (limited || kind === 'usage-limit') return 'usage-limit';
  if (kind === 'auth') return 'auth';
  if (kind === 'billing') return 'billing';
  if (kind === 'missing-cli') return 'missing-cli';
  return undefined;
}

/** Retries of a row that failed with no reset time: 15 minutes, then an hour. */
export const RETRY_BACKOFF_MS = [15 * 60_000, 60 * 60_000] as const;
/** A usage limit the provider gave no reset for. */
export const UNKNOWN_RESET_MS = 60 * 60_000;

export function holdFor(reason: ChainHold['reason'], previous: ChainHold | undefined, now: number, resetAt?: number): ChainHold {
  if (reason === 'usage-limit' || reason === 'held') {
    return { until: new Date(resetAt && resetAt > now ? resetAt : now + UNKNOWN_RESET_MS).toISOString(), reason };
  }
  const streak = previous && previous.reason === reason ? (previous.streak ?? 1) + 1 : 1;
  const wait = RETRY_BACKOFF_MS[Math.min(streak, RETRY_BACKOFF_MS.length) - 1]!;
  return { until: new Date(now + wait).toISOString(), reason, streak };
}

/**
 * The row a turn starts on: the first open row from the preferred one (#1 with `available`, the
 * active row with `manual`), wrapping round. Every row held: the preferred row, which fails as today.
 */
export function pickRow(
  rows: readonly ChainRow[],
  preferred: number,
  held: (row: ChainRow) => ChainHold | undefined,
): { row: ChainRow; skipped: Array<{ row: ChainRow; hold: ChainHold }> } {
  const start = Math.min(Math.max(preferred, 0), rows.length - 1);
  const order = [...rows.slice(start), ...rows.slice(0, start)];
  const skipped: Array<{ row: ChainRow; hold: ChainHold }> = [];
  for (const row of order) {
    const hold = held(row);
    if (!hold) return { row, skipped };
    skipped.push({ row, hold });
  }
  return { row: rows[start]!, skipped };
}

/** The next row to try after `failed`, never one this turn already tried. */
export function nextRow(
  rows: readonly ChainRow[],
  failed: number,
  attempted: ReadonlySet<number>,
  held: (row: ChainRow) => ChainHold | undefined,
): ChainRow | undefined {
  const order = [...rows.slice(failed + 1), ...rows.slice(0, failed)];
  return order.find((row) => !attempted.has(row.slot) && !held(row));
}

/** The earliest moment any row may answer again, among holds that end. */
export function earliestRelease(holds: ReadonlyArray<ChainHold | undefined>): number | undefined {
  const times = holds.flatMap((hold) => (hold ? [Date.parse(hold.until)] : [])).filter((at) => Number.isFinite(at));
  return times.length > 0 ? Math.min(...times) : undefined;
}

/** The cut-off turn's commands, so the backup does not repeat what already happened. */
export function cutOffNote(label: string, commands: ReadonlyArray<{ summary: string; output?: string }>): string {
  if (commands.length === 0) return '';
  const lines = commands.map((command) => `- ${command.summary}${command.output ? ` → ${command.output.split('\n')[0]?.slice(0, 160)}` : ''}`);
  return `[Your previous agent (${label}) was cut off after running these commands. Do not repeat them; continue from where it stopped.]\n${lines.join('\n')}\n\n`;
}

/** A change to any row, or to the failback choice, answers with #1 from the next turn. */
export function chainChanged(
  before: Pick<Manager, 'runner' | 'agentProfile' | 'model' | 'effort' | 'backups' | 'failback'>,
  after: Pick<Manager, 'runner' | 'agentProfile' | 'model' | 'effort' | 'backups' | 'failback'>,
): boolean {
  return JSON.stringify(chainOf(before)) !== JSON.stringify(chainOf(after)) || before.failback !== after.failback;
}

const REASON_TEXT: Record<ChainHold['reason'], string> = {
  'usage-limit': 'is out of usage limits',
  held: 'is out of usage limits',
  auth: 'can’t sign in',
  billing: 'is out of credits',
  'missing-cli': 'could not start',
};

const clock = (iso: string): string => `${iso.slice(11, 16)} UTC`;

/** `#2 claude · Personal`: the chain number plus the agent and account the user picked. */
export const refName = (ref: { slot: number; runner: string; label?: string; profileId: string }): string =>
  `#${ref.slot + 1} ${ref.runner} · ${ref.label ?? ref.profileId}`;

/** The plain line an older cockpit shows for a switch notice; the structured fields carry the rest. */
export function switchNoticeText(
  from: { slot: number; runner: string; label?: string; profileId: string },
  to: { slot: number; runner: string; label?: string; profileId: string; model?: string },
  reason: ManagerAgentSwitchReason,
  until?: string,
  lost?: ReadonlyArray<'connectors' | 'write'>,
): string {
  if (reason === 'back') return `Back on ${refName(to)}.`;
  if (reason === 'manual') return `Switched back to ${refName(to)}.`;
  const why = `${refName(from)} ${REASON_TEXT[reason]}${until ? ` until ${clock(until)}` : ''}.`;
  const losing = lost?.includes('connectors') ? ` Connectors are off on ${to.runner}.` : '';
  return `${why} Continuing with ${refName(to)}${to.model ? ` (${to.model})` : ''}.${losing}`;
}

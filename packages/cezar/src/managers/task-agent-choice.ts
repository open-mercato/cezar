/**
 * Which agent account a manager's new task runs on. The manager's allowed task accounts are the
 * default, in order; an account waiting out a usage limit is skipped for the next with capacity.
 * Limit state is the workspace's account holds — the same the queue enforces — never a second source.
 */
import type { RunnerId } from '../core/agent-runner.ts';

export interface AccountOption {
  runner: RunnerId;
  /** Absent: the project's automatic account. */
  agentProfile?: string;
  /** The resolved account id the limit is keyed on. */
  account: string;
  label: string;
  /** Epoch ms the account's usage limit resets; absent = capacity now. */
  until?: number;
  /** Set when the manager's list carries roles (spec 2026-11-25-manager-task-routing). */
  role?: 'main' | 'backup';
  /** Tasks running on the account across the workspace. */
  load?: number;
  /** Fresh five-hour used %, a tie-break only; absent = unknown. */
  usage?: number;
}

/** The roles' rules: when Backup accounts take new tasks. */
export interface RoleRouting {
  /** `undefined`: only once every Main is out of limits. A number: also while every Main runs that many. */
  maxRunning?: number;
}

export interface TaskAgentChoice {
  chosen: AccountOption;
  reason: string;
  /** Every open account already runs as many tasks as it may: the task waits for one to free up. */
  busy?: boolean;
  /** Every candidate is out of limits: the task waits in the queue until this instant. */
  queuedUntil?: number;
  /** An explicit account that is out of limits while an allowed one has capacity. */
  warning?: string;
}

const iso = (ms: number) => new Date(ms).toISOString();
export const accountName = (option: Pick<AccountOption, 'runner' | 'label'>) => `${option.runner} ${option.label}`;
export const accountFlags = (option: Pick<AccountOption, 'runner' | 'agentProfile'>) =>
  `--runner ${option.runner}${option.agentProfile ? ` --account ${option.agentProfile}` : ''}`;

/**
 * `candidates` are ordered, preferred first, and already narrowed by explicit flags; `allowed` is
 * every account the manager may use, for naming an alternative to an explicit pick. Never empty.
 */
export function chooseTaskAgent(
  candidates: readonly AccountOption[],
  options: {
    explicitAccount: boolean; fromSettings: boolean; allowed?: readonly AccountOption[]; now: number;
    /** Set when the list carries roles: Main by load, then Backup in order. */
    roles?: RoleRouting;
    /** The flag that narrowed `candidates` below `allowed` (e.g. `--runner codex`), for honest wording. */
    narrowedBy?: string;
  },
): TaskAgentChoice {
  const open = (option: AccountOption) => option.until === undefined || option.until <= options.now;
  const first = candidates[0];
  if (!first) throw new Error('chooseTaskAgent needs at least one candidate');
  const busy = (option: AccountOption) => options.roles?.maxRunning !== undefined && (option.load ?? 0) >= options.roles.maxRunning;
  if (options.explicitAccount) {
    if (open(first) && busy(first)) {
      const free = (options.allowed ?? candidates).find((option) => open(option) && !busy(option));
      return {
        chosen: first,
        reason: 'explicit --account',
        ...(free ? { warning: `${accountName(first)} already runs ${first.load} tasks; ${accountName(free)} has room (${accountFlags(free)})` } : {}),
      };
    }
    if (open(first)) return { chosen: first, reason: 'explicit --account' };
    const alternative = (options.allowed ?? candidates).find((option) => open(option));
    return {
      chosen: first,
      reason: `explicit --account; ${accountName(first)} is out of limits until ${iso(first.until!)}, so the task waits in the queue`,
      queuedUntil: first.until,
      ...(alternative ? { warning: `${accountName(first)} is out of usage limits until ${iso(first.until!)}; ${accountName(alternative)} has capacity (${accountFlags(alternative)})` } : {}),
    };
  }
  const source = options.fromSettings ? 'default from manager settings' : 'automatic selection';
  if (options.roles) return chooseByRole(candidates, options.roles, busy, open, options);
  const available = candidates.find(open);
  const skipped = candidates.slice(0, available ? candidates.indexOf(available) : candidates.length);
  const skippedText = skipped.map((option) => `${accountName(option)} out of limits until ${iso(option.until!)}`).join('; ');
  if (available) {
    return { chosen: available, reason: skipped.length ? `${source}: ${skippedText}, used ${accountName(available)}` : `${source}: ${accountName(available)}` };
  }
  const soonest = candidates.reduce((best, option) => (option.until! < best.until! ? option : best));
  // A flag narrowed the choice: "every allowed account" is only true of the accounts it left.
  const alternative = options.narrowedBy ? options.allowed?.find(open) : undefined;
  const scope = options.narrowedBy ? `every allowed account for ${options.narrowedBy}` : 'every allowed account';
  return {
    chosen: soonest,
    reason: candidates.length === 1
      ? `${source}: ${skippedText}; the task waits in the queue until it resets`
      : `${source}: ${scope} is out of limits (${skippedText}); queued on ${accountName(soonest)}, the first to reset`,
    queuedUntil: soonest.until,
    ...(alternative ? { warning: `${options.narrowedBy} has no account with capacity until ${iso(soonest.until!)}; ${accountName(alternative)} has capacity (${accountFlags(alternative)})` } : {}),
  };
}

const loadText = (option: AccountOption) => `${option.load ?? 0} running${option.usage !== undefined ? `, ${Math.round(option.usage)}% of 5h` : ''}`;

/**
 * Main accounts share new tasks: the open one with the fewest running, then lower five-hour usage,
 * then list order. Backup accounts are used in order once no Main is open. A Main or Backup is open
 * when it is not out of limits and, with a `maxRunning`, not already running that many.
 */
function chooseByRole(
  candidates: readonly AccountOption[],
  roles: RoleRouting,
  busy: (option: AccountOption) => boolean,
  open: (option: AccountOption) => boolean,
  options: { allowed?: readonly AccountOption[]; narrowedBy?: string },
): TaskAgentChoice {
  const usable = (option: AccountOption) => open(option) && !busy(option);
  const byLoad = (a: AccountOption, b: AccountOption) =>
    (a.load ?? 0) - (b.load ?? 0)
    || (a.usage !== undefined && b.usage !== undefined ? a.usage - b.usage : 0)
    || candidates.indexOf(a) - candidates.indexOf(b);
  const mains = candidates.filter((option) => option.role !== 'backup');
  const backups = candidates.filter((option) => option.role === 'backup');
  const main = mains.filter(usable).sort(byLoad)[0];
  if (main) {
    const others = mains.filter((option) => option !== main).map((option) => `${accountName(option)} ${loadText(option)}`);
    return { chosen: main, reason: `main: ${accountName(main)} had ${loadText(main)}${others.length ? `; ${others.join(', ')}` : ''}` };
  }
  const why = roles.maxRunning !== undefined ? 'every main account is out of limits or busy' : 'every main account is out of limits';
  const backup = backups.find(usable);
  if (backup) return { chosen: backup, reason: `backup: ${why}, used ${accountName(backup)}` };
  // Busy, not out of limits: the task waits for an account to free up.
  const waiting = [...mains, ...backups].filter(open).sort(byLoad)[0];
  if (waiting) return { chosen: waiting, reason: `every account is busy (${roles.maxRunning} running each); queued on ${accountName(waiting)}, the least loaded`, busy: true };
  const soonest = candidates.reduce((best, option) => (option.until! < best.until! ? option : best));
  const alternative = options.narrowedBy ? options.allowed?.find((option) => open(option)) : undefined;
  return {
    chosen: soonest,
    reason: `every ${options.narrowedBy ? `allowed account for ${options.narrowedBy}` : 'allowed account'} is out of limits; queued on ${accountName(soonest)}, the first to reset`,
    queuedUntil: soonest.until,
    ...(alternative ? { warning: `${options.narrowedBy} has no account with capacity until ${iso(soonest.until!)}; ${accountName(alternative)} has capacity (${accountFlags(alternative)})` } : {}),
  };
}

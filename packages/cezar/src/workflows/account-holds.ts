import type { RunnerId } from '../core/agent-runner.ts';
import type { RunRecord } from '../runs/store.ts';
import { recordedProfileFor } from '../server/recorded-profile.ts';
import type { AgentAccountStore } from '../workspace/agent-accounts.ts';
import { resolveAccountId } from '../workspace/agent-profiles.ts';
import type { AccountHolds } from '../workspace/semaphore.ts';
import { stepKind, type WorkflowDef } from './types.ts';

// The usage-limit hold derived from run records — moved out of run.ts so unloaded projects derive
// it the same way (spec 2026-08-03-auto-resume-after-usage-limit, 2026-11-23 addendum).

/** What `runAccountKey` needs to resolve an absent `agentProfile` to the account that really runs (#1722). */
export interface AccountResolution {
  store: AgentAccountStore;
  repoRoot: string;
  /** True when keying a run that holds the account (reads its recorded step), false when it asks to start. */
  holding?: boolean;
}

/**
 * Which agent ACCOUNT a run's work runs on — the thing a provider usage limit actually closes
 * (spec 2026-08-03-auto-resume-after-usage-limit).
 *
 * Backend plus agent account, because those are the two axes a limit is scoped to: a Claude
 * limit must never stall a Codex task, and a second Claude login is a second budget. A record
 * that names no runner has not started yet and will take the configured default, which is what
 * `fallbackRunner` carries; a run that HAS started always carries its resolved runner (execute
 * persists it), and only started runs can be holding.
 */
export function runAccountKey(
  run: Pick<RunRecord, 'runner' | 'agentProfile'> & { steps?: RunRecord['steps'] },
  fallbackRunner: RunnerId,
  accounts?: AccountResolution,
): string {
  const runner = run.runner ?? fallbackRunner;
  // Without the account store the old literal key stands (#1722 resolves only what it can read).
  if (!accounts) return `${runner}:${run.agentProfile ?? 'default'}`;
  // A holding run is keyed on the account its steps recorded; a run asking to start has no
  // recording yet, so it resolves as the spawn will: its override, else the repo's selection.
  const explicit = accounts.holding
    ? recordedProfileFor({ ...run, runner, steps: run.steps ?? [] } as RunRecord, runner)
    : run.agentProfile;
  // A named account keeps its own key (a stale id is still its own budget to the user).
  if (explicit !== undefined) return `${runner}:${explicit}`;
  return `${runner}:${resolveAccountId(accounts.store, { provider: runner, repoRoot: accounts.repoRoot })}`;
}

/**
 * An automatic resume still testing its account. Never held itself — resumes holding each other
 * deadlocked a live workspace; observing the window open (`autoResumeWindowOpen`, #2525) ends the test.
 */
export function resumeInFlight(run: Pick<RunRecord, 'status' | 'autoResumeAttempts' | 'autoResumeWindowOpen'>): boolean {
  return (
    run.autoResumeAttempts !== undefined
    && !run.autoResumeWindowOpen
    && (run.status === 'queued' || run.status === 'running')
  );
}

/**
 * May this run start, given what its account is holding?
 *
 * The two kinds of hold bind different work, and getting that wrong has produced a bug in each
 * direction (spec 2026-08-03-auto-resume-after-usage-limit):
 *
 *  - a `deadline` hold means the window is KNOWN shut until an instant, so it blocks everything
 *    on that account — resumes included. Exempting them let four resumes fire at once and
 *    re-limit one after another, which is the stampede wearing a different hat.
 *  - an `inFlight` hold means a resume is testing the window right now and nothing is proven, so
 *    it blocks fresh work but not other resumes. Blocking those deadlocked a live workspace.
 */
export function accountHeldFor(
  run: Pick<RunRecord, 'runner' | 'agentProfile' | 'status' | 'autoResumeAttempts' | 'autoResumeWindowOpen'>,
  holds: AccountHolds,
  fallbackRunner: RunnerId,
  accounts?: AccountResolution,
  workflow?: WorkflowDef,
): boolean {
  // A workflow with no agent step spends no account budget, so a closed window cannot concern it (#2094).
  if (workflow && !workflow.steps.some((s) => stepKind(s) === 'agent')) return false;
  const key = runAccountKey(run, fallbackRunner, accounts);
  if (holds.deadline.has(key)) return true;
  return holds.inFlight.has(key) && !resumeInFlight(run);
}

export interface DeriveHoldsOptions {
  now?: number;
  /** Resolves absent profiles (#1722); keyed as HOLDING runs. */
  accounts?: Omit<AccountResolution, 'holding'>;
  /** Why an account's holds were lifted early — "Resume now" or a re-login (`usageLimitLift`). */
  lift?: (account: string) => 'released' | 'login' | undefined;
  /** False for a project nobody has loaded: nothing of it is running, so an in-flight hold would only wedge. */
  inFlight?: boolean;
}

/** The accounts these runs hold, by kind. The record is the hold — nothing else is tracked. */
export function deriveAccountHolds(
  runs: Iterable<RunRecord>,
  options: DeriveHoldsOptions = {},
): { deadline: Set<string>; inFlight: Set<string>; deadlines: Map<string, number> } {
  const now = options.now ?? Date.now();
  const lift = options.lift ?? (() => undefined);
  const deadlines = new Map<string, number>();
  const deadline = new Set<string>();
  const inFlight = new Set<string>();
  const accounts = options.accounts && { ...options.accounts, holding: true };
  for (const run of runs) {
    // A holding run always carries the runner it actually ran on, so the fallback is unused
    // here — it is spelled out rather than `!` so a future record shape degrades, not throws.
    const key = () => runAccountKey(run, run.runner ?? 'claude', accounts);
    // A fallback's exhausted account stays held until ITS reset, whatever the task did since.
    for (const hold of run.usageLimitHolds ?? []) {
      const until = Date.parse(hold.until);
      if (Number.isFinite(until) && until > now && !lift(hold.account)) {
        deadline.add(hold.account);
        deadlines.set(hold.account, Math.max(deadlines.get(hold.account) ?? 0, until));
      }
    }
    // A transient retry says nothing about the account's window, so it holds nothing.
    if (run.autoResumeReason === 'transient') continue;
    if (run.status === 'failed' && run.autoResumeAt) {
      const at = Date.parse(run.autoResumeAt);
      const account = key();
      if (!Number.isFinite(at) || at <= now) continue;
      if (!lift(account)) {
        deadline.add(account);
        deadlines.set(account, Math.min(at, deadlines.get(account) ?? Infinity));
      } else if (options.inFlight !== false) {
        // A lifted deadline fires its resume, which tests the account first: until one sees its
        // window open (#2525), fresh work waits, as behind any resume.
        inFlight.add(account);
      }
    } else if (options.inFlight !== false && resumeInFlight(run)) {
      inFlight.add(key());
    }
  }
  return { deadline, inFlight, deadlines };
}

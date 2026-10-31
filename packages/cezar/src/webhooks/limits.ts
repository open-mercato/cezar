import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, open, chmod } from 'node:fs/promises';
import { z } from 'zod';
import { atomicWrite, readState, statePath, StateIntegrityError, syncDirectory } from './storage.ts';
const stateSchema = z.strictObject({
  version: z.literal(1), tokens: z.number().min(0).max(10), at: z.number().nonnegative(),
  tests: z.record(z.string().max(255), z.array(z.number().nonnegative()).max(3)),
  testsBlockedUntil: z.number().nonnegative().optional(),
  failures: z.array(z.number().nonnegative()).max(10),
});
type LimitState = z.infer<typeof stateSchema>;
export class ProjectLimits {
  private constructor(private readonly directory: string, private state: LimitState, readonly wasReset = false) {}
  static async open(directory: string, now: () => number = Date.now): Promise<ProjectLimits> {
    try {
      const state = await readState(directory, 'limits.json', stateSchema) ?? { version: 1 as const, tokens: 10, at: 0, tests: {}, failures: [] };
      return new ProjectLimits(directory, state);
    } catch (error) {
      if (!(error instanceof StateIntegrityError)) throw error;
    }
    // Short-lived budget counters, not evidence: an unreadable file must not disable the project.
    // Keep its bytes for inspection and restart from an EMPTY bucket with the manual-failure window
    // full, which is never more permissive than the lost state (it refills within five seconds and
    // a minute respectively). Persist that before any send can observe the default full bucket.
    const quarantine = statePath(directory, `limits.json.corrupt-${randomUUID()}`);
    // Preserve the corrupt original until the conservative replacement is durable. A crash or
    // write failure here must not make the next boot mistake missing state for a fresh budget.
    await copyFile(statePath(directory, 'limits.json'), quarantine, constants.COPYFILE_EXCL);
    await chmod(quarantine, 0o600);
    // Windows FlushFileBuffers requires a writable handle, even for a copied file.
    const evidence = await open(quarantine, constants.O_RDWR | constants.O_NOFOLLOW);
    try { await evidence.sync(); } finally { await evidence.close(); }
    await syncDirectory(directory);
    console.warn(`Webhook limits.json was unreadable and has been quarantined as ${quarantine}; budgets restart empty.`);
    const at = now();
    const state: LimitState = { version: 1, tokens: 0, at, tests: {}, testsBlockedUntil: at + 60000, failures: Array.from({ length: 10 }, () => at) };
    await atomicWrite(directory, 'limits.json', state);
    return new ProjectLimits(directory, state, true);
  }
  /** Called under the owning project's mutation queue immediately before claim. */
  async take(request: { host: string; test?: boolean; manualFailure?: boolean; preview?: boolean }, now: number): Promise<{ allowed: true } | { allowed: false; retryAt: number }> {
    if (request.host.length > 255) throw new Error('Invalid destination host');
    // Materialize elapsed refill and window ages at every observation, including
    // denials/previews. A rollback shifts the time origin, never grants tokens.
    // Persist before returning so a restart cannot resurrect the old clock.
    const delta = Math.min(0, now - this.state.at);
    const tokens = Math.min(10, this.state.tokens + Math.max(0, now - this.state.at) / 500);
    // Clamp only live entries at the epoch boundary (conservatively <= 60s);
    // expired entries must not be resurrected by that clamp.
    const rebase = (times: number[]) => times.filter(time => time > Math.max(now, this.state.at) - 60000).map(time => Math.max(0, time + delta));
    const failures = rebase(this.state.failures);
    const tests = Object.fromEntries(Object.entries(this.state.tests).map(([host, times]) => [host, rebase(times)] as const).filter(([, times]) => times.length));
    const testsBlockedUntil = this.state.testsBlockedUntil === undefined
      ? undefined : Math.max(0, this.state.testsBlockedUntil + delta);
    const cooldown = testsBlockedUntil !== undefined && testsBlockedUntil > now ? { testsBlockedUntil } : {};
    const observed = stateSchema.parse({ version: 1, tokens, at: now, tests, failures, ...cooldown });
    const hostTests = Object.hasOwn(tests, request.host) ? tests[request.host]! : [];
    let retryAt = now;
    if (tokens < 1) retryAt = Math.max(retryAt, now + Math.ceil((1 - tokens) * 500));
    if (request.test && testsBlockedUntil !== undefined) retryAt = Math.max(retryAt, testsBlockedUntil);
    if (request.test && hostTests.length >= 3) retryAt = Math.max(retryAt, hostTests[0]! + 60000);
    if (request.manualFailure && failures.length >= 10) retryAt = Math.max(retryAt, failures[0]! + 60000);
    if (retryAt > now || request.preview) {
      if (JSON.stringify(observed) !== JSON.stringify(this.state)) {
        await atomicWrite(this.directory, 'limits.json', observed); this.state = observed;
      }
      return retryAt > now ? { allowed: false, retryAt } : { allowed: true };
    }
    if (request.test) Object.defineProperty(tests, request.host, {
      value: [...hostTests, now], enumerable: true, configurable: true, writable: true,
    });
    if (request.manualFailure) failures.push(now);
    const next = stateSchema.parse({ version: 1, tokens: tokens - 1, at: now, tests, failures, ...cooldown });
    await atomicWrite(this.directory, 'limits.json', next); this.state = next;
    return { allowed: true };
  }
}

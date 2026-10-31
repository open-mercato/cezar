import { constants, closeSync, fstatSync, linkSync, openSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { open, readdir, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { bootIsStableId, ownProcessIdentity, processStarts } from './process-identity.ts';
import { statePath, syncDirectory } from './storage.ts';

const identitySchema = z.strictObject({
  token: z.string().uuid(), pid: z.number().int().positive(), start: z.string().regex(/^\d+$/), boot: z.string().min(1).max(128),
  host: z.string().min(1).max(255), directory: z.string().max(4096).optional(),
  // Linux only. Optional so identities written before the field existed still parse; see `alive()`.
  pidNamespace: z.string().regex(/^pid:\[\d+\]$/).optional(),
});
// The schema allows a 4096-character directory; JSON escaping and UTF-8 can expand one
// character to six bytes. A 2 KiB cap used to make a long-path identity writable but
// permanently unreadable; keep a cap above the schema worst case, far below memory risk.
const MAX_OWNER_BYTES = 32 * 1024;
export type OwnershipIdentity = z.infer<typeof identitySchema>;
async function ownIdentity(directory: string): Promise<Identity> {
  const own = await ownProcessIdentity();
  const namespace = own.pidNamespace === undefined ? {} : { pidNamespace: own.pidNamespace };
  const fields = { token: randomUUID(), directory, pid: own.pid, start: own.start, boot: own.boot, host: hostname() };
  return identitySchema.parse({ ...fields, ...namespace });
}
type Identity = OwnershipIdentity;
function readIdentity(directory: string, name: string, unpublished = false): Identity | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(statePath(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    if (fstatSync(fd).size > MAX_OWNER_BYTES) {
      if (unpublished) return undefined;
      throw new Error('Owner too large');
    }
    const raw = readFileSync(fd, 'utf8');
    if (raw.length > MAX_OWNER_BYTES) {
      if (unpublished) return undefined;
      throw new Error('Owner too large');
    }
    return identitySchema.parse(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    // An unpublished candidate may still be in its writer's first writeFile. It is
    // neither ownership authority nor safe to delete without a readable identity.
    if (unpublished && (error instanceof SyntaxError || error instanceof z.ZodError)) return undefined;
    throw new Error('Invalid webhook owner metadata');
  } finally { if (fd !== undefined) closeSync(fd); }
}

/** Read the authoritative published owner for consumers that bind ready state to its token. */
export function readOwnershipIdentity(directory: string): OwnershipIdentity | undefined {
  return readIdentity(directory, 'owner.lock');
}
/** An owner whose pid this process cannot see; it is never declared dead, only left alone. */
class ForeignOwnerError extends Error {
  constructor() { super('Cannot verify foreign owner identity'); }
}
async function alive(identity: Identity, own: Identity): Promise<boolean> {
  if (identity.host !== own.host) throw new ForeignOwnerError();
  // Only two random boot IDs prove a reboot. The Windows token is a boot INSTANT that moves when the
  // clock is set, so there a mismatch falls through to pid + start: its start ticks are absolute
  // creation times, valid across boots. A Linux start token counts jiffies since boot, so it must not
  // be compared across boots — and Linux always has a stable boot ID, so it never gets that far.
  if (identity.boot !== own.boot && bootIsStableId(identity.boot) && bootIsStableId(own.boot)) return false;
  // Same kernel, so /proc answers only for our own PID namespace (a `--network host` container shares
  // the hostname and boot_id): a foreign namespace's pid reads ENOENT while its owner lives.
  if (identity.pidNamespace !== own.pidNamespace) {
    // An identity written before the field existed (or by a namespace-less platform under the same
    // hostname) may live anywhere. Its exact pid+start showing up here is a positive sighting and keeps
    // it alive; anything else is unverifiable, never absent. A live legacy owner keeps the fence, a dead
    // one waits for a reboot or a manual owner.lock removal — the price of never stealing a live lock.
    if (identity.pidNamespace === undefined && (await processStarts([identity.pid])).get(identity.pid) === identity.start) return true;
    throw new ForeignOwnerError();
  }
  // A probe failure throws (fail closed): an unverifiable owner is never declared dead.
  return (await processStarts([identity.pid])).get(identity.pid) === identity.start;
}
export interface WebhookOwnership {
  valid(): boolean;
  release(): Promise<void>;
  recovered: boolean;
  readonly identity: OwnershipIdentity;
}
/** Transfers failed acquisition cleanup into the caller's already-bounded reservation. */
export class OwnershipCleanupError extends Error {
  constructor(readonly ownership: WebhookOwnership, cause: unknown) {
    super('Webhook acquisition cleanup failed', { cause });
  }
}
/**
 * Each dead owner has one immutable successor slot, claimed with an exclusive hard link.
 * Contenders follow that slot rather than racing check/unlink on owner.lock. If recovery
 * itself crashes, its dead successor has its own slot. A live successor blocks contenders
 * before it publishes owner.lock by rename. No heartbeat age authorizes a takeover.
 */
export async function acquireOwnership(directory: string, copiedRoot = false): Promise<WebhookOwnership | undefined> {
  const own = await ownIdentity(directory);
  const candidateName = `owner-record-${own.token}.json`;
  const candidate = statePath(directory, candidateName);
  const file = await open(candidate, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let acquired = false, recovered = false, handedOff = false;
  const owner: WebhookOwnership = {
    identity: own,
    get recovered() { return recovered; },
    valid() {
      // Token check only: our own start token cannot change while this process lives, so a
      // per-mutation probe would shell out on the hot path for a tautology.
      try { return readIdentity(directory, 'owner.lock')?.token === own.token; }
      catch { return false; }
    },
    async release() {
      // Missing or a verified replacement is safe to leave alone. Unreadable metadata
      // must throw so the caller retains this exact token for a later cleanup retry.
      if (acquired && readIdentity(directory, 'owner.lock')?.token === own.token) unlinkSync(statePath(directory, 'owner.lock'));
      await rm(candidate, { force: true }); await syncDirectory(directory);
    },
  };
  const ancestors = new Set<string>();
  /** Reaps owner-* files whose holder is provably dead; a live contender's file is never removed. */
  const reapDeadOrphans = async (): Promise<void> => {
    // Only a PUBLISHED owner may sweep. Slot names are the arbitration: deleting one while the lock
    // is still dead can free that name for a second contender, which then publishes beside us. Under
    // a live lock every contender's publish guard already sees this owner instead.
    for (const name of await readdir(directory)) {
      const match = /^owner-(record|next|publication)-([0-9a-f-]{36})\.(?:json|tmp)$/.exec(name);
      if (!match || match[2] === own.token) continue;
      let orphan: Identity | undefined;
      try { orphan = readIdentity(directory, name, true); } catch { continue; }
      if (!orphan || orphan.host !== own.host || orphan.token === own.token) continue;
      // A candidate/publication file is named after the identity it holds, so a mismatch means the
      // name and the content disagree and the file is not that writer's. A successor slot is named
      // after the DEAD predecessor and holds its CLAIMANT's identity, so only that claimant's
      // liveness decides — a live contender's slot must survive.
      if (match[1] !== 'next' && orphan.token !== match[2]) continue;
      try { if (await alive(orphan, own)) continue; }
      catch { continue; } // Unverifiable is not dead; an orphan cannot block acquisition.
      // The probe above can take a second (a cold PowerShell spawn on Windows); re-read without a
      // probe so only the exact file verified dead is removed.
      let confirmed: Identity | undefined;
      try { confirmed = readIdentity(directory, name, true); } catch { continue; }
      if (!confirmed || confirmed.token !== orphan.token) continue;
      await rm(statePath(directory, name), { force: true });
    }
  };
  try {
    try { await file.writeFile(JSON.stringify(own)); await file.sync(); } finally { await file.close(); }
    try { linkSync(candidate, statePath(directory, 'owner.lock')); acquired = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    if (!acquired) {
      let previous = readIdentity(directory, 'owner.lock');
      if (!previous) return undefined; // A concurrent orderly release: retry on health recheck.
      for (;;) {
        // Every hop follows a distinct predecessor file, so a crafted cycle is the only way the walk
        // can fail to terminate. Fail closed there instead of capping the depth: a fixed bound would
        // let a long chain of crashed recoveries wedge the fence permanently.
        if (ancestors.has(previous.token)) throw new Error('Webhook owner recovery chain cycles');
        if (!(copiedRoot && previous.directory !== directory) && await alive(previous, own)) return undefined;
        ancestors.add(previous.token);
        const successorName = `owner-next-${previous.token}.json`;
        try {
          linkSync(candidate, statePath(directory, successorName));
          // Localize the fence's invariant: this name is ours and no deletion may free it before the
          // publish below. A token names one immutable identity, so a mismatch means a rewrite.
          const claimed = readIdentity(directory, successorName, true);
          if (!claimed || claimed.token !== own.token) return undefined;
          const current = readIdentity(directory, 'owner.lock');
          if (!current || !ancestors.has(current.token)) return undefined;
          // Current still belongs to the verified-dead chain; no yield before publication.
          const publication = statePath(directory, `owner-publication-${own.token}.tmp`);
          linkSync(candidate, publication);
          renameSync(publication, statePath(directory, 'owner.lock'));
          acquired = true; recovered = true; break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          const next = readIdentity(directory, successorName);
          if (!next) return undefined;
          previous = next;
        }
      }
    }
    await syncDirectory(directory);
    // Remove only verified-dead predecessor records, never another contender's candidate.
    for (const token of ancestors) {
      await rm(statePath(directory, `owner-record-${token}.json`), { force: true });
      await rm(statePath(directory, `owner-next-${token}.json`), { force: true });
    }
    // A crash before the first hard link can leave a candidate outside the predecessor chain, and
    // an abandoned recovery can strand its `owner-next-` slot; reap only provably dead identities,
    // never a live concurrent contender's file.
    await reapDeadOrphans();
    await syncDirectory(directory);
    handedOff = true;
    return owner;
  } finally {
    if (!handedOff) {
      // Never strand a live-PID owner when acquisition fails after publishing the link.
      // Retain the exact cleanup handle even before publication when rm/sync fails.
      try { await owner.release(); }
      catch (error) { throw new OwnershipCleanupError(owner, error); }
    }
  }
}

import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { acquireOwnership, readOwnershipIdentity, type WebhookOwnership } from '../webhooks/ownership.ts';
import { assertNoSymlink } from '../webhooks/storage.ts';
import { PROCESS_IDENTITY_UNSUPPORTED_PLATFORM_MESSAGE, processIdentityPlatformSupported } from './process-identity.ts';

/**
 * One server process per project data dir (PR #2430). The single-cockpit slot lives in CEZ_HOME,
 * so a second server with another home (the dry-run test env) used to adopt a live cockpit's
 * tasks. This fence sits on `<repo>/.ai/cezar` itself, with the slot's ownership primitive.
 * Clients — tabs, phones, other devices — never touch it; only `serve` claims it.
 */
export const DATA_DIR_LOCK_DIRNAME = 'server-lock';

export type DataDirLockClaim =
  | { kind: 'owned'; release: () => Promise<void> }
  | { kind: 'held'; pid?: number; reason?: string }
  | { kind: 'degraded'; reason: string };

export function dataDirLockDirectory(dataDir: string): string {
  return join(dataDir, DATA_DIR_LOCK_DIRNAME);
}

/** Never throws. `held` means another live (or unverifiable) server owns `dataDir`. */
export async function claimDataDirLock(dataDir: string): Promise<DataDirLockClaim> {
  if (!processIdentityPlatformSupported()) return { kind: 'degraded', reason: PROCESS_IDENTITY_UNSUPPORTED_PLATFORM_MESSAGE };
  const directory = dataDirLockDirectory(dataDir);
  try {
    assertNoSymlink(directory);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  } catch (error) {
    return { kind: 'degraded', reason: message(error) };
  }
  let ownership: WebhookOwnership | undefined;
  try {
    // copiedRoot: a `cp -r` of the repo carries owner.lock along; its recorded directory differs.
    ownership = await acquireOwnership(directory, true);
  } catch (error) {
    // An owner we cannot verify (another host, a foreign pid namespace) is never declared dead.
    return ownerPid(directory) !== undefined
      ? { kind: 'held', pid: ownerPid(directory), reason: message(error) }
      : { kind: 'degraded', reason: message(error) };
  }
  if (!ownership) {
    const pid = ownerPid(directory);
    return pid === undefined ? { kind: 'held' } : { kind: 'held', pid };
  }
  const held = ownership;
  let released = false;
  return {
    kind: 'owned',
    release: async () => {
      if (released) return;
      released = true;
      try { await held.release(); } catch { /* a dead pid is reclaimed by the next claim */ }
    },
  };
}

/** The refusal line. Only the local boot error names the path; a 409 reaches phones and hosted clients. */
export function dataDirInUseMessage(claim: { pid?: number }, dataDir?: string): string {
  const who = claim.pid === undefined ? 'another cezar' : `another cezar (pid ${claim.pid})`;
  return dataDir === undefined ? `${who} already serves this project's tasks` : `${who} already serves the tasks in ${dataDir}`;
}

function ownerPid(directory: string): number | undefined {
  try { return readOwnershipIdentity(directory)?.pid; } catch { return undefined; }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname } from 'node:path';
import {
  DEFAULT_SERVER_INSTANCE,
  serverInstancesDir,
  serverLockPath,
  serverStatePath,
} from '../paths.js';
import { freshServerState, serverStateSchema, type ServerState, type StepOutcome } from './types.js';

/**
 * `~/.cezar/server.json` I/O and the single-writer lock. Reads degrade to a
 * fresh record on any corruption (house pattern — never crash the wizard);
 * writes are atomic (tmp + rename) and `0600`, since the file is the input to
 * uninstall's "reverse exactly what was created" logic.
 */

/** Load a host-level instance record, degrading to a fresh record on any error. */
export function loadServerState(instance: string = DEFAULT_SERVER_INSTANCE): ServerState {
  const path = serverStatePath(instance);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return freshServerState();
  }
  try {
    const parsed = serverStateSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    // malformed JSON — fall through to fresh
  }
  return freshServerState();
}

/**
 * Every instance recorded on this host, newest schema first: the `default`
 * record (`server.json`) plus each named record under `server-instances/`.
 * Used to auto-pick a free loopback port for a new instance and to let
 * uninstall/deploy resolve which instance to act on. Never throws — an
 * unreadable dir or a corrupt file is simply skipped.
 */
export function listServerInstances(): Array<{ instance: string; state: ServerState }> {
  const out: Array<{ instance: string; state: ServerState }> = [];
  if (existsSync(serverStatePath(DEFAULT_SERVER_INSTANCE))) {
    out.push({ instance: DEFAULT_SERVER_INSTANCE, state: loadServerState(DEFAULT_SERVER_INSTANCE) });
  }
  let entries: string[] = [];
  try {
    entries = readdirSync(serverInstancesDir());
  } catch {
    entries = [];
  }
  for (const file of entries) {
    if (!file.endsWith('.json')) continue;
    const instance = basename(file, '.json');
    out.push({ instance, state: loadServerState(instance) });
  }
  return out;
}

/**
 * The next free loopback port for a NEW instance, scanning from `startAt`
 * (4321, the default cockpit port) upward past every port already recorded by
 * another instance. Deterministic (recorded-state only, no network probe) so it
 * stays unit-testable; the operator can always override it with `--port`.
 */
export function nextFreeInstancePort(startAt = 4321): number {
  const used = new Set(listServerInstances().map((i) => i.state.primaryPort));
  let port = startAt;
  while (used.has(port)) port++;
  return port;
}

/** Atomically persist state as `0600`, creating its dir (`0700`) if needed. */
export function saveServerState(state: ServerState, instance: string = DEFAULT_SERVER_INSTANCE): void {
  const path = serverStatePath(instance);
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600); // best-effort — ignored on some filesystems
  } catch {
    // non-fatal
  }
}

/**
 * Delete a named instance's state file (used after a complete uninstall so it
 * stops reserving its port and drops out of `listServerInstances`). The
 * `default` record is left in place — that is the legacy single-host file, and
 * its absence vs. an empty-but-present record has historically meant the same
 * thing, so we don't change that behavior. Best-effort; never throws.
 */
export function deleteServerState(instance: string): void {
  if (instance === DEFAULT_SERVER_INSTANCE) return;
  try {
    rmSync(serverStatePath(instance), { force: true });
  } catch {
    // non-fatal — an empty record left behind is harmless
  }
}

/** A step is resolved (needs no run on resume) when it is done or skipped. */
export function isResolved(outcome: StepOutcome | undefined): boolean {
  return outcome?.status === 'done' || outcome?.status === 'skipped';
}

/**
 * First step id in `orderedIds` that is not yet resolved — the resume point.
 * `undefined` means every step is resolved (install complete).
 */
export function firstIncompleteStep(orderedIds: readonly string[], state: ServerState): string | undefined {
  return orderedIds.find((id) => !isResolved(state.steps[id]));
}

export class LockHeldError extends Error {}

/**
 * Acquire the exclusive install lock. Throws `LockHeldError` if a *live*
 * process already holds it; a stale lock (dead pid) is reclaimed. Returns a
 * release function.
 */
export function acquireLock(instance: string = DEFAULT_SERVER_INSTANCE): () => void {
  const path = serverLockPath(instance);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  // `wx` makes creation atomic — a plain exists-then-write check would let two
  // concurrent wizards both "acquire". One reclaim retry handles a stale lock;
  // if the second attempt still collides, someone live beat us to it.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, `${process.pid}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          if (existsSync(path) && readLockPid(path) === process.pid) rmSync(path);
        } catch {
          // non-fatal
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const holder = readLockPid(path);
      if (holder !== null && holder !== process.pid && isProcessAlive(holder)) {
        throw new LockHeldError(
          `another server-install/uninstall is already running (pid ${holder}). ` +
            `If that is wrong, remove ${path} and retry.`,
        );
      }
      // stale (dead pid, unreadable, or our own) — reclaim and retry the wx write
      try {
        rmSync(path);
      } catch {
        // raced with another reclaimer; the retry below decides
      }
    }
  }
  throw new LockHeldError(
    `could not acquire ${path} — another server-install/uninstall grabbed it first; retry in a moment.`,
  );
}

function readLockPid(path: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process; EPERM = alive but not ours (still alive)
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

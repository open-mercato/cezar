import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import {
  trackerAssociationSchema,
  trackerSourceSchema,
  type TrackerAssociation,
  type TrackerKind,
} from '@open-mercato/cezar-contract';

const persistedSchema = trackerAssociationSchema.extend({ source: trackerSourceSchema.passthrough() }).passthrough();

const mutationQueues = new Map<string, Promise<void>>();

function associationPath(dataDir: string): string {
  return join(dataDir, 'tracker.json');
}

async function serializeMutation<T>(dataDir: string, mutation: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(dataDir) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.catch(() => undefined).then(() => gate);
  mutationQueues.set(dataDir, tail);
  await previous.catch(() => undefined);
  try {
    return await lockedMutation(dataDir, mutation);
  } finally {
    release();
    if (mutationQueues.get(dataDir) === tail) mutationQueues.delete(dataDir);
  }
}

/** Filesystem lease shared by independent cockpits, including read/merge and clear. */
async function lockedMutation<T>(dataDir: string, mutation: () => Promise<T>): Promise<T> {
  await fs.mkdir(dataDir, { recursive: true });
  const lock = join(dataDir, 'tracker-association.lock');
  const owner = join(lock, String(process.pid));
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.mkdir(lock, { mode: 0o700 });
      try { await fs.writeFile(owner, '', { flag: 'wx', mode: 0o600 }); }
      catch (error) { await fs.rmdir(lock).catch(() => undefined); throw error; }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= 100) throw error;
      const stat = await fs.lstat(lock).catch(() => null);
      if (!stat) continue;
      const owners = await fs.readdir(lock).catch(() => []);
      if (owners.length === 1 && /^[1-9][0-9]*$/.test(owners[0]!)) {
        try { process.kill(Number(owners[0]), 0); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
            // Unlink elects one reaper; contenders cannot remove a replacement lease.
            try { await fs.unlink(join(lock, owners[0]!)); await fs.rmdir(lock); } catch {}
          }
        }
      } else if (owners.length === 0 && Date.now() - stat.mtimeMs > 60_000) {
        await fs.rmdir(lock).catch(() => undefined);
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  try { return await mutation(); }
  finally {
    // A cleanup failure must not turn a committed replacement into a reported failure.
    await fs.unlink(owner).catch(() => undefined);
    await fs.rmdir(lock).catch(() => undefined);
  }
}

/** Missing, unreadable, malformed, or schema-invalid state is simply unassociated. */
export async function readTrackerAssociation(dataDir: string): Promise<TrackerAssociation | null> {
  try {
    const raw: unknown = JSON.parse(await fs.readFile(associationPath(dataDir), 'utf8'));
    const parsed = trackerAssociationSchema.strip().extend({ source: trackerSourceSchema.strip() }).safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Atomic replacement. A failed validation/write/rename leaves any old association intact. */
export async function writeTrackerAssociation(
  dataDir: string,
  association: TrackerAssociation,
): Promise<boolean> {
  const parsed = persistedSchema.safeParse(association);
  if (!parsed.success) return false;
  return serializeMutation(dataDir, async () => {
    const path = associationPath(dataDir);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await fs.mkdir(dataDir, { recursive: true });
      const previous = await fs.readFile(path, 'utf8').then(text => persistedSchema.parse(JSON.parse(text))).catch(() => null);
      const merged = { ...previous, ...parsed.data, source: { ...previous?.source, ...parsed.data.source } };
      await fs.writeFile(temporary, `${JSON.stringify(merged, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, path);
      return true;
    } catch {
      await fs.unlink(temporary).catch(() => undefined);
      return false;
    }
  }).catch(() => false);
}

/** Idempotent removal; missing state is already the requested result. */
export async function clearTrackerAssociation(dataDir: string): Promise<boolean> {
  return serializeMutation(dataDir, async () => {
    try {
      await fs.unlink(associationPath(dataDir));
      return true;
    } catch (error) {
      return error instanceof Error && 'code' in error && error.code === 'ENOENT';
    }
  }).catch(error => (error as NodeJS.ErrnoException).code === 'ENOENT');
}

/** Cheap local classification for project lists; never contacts a provider. */
export async function classifyTracker(dataDir: string): Promise<TrackerKind | undefined> {
  return (await readTrackerAssociation(dataDir))?.kind;
}

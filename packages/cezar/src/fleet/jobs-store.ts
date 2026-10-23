import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { fleetJobSchema, type FleetJob } from '@open-mercato/cezar-contract';
import { cezarHomeDir } from '../paths.ts';

/**
 * The hub's job queue: `cezarHomeDir()/fleet/jobs.json`, atomic tmp+rename. State may be written,
 * never required: a missing or corrupt file starts a fresh queue with one warning (the hub is
 * restart-safe for what it managed to save, and never refuses to boot over it).
 */

const fileSchema = z.object({ version: z.literal(1), jobs: z.array(z.unknown()) });

export function fleetJobsPath(): string {
  return join(cezarHomeDir(), 'fleet', 'jobs.json');
}

export function loadJobs(path = fleetJobsPath(), warn: (message: string) => void = console.warn): FleetJob[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  try {
    const file = fileSchema.parse(JSON.parse(raw));
    // Per-entry salvage: one bad row never evicts the queue.
    return file.jobs.flatMap((entry) => {
      const parsed = fleetJobSchema.safeParse(entry);
      return parsed.success ? [parsed.data] : [];
    });
  } catch {
    warn(`fleet: ${path} is unreadable; starting with an empty job queue`);
    return [];
  }
}

export function saveJobs(jobs: readonly FleetJob[], path = fleetJobsPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, jobs }, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

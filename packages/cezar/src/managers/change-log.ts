/**
 * The change log (spec 2026-11-20-manager-admin-actions § 3.3): one line per proposal a user (or
 * cezar) settled and per direct write a manager made, in `~/.cezar/admin-audit.ndjson`. Append-only,
 * rotated by size into `admin-audit.1.ndjson`. Deleting either loses history, never boot; a bad line
 * is skipped. Secret values are redacted before a line is written.
 */
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { managerChangeSchema, type ManagerChange } from '@open-mercato/cezar-contract';
import { collectSecretValues, redactDeep } from '../core/secret-redaction.ts';
import { assertCezarHomeWriteIsSandboxed, cezarHomeDir } from '../paths.ts';

/** About 5,000 entries: the older half moves aside so a read never parses more than two files. */
export const CHANGE_LOG_ROTATE_BYTES = 2_000_000;

export function changeLogPath(): string {
  return join(cezarHomeDir(), 'admin-audit.ndjson');
}

export class ManagerChangeLog {
  private readonly secrets = collectSecretValues();
  private warned = false;

  constructor(
    private readonly warn: (message: string) => void = (message) => console.warn(message),
    private readonly rotateBytes = CHANGE_LOG_ROTATE_BYTES,
  ) {}

  /** Never throws: a log that cannot be written must not fail the change it records. */
  append(entry: ManagerChange): void {
    const path = changeLogPath();
    let fd: number | undefined;
    try {
      assertCezarHomeWriteIsSandboxed(path);
      mkdirSync(dirname(path), { recursive: true });
      // The size comes from the open descriptor, never a path check before the write (CodeQL js/file-system-race).
      fd = openSync(path, 'a', 0o600);
      if (fstatSync(fd).size >= this.rotateBytes) {
        closeSync(fd);
        fd = undefined;
        renameSync(path, rotatedPath(path));
        fd = openSync(path, 'a', 0o600);
      }
      writeSync(fd, `${JSON.stringify(redactDeep(entry, this.secrets))}\n`);
    } catch (cause) {
      if (!this.warned) this.warn(`[cezar] could not write the manager change log ${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
      this.warned = true;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  /** Newest first. */
  list(query: { managerId?: string; limit?: number } = {}): ManagerChange[] {
    const path = changeLogPath();
    const limit = query.limit ?? 100;
    const found: ManagerChange[] = [];
    for (const file of [path, rotatedPath(path)]) {
      for (const entry of readEntries(file).reverse()) {
        if (query.managerId !== undefined && entry.managerId !== query.managerId) continue;
        found.push(entry);
        if (found.length >= limit) return found;
      }
    }
    return found;
  }
}

const rotatedPath = (path: string): string => path.replace(/\.ndjson$/, '.1.ndjson');

function readEntries(path: string): ManagerChange[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return []; // Missing or unreadable: no history, never an error.
  }
  return text.split('\n').flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const parsed = managerChangeSchema.safeParse(JSON.parse(line));
      return parsed.success ? [parsed.data] : [];
    } catch {
      return [];
    }
  });
}

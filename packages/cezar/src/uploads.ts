import { randomBytes } from 'node:crypto';
import { closeSync, fstatSync, openSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { attachmentInputSchema, UPLOAD_ID_RE, type AttachmentInput, type StagedUpload } from '@open-mercato/cezar-contract';
import { cezarHomeDir } from './paths.ts';
import { atomicWriteJsonSync } from './workspace/config.ts';

/**
 * Staged attachments (telemetry 7054e5f2): the composer uploads each file when it is ATTACHED and a
 * message names it by id, so a message's attachments are no longer bounded by one request body.
 *
 * Workspace-level, under `~/.cezar/uploads/`, because the new-task form carries attachments across
 * a project switch. Transient by design: an upload is pruned after `UPLOAD_TTL_MS`, the oldest go
 * first when the store passes `UPLOADS_MAX_BYTES`, and a reference to a pruned one is refused with
 * `ATTACHMENT_UPLOAD_MISSING`, which the composer answers by staging again.
 */

export const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
export const UPLOADS_MAX_BYTES = 512 * 1024 * 1024;

interface StoredUpload extends AttachmentInput {
  id: string;
  bytes: number;
}

export function uploadsDir(): string {
  return join(cezarHomeDir(), 'uploads');
}

function uploadPath(id: string): string {
  return join(uploadsDir(), `${id}.json`);
}

function decodedBytes(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

/** Drop expired uploads, then the oldest until `incoming` more bytes fit. Never throws. */
function prune(incoming: number, now: number): void {
  let entries: Array<{ path: string; size: number; mtime: number }>;
  try {
    entries = readdirSync(uploadsDir())
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        const path = join(uploadsDir(), name);
        const stat = statSync(path);
        return { path, size: stat.size, mtime: stat.mtimeMs };
      });
  } catch {
    return;
  }
  const kept = [];
  for (const entry of entries) {
    if (now - entry.mtime > UPLOAD_TTL_MS) {
      try { unlinkSync(entry.path); } catch { /* already gone */ }
    } else kept.push(entry);
  }
  let total = kept.reduce((n, e) => n + e.size, 0) + incoming;
  for (const entry of kept.sort((a, b) => a.mtime - b.mtime)) {
    if (total <= UPLOADS_MAX_BYTES) break;
    try { unlinkSync(entry.path); } catch { /* already gone */ }
    total -= entry.size;
  }
}

export function writeUpload(
  input: AttachmentInput,
  now = Date.now(),
): { ok: true; upload: StagedUpload } | { ok: false; error: string } {
  const id = randomBytes(12).toString('hex');
  const record: StoredUpload = {
    id,
    mediaType: input.mediaType,
    data: input.data,
    ...(input.name ? { name: input.name } : {}),
    bytes: decodedBytes(input.data),
  };
  try {
    prune(input.data.length, now);
    atomicWriteJsonSync(uploadPath(id), record);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true, upload: { uploadId: id, mediaType: record.mediaType, bytes: record.bytes } };
}

/** The staged attachment, or `null` when it is unknown, expired or unreadable. */
export function readUpload(id: string, now = Date.now()): AttachmentInput | null {
  if (!UPLOAD_ID_RE.test(id)) return null;
  let fd = -1;
  try {
    // One descriptor for the TTL check and the read, so both see the same file (CodeQL js/file-system-race).
    fd = openSync(uploadPath(id), 'r');
    if (now - fstatSync(fd).mtimeMs > UPLOAD_TTL_MS) return null;
    const stored = JSON.parse(readFileSync(fd, 'utf8')) as Partial<StoredUpload>;
    // Re-validated: the file sits on disk between write and read.
    const parsed = attachmentInputSchema.safeParse({
      mediaType: stored.mediaType,
      data: stored.data,
      ...(typeof stored.name === 'string' && stored.name ? { name: stored.name } : {}),
    });
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  } finally {
    if (fd !== -1) closeSync(fd);
  }
}

/** Idempotent; never throws. */
export function deleteUpload(id: string): void {
  if (!UPLOAD_ID_RE.test(id)) return;
  try { unlinkSync(uploadPath(id)); } catch { /* already gone */ }
}

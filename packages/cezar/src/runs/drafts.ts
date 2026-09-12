import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync, statSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import {
  DRAFT_IMAGE_ID_RE,
  DRAFT_MAX_IMAGES,
  DRAFT_MAX_SURFACES,
  DRAFT_SURFACE_RE,
  DRAFT_TEXT_MAX,
  type DraftEntry,
  type DraftImage,
  type DraftImageContent,
  type RunDraftsResponse,
} from '@open-mercato/cezar-contract';
import { atomicWriteJsonSync } from '../workspace/config.ts';

/**
 * The per-run draft store (spec `.ai/specs/2026-08-30-thread-composer-draft-persistence.md`,
 * #939): the unsent text and pasted screenshots of every editable input inside a task, kept as
 * plain files so a half-written message survives navigating away, a reload, a second browser and
 * a `cez` restart.
 *
 * ```
 * .ai/cezar/drafts/<runId>/
 *   draft.json                    { surfaces: { <surfaceId>: { text, images: [<imageId>], updatedAt } } }
 *   images/<imageId>.json         { id, mediaType, name, bytes, data }   ← the blob
 *   images/<imageId>.meta.json    { id, mediaType, name, bytes }         ← the same facts, without the bytes
 * ```
 *
 * One directory per run, so deleting a run's drafts is one `rm -rf` with no shared index to
 * rewrite. `draft.json` stores image IDS; the metadata lives beside the bytes, in a second tiny
 * file written in the same breath as the blob. That sidecar is not an index and cannot diverge
 * from one — it is written once, never rewritten, and its absence means exactly what a missing
 * blob means (the attachment is gone). It exists because a LISTING must not cost a multi-megabyte
 * `readFileSync` + `JSON.parse`: `cezar serve` is single-threaded and is streaming agent output
 * over SSE while the user types, so a per-typing-pause draft write that parsed every attached
 * screenshot would stall the whole cockpit. Only `GET …/images/:imageId` — the route that is
 * ASKING for the bytes — reads the blob.
 *
 * House style, inherited rather than invented (`workspace/ui-state.ts`, `runs/store.ts`): reads
 * NEVER throw — missing, unreadable, malformed and corrupt all degrade to "no draft"; writes are
 * atomic (tmp + rename, `0600`) so a crash mid-write cannot leave a truncated draft; and every
 * axis is bounded. The one bound that is not a per-request cap is the whole-store backstop below.
 *
 * Knows nothing about HTTP. The routes in `server/server.ts` own status codes; this owns the files.
 */

/** Everything the store keeps for one project lives here. */
export function draftsRoot(dataDir: string): string {
  return join(dataDir, 'drafts');
}

function runDir(dataDir: string, runId: string): string {
  // `runId` is a store-minted uuid, never user input — but the store is the last line before the
  // filesystem, so it is checked here too rather than trusted from the caller.
  return join(draftsRoot(dataDir), safeSegment(runId));
}

function draftPath(dataDir: string, runId: string): string {
  return join(runDir(dataDir, runId), 'draft.json');
}

function imagesDir(dataDir: string, runId: string): string {
  return join(runDir(dataDir, runId), 'images');
}

function imagePath(dataDir: string, runId: string, imageId: string): string {
  return join(imagesDir(dataDir, runId), `${safeSegment(imageId)}.json`);
}

const IMAGE_META_SUFFIX = '.meta.json';

/** The bytes-free half of a blob — see the module header for why it is a separate file. */
function imageMetaPath(dataDir: string, runId: string, imageId: string): string {
  return join(imagesDir(dataDir, runId), `${safeSegment(imageId)}${IMAGE_META_SUFFIX}`);
}

/** A path segment that cannot escape its directory. Anything else is refused outright — a draft
 *  is not worth a traversal, and every id that reaches here is machine-minted. The alphabet
 *  matches `runIdParamSchema`'s (dots included, `..` excluded). */
function safeSegment(value: string): string {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(value) || value.includes('..')) {
    throw new Error(`unsafe draft path segment: ${value}`);
  }
  return value;
}

/**
 * The whole-store ceiling, and the ONLY thing that ever deletes a draft the user did not empty.
 *
 * "Cleared on send or empty only" (Q4) is the user-facing policy, not a promise never to reclaim
 * disk: with images in scope one run's draft can hold ~20 MB, and "keep forever, in the user's
 * repo directory" without a ceiling is a disk-fill bug. Eviction is by least-recently-touched
 * WHOLE RUN, never by age and never by count — a user with 500 typed-but-unsent drafts keeps all
 * of them, because 500 text drafts do not come close to this.
 */
export const DRAFT_STORE_MAX_BYTES = 64 * 1024 * 1024;

/**
 * How long a freshly uploaded blob is safe from the orphan sweep.
 *
 * An attachment is POSTed on paste and only NAMED by the draft record on the next debounced PUT.
 * Without a grace window, a write to any surface in that gap would sweep the image the user just
 * pasted. Ten minutes is far past the 500 ms debounce and far short of mattering to the backstop.
 */
const ORPHAN_GRACE_MS = 10 * 60 * 1000;

/** On disk: the surface map, with image IDS rather than resolved metadata. */
interface StoredDraft {
  surfaces: Record<string, { text: string; images: string[]; updatedAt: string }>;
}

const EMPTY: StoredDraft = { surfaces: {} };

/**
 * Read `draft.json`, salvaging what parses.
 *
 * Additive and per-entry tolerant on purpose: an unknown surface id, a malformed entry or a
 * missing key drops THAT entry, never the file's siblings, and a corrupt file reads as no drafts
 * at all. Nothing here throws, so a read-only or half-written repo directory is invisible to the
 * cockpit rather than a 500.
 */
function readStored(dataDir: string, runId: string): StoredDraft {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(draftPath(dataDir, runId), 'utf8'));
  } catch {
    return { surfaces: {} };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { surfaces: {} };
  const surfacesRaw = (raw as { surfaces?: unknown }).surfaces;
  if (surfacesRaw === null || typeof surfacesRaw !== 'object' || Array.isArray(surfacesRaw)) {
    return { surfaces: {} };
  }
  const surfaces: StoredDraft['surfaces'] = {};
  for (const [surface, value] of Object.entries(surfacesRaw as Record<string, unknown>)) {
    if (!DRAFT_SURFACE_RE.test(surface)) continue;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    const entry = value as { text?: unknown; images?: unknown; updatedAt?: unknown };
    const text = typeof entry.text === 'string' ? entry.text.slice(0, DRAFT_TEXT_MAX) : '';
    const images = Array.isArray(entry.images)
      ? entry.images
          .filter((id): id is string => typeof id === 'string' && DRAFT_IMAGE_ID_RE.test(id))
          .slice(0, DRAFT_MAX_IMAGES)
      : [];
    if (text === '' && images.length === 0) continue; // an empty surface is not a draft
    surfaces[surface] = {
      text,
      images,
      updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : new Date(0).toISOString(),
    };
  }
  return { surfaces };
}

/** Read one image blob, or `undefined` when it is missing/corrupt. */
function readImage(dataDir: string, runId: string, imageId: string): DraftImageContent | undefined {
  if (!DRAFT_IMAGE_ID_RE.test(imageId)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(imagePath(dataDir, runId, imageId), 'utf8'));
  } catch {
    return undefined;
  }
  if (raw === null || typeof raw !== 'object') return undefined;
  const blob = raw as Partial<DraftImageContent>;
  if (typeof blob.data !== 'string' || typeof blob.mediaType !== 'string') return undefined;
  return {
    id: imageId,
    mediaType: blob.mediaType,
    name: typeof blob.name === 'string' ? blob.name : 'image',
    bytes: typeof blob.bytes === 'number' ? blob.bytes : 0,
    data: blob.data,
  };
}

/**
 * The metadata half of a blob — what a draft listing carries.
 *
 * Reads the sidecar, never the bytes: this runs once per attached image on every debounced `PUT`
 * and on every task open, and the bytes can be five megabytes each. The blob is confirmed with a
 * single `existsSync` so an attachment whose bytes vanished still drops out of the listing.
 */
function imageMeta(dataDir: string, runId: string, imageId: string): DraftImage | undefined {
  if (!DRAFT_IMAGE_ID_RE.test(imageId)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(imageMetaPath(dataDir, runId, imageId), 'utf8'));
  } catch {
    return undefined;
  }
  if (raw === null || typeof raw !== 'object') return undefined;
  const meta = raw as Partial<DraftImage>;
  if (typeof meta.mediaType !== 'string') return undefined;
  if (!existsSync(imagePath(dataDir, runId, imageId))) return undefined;
  return {
    id: imageId,
    mediaType: meta.mediaType,
    name: typeof meta.name === 'string' ? meta.name : 'image',
    bytes: typeof meta.bytes === 'number' ? meta.bytes : 0,
  };
}

/** Did this store mint `imageId`? Two `stat`s, no parse — the check a `PUT` runs per named image. */
function imageExists(dataDir: string, runId: string, imageId: string): boolean {
  if (!DRAFT_IMAGE_ID_RE.test(imageId)) return false;
  return (
    existsSync(imageMetaPath(dataDir, runId, imageId)) && existsSync(imagePath(dataDir, runId, imageId))
  );
}

/** Resolve a stored entry's image ids to metadata, dropping any whose blob is gone. */
function resolve(
  dataDir: string,
  runId: string,
  entry: StoredDraft['surfaces'][string],
): DraftEntry {
  const images: DraftImage[] = [];
  for (const id of entry.images) {
    const meta = imageMeta(dataDir, runId, id);
    if (meta) images.push(meta);
  }
  return { text: entry.text, images, updatedAt: entry.updatedAt };
}

/** `GET /runs/:id/drafts` — every surface of one run that holds something. Never throws. */
export function readRunDrafts(dataDir: string, runId: string): RunDraftsResponse {
  let stored: StoredDraft;
  try {
    stored = readStored(dataDir, runId);
  } catch {
    return { surfaces: {} };
  }
  const surfaces: Record<string, DraftEntry> = {};
  for (const [surface, entry] of Object.entries(stored.surfaces)) {
    const resolved = resolve(dataDir, runId, entry);
    // A surface whose text is empty and whose every blob has vanished is no longer a draft.
    if (resolved.text === '' && resolved.images.length === 0) continue;
    surfaces[surface] = resolved;
  }
  return { surfaces };
}

/** One surface, or `undefined`. */
export function readRunDraftSurface(
  dataDir: string,
  runId: string,
  surface: string,
): DraftEntry | undefined {
  return readRunDrafts(dataDir, runId).surfaces[surface];
}

/** How many attachments one surface already holds — the per-draft cap, answered from `draft.json`
 *  alone so an upload never touches the blobs it is about to sit beside. Never throws. */
export function countRunDraftImages(dataDir: string, runId: string, surface: string): number {
  try {
    return readStored(dataDir, runId).surfaces[surface]?.images.length ?? 0;
  } catch {
    return 0;
  }
}

export type DraftWriteResult =
  | { ok: true; entry: DraftEntry }
  | { ok: false; error: string };

/**
 * `PUT /runs/:id/drafts/:surface` — replace one surface.
 *
 * An empty write DELETES the entry (and sweeps the blobs nothing references any more), which is
 * how the "cleared when emptied" policy is enforced server-side rather than by client politeness.
 * The returned entry is what the surface now holds — for an empty write, an empty entry.
 */
export function writeRunDraftSurface(
  dataDir: string,
  runId: string,
  surface: string,
  input: { text: string; images: string[] },
  now: () => Date = () => new Date(),
): DraftWriteResult {
  if (!DRAFT_SURFACE_RE.test(surface)) return { ok: false, error: 'unknown draft surface' };
  if (input.text.length > DRAFT_TEXT_MAX) {
    return { ok: false, error: `text must be at most ${DRAFT_TEXT_MAX} characters` };
  }
  if (input.images.length > DRAFT_MAX_IMAGES) {
    return { ok: false, error: `at most ${DRAFT_MAX_IMAGES} images per draft` };
  }
  try {
    return writeChecked(dataDir, runId, surface, input, now);
  } catch (err) {
    // House rule: a draft write REPORTS its failure, it never raises one. The route turns this
    // into a 400 and the cockpit stays silent.
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function writeChecked(
  dataDir: string,
  runId: string,
  surface: string,
  input: { text: string; images: string[] },
  now: () => Date,
): DraftWriteResult {
  for (const id of input.images) {
    if (!imageExists(dataDir, runId, id)) return { ok: false, error: `unknown image: ${id}` };
  }

  const stamp = now().toISOString();
  const stored = readStored(dataDir, runId);
  const emptied = input.text === '' && input.images.length === 0;
  if (emptied) delete stored.surfaces[surface];
  else stored.surfaces[surface] = { text: input.text, images: [...input.images], updatedAt: stamp };

  if (Object.keys(stored.surfaces).length > DRAFT_MAX_SURFACES) {
    // Oldest first, so the surface just written is never the one dropped.
    const ordered = Object.entries(stored.surfaces).sort((a, b) =>
      a[1].updatedAt.localeCompare(b[1].updatedAt),
    );
    for (const [name] of ordered.slice(0, ordered.length - DRAFT_MAX_SURFACES)) {
      delete stored.surfaces[name];
    }
  }

  if (Object.keys(stored.surfaces).length === 0) {
    // Nothing left to keep — the whole run directory goes, blobs included.
    deleteRunDrafts(dataDir, runId);
    return { ok: true, entry: { text: '', images: [], updatedAt: stamp } };
  }

  try {
    enforceStoreBudget(dataDir, runId, estimatedBytes(stored));
    atomicWriteJsonSync(draftPath(dataDir, runId), stored);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  sweepOrphanImages(dataDir, runId, stored, now());
  return {
    ok: true,
    entry: emptied
      ? { text: '', images: [], updatedAt: stamp }
      : resolve(dataDir, runId, stored.surfaces[surface]!),
  };
}

/** `DELETE /runs/:id/drafts/:surface`. Idempotent — a surface that held nothing still ends up
 *  holding nothing. Never throws. */
export function deleteRunDraftSurface(dataDir: string, runId: string, surface: string): void {
  const stored = readStored(dataDir, runId);
  if (stored.surfaces[surface] === undefined) return;
  delete stored.surfaces[surface];
  if (Object.keys(stored.surfaces).length === 0) {
    deleteRunDrafts(dataDir, runId);
    return;
  }
  try {
    atomicWriteJsonSync(draftPath(dataDir, runId), stored);
  } catch {
    return; // unwritable repo — the draft simply stays; a failed cleanup is never louder than this
  }
  sweepOrphanImages(dataDir, runId, stored, new Date());
}

/** Every draft this run holds, gone — called when the run itself is deleted or pruned. A draft
 *  for a run that no longer exists is unreachable by definition. Never throws. */
export function deleteRunDrafts(dataDir: string, runId: string): void {
  try {
    rmSync(runDir(dataDir, runId), { recursive: true, force: true });
  } catch {
    // best effort — an undeletable draft directory is inert
  }
}

/** `POST /runs/:id/drafts/:surface/images` — store one attachment and mint its id. The blob is
 *  written before any draft record names it; the orphan sweep is what cleans up an upload the
 *  user removed before the debounce fired. */
export function writeRunDraftImage(
  dataDir: string,
  runId: string,
  image: { mediaType: string; name: string; data: string },
): { ok: true; image: DraftImage } | { ok: false; error: string } {
  const bytes = decodedBytes(image.data);
  const id = randomBytes(12).toString('hex');
  const record: DraftImageContent = {
    id,
    mediaType: image.mediaType,
    name: image.name,
    bytes,
    data: image.data,
  };
  const { data: _data, ...meta } = record;
  try {
    // `data` dominates the record; the envelope around it is noise at this scale.
    enforceStoreBudget(dataDir, runId, image.data.length);
    // Blob first, sidecar second: if the process dies between them the attachment is simply not
    // listed (`imageMeta` needs the sidecar) and the orphan sweep reclaims the bytes. The other
    // order would advertise an attachment whose bytes are not there yet.
    atomicWriteJsonSync(imagePath(dataDir, runId, id), record);
    atomicWriteJsonSync(imageMetaPath(dataDir, runId, id), meta);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true, image: meta };
}

/** `GET /runs/:id/drafts/:surface/images/:imageId` — the bytes, base64. */
export function readRunDraftImage(
  dataDir: string,
  runId: string,
  imageId: string,
): DraftImageContent | undefined {
  return readImage(dataDir, runId, imageId);
}

/** `DELETE /runs/:id/drafts/:surface/images/:imageId` — drop one attachment and any reference to
 *  it. Idempotent; never throws. */
export function deleteRunDraftImage(dataDir: string, runId: string, imageId: string): void {
  if (!DRAFT_IMAGE_ID_RE.test(imageId)) return;
  try {
    rmSync(imagePath(dataDir, runId, imageId), { force: true });
    rmSync(imageMetaPath(dataDir, runId, imageId), { force: true });
  } catch {
    // best effort
  }
  const stored = readStored(dataDir, runId);
  let touched = false;
  for (const entry of Object.values(stored.surfaces)) {
    const kept = entry.images.filter((id) => id !== imageId);
    if (kept.length !== entry.images.length) {
      entry.images = kept;
      touched = true;
    }
  }
  if (!touched) return;
  for (const [surface, entry] of Object.entries(stored.surfaces)) {
    if (entry.text === '' && entry.images.length === 0) delete stored.surfaces[surface];
  }
  if (Object.keys(stored.surfaces).length === 0) {
    deleteRunDrafts(dataDir, runId);
    return;
  }
  try {
    atomicWriteJsonSync(draftPath(dataDir, runId), stored);
  } catch {
    // best effort
  }
}

/** Base64 → decoded byte count, without decoding it. */
function decodedBytes(data: string): number {
  const clean = data.replace(/[^A-Za-z0-9+/=]/g, '');
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

/** Blobs no surface names any more, and old enough that no in-flight PUT can be about to name
 *  them (see `ORPHAN_GRACE_MS`), are removed. Best effort — an unswept blob is only disk. */
function sweepOrphanImages(dataDir: string, runId: string, stored: StoredDraft, now: Date): void {
  const referenced = new Set(Object.values(stored.surfaces).flatMap((entry) => entry.images));
  let files: string[];
  try {
    files = readdirSync(imagesDir(dataDir, runId));
  } catch {
    return;
  }
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    // A blob and its sidecar sweep independently, each on its own mtime — they are written
    // together, so in practice they go together too.
    const id = file.endsWith(IMAGE_META_SUFFIX)
      ? file.slice(0, -IMAGE_META_SUFFIX.length)
      : file.slice(0, -'.json'.length);
    if (referenced.has(id)) continue;
    const path = join(imagesDir(dataDir, runId), file);
    try {
      if (now.getTime() - statSync(path).mtimeMs < ORPHAN_GRACE_MS) continue;
      rmSync(path, { force: true });
    } catch {
      // best effort
    }
  }
}

/** Recursive byte total of one directory. Best effort — an unreadable entry counts as 0. */
function dirBytes(path: string): number {
  let total = 0;
  let entries: Dirent[];
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const child = join(path, entry.name);
    try {
      if (entry.isDirectory()) total += dirBytes(child);
      else total += statSync(child).size;
    } catch {
      // vanished mid-walk — count it as nothing
    }
  }
  return total;
}

/** The newest `updatedAt` in a run's draft file — the eviction order. A run whose file is
 *  unreadable sorts oldest, so a corrupt directory is the first thing reclaimed. */
function lastTouched(dataDir: string, runId: string): string {
  const stored = readStored(dataDir, runId);
  let newest = '';
  for (const entry of Object.values(stored.surfaces)) {
    if (entry.updatedAt > newest) newest = entry.updatedAt;
  }
  return newest;
}

/** Roughly what this draft record will occupy. An estimate on purpose: the exact figure costs a
 *  second `JSON.stringify` of the user's text, and it is only ever compared to a 64 MiB backstop. */
function estimatedBytes(stored: StoredDraft): number {
  let total = 0;
  for (const [surface, entry] of Object.entries(stored.surfaces)) {
    total += surface.length + entry.text.length + entry.updatedAt.length + 64;
    for (const id of entry.images) total += id.length + 8;
  }
  return total;
}

/** The fullness at which the cheap estimate below stops being trusted and the tree is walked. */
const BUDGET_RECHECK_BYTES = Math.floor(DRAFT_STORE_MAX_BYTES * 0.8);

/**
 * A running estimate of each store's size, so the exact walk happens near the ceiling rather than
 * on every typing pause.
 *
 * Deliberately one-directional: it only grows between walks, so a deletion leaves it reading HIGH
 * and the next write pays for a walk it did not need — the safe direction. It can never read low
 * enough to let the store past its ceiling unnoticed, because every walk resets it to the truth.
 */
const storeBytesEstimate = new Map<string, number>();

/**
 * Keep the whole store under {@link DRAFT_STORE_MAX_BYTES}, evicting least-recently-touched run
 * directories until it fits. `keepRunId` — the run being written right now — is never evicted, so
 * a write can't delete the draft it is in the middle of saving. `incomingBytes` is what is about
 * to be written, counted BEFORE the write so the store cannot overshoot its own ceiling by a whole
 * attachment. One log line per sweep, because a silent deletion of the user's own unsent text
 * would be the wrong kind of quiet.
 */
function enforceStoreBudget(dataDir: string, keepRunId: string, incomingBytes: number): void {
  const root = draftsRoot(dataDir);
  if (!existsSync(root)) {
    storeBytesEstimate.set(dataDir, incomingBytes);
    return;
  }
  const estimate = storeBytesEstimate.get(dataDir);
  if (estimate !== undefined && estimate + incomingBytes <= BUDGET_RECHECK_BYTES) {
    storeBytesEstimate.set(dataDir, estimate + incomingBytes);
    return;
  }
  let total = dirBytes(root);
  storeBytesEstimate.set(dataDir, total + incomingBytes);
  if (total + incomingBytes <= DRAFT_STORE_MAX_BYTES) return;
  let runIds: string[];
  try {
    runIds = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== keepRunId)
      .map((entry) => entry.name);
  } catch {
    return;
  }
  const ordered = runIds
    .map((id) => ({ id, touched: lastTouched(dataDir, id) }))
    .sort((a, b) => a.touched.localeCompare(b.touched));
  const evicted: string[] = [];
  for (const { id } of ordered) {
    if (total + incomingBytes <= DRAFT_STORE_MAX_BYTES) break;
    total -= dirBytes(join(root, id));
    deleteRunDrafts(dataDir, id);
    evicted.push(id);
  }
  storeBytesEstimate.set(dataDir, total + incomingBytes);
  if (evicted.length > 0) {
    console.warn(
      `[cezar] drafts store exceeded ${Math.round(DRAFT_STORE_MAX_BYTES / 1024 / 1024)} MiB — ` +
        `evicted ${evicted.length} least-recently-touched draft(s)`,
    );
  }
}

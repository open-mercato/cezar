import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { RunArtifact, RunArtifactsEvent, RunArtifactVersion } from '@open-mercato/cezar-contract';
import { imageMimeType } from './git-changes.ts';

/**
 * Serving run artifacts (spec `.ai/specs/2026-10-22-html-artifacts-and-impact.md` § Serving).
 *
 * HTML runs on the cockpit origin but in an OPAQUE one: the CSP `sandbox` directive (no
 * `allow-same-origin`) holds even when the URL is opened directly in a tab. Never add
 * `allow-same-origin` here — it re-opens the API to every page an agent writes.
 */

const CDN_SCRIPT = ['https://cdnjs.cloudflare.com', 'https://cdn.jsdelivr.net', 'https://unpkg.com'];
const CDN_STYLE = ['https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com', 'https://cdn.jsdelivr.net'];
const CDN_FONT = ['https://fonts.gstatic.com'];

/** The exact CSP of an HTML artifact (Q3 + Q4). `cdnEnabled` false drops every `https:` source. */
export function artifactCsp(cdnEnabled: boolean): string {
  const src = (base: string[], cdn: string[]) => [...base, ...(cdnEnabled ? cdn : [])].join(' ');
  return [
    'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox',
    "default-src 'none'",
    `script-src ${src(["'unsafe-inline'"], CDN_SCRIPT)}`,
    `style-src ${src(["'unsafe-inline'"], CDN_STYLE)}`,
    `font-src ${src(['data:'], CDN_FONT)}`,
    'img-src data: blob:',
    'media-src data: blob:',
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
}

/** The no-script set the raw image route already sends (`/runs/:id/files?raw=1`). */
const INERT_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

/** Response headers for one listed artifact, by kind. */
export function artifactHeaders(artifact: RunArtifact, cdnEnabled: boolean): Record<string, string> {
  const common = { 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' };
  switch (artifact.kind) {
    case 'html':
      return {
        ...common,
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': artifactCsp(cdnEnabled),
        'referrer-policy': 'no-referrer',
        'cross-origin-resource-policy': 'same-origin',
      };
    case 'markdown':
      return { ...common, 'content-type': 'text/markdown; charset=utf-8', 'content-security-policy': INERT_CSP };
    case 'json':
      return { ...common, 'content-type': 'application/json; charset=utf-8', 'content-security-policy': INERT_CSP };
    case 'image':
      return {
        ...common,
        'content-type': imageMimeType(artifact.name) ?? 'application/octet-stream',
        'content-security-policy': INERT_CSP,
      };
    default:
      return {
        ...common,
        'content-type': 'application/octet-stream',
        'content-security-policy': INERT_CSP,
        'content-disposition': `attachment; filename="${artifact.name}"`,
      };
  }
}

/**
 * Open a listed artifact for streaming. `O_NOFOLLOW` + an fstat on the opened handle close the
 * window between the membership scan and the read: a file swapped for a symlink is refused.
 */
export async function openArtifact(dir: string, name: string): Promise<ReadableStream<Uint8Array> | null> {
  let handle;
  try {
    handle = await open(join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!(await handle.stat()).isFile()) {
      await handle.close();
      return null;
    }
  } catch {
    await handle?.close().catch(() => undefined);
    return null;
  }
  return Readable.toWeb(handle.createReadStream()) as ReadableStream<Uint8Array>;
}

/** What `RunStore.publishArtifacts` emits as `('artifacts', …)`. */
export interface ArtifactsBusPayload {
  runId: string;
  artifacts: RunArtifact[];
  truncated: boolean;
  versions?: RunArtifactVersion[];
}

/** The `artifacts` SSE frame; `project` only on the workspace stream. */
export function artifactsFrame(payload: ArtifactsBusPayload, project?: string): RunArtifactsEvent {
  return {
    type: 'artifacts',
    runId: payload.runId,
    artifacts: payload.artifacts,
    truncated: payload.truncated,
    ...(payload.versions?.length ? { versions: payload.versions } : {}),
    ...(project !== undefined ? { project } : {}),
  };
}

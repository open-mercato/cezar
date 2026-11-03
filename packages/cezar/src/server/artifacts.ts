import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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

/**
 * The exact CSP of an HTML artifact (Q3 + Q4). `cdnEnabled` false drops every `https:` source.
 * `ownBase` is this run's artifacts URL (`artifactsBaseUrl`): images and media load from there
 * only. `'self'` is not used — it would admit every cockpit route, and no other run's files.
 */
export function artifactCsp(cdnEnabled: boolean, ownBase?: string): string {
  const src = (base: string[], cdn: string[]) => [...base, ...(cdnEnabled ? cdn : [])].join(' ');
  const own = ownBase ? ` ${ownBase}` : '';
  return [
    'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox',
    "default-src 'none'",
    `script-src ${src(["'unsafe-inline'"], CDN_SCRIPT)}`,
    `style-src ${src(["'unsafe-inline'"], CDN_STYLE)}`,
    `font-src ${src(['data:'], CDN_FONT)}`,
    `img-src data: blob:${own}`,
    `media-src data: blob:${own}`,
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
}

/** The no-script set the raw image route already sends (`/runs/:id/files?raw=1`). */
const INERT_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

/**
 * The run's artifacts directory as a CSP source, from the URL the artifact was requested at:
 * everything up to and including `/runs/<id>/artifacts/`, so a page's relative `<img src>` resolves inside
 * it whichever alias (`/api/v1/…` or `/api/v1/p/<project>/…`) served the page. `undefined` when the
 * URL holds anything a CSP source list could misread. The host is the one this server saw: behind
 * a proxy that rewrites `Host` (the Vite dev proxy included) the images fail closed.
 */
export function artifactsBaseUrl(requestUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return undefined;
  }
  // The route's own `/runs/<id>/artifacts/`, never a folder that happens to be named `artifacts`.
  const route = /^.*?\/runs\/[^/]+\/artifacts\//.exec(url.pathname);
  if (!route || (url.protocol !== 'http:' && url.protocol !== 'https:')) return undefined;
  const base = `${url.origin}${route[0]}`;
  return /^[A-Za-z0-9:/._~%@[\]-]+$/.test(base) ? base : undefined;
}

/** Response headers for one listed artifact, by kind. */
export function artifactHeaders(artifact: RunArtifact, cdnEnabled: boolean, ownBase?: string): Record<string, string> {
  const common = { 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' };
  switch (artifact.kind) {
    case 'html':
      return {
        ...common,
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': artifactCsp(cdnEnabled, ownBase),
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
 * window between the membership scan and the read: a file swapped for a symlink is refused. For
 * a nested name `O_NOFOLLOW` guards only the last segment, so the opened file must also be the
 * one its real path names inside `dir` — a folder swapped for a symlink is refused too.
 */
export async function openArtifact(dir: string, name: string): Promise<ReadableStream<Uint8Array> | null> {
  let handle;
  try {
    const path = join(dir, name);
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || (name.includes('/') && !(await sameFileInside(dir, path, opened)))) {
      await handle.close();
      return null;
    }
  } catch {
    await handle?.close().catch(() => undefined);
    return null;
  }
  return Readable.toWeb(handle.createReadStream()) as ReadableStream<Uint8Array>;
}

async function sameFileInside(dir: string, path: string, opened: { dev: number; ino: number }): Promise<boolean> {
  const [root, real] = await Promise.all([realpath(dir), realpath(path)]);
  if (dirname(dirname(real)) !== root) return false;
  const now = await stat(real);
  return now.dev === opened.dev && now.ino === opened.ino;
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

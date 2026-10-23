import { watch, type FSWatcher } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { ARTIFACT_NAME_RE, type RunArtifact, type RunArtifactKind, type RunArtifactVersion } from '@open-mercato/cezar-contract';
import { imageMimeType } from '../server/git-changes.ts';

/**
 * The generic artifacts layer (spec `.ai/specs/2026-10-22-html-artifacts-and-impact.md`):
 * listing a run's artifacts directory, telling the agent about it, and watching it while live.
 */

/** Q5 caps: a runaway agent stays bounded. */
export const MAX_ARTIFACTS = 64;
export const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
const TITLE_SNIFF_BYTES = 8 * 1024;
const TITLE_MAX_CHARS = 200;
const WATCH_DEBOUNCE_MS = 300;

export interface ArtifactListing {
  artifacts: RunArtifact[];
  truncated: boolean;
  versions?: RunArtifactVersion[];
}

/** Kept revisions live under `<dir>/.versions/<n>/` (spec R4); the scan's dotfile skip hides them. */
export const VERSIONS_DIR = '.versions';
const MAX_VERSIONS = 100;

/** The directory of revision `version`. */
export function artifactVersionDir(dir: string, version: number): string {
  return join(dir, VERSIONS_DIR, String(version));
}

async function realDir(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory(); // lstat: a symlinked directory is refused
  } catch {
    return false;
  }
}

/**
 * Revision `version`'s directory when both `.versions` and `.versions/<n>` are real directories,
 * else null. The agent can write here, so a planted symlink must never lead a read elsewhere.
 */
export async function existingVersionDir(dir: string, version: number): Promise<string | null> {
  if (!(await realDir(join(dir, VERSIONS_DIR)))) return null;
  const vdir = artifactVersionDir(dir, version);
  return (await realDir(vdir)) ? vdir : null;
}

/** Kept revisions, oldest first (the newest 100). Never throws; no `.versions` is `[]`. */
export async function listArtifactVersions(dir: string): Promise<RunArtifactVersion[]> {
  if (!(await realDir(join(dir, VERSIONS_DIR)))) return [];
  let names: string[];
  try {
    names = await readdir(join(dir, VERSIONS_DIR));
  } catch {
    return [];
  }
  const numbers = names.filter((name) => /^[1-9][0-9]{0,5}$/.test(name)).map(Number).sort((a, b) => a - b);
  const versions: RunArtifactVersion[] = [];
  for (const version of numbers.slice(-MAX_VERSIONS)) {
    const vdir = await existingVersionDir(dir, version);
    if (!vdir) continue;
    const { artifacts } = await scanArtifacts(vdir);
    if (artifacts.length === 0) continue;
    const newest = artifacts.reduce((a, b) => (a.updatedAt >= b.updatedAt ? a : b));
    versions.push({ version, updatedAt: newest.updatedAt, files: artifacts.map((a) => a.name).sort() });
  }
  return versions;
}

/** `CEZ_ARTIFACTS_CDN=0` closes the CDN script allowlist (owner decision O1: default on). */
export function artifactsCdnEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CEZ_ARTIFACTS_CDN !== '0';
}

/** The one system-prompt line every agent step carries (O3). */
export function artifactsPromptPart(dir: string, cdnEnabled = artifactsCdnEnabled()): string {
  const network = cdnEnabled
    ? 'Scripts may load only from cdnjs, jsDelivr or unpkg with an exact pinned version; no fetch/XHR to any host.'
    : 'Inline every script and style — no external URL loads; no fetch/XHR to any host.';
  return `To show the user a page or report, write it as a single HTML (or .md/.png) file into \`${dir}\` (also $CEZ_ARTIFACTS_DIR); it appears live in the cockpit's Assets view. ${network}`;
}

function kindOf(name: string, size: number): RunArtifactKind {
  if (size > MAX_ARTIFACT_BYTES) return 'other';
  const ext = extname(name).toLowerCase();
  if (ext === '.html' || ext === '.htm') return 'html';
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  if (ext === '.json') return 'json';
  if (imageMimeType(name)) return 'image';
  return 'other';
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };

function cleanTitle(raw: string): string | undefined {
  const text = raw
    .replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, e: string) => ENTITIES[e] ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.slice(0, TITLE_MAX_CHARS) : undefined;
}

/** `<title>` (HTML) or the first `# ` heading (Markdown), from the first 8 KB only. */
export function extractTitle(kind: RunArtifactKind, head: string): string | undefined {
  if (kind === 'html') {
    const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head);
    return match ? cleanTitle(match[1]!) : undefined;
  }
  if (kind === 'markdown') {
    const match = /^#[ \t]+(.+)$/m.exec(head);
    return match ? cleanTitle(match[1]!.replace(/[ \t]+#+[ \t]*$/, '')) : undefined;
  }
  return undefined;
}

async function readHead(path: string): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const buf = Buffer.alloc(TITLE_SNIFF_BYTES);
    const { bytesRead } = await handle.read(buf, 0, TITLE_SNIFF_BYTES, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * The run's artifacts, newest first. Never throws — a missing or unreadable directory is an
 * empty listing. Non-recursive; skips dotfiles, directories, symlinks and names the serving
 * route could not address, so a listed name is always a regular file inside `dir`.
 */
export async function scanArtifacts(dir: string): Promise<ArtifactListing> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return { artifacts: [], truncated: false };
  }
  const files: Array<{ name: string; size: number; mtimeMs: number }> = [];
  for (const name of names) {
    if (name.startsWith('.') || !ARTIFACT_NAME_RE.test(name)) continue;
    try {
      const info = await lstat(join(dir, name));
      if (!info.isFile()) continue; // lstat: a symlink is never a file here
      files.push({ name, size: info.size, mtimeMs: info.mtimeMs });
    } catch {
      // vanished between readdir and lstat
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
  const kept = files.slice(0, MAX_ARTIFACTS);
  const artifacts: RunArtifact[] = [];
  for (const file of kept) {
    const kind = kindOf(file.name, file.size);
    let title: string | undefined;
    if (kind === 'html' || kind === 'markdown') {
      title = extractTitle(kind, await readHead(join(dir, file.name)).catch(() => ''));
    }
    artifacts.push({
      name: file.name,
      kind,
      ...(title ? { title } : {}),
      size: file.size,
      updatedAt: new Date(file.mtimeMs).toISOString(),
    });
  }
  const versions = await listArtifactVersions(dir);
  return { artifacts, truncated: files.length > MAX_ARTIFACTS, ...(versions.length ? { versions } : {}) };
}

/**
 * Debounced `fs.watch` on one directory. Speed only — `fs.watch` is not reliable everywhere, so
 * the turn-end rescan is the guarantee (spec Q2). Never throws; an unwatchable dir is a no-op.
 */
export function watchArtifacts(dir: string, onChange: () => void): { close: () => void } {
  let timer: NodeJS.Timeout | undefined;
  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(dir, { persistent: false }, () => {
      clearTimeout(timer);
      timer = setTimeout(onChange, WATCH_DEBOUNCE_MS);
      timer.unref?.();
    });
    watcher.on('error', () => watcher?.close());
  } catch {
    watcher = undefined;
  }
  return {
    close: () => {
      clearTimeout(timer);
      try {
        watcher?.close();
      } catch {
        // already closed
      }
    },
  };
}

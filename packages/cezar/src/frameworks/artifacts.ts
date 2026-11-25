import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * "Must leave" artifacts (spec 2026-11-15-framework-board D14): which of a stage's globs match
 * nothing in the card's worktree. A tiny matcher on purpose — `*` and `?` within one path
 * segment, `**` across segments — so no glob dependency is needed for a handful of paths.
 */

const SKIP_DIRS = new Set(['.git', 'node_modules']);
const MAX_VISITS = 20_000;

function segmentRegex(segment: string): RegExp {
  const body = segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
  return new RegExp(`^${body}$`);
}

/** A glob relative to the worktree; absolute paths and `..` never match (they leave the tree). */
function segmentsOf(glob: string): string[] | null {
  const trimmed = glob.trim().replace(/^\.\//, '');
  if (!trimmed || trimmed.startsWith('/') || /^[A-Za-z]:[\\/]/.test(trimmed)) return null;
  const segments = trimmed.split('/').filter(Boolean);
  return segments.some((s) => s === '..') ? null : segments;
}

async function anyMatch(root: string, segments: string[]): Promise<boolean> {
  let visits = 0;
  const walk = async (dir: string, i: number): Promise<boolean> => {
    if (++visits > MAX_VISITS) return false;
    if (i === segments.length) return true;
    const segment = segments[i]!;
    if (segment === '**') {
      if (await walk(dir, i + 1)) return true;
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        if (e.isDirectory() && !SKIP_DIRS.has(e.name) && (await walk(join(dir, e.name), i))) return true;
      }
      return false;
    }
    if (!/[*?]/.test(segment)) {
      const path = join(dir, segment);
      const info = await stat(path).catch(() => null);
      if (!info) return false;
      return i === segments.length - 1 ? true : info.isDirectory() && walk(path, i + 1);
    }
    const re = segmentRegex(segment);
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (!re.test(e.name)) continue;
      if (i === segments.length - 1) return true;
      if (e.isDirectory() && (await walk(join(dir, e.name), i + 1))) return true;
    }
    return false;
  };
  return walk(root, 0);
}

/** The globs (as written) that match no file or directory under `root`. Never throws. */
export async function missingArtifacts(root: string, globs: readonly string[]): Promise<string[]> {
  const missing: string[] = [];
  for (const glob of globs) {
    const segments = segmentsOf(glob);
    if (!segments || !(await anyMatch(root, segments))) missing.push(glob);
  }
  return missing;
}

/** Whether a worktree-relative path matches a glob (the state watcher's event filter). */
export function globMatches(glob: string, relPath: string): boolean {
  const segments = segmentsOf(glob);
  if (!segments) return false;
  const parts = relPath.split(/[\\/]/).filter(Boolean);
  const match = (i: number, j: number): boolean => {
    if (i === segments.length) return j === parts.length;
    if (segments[i] === '**') return match(i + 1, j) || (j < parts.length && match(i, j + 1));
    return j < parts.length && segmentRegex(segments[i]!).test(parts[j]!) && match(i + 1, j + 1);
  };
  return match(0, 0);
}

/** The directory a glob's matches all live under: its segments before the first wildcard. */
export function globStaticPrefix(glob: string): string[] {
  const segments = segmentsOf(glob) ?? [];
  const out: string[] = [];
  for (const s of segments.slice(0, -1)) {
    if (/[*?]/.test(s)) break;
    out.push(s);
  }
  return out;
}

/** The rest of a version bump — the files a `chore(release)` PR used to edit by hand beside the
 *  release set: the cockpit manifest, the lockfile and the changelog. Pure; the release-line
 *  workflows (`scripts/release-line.mts`) do the I/O. */

import { compareStableVersions, parseStableVersion } from './stable.ts';
import { pinDependency, type ManifestLike } from './manifests.ts';

const DEP_SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies'] as const;

/** Stamp a workspace that versions in lockstep but is not in the release set (the cockpit). */
export function stampCompanionManifest(
  pkg: ManifestLike,
  version: string,
  releaseNames: readonly string[],
): ManifestLike {
  let out: ManifestLike = { ...pkg, version };
  for (const name of releaseNames) out = pinDependency(out, name, `^${version}`);
  return out;
}

interface LockfileLike {
  packages?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

/** Mirror stamped workspace manifests into `package-lock.json` — the version and every range the
 *  lock already records — so `npm ci` keeps passing on the bump commit. */
export function stampLockfile(
  lock: LockfileLike,
  manifestsByDir: Readonly<Record<string, ManifestLike>>,
): LockfileLike {
  const packages = { ...lock.packages };
  for (const [dir, manifest] of Object.entries(manifestsByDir)) {
    const entry = packages[dir];
    if (!entry) continue;
    const next: Record<string, unknown> = { ...entry, version: manifest.version };
    for (const section of DEP_SECTIONS) {
      const locked = entry[section] as Record<string, string> | undefined;
      const declared = manifest[section] as Record<string, string> | undefined;
      if (!locked || !declared) continue;
      const merged = { ...locked };
      for (const name of Object.keys(locked)) if (name in declared) merged[name] = declared[name]!;
      next[section] = merged;
    }
    packages[dir] = next;
  }
  return { ...lock, packages };
}

const HEADING = /^# (\S+)(?:\s.*)?$/;

/**
 * Make sure CHANGELOG.md has an entry for `version`. A hand-written one wins: an existing
 * `# <version>` is kept and a leading `# Unreleased` is renamed; only when neither is there is
 * the generated `notes` body used.
 */
export function ensureChangelogEntry(
  changelog: string,
  version: string,
  date: string,
  notes: string,
): { text: string; source: 'existing' | 'unreleased' | 'generated' } {
  const lines = changelog.split('\n');
  if (lines.some((l) => HEADING.exec(l)?.[1] === version)) return { text: changelog, source: 'existing' };
  const heading = `# ${version} (${date})`;
  const first = lines.findIndex((l) => HEADING.test(l));
  if (first >= 0 && /^# unreleased\b/i.test(lines[first]!)) {
    lines[first] = heading;
    return { text: lines.join('\n'), source: 'unreleased' };
  }
  const body = notes.trim() || '- Maintenance release.';
  return { text: `${heading}\n\n${body}\n\n${changelog.replace(/^\n+/, '')}`, source: 'generated' };
}

/**
 * Drop a leading `# Unreleased` section. A cut hands it to the new line, which renames it to
 * the line's `x.y.0`; left on `main` it would sit above that entry once the release carries it
 * back, and the next cut would ship it again.
 */
export function dropUnreleased(changelog: string): string {
  const lines = changelog.split('\n');
  const first = lines.findIndex((l) => HEADING.test(l));
  if (first < 0 || !/^# unreleased\b/i.test(lines[first]!)) return changelog;
  let end = lines.findIndex((l, i) => i > first && HEADING.test(l));
  if (end < 0) end = lines.length;
  return [...lines.slice(0, first), ...lines.slice(end)].join('\n');
}

/** The `# <version>` entry's heading line and body, or `null` when there is none. */
export function changelogSection(
  changelog: string,
  version: string,
): { heading: string; body: string } | null {
  const lines = changelog.split('\n');
  const start = lines.findIndex((l) => HEADING.exec(l)?.[1] === version);
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && HEADING.test(l));
  if (end < 0) end = lines.length;
  return { heading: lines[start]!, body: lines.slice(start + 1, end).join('\n').trim() };
}

/**
 * Carry a released entry onto another branch's changelog (a patch released from
 * `release/vX.Y.x` back to `main`): placed above the first older version, after any
 * `# Unreleased`, and a no-op when the branch already has it.
 */
export function insertChangelogEntry(changelog: string, version: string, entry: string): string {
  const lines = changelog.split('\n');
  if (lines.some((l) => HEADING.exec(l)?.[1] === version)) return changelog;
  const at = lines.findIndex((l) => {
    const v = HEADING.exec(l)?.[1];
    return v !== undefined && parseStableVersion(v) !== null && compareStableVersions(v, version) < 0;
  });
  const block = [...entry.trimEnd().split('\n'), ''];
  if (at < 0) return `${changelog.trimEnd()}\n\n${block.join('\n')}`;
  lines.splice(at, 0, ...block);
  return lines.join('\n');
}

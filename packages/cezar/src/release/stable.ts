/** Stable-release decisions — the pure half of `scripts/release.mts`.
 *
 *  Sibling of `snapshot.ts`, but for the *owner-driven* `latest` channel. The
 *  `Release` workflow (`.github/workflows/release.yml`) is run manually and
 *  never fires from a push, so — unlike snapshots — a stable release is the only
 *  thing that ever moves the `latest` dist-tag (spec
 *  `.ai/specs/2026-07-18-npm-preview-publish.md`, #482).
 *
 *  Two decisions live here so they stay unit-testable and side-effect-free: the next stable
 *  version for a given bump, and the pin style the release set is stamped with. Crucially,
 *  stable releases use a **caret** range — the opposite of the snapshot stamper's exact pin —
 *  so a stable `cezar-cli` picks up compatible patch releases of the implementation package.
 */

import { stampManifestSet, type ReleaseManifests as ReleaseManifestSet } from './manifests.ts';

/** The version-bump modes the Release workflow offers. `existing` publishes the
 *  version already committed to the service manifest (for hand-prepared releases);
 *  the rest increment semver from the current base. */
export type ReleaseBump = 'patch' | 'minor' | 'major' | 'existing';

export const RELEASE_BUMPS: readonly ReleaseBump[] = ['patch', 'minor', 'major', 'existing'];

export function isReleaseBump(value: string): value is ReleaseBump {
  return (RELEASE_BUMPS as readonly string[]).includes(value);
}

/** Compute the next stable version from the current base and a bump mode.
 *
 *  `base` must be a plain `major.minor.patch` (no prerelease/build suffix) — a
 *  stable release should never start from a snapshot version. `existing` returns
 *  the base verbatim; the increments zero out the lower components the way
 *  `npm version` does. Returns `null` for an unparseable base so the caller can
 *  fail loudly instead of publishing a garbage version. */
export function computeStableVersion(bump: ReleaseBump, base: string): string | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(base.trim());
  if (!m) return null;
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  switch (bump) {
    case 'existing':
      return `${major}.${minor}.${patch}`;
    case 'patch':
      return `${major}.${minor}.${patch + 1}`;
    case 'minor':
      return `${major}.${minor + 1}.0`;
    case 'major':
      return `${major + 1}.0.0`;
    default:
      return null;
  }
}

/** `[major, minor, patch]` of a plain `x.y.z`, or `null` for anything else. */
export function parseStableVersion(version: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Semver order of two plain versions; an unparseable one sorts lowest. */
export function compareStableVersions(a: string, b: string): number {
  const pa = parseStableVersion(a);
  const pb = parseStableVersion(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
  return 0;
}

/** The maintenance branch a version's minor line lives on: `0.15.2` → `release/v0.15.x`. */
export function releaseBranchFor(version: string): string | null {
  const v = parseStableVersion(version);
  return v ? `release/v${v[0]}.${v[1]}.x` : null;
}

/** The `major.minor` a `release/vX.Y.x` branch maintains, or `null` for any other ref. */
export function parseReleaseBranch(ref: string): { major: number; minor: number } | null {
  const m = /^(?:refs\/heads\/)?release\/v(\d+)\.(\d+)\.x$/.exec(ref.trim());
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
}

/** The version `main` moves to when its line is cut: the next minor. */
export function nextMinorVersion(version: string): string | null {
  return computeStableVersion('minor', version);
}

export type ReleasePlan =
  | { ok: true; version: string; bumped: boolean; resume: boolean; previousTag: string | null }
  | { ok: false; error: string };

/**
 * What a release from a `release/vX.Y.x` branch publishes.
 *
 * A release is done when its GitHub Release exists (created last); the tag pins its commit.
 * - The line's newest tag has no GitHub Release → **resume** that version at its tag. Backports
 *   merged since wait for the next patch, so one npm version never mixes two commits.
 * - Otherwise the committed version ships as-is while no tag names it (a fresh line's `x.y.0`,
 *   or a bump whose run died before tagging); once tagged, the patch is bumped first.
 * - An untagged version with packages already on npm is refused: publishing it from the tip
 *   would mix revisions. Restore its tag at the published commit instead.
 */
export function planRelease(input: {
  branch: string;
  manifestVersion: string;
  tags: readonly string[];
  /** Tags that have a GitHub Release. */
  releasedTags: readonly string[];
  /** Whether any release-set package already has `manifestVersion` on npm. */
  manifestPublished: boolean;
}): ReleasePlan {
  const line = parseReleaseBranch(input.branch);
  if (!line) return { ok: false, error: `"${input.branch}" is not a release/vX.Y.x branch` };
  const manifest = input.manifestVersion.trim();
  const base = parseStableVersion(manifest);
  if (!base) return { ok: false, error: `manifest version "${manifest}" is not a plain x.y.z` };
  if (base[0] !== line.major || base[1] !== line.minor) {
    return { ok: false, error: `manifest version ${manifest} does not belong to ${input.branch}` };
  }
  const tags = input.tags.map((t) => t.trim());
  const previousOf = (version: string) =>
    tags
      .filter((t) => parseStableVersion(t) && compareStableVersions(t, version) < 0)
      .sort(compareStableVersions)
      .at(-1) ?? null;

  const newest = newestLineTag(tags, line);
  if (newest && !input.releasedTags.includes(newest)) {
    const version = newest.slice(1);
    return { ok: true, version, bumped: false, resume: true, previousTag: previousOf(version) };
  }

  const taken = new Set(tags);
  let version = manifest;
  while (taken.has(`v${version}`)) version = computeStableVersion('patch', version)!;
  const bumped = version !== manifest;
  if (!bumped && input.manifestPublished) {
    return {
      ok: false,
      error: `${manifest} is on npm but has no v${manifest} tag — restore the tag at the commit it was published from (never delete a release tag)`,
    };
  }
  return { ok: true, version, bumped, resume: false, previousTag: previousOf(version) };
}

/** The highest `vX.Y.Z` tag of one line, or `null`. */
export function newestLineTag(
  tags: readonly string[],
  line: { major: number; minor: number },
): string | null {
  return (
    tags
      .filter((t) => {
        const v = /^v/.test(t) ? parseStableVersion(t) : null;
        return v !== null && v[0] === line.major && v[1] === line.minor;
      })
      .sort(compareStableVersions)
      .at(-1) ?? null
  );
}

/** The highest stable version among the release set's `latest` dist-tags — what a new release
 *  must reach to move `latest`. Judging one package misses a half-published run. */
export function highestLatest(latests: readonly (string | null | undefined)[]): string | null {
  return (
    latests
      .filter((v): v is string => typeof v === 'string' && parseStableVersion(v) !== null)
      .sort(compareStableVersions)
      .at(-1) ?? null
  );
}

/**
 * The dist-tag a stable release publishes under. Only the newest line moves `latest` — the
 * updater's stable channel follows it — so a backport publishes under `latest-X.Y` instead.
 */
export function resolveStableDistTag(version: string, currentLatest: string | null | undefined): string {
  const v = parseStableVersion(version);
  if (!v) throw new Error(`not a stable version: ${version}`);
  if (!currentLatest || !parseStableVersion(currentLatest)) return 'latest';
  return compareStableVersions(version, currentLatest) >= 0 ? 'latest' : `latest-${v[0]}.${v[1]}`;
}

export type { ManifestLike, ReleaseManifests } from './manifests.ts';

/** Stamp the release set to a stable version.
 *
 *  Mirror of `stampSnapshotManifests`, differing in exactly one decision: intra-release
 *  dependencies get a **caret** range (`^0.1.6`), not an exact pin. A stable `cezar-cli` should
 *  follow compatible releases of the implementation package, and a stable service should follow
 *  compatible releases of the api-client; a snapshot must pin the one exact build it was cut
 *  from. Everything else — which manifests exist, which sections carry the pin, what the alias
 *  inherits — lives in `manifests.ts` so the two channels cannot drift apart. */
export function stampStableManifests(
  manifests: ReleaseManifestSet,
  version: string,
): ReleaseManifestSet {
  return stampManifestSet(manifests, version, (v) => `^${v}`);
}

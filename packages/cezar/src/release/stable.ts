/** Stable-release decisions — the pure half of `scripts/release.mjs`.
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
  | { ok: true; version: string; bumped: boolean; previousTag: string | null }
  | { ok: false; error: string };

/**
 * What a release from a `release/vX.Y.x` branch publishes.
 *
 * The committed version ships as-is while no tag names it (the line's first `x.y.0`); once it
 * is tagged, the release bumps the patch first — past any tag already taken, so a re-run after a
 * half-finished release never collides. The branch and the manifests must agree on the line.
 */
export function planRelease(input: {
  branch: string;
  manifestVersion: string;
  tags: readonly string[];
}): ReleasePlan {
  const line = parseReleaseBranch(input.branch);
  if (!line) return { ok: false, error: `"${input.branch}" is not a release/vX.Y.x branch` };
  const base = parseStableVersion(input.manifestVersion);
  if (!base) return { ok: false, error: `manifest version "${input.manifestVersion}" is not a plain x.y.z` };
  if (base[0] !== line.major || base[1] !== line.minor) {
    return {
      ok: false,
      error: `manifest version ${input.manifestVersion} does not belong to ${input.branch}`,
    };
  }
  const taken = new Set(input.tags.map((t) => t.trim()));
  let version = input.manifestVersion.trim();
  while (taken.has(`v${version}`)) version = computeStableVersion('patch', version)!;
  const previous = input.tags
    .filter((t) => parseStableVersion(t) && compareStableVersions(t, version) < 0)
    .sort(compareStableVersions)
    .at(-1);
  return { ok: true, version, bumped: version !== input.manifestVersion.trim(), previousTag: previous ?? null };
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

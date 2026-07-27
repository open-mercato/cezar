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

import { stampManifestSet, type ReleaseManifests as ReleaseManifestSet } from './manifests.js';

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

export type { ManifestLike, ReleaseManifests } from './manifests.js';

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

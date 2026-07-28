/** Snapshot release decisions — the pure half of `scripts/release-snapshot.mjs`.
 *
 *  Spec `.ai/specs/2026-07-18-npm-preview-publish.md` (#482): every green CI run
 *  publishes an installable preview of the CLI. This module decides *whether* a
 *  given CI event publishes, under *which* version and dist-tag, and how the two
 *  manifests (the scoped package and its unscoped alias) are stamped. Kept
 *  dependency-free and side-effect-free so the decision is unit-testable; the
 *  script owns file writes, `npm publish`, and the exit code.
 *
 *  Deliberately name-agnostic: package names come from the checked-out manifests
 *  at call time, never from constants — so the `@pat-lewczuk/cezar` →
 *  `@open-mercato/cezar` rename (PR #501) lands independently of this pipeline.
 */

import { stampManifestSet, type ReleaseManifests as ReleaseManifestSet } from './manifests.js';

/** The CI facts the decision needs, straight from GitHub Actions' env/event. */
export interface SnapshotContext {
  /** `GITHUB_EVENT_NAME` — only `pull_request` and `push` ever publish. */
  eventName: string;
  /** `GITHUB_REF_NAME` for push events — only `develop` publishes a snapshot;
   *  `main` is reserved for owner-driven stable releases (see stable.ts). */
  refName: string;
  /** PR number for pull_request events; absent/invalid → no publish. */
  prNumber?: number;
  /** `owner/name` of the PR head repo — fork PRs (≠ `repo`) never publish. */
  headRepo?: string;
  /** `GITHUB_REPOSITORY` — this repo's `owner/name`. */
  repo?: string;
  /** The base version from the root `package.json` (e.g. `0.1.5`). */
  baseVersion: string;
  /** `GITHUB_RUN_NUMBER` — monotonic per workflow; makes versions unique. */
  runNumber: number;
  /** `GITHUB_RUN_ATTEMPT` — appended only when > 1 so re-runs never collide. */
  runAttempt?: number;
}

/** A publishable snapshot: prerelease version + the explicit dist-tag.
 *  The dist-tag is structurally never `latest` — snapshots must not become the
 *  default install; stable releases stay owner-driven (spec, resolved Q2). */
export interface SnapshotPlan {
  channel: string;
  version: string;
  distTag: string;
}

export function computeSnapshot(ctx: SnapshotContext): SnapshotPlan | null {
  const channel = resolveChannel(ctx);
  if (!channel) return null;
  if (!ctx.baseVersion || !Number.isInteger(ctx.runNumber) || ctx.runNumber <= 0) return null;
  const attempt = ctx.runAttempt !== undefined && Number.isInteger(ctx.runAttempt) && ctx.runAttempt > 1
    ? `.${ctx.runAttempt}`
    : '';
  return {
    channel: channel.channel,
    version: `${ctx.baseVersion}-${channel.channel}.${ctx.runNumber}${attempt}`,
    distTag: channel.distTag,
  };
}

function resolveChannel(ctx: SnapshotContext): { channel: string; distTag: string } | null {
  if (ctx.eventName === 'pull_request') {
    const n = ctx.prNumber;
    if (n === undefined || !Number.isInteger(n) || n <= 0) return null;
    // Defense in depth: the workflow's `if` already excludes forks, and fork PRs
    // get no secrets — but the decision must not rely on workflow wiring alone.
    if (!ctx.headRepo || !ctx.repo || ctx.headRepo !== ctx.repo) return null;
    return { channel: `pr${n}`, distTag: `pr-${n}` };
  }
  if (ctx.eventName === 'push') {
    // Only `develop` publishes a snapshot. `main` is deliberately excluded so a
    // merge to main never touches npm — stable `latest` releases are cut
    // manually via the Release workflow (stable.ts). Defense in depth: the
    // workflow's `if` already restricts the push channel to develop.
    if (ctx.refName === 'develop') return { channel: 'develop', distTag: 'develop' };
    return null;
  }
  return null;
}

export type { ManifestLike, ReleaseManifests } from './manifests.js';

/** Stamp the release set to the snapshot version.
 *
 *  Every intra-release dependency is pinned **exact** (`0.1.5-pr482.123`, no range) so
 *  `npx <alias>@<version>` runs exactly the PR's code and the service resolves exactly the
 *  api-client it was cut with — a `^` range would resolve to whatever newer version exists
 *  (spec, resolved Q5). Stable releases keep their `^` range and never go through this
 *  stamper. */
export function stampManifests(
  manifests: ReleaseManifestSet,
  version: string,
): ReleaseManifestSet {
  return stampManifestSet(manifests, version, (v) => v);
}

/** The copy-pasteable commands for the sticky PR comment and the step summary.
 *  Rendered from the *actual* alias package name so a future rename of the npx
 *  command can never leave stale instructions (spec, resolved Q1). */
export function buildInstallLines(aliasName: string, version: string): string[] {
  const cmd = `npx ${aliasName}@${version}`;
  return [
    `${cmd}                                # cockpit at http://localhost:4321`,
    `${cmd} run "…"                        # headless run`,
    `${cmd} server-deploy --platform <id>  # roll a server to this exact build`,
  ];
}

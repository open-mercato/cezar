/**
 * The little semver the self-updater needs — dependency-free on purpose (the CLI's runtime deps
 * are six packages and this is not worth a seventh). Handles what cezar publishes:
 * `0.11.1`, `0.11.1-nightly.20260924.49`, `0.9.2-pr743.1156.2`, `0.1.5-develop.124`.
 */

export type VersionChannel = 'stable' | 'nightly' | 'preview';

export interface ParsedVersion {
  core: [number, number, number];
  /** Prerelease identifiers after the `-`; empty for a release. Build metadata (`+…`) is dropped. */
  pre: string[];
}

export function parseVersion(raw: string): ParsedVersion | null {
  const withoutBuild = raw.trim().replace(/^v/, '').split('+')[0] ?? '';
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(withoutBuild);
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split('.') : [],
  };
}

/** semver §11 precedence: numeric core, then a release beats any prerelease of the same core,
 *  then prerelease identifiers left to right (numbers numerically, strings lexically, a shorter
 *  list loses). Unparseable strings sort below everything parseable. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : a.localeCompare(b);
  for (let i = 0; i < 3; i++) {
    const diff = pa.core[i]! - pb.core[i]!;
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1;
  if (pb.pre.length === 0) return -1;
  const len = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < len; i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x) ? Number(x) : null;
    const ny = /^\d+$/.test(y) ? Number(y) : null;
    if (nx !== null && ny !== null) {
      if (nx !== ny) return nx > ny ? 1 : -1;
    } else if (nx !== null) {
      return -1; // numeric identifiers sort before alphanumeric ones
    } else if (ny !== null) {
      return 1;
    } else if (x !== y) {
      return x > y ? 1 : -1;
    }
  }
  return 0;
}

export function isNewer(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0;
}

/** Which dist-tag family a published version belongs to, from its prerelease identifiers. */
export function classifyVersion(version: string): VersionChannel {
  const parsed = parseVersion(version);
  // Unparseable is `preview`, not `stable`: the picker filters previews out, so a junk entry in
  // the registry document is dropped instead of being offered as a release to install.
  if (!parsed) return 'preview';
  if (parsed.pre.length === 0) return 'stable';
  return parsed.pre[0] === 'nightly' ? 'nightly' : 'preview';
}

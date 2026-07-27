/** The manifest arithmetic both release channels share — the pure half of stamping.
 *
 *  `stable.ts` and `snapshot.ts` differ in exactly one decision (how a released package pins
 *  its sibling: a caret range for stable, an exact pin for a snapshot), so everything else
 *  lives here rather than twice.
 *
 *  Deliberately name-agnostic: names come from the checked-out manifests at call time, never
 *  from constants, so a package rename lands without touching this pipeline.
 */

/** The minimal manifest shape the stamper touches; everything else passes through. */
export interface ManifestLike {
  name: string;
  version: string;
  /** npm's own opt-out. A private package is still versioned in lockstep, never published. */
  private?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * Whether a release stamps AND publishes this package, or only stamps it.
 *
 * The distinction exists because "in the release" and "on the registry" are different things.
 * A package that ships nowhere yet still needs its version moved in lockstep: the api-client is
 * the worked example — the service pins it, so a frozen version would leave that range pointing
 * at a build the release was not cut from, which is exactly the drift this pipeline exists to
 * prevent. Publishing is gated on npm's own `private` flag rather than a list here, so opening
 * a package up is one line in ITS manifest and no change to the release code.
 */
export function isPublishable(pkg: ManifestLike): boolean {
  return pkg.private !== true;
}

/**
 * Every manifest a release stamps.
 *
 * The order of the fields is the order they must be PUBLISHED in, because each one depends on
 * the one before it: the alias is a bin-shim over the service, and the service (from the phase
 * where it stops merely testing against the client and starts importing it) depends on the
 * api-client. Publishing the dependent first would briefly advertise a version of its
 * dependency that does not exist on the registry yet.
 */
export interface ReleaseManifests {
  /** The contract package a consumer installs to talk to a cezar service. */
  apiClient: ManifestLike;
  /** The published service + CLI. */
  cezar: ManifestLike;
  /** The unscoped bin alias, so `npx cezar-cli` works. */
  alias: ManifestLike;
}

/** How a released package pins a sibling it depends on. */
export type PinStyle = (version: string) => string;

/**
 * Rewrite `pkg`'s range for `depName`, in whichever dependency section already declares it.
 *
 * Absent means absent: a package that does not depend on the other is returned untouched. That
 * is what lets the api-client dependency migrate from `devDependencies` (today: only the tests
 * import it) to `dependencies` (once the service imports its DTOs at runtime) without the
 * release pipeline needing to know it happened.
 */
export function pinDependency(pkg: ManifestLike, depName: string, range: string): ManifestLike {
  const sections = ['dependencies', 'devDependencies', 'peerDependencies'] as const;
  const out: ManifestLike = { ...pkg };
  for (const section of sections) {
    const deps = pkg[section] as Record<string, string> | undefined;
    if (deps && depName in deps) out[section] = { ...deps, [depName]: range };
  }
  return out;
}

/**
 * Stamp every manifest to `version` and re-pin the intra-release dependencies.
 *
 * Two pins, both derived from the manifests rather than hardcoded:
 *   - the alias → the service, so `npx <alias>@<v>` runs the matching CLI;
 *   - the service → the api-client, so a published service can never resolve a client build it
 *     was not released with.
 *
 * The alias also inherits `repository`/`homepage`/`bugs` from the service manifest: we publish
 * with `--provenance`, and npm rejects (E422) any manifest whose `repository.url` does not
 * match the building repo. The alias file carries none of its own, so it borrows the
 * service's — already correct, and being a git URL, unaffected by any npm-name rename.
 */
export function stampManifestSet(
  manifests: ReleaseManifests,
  version: string,
  pin: PinStyle,
): ReleaseManifests {
  const { apiClient, cezar, alias } = manifests;
  const range = pin(version);

  const inherited: Partial<ManifestLike> = {};
  for (const field of ['repository', 'homepage', 'bugs'] as const) {
    if (cezar[field] !== undefined) inherited[field] = cezar[field];
  }

  return {
    apiClient: { ...apiClient, version },
    cezar: pinDependency({ ...cezar, version }, apiClient.name, range),
    alias: {
      ...pinDependency({ ...alias, ...inherited, version }, cezar.name, range),
      // The alias exists only to depend on the service — an unpinned or missing entry would
      // make `npx <alias>` install nothing useful, so this one is asserted, not merged.
      dependencies: { ...alias.dependencies, [cezar.name]: range },
    },
  };
}

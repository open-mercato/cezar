/**
 * npm registry reads for the self-updater. One document per package
 * (`https://registry.npmjs.org/<name>`), zod-validated at the boundary, cached in memory for a
 * few minutes. Silent on any failure — offline must degrade to "nothing known", never an error,
 * exactly like the boot-time check it replaced (#368).
 */

import { z } from 'zod';

import { classifyVersion, compareVersions, type VersionChannel } from './semver.ts';

const REGISTRY = 'https://registry.npmjs.org';
const TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 5 * 60_000;

export interface RegistryVersion {
  version: string;
  channel: VersionChannel;
  publishedAt: string | null;
}

export interface PackageDocument {
  distTags: Record<string, string>;
  /** Newest first. Unpublished versions (present in `time`, absent in `versions`) are excluded. */
  versions: RegistryVersion[];
  fetchedAt: string;
}

const documentSchema = z
  .object({
    'dist-tags': z.record(z.string(), z.string()).catch({}),
    versions: z.record(z.string(), z.unknown()).catch({}),
    time: z.record(z.string(), z.string()).catch({}),
  })
  .passthrough();

/** The registry path of a package: a scope keeps its leading `@`, everything else is encoded
 *  (`@scope/name` → `@scope%2Fname`). */
export function registryPath(pkgName: string): string {
  return pkgName.startsWith('@') ? `@${encodeURIComponent(pkgName.slice(1))}` : encodeURIComponent(pkgName);
}

export async function fetchPackageDocument(pkgName: string, fetchImpl: typeof fetch = fetch): Promise<PackageDocument | null> {
  try {
    const res = await fetchImpl(`${REGISTRY}/${registryPath(pkgName)}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    const parsed = documentSchema.safeParse(await res.json());
    if (!parsed.success) return null;
    const versions = Object.keys(parsed.data.versions)
      .map((version) => ({
        version,
        channel: classifyVersion(version),
        publishedAt: parsed.data.time[version] ?? null,
      }))
      .sort((a, b) => compareVersions(b.version, a.version));
    return { distTags: parsed.data['dist-tags'], versions, fetchedAt: new Date().toISOString() };
  } catch {
    return null;
  }
}

/** A memoized reader: `get()` answers the cached document while it is fresh, refetches otherwise;
 *  `refresh()` always goes to the registry. A failed fetch keeps the last good document. */
export class RegistryCache {
  private doc: PackageDocument | null = null;
  private fetchedAtMs = 0;
  private inFlight: Promise<PackageDocument | null> | null = null;

  constructor(private readonly pkgName: string, private readonly fetchImpl: typeof fetch = fetch) {}

  current(): PackageDocument | null {
    return this.doc;
  }

  async get(): Promise<PackageDocument | null> {
    if (this.doc && Date.now() - this.fetchedAtMs < CACHE_TTL_MS) return this.doc;
    return this.refresh();
  }

  async refresh(): Promise<PackageDocument | null> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = fetchPackageDocument(this.pkgName, this.fetchImpl).then((doc) => {
      if (doc) {
        this.doc = doc;
        this.fetchedAtMs = Date.now();
      }
      this.inFlight = null;
      return this.doc;
    });
    return this.inFlight;
  }
}

/** The dist-tag a release channel resolves through. */
export function distTagFor(channel: 'stable' | 'nightly'): string {
  return channel === 'stable' ? 'latest' : 'nightly';
}

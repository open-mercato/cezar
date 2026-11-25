import { z } from 'zod';

import { compareVersions, parseVersion } from '../self-update/semver.ts';
import type { RunnerId } from './agent-runner.ts';
import { AGENT_RECIPES, recipeFor, type AgentRecipe } from './agent-install.ts';

/**
 * Two version facts the agent setup sheet shows next to the installed version (spec
 * `2026-11-25-agent-cli-install-and-update`): the newest release on npm, read only when asked,
 * and the oldest version a vendor has said it needs at runtime.
 */

const REGISTRY = 'https://registry.npmjs.org';
const TIMEOUT_MS = 8_000;
export const LATEST_TTL_MS = 6 * 60 * 60_000;
/** A failed lookup is retried sooner than a good answer, but not on every page load. */
const FAILED_TTL_MS = 30 * 60_000;

/** `CEZ_AGENT_VERSION_CHECK=0` turns the lookup off; dry-run never leaves the machine. */
export function latestLookupEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CEZ_AGENT_VERSION_CHECK !== '0' && env.CEZ_DRY_RUN !== '1';
}

const latestSchema = z.object({ version: z.string() });
const versionsSchema = z.object({ versions: z.record(z.string(), z.unknown()) });

export type FetchLike = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export class LatestVersions {
  private readonly cache = new Map<RunnerId, { at: number; version: string | null; ttl: number }>();
  private readonly inflight = new Map<RunnerId, Promise<string | null>>();

  constructor(
    private readonly deps: { fetch?: FetchLike; now?: () => number; env?: NodeJS.ProcessEnv } = {},
  ) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** The newest stable release of this agent's npm package, within the major cezar can drive.
   *  Null when unknown: no package, lookup off, offline. Never throws. */
  async latest(provider: RunnerId): Promise<string | null> {
    const recipe = recipeFor(provider);
    if (!recipe.npmPackage || !latestLookupEnabled(this.deps.env)) return null;
    const cached = this.cache.get(provider);
    if (cached && this.now() - cached.at < cached.ttl) return cached.version;
    const running = this.inflight.get(provider);
    if (running) return running;
    const lookup = this.lookup(recipe.npmPackage, recipe.npmMajor).then((version) => {
      this.cache.set(provider, { at: this.now(), version, ttl: version ? LATEST_TTL_MS : FAILED_TTL_MS });
      this.inflight.delete(provider);
      return version;
    });
    this.inflight.set(provider, lookup);
    return lookup;
  }

  private async lookup(pkg: string, major: number | undefined): Promise<string | null> {
    const fetchImpl: FetchLike = this.deps.fetch ?? ((url, init) => fetch(url, init));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      if (major === undefined) {
        const response = await fetchImpl(`${REGISTRY}/${pkg}/latest`, { signal: controller.signal, headers: { accept: 'application/json' } });
        if (!response.ok) return null;
        const parsed = latestSchema.safeParse(await response.json());
        return parsed.success && parseVersion(parsed.data.version) ? parsed.data.version : null;
      }
      // The abbreviated document lists every version without their manifests' bulk.
      const response = await fetchImpl(`${REGISTRY}/${pkg}`, { signal: controller.signal, headers: { accept: 'application/vnd.npm.install-v1+json' } });
      if (!response.ok) return null;
      const parsed = versionsSchema.safeParse(await response.json());
      if (!parsed.success) return null;
      return newestInMajor(Object.keys(parsed.data.versions), major);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function newestInMajor(versions: readonly string[], major: number): string | null {
  let best: string | null = null;
  for (const version of versions) {
    const parsed = parseVersion(version);
    if (!parsed || parsed.pre.length > 0 || parsed.core[0] !== major) continue;
    if (best === null || compareVersions(version, best) > 0) best = version;
  }
  return best;
}

// --- minimums a vendor stated at runtime -----------------------------------------------------

const REQUIRED_RE = /\b(\d+\.\d+(?:\.\d+)?)\+? or (?:newer|later|higher|above) is required\b|\brequires? (?:version |v)?(\d+\.\d+(?:\.\d+)?) or (?:newer|later|higher)\b/i;

const learned = new Map<RunnerId, string>();

const fullVersion = (version: string): string => (version.split('.').length === 2 ? `${version}.0` : version);

/** The version an agent error says it needs ("OpenCode 1.18.0 or newer is required"), if any. */
export function requiredVersionFrom(message: string): string | null {
  const match = REQUIRED_RE.exec(message);
  const version = match?.[1] ?? match?.[2];
  return version ? fullVersion(version) : null;
}

/** Remember the highest minimum each agent has reported this process. In memory only: the next
 *  failure after a restart teaches it again. */
export function noteAgentErrorVersion(provider: string | undefined, message: string): void {
  const recipe = provider ? (recipeForOrNull(provider)) : null;
  if (!recipe) return;
  const version = requiredVersionFrom(message);
  if (!version) return;
  const previous = learned.get(recipe.provider);
  if (!previous || compareVersions(version, previous) > 0) learned.set(recipe.provider, version);
}

const recipeForOrNull = (provider: string) => (AGENT_RECIPES as Partial<Record<string, AgentRecipe>>)[provider] ?? null;

/** The highest of the recipe's minimum and the one learned at runtime. */
export function minimumVersion(provider: RunnerId): string | null {
  const known = recipeFor(provider).minVersion ?? null;
  const seen = learned.get(provider) ?? null;
  if (!known) return seen;
  if (!seen) return known;
  return compareVersions(seen, known) > 0 ? seen : known;
}

/** Test seam. */
export function forgetLearnedMinimums(): void {
  learned.clear();
}

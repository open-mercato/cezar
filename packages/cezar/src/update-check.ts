/**
 * Update discovery (#368): a best-effort, fire-and-forget check against the
 * npm registry so the cockpit can tell the user a newer cezar exists — the
 * root cause behind most "bug already fixed" reports is `npx` happily reusing
 * a stale cached version forever. Silent on any failure: offline, slow
 * registry or a weird payload must never affect startup.
 */

const REGISTRY_TIMEOUT_MS = 3_000;

/** Newest published version when it's newer than `current`, else null. */
export async function checkForUpdate(pkgName: string, current: string): Promise<string | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkgName)}/latest`, {
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: unknown };
    const latest = typeof data.version === 'string' ? data.version : null;
    return latest && isNewerVersion(latest, current) ? latest : null;
  } catch {
    return null;
  }
}

/** Plain numeric semver compare (`1.2.10` > `1.2.9`); pre-release tags and
 *  anything unparseable compare as 0 — good enough for release-only publishes. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (v: string) =>
    v
      .split('.')
      .slice(0, 3)
      .map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(candidate);
  const b = parse(current);
  for (let i = 0; i < 3; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

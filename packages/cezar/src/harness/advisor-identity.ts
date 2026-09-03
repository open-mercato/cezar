export interface AdvisorIdentityRef {
  runner: string;
  model: string;
  family?: string;
}

export type CanonicalAdvisorRef<T extends AdvisorIdentityRef> =
  T extends { runner: 'harness' } ? Omit<T, 'family'> & { family: string } : T;

export type CanonicalAdvisorResult<T extends AdvisorIdentityRef> =
  | { ok: true; refs: CanonicalAdvisorRef<T>[] }
  | { ok: false; error: string };

/**
 * Advisor family is authorization/configuration data, never a client hint.
 * Resolve it from the trusted agentHarness model table and reject a caller
 * that attempts to relabel a model to manufacture council diversity.
 */
export function canonicalizeAdvisorRefs<T extends AdvisorIdentityRef>(
  refs: readonly T[],
  models: Record<string, unknown> | undefined,
): CanonicalAdvisorResult<T> {
  const canonical: CanonicalAdvisorRef<T>[] = [];
  for (const ref of refs) {
    if (ref.runner !== 'harness') {
      canonical.push({ ...ref } as CanonicalAdvisorRef<T>);
      continue;
    }
    const raw = models?.[ref.model];
    const family =
      raw && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as { family?: unknown }).family
        : undefined;
    if (typeof family !== 'string' || family.trim() === '') {
      return {
        ok: false,
        error: `advisor reviewer "${ref.model}" has no trusted family in agentHarness.models`,
      };
    }
    if (ref.family !== undefined && ref.family !== family) {
      return {
        ok: false,
        error:
          `advisor reviewer "${ref.model}" was labelled as family "${ref.family}", ` +
          `but trusted configuration declares "${family}"`,
      };
    }
    canonical.push({ ...ref, family } as CanonicalAdvisorRef<T>);
  }
  return { ok: true, refs: canonical };
}

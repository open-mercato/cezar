import type { RunnerModelCatalogResult } from './runner-model-catalog.ts';

/**
 * Antigravity has no effort flag: `agy models` lists one id per effort variant
 * (`gemini-4-neon-low`, `-medium`, `-high`, `-xhigh`). An effort is applied by picking the
 * variant of the chosen model family from the DISCOVERED list, never a hardcoded one.
 */

/** Effort variant suffixes, lowest to highest. */
const VARIANTS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;

export interface AntigravityVariant {
  family: string;
  variant: string;
}

/** `gemini-4-neon-high` → `{ family: 'gemini-4-neon', variant: 'high' }`; undefined for an id with no effort suffix. */
export function antigravityVariantOf(id: string): AntigravityVariant | undefined {
  const match = /^(.+)-([a-z]+)$/.exec(id);
  if (!match || !(VARIANTS as readonly string[]).includes(match[2]!)) return undefined;
  return { family: match[1]!, variant: match[2]! };
}

const rank = (variant: string): number => (VARIANTS as readonly string[]).indexOf(variant);

export type AntigravityEffortResolution = { model: string; note: string } | { error: string };

/**
 * The model id that carries `effort` on antigravity. `model` is an explicit `--model` (a family,
 * or a full id whose variant must agree); `defaultModel` names the family otherwise. `max` takes
 * the family's highest listed variant. Refuses rather than guesses.
 */
export function resolveAntigravityEffort(input: {
  effort: string;
  model?: string | undefined;
  defaultModel?: string | undefined;
  /** Model ids from `agy models`; undefined when discovery failed. */
  models?: readonly string[] | undefined;
}): AntigravityEffortResolution {
  const { effort } = input;
  const models = input.models ?? [];
  // A name that is itself a listed family stays one; otherwise a variant suffix is stripped.
  const familyOf = (id: string): string =>
    models.some((other) => antigravityVariantOf(other)?.family === id) ? id : antigravityVariantOf(id)?.family ?? id;
  const explicit = input.model;
  const base = explicit ?? input.defaultModel;
  if (!base) {
    return { error: `antigravity sets effort through the model id, and no model is chosen: pass --model <family> with --effort ${effort}${familyHint(models)}` };
  }
  const family = familyOf(base);
  const variants = models
    .map((id) => ({ id, parsed: antigravityVariantOf(id) }))
    .filter((entry): entry is { id: string; parsed: AntigravityVariant } => entry.parsed?.family === family)
    .sort((a, b) => rank(a.parsed.variant) - rank(b.parsed.variant));
  const carried = explicit && family !== explicit ? antigravityVariantOf(explicit) : undefined;
  if (variants.length === 0) {
    // No list to pick from: a full id that already names this effort is still unambiguous.
    if (carried && carried.variant === effort) return { model: explicit!, note: `effort ${effort} -> ${explicit}` };
    if (models.length === 0) {
      return { error: `antigravity model list is unavailable, so --effort ${effort} cannot be mapped to a variant of '${family}': pass the full model id (e.g. --model ${family}-${effort === 'max' ? 'high' : effort}) without --effort` };
    }
    return { error: `antigravity model '${family}' has no effort variants, so --effort ${effort} cannot apply. Drop --effort, or pick a model family with variants${familyHint(models)}` };
  }
  const target = effort === 'max' ? variants[variants.length - 1]! : variants.find((entry) => entry.parsed.variant === effort);
  const choices = `Valid for ${family}: ${variants.map((entry) => entry.id).join(', ')} (--effort ${[...variants.map((entry) => entry.parsed.variant), 'max'].join(', ')})`;
  if (carried && (!target || carried.variant !== target.parsed.variant)) {
    return { error: `--model ${explicit} already sets effort '${carried.variant}', which conflicts with --effort ${effort}. Pass the family (--model ${family}) with --effort, or drop --effort. ${choices}` };
  }
  if (!target) return { error: `antigravity has no '${effort}' variant of ${family}. ${choices}` };
  return { model: target.id, note: `effort ${effort} -> ${target.id}` };
}

function familyHint(models: readonly string[]): string {
  const families = [...new Set(models.map((id) => antigravityVariantOf(id)?.family).filter((family): family is string => Boolean(family)))];
  return families.length > 0 ? `. Families: ${families.slice(0, 20).join(', ')}` : '';
}

/** The host catalog, set once by the server (as `setNamerModelCatalog`); absent in a headless `cezar run`. */
let catalog: { get(runner: 'antigravity'): Promise<RunnerModelCatalogResult> } | undefined;
export function setAntigravityEffortCatalog(next: typeof catalog): void {
  catalog = next;
}
export async function antigravityModelIds(): Promise<string[] | undefined> {
  const result = await catalog?.get('antigravity').catch(() => undefined);
  return result && result.models.length > 0 ? result.models.map((model) => model.id) : undefined;
}

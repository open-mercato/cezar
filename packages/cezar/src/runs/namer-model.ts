import { runnerSupportsReasoningEffort, type RunnerId } from '../core/agent-runner.ts';
import type { ModelOption } from '../core/runner-model-catalog.ts';

/**
 * Which cheap model a bookkeeping call (task naming, landing commit subjects) runs on, per
 * runner (#2012). Without a model the CLI falls back to the user's own default — on Copilot or
 * Codex a premium model, often at high effort — so a runner with no known cheap model answers
 * null and the caller keeps its heuristic instead of making the call at all.
 */

export interface NamerModelChoice {
  model: string;
  reasoningEffort?: string;
}

/** The slice of `RunnerModelCatalog` the namer reads — host discovery, cached by the server. */
export interface NamerModelCatalog {
  get(runner: RunnerId): Promise<{ models: ModelOption[] }>;
}

/** Cheap tiers, best first; matched as whole id segments so `gemini` never reads as `mini`. */
const CHEAP_TIERS = ['haiku', 'flash-lite', 'nano', 'mini', 'lite', 'flash'] as const;

/** Used only when discovery has no answer. Codex's is its picker's own mini preset. */
const STATIC_CHEAP_MODEL: Partial<Record<RunnerId, NamerModelChoice>> = {
  codex: { model: 'gpt-5.1-codex-mini', reasoningEffort: 'medium' },
  gemini: { model: 'gemini-3.1-flash-lite' },
};

const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** Discovery waits at most this long; naming must never stall on a slow catalog. */
export const NAMER_CATALOG_WAIT_MS = 5_000;

let catalog: NamerModelCatalog | undefined;

/** The server registers its host model catalog once at boot; headless runs go without. */
export function setNamerModelCatalog(next: NamerModelCatalog | undefined): void {
  catalog = next;
}

function tierRank(id: string): number {
  const segments = id.toLowerCase().split(/[/:]/).pop() ?? '';
  return CHEAP_TIERS.findIndex((tier) => new RegExp(`(^|[-_.])${tier}([-_.]|$)`).test(segments));
}

/** The cheapest-tier model a runner's discovered catalog offers, at its lowest listed effort. */
export function pickCheapModel(models: readonly ModelOption[]): NamerModelChoice | undefined {
  let best: { option: ModelOption; rank: number } | undefined;
  for (const option of models) {
    const rank = tierRank(option.id);
    if (rank >= 0 && (!best || rank < best.rank)) best = { option, rank };
  }
  if (!best) return undefined;
  const efforts = (best.option.reasoningEfforts ?? [])
    .map((e) => e.id)
    .filter((id) => EFFORT_ORDER.includes(id))
    .sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
  return { model: best.option.id, ...(efforts[0] ? { reasoningEffort: efforts[0] } : {}) };
}

/**
 * Explicit `namerModels[runner]` wins, then Claude's `namerModel`, then a cheap model from
 * discovery, then a static default; null = no cheap model known, skip the call.
 */
export async function resolveNamerModel(
  runner: RunnerId,
  config: { namerModel: string; namerModels?: Partial<Record<RunnerId, string | undefined>> },
  env: NodeJS.ProcessEnv = process.env,
): Promise<NamerModelChoice | null> {
  const explicit = config.namerModels?.[runner];
  if (explicit) return { model: explicit };
  if (runner === 'claude') return { model: config.namerModel };
  // The dry-run mock answers any model; never spawn a real CLI to discover one.
  if (catalog && env.CEZ_DRY_RUN !== '1') {
    const discovered = await Promise.race([
      catalog.get(runner).then((r) => r.models, () => []),
      new Promise<ModelOption[]>((resolve) => setTimeout(() => resolve([]), NAMER_CATALOG_WAIT_MS).unref()),
    ]);
    const cheap = pickCheapModel(discovered);
    if (cheap) return withSupportedEffort(runner, cheap);
  }
  return STATIC_CHEAP_MODEL[runner] ?? null;
}

/** Runners outside Claude/Codex refuse a `reasoningEffort` at the seam — drop it there. */
function withSupportedEffort(runner: RunnerId, choice: NamerModelChoice): NamerModelChoice {
  return runnerSupportsReasoningEffort(runner) ? choice : { model: choice.model };
}

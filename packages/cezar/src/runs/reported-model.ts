import type { ModelUsage } from '@open-mercato/cezar-contract';

/**
 * The model an agent reports actually running, folded from its own events: `session.started.model`
 * (claude's `init`, codex's thread result, …) and `turn.completed.models` (claude's `modelUsage`).
 * Pure, so the store's `appendEvent` and the tests share it.
 */
export interface ReportedModelState {
  actualModel?: string;
  modelsUsed?: ModelUsage[];
}

/** `claude-opus-4-8[1m]` (init), `claude-opus-4-8` (modelUsage) and `anthropic/claude-opus-4-8`
 *  (a request's identity) name one model. */
export function sameModel(a: string, b: string): boolean {
  return baseModel(a) === baseModel(b);
}

/** One model's name with its provider prefix and `[1m]`-style suffix dropped, lowercased. */
export function baseModel(model: string): string {
  return model.trim().replace(/\[[^\]]*\]$/, '').replace(/^[^/]+\//, '').trim().toLowerCase();
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function readShares(raw: unknown): ModelUsage[] {
  if (!Array.isArray(raw)) return [];
  const shares: ModelUsage[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const { model, inputTokens, outputTokens, costUsd } = entry as Record<string, unknown>;
    if (typeof model !== 'string' || model.trim() === '') continue;
    const share: ModelUsage = { model };
    if (finite(inputTokens) !== undefined) share.inputTokens = finite(inputTokens);
    if (finite(outputTokens) !== undefined) share.outputTokens = finite(outputTokens);
    if (finite(costUsd) !== undefined) share.costUsd = finite(costUsd);
    shares.push(share);
  }
  return shares;
}

function add(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
}

function merge(list: ModelUsage[], share: ModelUsage): ModelUsage[] {
  const index = list.findIndex((entry) => sameModel(entry.model, share.model));
  if (index < 0) return [...list, share];
  const current = list[index]!;
  const merged: ModelUsage = { model: current.model };
  const inputTokens = add(current.inputTokens, share.inputTokens);
  const outputTokens = add(current.outputTokens, share.outputTokens);
  const costUsd = add(current.costUsd, share.costUsd);
  if (inputTokens !== undefined) merged.inputTokens = inputTokens;
  if (outputTokens !== undefined) merged.outputTokens = outputTokens;
  if (costUsd !== undefined) merged.costUsd = costUsd;
  return list.map((entry, i) => (i === index ? merged : entry));
}

/** The share that carried the turn: highest cost, else most tokens, else the first listed. */
function dominant(shares: ModelUsage[]): ModelUsage | undefined {
  const weight = (s: ModelUsage) => [s.costUsd ?? -1, (s.inputTokens ?? 0) + (s.outputTokens ?? 0)] as const;
  return shares.reduce<ModelUsage | undefined>((best, share) => {
    if (!best) return share;
    const [bc, bt] = weight(best);
    const [sc, st] = weight(share);
    return sc > bc || (sc === bc && st > bt) ? share : best;
  }, undefined);
}

/**
 * Fold one event into a step's reported model, or undefined when the event says nothing new.
 * `session.started` names the main model (a later session — a resume, a switch — replaces it);
 * `turn.completed.models` adds shares, and names the main model only when none is known yet or
 * the known one is absent from the turn.
 */
export function foldReportedModel(
  step: ReportedModelState,
  event: { type: string; [key: string]: unknown },
): ReportedModelState | undefined {
  if (event.type === 'session.started') {
    const model = typeof event.model === 'string' ? event.model.trim() : '';
    if (model === '') return undefined;
    const modelsUsed = merge(step.modelsUsed ?? [], { model });
    if (step.actualModel === model && modelsUsed.length === (step.modelsUsed ?? []).length) return undefined;
    return { actualModel: model, modelsUsed };
  }
  if (event.type === 'turn.completed') {
    const shares = readShares(event.models);
    if (shares.length === 0) return undefined;
    const modelsUsed = shares.reduce(merge, step.modelsUsed ?? []);
    const known = step.actualModel;
    const actualModel =
      known !== undefined && shares.some((share) => sameModel(share.model, known))
        ? known
        : (() => {
            const top = dominant(shares)!;
            return modelsUsed.find((entry) => sameModel(entry.model, top.model))!.model;
          })();
    return { actualModel, modelsUsed };
  }
  return undefined;
}

/** Run-level summary: the latest main model, and every model's name in first-seen order. */
export function foldRunModels(
  run: { actualModel?: string; modelsUsed?: string[] },
  step: ReportedModelState,
): { actualModel?: string; modelsUsed: string[] } {
  let names = run.modelsUsed ?? [];
  for (const entry of step.modelsUsed ?? []) {
    if (!names.some((name) => sameModel(name, entry.model))) names = [...names, entry.model];
  }
  return { actualModel: step.actualModel ?? run.actualModel, modelsUsed: names };
}

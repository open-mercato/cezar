import { runnerSupportsReasoningEffort, REASONING_EFFORT_RUNNERS } from '@open-mercato/cezar-contract';
import { AgentProviderUnavailable, type RunnerId } from '../core/agent-runner.ts';
import { authMethods } from '../core/agent-auth-methods.ts';
import { implicitProviderMethod } from '../core/agent-provider-env.ts';
import { providerAuthChecksDisabled } from '../core/provider-auth.ts';
import type { StoredAgentProviders } from '../workspace/agent-providers.ts';
import { KNOWN_PRESETS_BY_RUNNER, modelConflictsWithRunner } from '../core/model-presets.ts';

/**
 * A manager's `--model`/`--effort` checked before the task starts (spec 2026-10-31-managers,
 * Addendum 2026-11-12). `POST /runs` takes any free-form model and an unknown one quietly runs on
 * the default; a manager has no picker to notice that, so it is told up front instead.
 */

/** The slice of `GET /models` this reads. */
export interface TaskModelCatalog {
  models: Array<{ id: string; via?: { methodId: string }; reasoningEfforts?: Array<{ id: string }> }>;
}

/** Managers have no method picker. Resolve the same implicit billing method as the launch before ranking a row. */
export function managerProviderChoice(runner: RunnerId, entry: StoredAgentProviders['agents'][RunnerId], model?: string): { error?: string; gateway?: string } {
  if (!entry || authMethods(runner).mode !== 'any' || providerAuthChecksDisabled()) return {};
  const selected = model === 'auto' ? undefined : model;
  try {
    const id = implicitProviderMethod(runner, entry, selected);
    if (!id) return { error: `Pick a model offered by a configured provider for ${runner}.` };
    const method = entry.methods[id];
    if (method?.kind !== 'openrouter' && method?.kind !== 'custom') return {};
    const ids = method.models?.ids;
    if (!ids?.length || (selected && !ids.some(item => item.id === selected))) {
      return { error: `Pick a model offered by ${runner}/${id}.` };
    }
    return { gateway: id };
  } catch (error) {
    if (error instanceof AgentProviderUnavailable) return { error: error.message };
    throw error;
  }
}

/** Native levels when the catalog names none: Claude's `--effort`, Codex's `turn/start.effort`. */
const STATIC_EFFORTS: Partial<Record<RunnerId, readonly string[]>> = {
  claude: ['low', 'medium', 'high', 'max'],
  codex: ['low', 'medium', 'high'],
};

const LIST_LIMIT = 30;
const listed = (values: readonly string[]): string =>
  values.length > LIST_LIMIT ? `${values.slice(0, LIST_LIMIT).join(', ')}, … (${values.length - LIST_LIMIT} more)` : values.join(', ');

/** Why the choice cannot run, with the valid ones; undefined when it can. No catalog = models fail open. */
export function taskModelIssue(input: { runner: RunnerId; model?: string | undefined; effort?: string | undefined; catalog?: TaskModelCatalog | undefined }): string | undefined {
  const { runner, model, effort } = input;
  const catalog = input.catalog && input.catalog.models.length > 0 ? input.catalog : undefined;
  const isGateway = (entry: TaskModelCatalog['models'][number]) => entry.via?.methodId === 'custom' || entry.via?.methodId === 'openrouter';
  // A configured gateway serves the IDs in its catalog, including on runners with native presets.
  const presets = catalog?.models.some(isGateway) ? [] : KNOWN_PRESETS_BY_RUNNER[runner] ?? [];
  const valid = [...new Set([...presets, ...(catalog?.models.map(entry => entry.id) ?? [])])];
  if (model) {
    const gateway = catalog?.models.some(option => option.id === model && isGateway(option));
    if (!gateway && modelConflictsWithRunner(model, runner)) {
      return `model '${model}' is not a ${runner} model${valid.length > 0 ? `. Valid for ${runner}: ${listed(valid)}` : ''}. Pick another, or pass --runner`;
    }
    if (catalog && !valid.includes(model)) return `unknown model '${model}' for ${runner}. Valid: ${listed(valid)}`;
  }
  if (!effort) return undefined;
  if (!runnerSupportsReasoningEffort(runner)) {
    return `${runner} has no effort setting: --effort works with ${REASONING_EFFORT_RUNNERS.join(', ')}. Drop --effort, or pass --runner`;
  }
  // The model's own advertised levels; with no model, any model's. A catalog silent on levels says nothing.
  const advertised = model
    ? catalog?.models.find((candidate) => candidate.id === model)?.reasoningEfforts?.map((level) => level.id) ?? []
    : [...new Set(catalog?.models.flatMap((candidate) => candidate.reasoningEfforts?.map((level) => level.id) ?? []) ?? [])];
  const levels = advertised.length > 0 ? advertised : STATIC_EFFORTS[runner];
  if (levels && !levels.includes(effort)) return `effort '${effort}' is not available for ${model ?? runner}. Valid: ${listed(levels)}`;
  return undefined;
}

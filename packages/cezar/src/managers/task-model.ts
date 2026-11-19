import { runnerSupportsReasoningEffort, REASONING_EFFORT_RUNNERS } from '@open-mercato/cezar-contract';
import type { RunnerId } from '../core/agent-runner.ts';
import { KNOWN_PRESETS_BY_RUNNER, modelConflictsWithRunner } from '../core/model-presets.ts';

/**
 * A manager's `--model`/`--effort` checked before the task starts (spec 2026-10-31-managers,
 * Addendum 2026-11-12). `POST /runs` takes any free-form model and an unknown one quietly runs on
 * the default; a manager has no picker to notice that, so it is told up front instead.
 */

/** The slice of `GET /models` this reads. */
export interface TaskModelCatalog {
  models: Array<{ id: string; reasoningEfforts?: Array<{ id: string }> }>;
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
  const valid = [...new Set([...(KNOWN_PRESETS_BY_RUNNER[runner] ?? []), ...(catalog?.models.map((entry) => entry.id) ?? [])])];
  if (model) {
    if (modelConflictsWithRunner(model, runner)) {
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

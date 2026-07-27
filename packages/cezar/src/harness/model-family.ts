/**
 * The ONE definition of "provider family" — the independence axis the council's
 * multi-model rule is actually asking about (review 2026-07-27).
 *
 * Three encodings used to coexist and disagree:
 *
 *  - `councilFamilyOf` (driver) returned the RUNNER for runner-backed refs, so a
 *    host `claude/sonnet` reviewer and a gateway-resold `opencode/claude-sonnet-4-5`
 *    reviewer read as two families — two Anthropic models certified as an
 *    independent cross-check;
 *  - `harnessFamilyOf` (server admission) and `modelFamilyOf` (web composer)
 *    returned the id's `provider/` PREFIX, which is the gateway for Zen ids
 *    (`opencode/...`) and the real provider for others (`anthropic/...`);
 *  - `reviewerFamily` (binding synthesis) resolved WEIGHT LINEAGE from the model
 *    name, which is the only one that answers the question being asked.
 *
 * The admission check and the quorum check therefore measured different things,
 * and the coarsest of them gated the run. Every layer now resolves through
 * `providerFamilyOf` here. `web/app/src/routes/new-task-form.ts` keeps a
 * byte-faithful mirror (the browser cannot import server code) — the table below
 * and that mirror must change together; `model-family.test.ts` pins them.
 */

/** Gateways that resell other vendors' weights. The prefix of a `provider/model`
 *  id is a routing detail for these, never a family. */
const GATEWAY_PREFIXES: ReadonlySet<string> = new Set(['opencode', 'openrouter', 'zen']);

/** Weight lineage by model name. Two models behind one gateway can be genuinely
 *  different models, and one vendor reached through two gateways is still one
 *  vendor — only the name answers that. */
export const FAMILY_BY_NAME: ReadonlyArray<[RegExp, string]> = [
  [/^glm/i, 'zhipu'],
  [/^kimi/i, 'moonshot'],
  [/^deepseek/i, 'deepseek'],
  [/^mimo/i, 'xiaomi'],
  [/^qwen/i, 'alibaba'],
  [/^gpt|^o[0-9]|^codex/i, 'openai'],
  [/^claude/i, 'anthropic'],
  [/^gemini/i, 'google'],
  [/^grok/i, 'xai'],
  [/^llama/i, 'meta'],
  [/^mistral|^magistral/i, 'mistral'],
  [/^nemotron/i, 'nvidia'],
  [/^ling|^ring/i, 'inclusionai'],
];

/** Best-effort weight family for a bare model id; `fallback` (the gateway, or
 *  the runner) is used so an unrecognised model never silently merges into
 *  another family — an unknown model counts as its own, which can only make the
 *  diversity check stricter. */
export function familyByModelName(bareModel: string, fallback: string): string {
  for (const [pattern, family] of FAMILY_BY_NAME) if (pattern.test(bareModel)) return family;
  return fallback;
}

export interface FamilyResolvableRef {
  runner: string;
  model: string;
  /** Advisor refs (`runner: 'harness'`) carry the family from trusted config. */
  family?: string;
}

/**
 * The provider family a role ref belongs to.
 *
 * Resolution order — name first, because the weights are what "independent"
 * means, and a gateway prefix only tells you who billed for them.
 */
export function providerFamilyOf(ref: FamilyResolvableRef): string {
  // Configured advisors declare their family in trusted config; it wins.
  if (ref.runner === 'harness') return ref.family ?? 'harness';

  const slash = ref.model.indexOf('/');
  const prefix = slash > 0 ? ref.model.slice(0, slash) : '';
  const bare = slash > 0 ? ref.model.slice(slash + 1) : ref.model;

  // A non-gateway prefix IS the provider (`anthropic/claude-sonnet-5`); trust it
  // over the name table, which cannot know a vendor's private model names.
  if (prefix && !GATEWAY_PREFIXES.has(prefix.toLowerCase())) return prefix.toLowerCase();

  // The runner implies the vendor for the two first-party CLIs — but only as a
  // FALLBACK, so `claude`-runner and gateway-resold Anthropic still collapse to
  // one family via the name table above.
  const runnerFallback =
    ref.runner === 'claude' ? 'anthropic'
    : ref.runner === 'codex' ? 'openai'
    : prefix.toLowerCase() || ref.runner;

  return familyByModelName(bare, runnerFallback);
}

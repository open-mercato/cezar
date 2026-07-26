/**
 * Express a picker-chosen reviewer as a runtime model binding.
 *
 * Why this exists (2026-07-25). The om harness runs a reviewer as ONE
 * structured call — subject inline, `response_format: json_object`, done in
 * about a minute. Cezar's port instead spawned a whole coding agent per
 * reviewer and asked it to explore the repo and write a result file. Measured
 * on the same spec, the same day, with the same model:
 *
 *   mimo-v2.5-free as an advisor (HTTP call) → completed in 62s, 3 findings
 *   mimo-v2.5-free as an agent session       → timed out at 30m, 60m, 60m
 *
 * Small models cannot drive an agentic session; they answer a schema'd prompt
 * perfectly. Every mitigation the session path needed — turn nudges, per-phase
 * wall clocks, "ended without a valid result file", council quorum — is an
 * artifact of that substitution, not of reviewing.
 *
 * So a reviewer the user picked from the model catalog is translated into the
 * binding shape `harness.mjs` already knows, and reviewed through the same op
 * the advisors use.
 */

import type { HarnessRoleRef } from './driver.js';

/** A synthesized `agentHarness.models` entry, in the runtime's own shape. */
export interface ReviewerBinding {
  /** Key under `agentHarness.models`, and the id the profile references. */
  id: string;
  entry: Record<string, unknown>;
}

/** Gateways cezar can reach with a credential the runtime already resolves. */
const GATEWAYS: Record<string, { endpoint: string; authStoreProvider: string }> = {
  opencode: {
    endpoint: 'https://opencode.ai/zen/v1/chat/completions',
    authStoreProvider: 'opencode',
  },
  deepseek: {
    endpoint: 'https://api.deepseek.com/chat/completions',
    authStoreProvider: 'deepseek',
  },
};

/** Weight lineage, which is what "independent family" is actually asking about
 *  — two models behind one gateway can still be genuinely different models. */
const FAMILY_BY_NAME: ReadonlyArray<[RegExp, string]> = [
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

/** Best-effort weight family for a bare model id; the gateway is the fallback
 *  so an unrecognised model never silently merges into another's family. */
export function reviewerFamily(bareModel: string, gateway: string): string {
  for (const [pattern, family] of FAMILY_BY_NAME) if (pattern.test(bareModel)) return family;
  return gateway;
}

/**
 * Translate a runner-backed reviewer into a runtime binding, or return null
 * when it has no structured path.
 *
 * `claude` returns null on purpose: it is the host, and the om contract has the
 * wrapper supply a FRESH CLAUDE CONTEXT rather than an API call — there is no
 * endpoint to reach on a subscription login. Claude reviewers therefore keep
 * the session path, which is also the one path that never failed.
 */
export function synthesizeReviewerBinding(
  ref: HarnessRoleRef,
  opts: { timeoutMs?: number } = {},
): ReviewerBinding | null {
  if (ref.runner === 'claude') return null;

  if (ref.runner === 'codex') {
    // Codex reviews through its own CLI with a schema file — the runtime's
    // audited read-only command shape.
    return {
      id: `cez-codex-${sanitize(ref.model || 'auto')}`,
      entry: {
        adapter: 'command',
        family: 'openai',
        model: ref.model || 'gpt-5.6-sol',
        roles: ['reviewer'],
        timeoutMs: opts.timeoutMs ?? 600_000,
        ...(ref.effort ? { reasoningEffort: ref.effort } : {}),
        commands: {
          probe: ['codex', '--version'],
          review: [
            'codex',
            'exec',
            '--ignore-user-config',
            '--ignore-rules',
            '--ephemeral',
            '--sandbox',
            'read-only',
            '--cd',
            '{worktree}',
            '--model',
            '{model}',
            '--output-schema',
            '{schemaFile}',
            '-',
          ],
        },
      },
    };
  }

  // opencode: the model id is `provider/model` from the gateway catalog.
  const slash = ref.model.indexOf('/');
  if (slash <= 0) return null;
  const gateway = ref.model.slice(0, slash);
  const bare = ref.model.slice(slash + 1);
  const wire = GATEWAYS[gateway];
  if (!wire) return null;

  return {
    id: `cez-${gateway}-${sanitize(bare)}`,
    entry: {
      adapter: 'preset',
      // Any non-kimi preset name takes the runtime's plain HTTP path.
      preset: gateway === 'deepseek' ? 'deepseek-api' : 'opencode-zen',
      family: reviewerFamily(bare, gateway),
      model: bare,
      roles: ['reviewer'],
      endpoint: wire.endpoint,
      authStoreProvider: wire.authStoreProvider,
      maxOutputTokens: 32768,
      timeoutMs: opts.timeoutMs ?? 600_000,
      ...(ref.effort ? { reasoningEffort: ref.effort } : {}),
    },
  };
}

const sanitize = (value: string): string => value.replace(/[^A-Za-z0-9._-]+/g, '-');

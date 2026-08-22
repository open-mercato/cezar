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
import { familyByModelName } from './model-family.js';

/** A synthesized `agentHarness.models` entry, in the runtime's own shape. */
export interface ReviewerBinding {
  id: string;
  entry: Record<string, unknown>;
}

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

/** Best-effort weight family for a bare model id; the gateway is the fallback
 *  so an unrecognised model never silently merges into another's family. The
 *  table itself lives in `model-family.ts`, which every layer now shares. */
export function reviewerFamily(bareModel: string, gateway: string): string {
  return familyByModelName(bareModel, gateway);
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

/** The shape every caller of {@link opencodeSeatingError} shares — the contract's
 *  `HarnessModelRef` and the driver's `HarnessRoleRef` both satisfy it. */
interface SeatRef {
  runner: string;
  model: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
}

/**
 * Why an OpenCode-bound lineup cannot be seated, or null when it can.
 *
 * The stage-only refusal is about SESSIONS, not about OpenCode. An orchestrator
 * or implementer runs as an agent session that writes to the worktree, and
 * cezar can only hold such a session to stage-only where it has a seam for it:
 * a `PreToolUse` hook plus sandboxed Bash for claude (`claude-guard.ts`), the
 * workspace-write sandbox for codex. OpenCode offers neither, so those two
 * roles refuse it outright.
 *
 * A reviewer with a structured binding never opens a session at all — it is one
 * `response_format: json_object` call to the gateway ({@link
 * synthesizeReviewerBinding}), and the driver content-hashes the worktree
 * around every council regardless. Refusing it was over-broad: it blocked the
 * one transport this module exists to provide, and left the composer offering
 * `opencode/…` reviewers that always 409'd at start.
 *
 * A reviewer WITHOUT a structured path (a bare model id naming no gateway) is
 * still refused, and says how to spell it instead.
 */
export function opencodeSeatingError(roles: {
  orchestrator: SeatRef;
  implementer: SeatRef;
  reviewers: readonly SeatRef[];
}): string | null {
  const sessionRole = ([['orchestrator', roles.orchestrator], ['implementer', roles.implementer]] as const)
    .find(([, ref]) => ref.runner === 'opencode');
  if (sessionRole) {
    return (
      `OpenCode cannot enforce Cezar’s stage-only isolation for the ${sessionRole[0]} — ` +
      'that role runs as an agent session. Use Claude or Codex.'
    );
  }
  const unroutable = roles.reviewers.find(
    (ref) =>
      ref.runner === 'opencode' &&
      synthesizeReviewerBinding({ ...ref, runner: 'opencode', model: ref.model }) === null,
  );
  if (unroutable) {
    return (
      `OpenCode reviewer "${unroutable.model}" has no structured review path — ` +
      'name it as `opencode/<model>` so the council can reach it through the gateway.'
    );
  }
  return null;
}

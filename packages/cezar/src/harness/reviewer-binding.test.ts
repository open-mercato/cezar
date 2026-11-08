import { describe, expect, it } from 'vitest';
import {
  opencodeSeatingError,
  reviewerFamily,
  runnerEquivalentOf,
  synthesizeReviewerBinding,
} from './reviewer-binding.js';

/**
 * The port's central defect (2026-07-25): cezar ran council reviewers as full
 * agentic CLI sessions, where the om harness makes one schema-constrained API
 * call. Measured on one spec, one day, one model — `mimo-v2.5-free` answered as
 * an advisor in 62 seconds and never finished as a session across a 30-minute
 * and two 60-minute budgets.
 *
 * These pin the translation from a picker-chosen reviewer to the binding shape
 * `harness.mjs` reviews through.
 */

describe('synthesizeReviewerBinding', () => {
  it('routes an opencode gateway model to the Zen endpoint with auth-store credentials', () => {
    const binding = synthesizeReviewerBinding({
      runner: 'opencode',
      model: 'opencode/mimo-v2.5-free',
    });
    expect(binding).not.toBeNull();
    expect(binding!.entry).toMatchObject({
      adapter: 'preset',
      model: 'mimo-v2.5-free', // the BARE id — the gateway prefix is wire info
      endpoint: 'https://opencode.ai/zen/v1/chat/completions',
      authStoreProvider: 'opencode',
      roles: ['reviewer'],
    });
    expect(JSON.stringify(binding!.entry)).not.toMatch(/sk-|Bearer/);
  });

  it('routes a direct deepseek model to the deepseek endpoint', () => {
    const binding = synthesizeReviewerBinding({ runner: 'opencode', model: 'deepseek/deepseek-v4-pro' });
    expect(binding!.entry).toMatchObject({
      endpoint: 'https://api.deepseek.com/chat/completions',
      authStoreProvider: 'deepseek',
      model: 'deepseek-v4-pro',
      family: 'deepseek',
    });
  });

  it('gives codex its schema-constrained read-only CLI command', () => {
    const binding = synthesizeReviewerBinding({ runner: 'codex', model: 'gpt-5.6-sol' });
    const review = (binding!.entry.commands as { review: string[] }).review;
    expect(binding!.entry).toMatchObject({ adapter: 'command', family: 'openai' });
    expect(review).toContain('--output-schema');
    expect(review).toContain('read-only'); // a reviewer must not mutate the worktree
    expect(review).toContain('{schemaFile}');
    expect(review).not.toContain('--config');
  });

  it.each([
    ['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['max', 'xhigh'],
  ] as const)('passes the selected Codex reviewer effort %s to its command', (effort, nativeEffort) => {
    const binding = synthesizeReviewerBinding({ runner: 'codex', model: 'gpt-5.6-sol', effort });
    const review = (binding!.entry.commands as { review: string[] }).review;
    expect(binding!.entry.reasoningEffort).toBe(nativeEffort);
    expect(review.slice(review.indexOf('--config'), review.indexOf('--config') + 2))
      .toEqual(['--config', 'model_reasoning_effort={reasoningEffort}']);
  });

  it('returns null for claude — the host has no endpoint on a subscription login', () => {
    expect(synthesizeReviewerBinding({ runner: 'claude', model: 'opus' })).toBeNull();
  });

  it('returns null for a gateway it cannot reach, rather than inventing an endpoint', () => {
    expect(synthesizeReviewerBinding({ runner: 'opencode', model: 'mystery/some-model' })).toBeNull();
    expect(synthesizeReviewerBinding({ runner: 'opencode', model: 'no-slash' })).toBeNull();
  });

  it('carries the role’s effort dial through when set', () => {
    const binding = synthesizeReviewerBinding({
      runner: 'opencode',
      model: 'opencode/glm-5.2',
      effort: 'max',
    });
    expect(binding!.entry.reasoningEffort).toBe('max');
  });

  it('mints ids that are distinct, stable, and safe as JSON keys', () => {
    const a = synthesizeReviewerBinding({ runner: 'opencode', model: 'opencode/glm-5.2' })!;
    const b = synthesizeReviewerBinding({ runner: 'opencode', model: 'opencode/mimo-v2.5-free' })!;
    expect(a.id).not.toBe(b.id);
    expect(a.id).toBe(synthesizeReviewerBinding({ runner: 'opencode', model: 'opencode/glm-5.2' })!.id);
    for (const id of [a.id, b.id]) expect(id).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});

describe('reviewerFamily', () => {
  it('reads weight lineage, so two models behind one gateway stay independent', () => {
    expect(reviewerFamily('glm-5.2', 'opencode')).toBe('zhipu');
    expect(reviewerFamily('mimo-v2.5-free', 'opencode')).toBe('xiaomi');
    expect(reviewerFamily('kimi-k2.6', 'opencode')).toBe('moonshot');
    expect(reviewerFamily('gpt-5.1', 'opencode')).toBe('openai');
  });

  it('falls back to the gateway for an unrecognised model instead of guessing', () => {
    expect(reviewerFamily('big-pickle', 'opencode')).toBe('opencode');
  });
});

/**
 * The refusal used to be "no OpenCode anywhere in the lineup", which blocked the
 * exact transport the module above exists to provide: a picker-chosen
 * `opencode/<model>` reviewer resolves to one structured Zen call and never
 * opens a session, so nothing about stage-only applies to it. Meanwhile the
 * composer offered OpenCode for every role and DEFAULTED the orchestrator to
 * one, so the first Start on a fresh workspace answered 409.
 */
describe('opencodeSeatingError', () => {
  const claude = { runner: 'claude', model: 'haiku' } as const;
  const codex = { runner: 'codex', model: 'gpt-5.6-luna' } as const;

  it('seats an OpenCode reviewer that resolves to a structured gateway call', () => {
    expect(
      opencodeSeatingError({
        orchestrator: claude,
        implementer: codex,
        reviewers: [claude, codex, { runner: 'opencode', model: 'opencode/muse-spark-1.2-contributor-free' }],
      }),
    ).toBeNull();
  });

  it('refuses OpenCode for the orchestrator — that role runs as a session', () => {
    expect(
      opencodeSeatingError({
        orchestrator: { runner: 'opencode', model: 'opencode/claude-fable-5' },
        implementer: codex,
        reviewers: [claude, codex],
      }),
    ).toMatch(/stage-only isolation for the orchestrator/);
  });

  it('refuses OpenCode for the implementer for the same reason', () => {
    expect(
      opencodeSeatingError({
        orchestrator: claude,
        implementer: { runner: 'opencode', model: 'opencode/gpt-5.6-luna' },
        reviewers: [claude, codex],
      }),
    ).toMatch(/stage-only isolation for the implementer/);
  });

  it('refuses an OpenCode reviewer with no gateway prefix, and says how to spell it', () => {
    // A bare id names no gateway, so `synthesizeReviewerBinding` has no endpoint
    // to reach — the council would have had to fall back to a session.
    const error = opencodeSeatingError({
      orchestrator: claude,
      implementer: codex,
      reviewers: [claude, { runner: 'opencode', model: 'muse-spark-1.2-contributor-free' }],
    });
    expect(error).toMatch(/no structured review path/);
    expect(error).toContain('opencode/<model>');
  });

  it('leaves a lineup with no OpenCode at all alone', () => {
    expect(
      opencodeSeatingError({ orchestrator: claude, implementer: codex, reviewers: [claude, codex] }),
    ).toBeNull();
  });
});

describe('runnerEquivalentOf', () => {
  it('maps a trusted gateway preset on its own endpoint to the `<gateway>/<model>` reviewer', () => {
    expect(
      runnerEquivalentOf({
        adapter: 'preset',
        preset: 'opencode-zen',
        endpoint: 'https://opencode.ai/zen/v1/chat/completions',
        model: 'glm-5.3',
        credentialEnv: 'OM_ZEN_KEY',
        authStoreProvider: 'opencode',
      }),
    ).toEqual({ runner: 'opencode', model: 'opencode/glm-5.3' });
    expect(
      runnerEquivalentOf({
        adapter: 'preset',
        preset: 'deepseek-api',
        endpoint: 'https://api.deepseek.com/chat/completions',
        model: 'deepseek-v4-pro',
      }),
    ).toEqual({ runner: 'opencode', model: 'deepseek/deepseek-v4-pro' });
  });

  it('is the exact inverse of synthesizeReviewerBinding for every gateway', () => {
    for (const model of ['opencode/qwen3.8-max', 'deepseek/deepseek-v4-pro']) {
      const synthesized = synthesizeReviewerBinding({ runner: 'opencode', model });
      expect(runnerEquivalentOf(synthesized?.entry)).toEqual({ runner: 'opencode', model });
    }
  });

  it('maps a `codex exec` review command to the codex reviewer', () => {
    expect(
      runnerEquivalentOf({
        adapter: 'command',
        model: 'gpt-5.6-sol',
        commands: { review: ['codex', 'exec', '--sandbox', 'read-only', '-'] },
      }),
    ).toEqual({ runner: 'codex', model: 'gpt-5.6-sol' });
  });

  it('claims no twin for anything else — a different endpoint, a kimi CLI, a malformed entry', () => {
    expect(
      runnerEquivalentOf({
        adapter: 'preset',
        preset: 'opencode-zen',
        endpoint: 'https://proxy.example.com/v1/chat/completions',
        model: 'glm-5.3',
      }),
    ).toBeNull();
    expect(
      runnerEquivalentOf({ adapter: 'command', model: 'k3', commands: { review: ['kimi', 'review'] } }),
    ).toBeNull();
    expect(runnerEquivalentOf({ adapter: 'preset', preset: 'opencode-zen' })).toBeNull();
    expect(runnerEquivalentOf(null)).toBeNull();
    expect(runnerEquivalentOf(['preset'])).toBeNull();
  });
});

describe('the composer\'s reviewer gateways', () => {
  it('match the gateways synthesizeReviewerBinding can route', async () => {
    const { readFileSync } = await import('node:fs');
    const text = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
    const server = text('./reviewer-binding.ts').match(/const GATEWAYS[\s\S]*?= \{([\s\S]*?)\n\};/)?.[1] ?? '';
    const gateways = [...server.matchAll(/^  ([a-z-]+): \{/gm)].map((match) => match[1]);
    const mirror = text('../../../web/src/routes/new-task-harness-form.ts').match(
      /REVIEWER_GATEWAYS: readonly string\[\] = \[([^\]]*)\]/,
    )?.[1];
    expect(gateways.length).toBeGreaterThan(0);
    expect(mirror?.split(',').map((entry) => entry.trim().replace(/'/g, ''))).toEqual(gateways);
    for (const gateway of gateways) {
      expect(synthesizeReviewerBinding({ runner: 'opencode', model: `${gateway}/m` })).not.toBeNull();
    }
  });
});

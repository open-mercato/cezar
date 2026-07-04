import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runAction } from '../../src/actions-v2/runner.js';
import type { DeferredEffect, ActionTarget } from '../../src/actions-v2/runner.js';
import type { ActionDef } from '../../src/actions-v2/action.js';
import type { EffectContext } from '../../src/actions-v2/effects.js';
import type { GitHubService } from '../../src/services/github.service.js';
import type { AgentBackend, AgentRunner, AgentRunSpec } from '../../src/agents/agent-runner.js';

// ─── Fakes ──────────────────────────────────────────────────────────────────

/**
 * Fake AgentRunner factory. Returns whatever `parsed` object the test scripts as
 * the runner's Zod-validated structured output — the CLI path in `runAction`
 * reads `result.parsed`. Records the specs it was handed and the backend asked
 * for, so the test can assert the CLI path (not the Anthropic SDK) ran.
 */
function fakeRunnerFactory(parsed: unknown, tokensUsed = 0) {
  const specs: AgentRunSpec[] = [];
  let backendSeen: AgentBackend | null = null;
  const factory = (backend: AgentBackend): AgentRunner => ({
    backend,
    async run<T>(spec: AgentRunSpec<T>) {
      backendSeen = backend;
      specs.push(spec as AgentRunSpec);
      return {
        text: JSON.stringify(parsed),
        parsed: parsed as T,
        toolCalls: [],
        tokensUsed,
        budgetExceeded: false,
      };
    },
    async interrupt() {},
  });
  return { factory, specs, backend: () => backendSeen };
}

function makeAction(overrides: Partial<ActionDef> = {}): ActionDef {
  return {
    id: 'a1',
    workspaceId: 'w1',
    name: 'auto-triage',
    kind: 'built-in',
    description: null,
    systemPrompt: 'Triage the issue.',
    skillRefs: [],
    target: 'issue',
    triggers: ['manual'],
    effects: null, // tool-use action → collapses to single-shot JSON on CLI
    outputSchema: null,
    enabled: true,
    ...overrides,
  };
}

const target: ActionTarget = {
  kind: 'issue',
  number: 42,
  title: 'Crash on save',
  body: 'It crashes.',
  state: 'open',
  labels: [],
  htmlUrl: 'https://github.com/o/r/issues/42',
};

function makeEffectCtx(): { ctx: EffectContext; addLabel: ReturnType<typeof vi.fn> } {
  const addLabel = vi.fn(async () => {});
  const ctx: EffectContext = {
    github: { addLabel } as unknown as GitHubService,
    targetNumber: 42,
  };
  return { ctx, addLabel };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('runAction CLI backend', () => {
  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY; // the CLI path must not require a key
  });
  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('routes through the AgentRunner and applies effects without an API key', async () => {
    const { factory, specs, backend } = fakeRunnerFactory({
      summary: 'looks like a bug',
      effects: [{ effect: 'label.add', args: { label: 'bug' } }],
    });
    const { ctx, addLabel } = makeEffectCtx();

    const result = await runAction(makeAction(), target, {
      skills: [],
      backend: 'claude-cli',
      runnerFactory: factory,
      effectCtx: ctx,
    });

    expect(backend()).toBe('claude-cli');
    expect(specs).toHaveLength(1);
    // Actions run tool-less and JSON-only on the CLI.
    expect(specs[0].allowedTools).toEqual([]);
    expect(specs[0].responseSchema).toBeDefined();
    expect(addLabel).toHaveBeenCalledWith(42, 'bug');
    expect(result.text).toBe('looks like a bug');
    expect(result.effectsApplied).toHaveLength(1);
  });

  it('defers a mid-confidence effect to the sink (HITL routing on CLI)', async () => {
    const { factory } = fakeRunnerFactory({
      summary: 'probably a dupe',
      effects: [{ effect: 'label.add', args: { label: 'bug' }, confidence: 70 }],
    });
    const { ctx, addLabel } = makeEffectCtx();
    const deferred: DeferredEffect[] = [];

    const result = await runAction(
      makeAction({
        acceptanceMode: 'human-in-the-loop',
        confidenceConfig: { autoAcceptAbove: 90, autoDenyBelow: 60 },
      }),
      target,
      {
        skills: [],
        backend: 'claude-cli',
        runnerFactory: factory,
        effectCtx: ctx,
        deferSink: async (item) => {
          deferred.push(item);
        },
      },
    );

    expect(addLabel).not.toHaveBeenCalled();
    expect(deferred).toHaveLength(1);
    expect(deferred[0].confidence).toBe(70);
    expect(result.effectsApplied[0].summary).toContain('deferred to inbox');
  });

  it('surfaces the runner token count as usage', async () => {
    const { factory } = fakeRunnerFactory({ summary: 'ok', effects: [] }, 1234);
    const { ctx } = makeEffectCtx();

    const result = await runAction(makeAction(), target, {
      skills: [],
      backend: 'codex-cli',
      runnerFactory: factory,
      effectCtx: ctx,
    });

    expect(result.usage.outputTokens).toBe(1234);
  });

  it('does NOT use the runnerFactory for the anthropic-api backend', async () => {
    const { factory, specs } = fakeRunnerFactory({ summary: 'x', effects: [] });
    const { ctx } = makeEffectCtx();
    process.env.ANTHROPIC_API_KEY = 'test-key';

    // We don't script an Anthropic client here; we only assert the CLI factory
    // was never consulted. The call will hit the real SDK constructor but never
    // a network call because we throw via a stub anthropic client.
    const anthropic = {
      messages: {
        create: async () => ({ content: [{ type: 'text', text: '{"effects":[]}' }], usage: {} }),
      },
    } as unknown as import('@anthropic-ai/sdk').default;

    await runAction(makeAction({ effects: ['label.add'] }), target, {
      skills: [],
      backend: 'anthropic-api',
      anthropic,
      runnerFactory: factory,
      effectCtx: ctx,
    });

    expect(specs).toHaveLength(0);
  });
});

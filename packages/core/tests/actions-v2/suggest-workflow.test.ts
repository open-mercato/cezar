import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { runAction } from '../../src/actions-v2/runner.js';
import type { DeferredEffect } from '../../src/actions-v2/runner.js';
import { executeEffect } from '../../src/actions-v2/effects.js';
import type { ActionDef } from '../../src/actions-v2/action.js';
import type { ActionTarget } from '../../src/actions-v2/runner.js';
import type { EffectContext } from '../../src/actions-v2/effects.js';
import type { GitHubService } from '../../src/services/github.service.js';

// ─── Fakes ──────────────────────────────────────────────────────────────────

type ContentBlock = Record<string, unknown>;

interface CapturedCall {
  tools?: Array<{
    name: string;
    input_schema: { properties: Record<string, unknown>; required?: string[] };
  }>;
  messages: Array<{ role: string; content: unknown }>;
}

/**
 * Fake Anthropic client that plays back a scripted sequence of responses
 * (same pattern as context-providers.test.ts, extended with tool_use turns).
 */
function fakeAnthropic(responses: ContentBlock[][]): {
  client: Anthropic;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  let i = 0;
  const client = {
    messages: {
      create: async (args: CapturedCall) => {
        calls.push(args);
        const content = responses[Math.min(i, responses.length - 1)];
        i += 1;
        return {
          content,
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

const textTurn: ContentBlock[] = [{ type: 'text', text: 'done' }];

function toolUseTurn(name: string, input: Record<string, unknown>): ContentBlock[] {
  return [{ type: 'tool_use', id: 'tu-1', name, input }];
}

function makeAction(overrides: Partial<ActionDef> = {}): ActionDef {
  return {
    id: '',
    workspaceId: '',
    name: 'auto-triage',
    kind: 'built-in',
    description: null,
    systemPrompt: 'Triage the issue.',
    skillRefs: [],
    target: 'issue',
    triggers: ['manual'],
    effects: null,
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

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
});

// ─── effectRouting overrides ────────────────────────────────────────────────

describe('applyOrDefer effectRouting overrides', () => {
  it("'always-defer' beats confidence 100 — deferred when a sink is present", async () => {
    const { client } = fakeAnthropic([
      toolUseTurn('label_add', { label: 'bug', _confidence: 100 }),
      textTurn,
    ]);
    const { ctx, addLabel } = makeEffectCtx();
    const deferred: DeferredEffect[] = [];

    const result = await runAction(
      makeAction({ effectRouting: { 'label.add': 'always-defer' } }),
      target,
      {
        skills: [],
        anthropic: client,
        effectCtx: ctx,
        deferSink: async (item) => {
          deferred.push(item);
        },
      },
    );

    expect(addLabel).not.toHaveBeenCalled();
    expect(deferred).toHaveLength(1);
    expect(deferred[0].call.effect).toBe('label.add');
    expect(deferred[0].confidence).toBe(100);
    expect(result.effectsApplied[0].summary).toContain('deferred to inbox');
  });

  it("'always-defer' without a sink drops the effect", async () => {
    const { client } = fakeAnthropic([
      toolUseTurn('label_add', { label: 'bug', _confidence: 100 }),
      textTurn,
    ]);
    const { ctx, addLabel } = makeEffectCtx();

    const result = await runAction(
      makeAction({ effectRouting: { 'label.add': 'always-defer' } }),
      target,
      { skills: [], anthropic: client, effectCtx: ctx },
    );

    expect(addLabel).not.toHaveBeenCalled();
    expect(result.effectsApplied[0].summary).toBe('dropped (no review sink for always-defer)');
  });

  it("'auto' applies unconditionally — below the confidence thresholds", async () => {
    const { client } = fakeAnthropic([
      toolUseTurn('label_add', { label: 'bug', _confidence: 10 }),
      textTurn,
    ]);
    const { ctx, addLabel } = makeEffectCtx();

    const result = await runAction(
      makeAction({
        acceptanceMode: 'human-in-the-loop',
        confidenceConfig: { autoAcceptAbove: 90, autoDenyBelow: 60 },
        effectRouting: { 'label.add': 'auto' },
      }),
      target,
      { skills: [], anthropic: client, effectCtx: ctx },
    );

    expect(addLabel).toHaveBeenCalledWith(42, 'bug');
    expect(result.effectsApplied[0].summary).toContain('added label "bug"');
  });

  it('absent routing falls through to the existing confidence logic', async () => {
    const { client } = fakeAnthropic([
      toolUseTurn('label_add', { label: 'bug', _confidence: 10 }),
      textTurn,
    ]);
    const { ctx, addLabel } = makeEffectCtx();

    const result = await runAction(
      makeAction({
        acceptanceMode: 'human-in-the-loop',
        confidenceConfig: { autoAcceptAbove: 90, autoDenyBelow: 60 },
      }),
      target,
      { skills: [], anthropic: client, effectCtx: ctx },
    );

    expect(addLabel).not.toHaveBeenCalled();
    expect(result.effectsApplied[0].summary).toContain('dropped');
  });
});

// ─── suggest-workflow tool exposure ─────────────────────────────────────────

describe('suggest-workflow tool exposure', () => {
  it('exposes the tool with a reason-only schema when suggestedFlowId is set', async () => {
    const { client, calls } = fakeAnthropic([textTurn]);
    const { ctx } = makeEffectCtx();

    await runAction(makeAction({ suggestedFlowId: 'flow-123' }), target, {
      skills: [],
      anthropic: client,
      effectCtx: ctx,
    });

    const tools = calls[0].tools ?? [];
    const tool = tools.find((t) => t.name === 'suggest-workflow');
    expect(tool).toBeDefined();
    const props = Object.keys(tool!.input_schema.properties);
    expect(props).toContain('reason');
    expect(props).toContain('_confidence');
    expect(props).not.toContain('flowId');
    expect(props).not.toContain('flowName');
    expect(tool!.input_schema.required ?? []).not.toContain('flowId');
  });

  it('does not expose the tool when suggestedFlowId is unset', async () => {
    const { client, calls } = fakeAnthropic([textTurn]);
    const { ctx } = makeEffectCtx();

    await runAction(makeAction(), target, {
      skills: [],
      anthropic: client,
      effectCtx: ctx,
    });

    const tools = calls[0].tools ?? [];
    expect(tools.some((t) => t.name === 'suggest-workflow')).toBe(false);
    // The rest of the vocabulary is still there.
    expect(tools.some((t) => t.name === 'label_add')).toBe(true);
  });
});

// ─── suggest-workflow routing + flowId injection ────────────────────────────

describe('suggest-workflow routing', () => {
  it('defaults to always-defer and injects the configured flowId into the call args', async () => {
    const { client } = fakeAnthropic([
      toolUseTurn('suggest-workflow', { reason: 'confirmed bug', _confidence: 95 }),
      textTurn,
    ]);
    const { ctx } = makeEffectCtx();
    const deferred: DeferredEffect[] = [];

    const result = await runAction(makeAction({ suggestedFlowId: 'flow-123' }), target, {
      skills: [],
      anthropic: client,
      effectCtx: ctx,
      deferSink: async (item) => {
        deferred.push(item);
      },
    });

    expect(deferred).toHaveLength(1);
    expect(deferred[0].call.effect).toBe('suggest-workflow');
    expect(deferred[0].call.args).toEqual({ reason: 'confirmed bug', flowId: 'flow-123' });
    expect(result.effectsApplied[0].summary).toContain('deferred to inbox (suggest-workflow');
  });

  it('drops a declared-mode suggest-workflow call when no workflow is configured', async () => {
    const declaredResponse: ContentBlock[] = [
      {
        type: 'text',
        text: JSON.stringify({
          summary: 'suggesting',
          effects: [{ effect: 'suggest-workflow', args: { reason: 'x' }, confidence: 95 }],
        }),
      },
    ];
    const { client } = fakeAnthropic([declaredResponse]);
    const { ctx } = makeEffectCtx();

    const result = await runAction(
      makeAction({ effects: ['suggest-workflow'], suggestedFlowId: null }),
      target,
      { skills: [], anthropic: client, effectCtx: ctx },
    );

    expect(result.effectsApplied).toHaveLength(1);
    expect(result.effectsApplied[0].summary).toBe('dropped (no workflow configured)');
  });
});

// ─── executor environment guard ─────────────────────────────────────────────

describe('suggest-workflow executor', () => {
  it('returns a not-supported summary when supabase is absent (CLI path)', async () => {
    const { ctx } = makeEffectCtx();
    const summary = await executeEffect(
      { effect: 'suggest-workflow', args: { flowId: 'flow-123', reason: 'x' } },
      ctx,
    );
    expect(summary).toBe('suggest-workflow not supported in this environment');
  });

  it('returns a not-supported summary when workspaceId is absent', async () => {
    const { ctx } = makeEffectCtx();
    const summary = await executeEffect(
      { effect: 'suggest-workflow', args: { flowId: 'flow-123' } },
      { ...ctx, supabase: {} },
    );
    expect(summary).toBe('suggest-workflow not supported in this environment');
  });
});

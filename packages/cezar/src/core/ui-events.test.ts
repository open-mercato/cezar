/**
 * Compile-time contract tests for the v2 protocol vocabulary. Most of the
 * value here is in `tsc` (typecheck runs over test files): exhaustiveness,
 * discriminant narrowing, and drift guards. The runtime assertions just keep
 * vitest honest about executing the file.
 */
import { describe, expect, it } from 'vitest';

import type { RunnerId } from './agent-runner.ts';
import type {
  PlanEntry,
  StopReason,
  TokenUsage,
  ToolKind,
  ToolStatus,
  UiBackend,
  UiEvent,
  UiEventType,
  UiItem,
  UiToolItem,
} from './ui-events.ts';

/** Exact structural equality of two types (the classic conditional trick). */
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2)
  ? true
  : false;
function assertType<_T extends true>(): void {}

describe('UiEvent vocabulary (compile-time contract)', () => {
  it('UiBackend stays in lockstep with RunnerId (no drift with agent-runner.ts)', () => {
    assertType<Equal<UiBackend, RunnerId>>();
    expect<UiBackend[]>(['claude', 'codex', 'opencode', 'pi']).toBeDefined();
  });

  it('enums match the research §7 vocabulary exactly', () => {
    assertType<Equal<ToolStatus, 'pending' | 'running' | 'completed' | 'failed' | 'declined'>>();
    assertType<
      Equal<
        ToolKind,
        | 'read'
        | 'edit'
        | 'delete'
        | 'move'
        | 'search'
        | 'execute'
        | 'think'
        | 'fetch'
        | 'task'
        | 'plan'
        | 'other'
      >
    >();
    assertType<
      Equal<StopReason, 'end_turn' | 'max_tokens' | 'refusal' | 'cancelled' | 'timeout' | 'error'>
    >();
    expect(true).toBe(true);
  });

  it('every UiEvent type is covered by a rendering-relevance map (compile-time exhaustive)', () => {
    // Adding a UiEvent variant without deciding how the UI treats it fails
    // this `satisfies` — the map is the honesty check for future additions.
    const renderRelevance = {
      'session.started': 'meta',
      'session.ended': 'meta',
      'session.error': 'thread',
      'turn.started': 'meta',
      'turn.completed': 'meta',
      'item.started': 'thread',
      'item.delta': 'thread',
      'item.updated': 'thread',
      'item.completed': 'thread',
      'plan.updated': 'dock',
      'permission.requested': 'reserved',
      'permission.resolved': 'reserved',
      'ask.requested': 'thread',
      'usage.updated': 'gauge',
      'image': 'thread',
    } as const satisfies Record<UiEventType, 'thread' | 'meta' | 'dock' | 'gauge' | 'reserved'>;

    // And the map has no extra keys either: its key set IS the event set.
    assertType<Equal<keyof typeof renderRelevance, UiEventType>>();
    expect(Object.keys(renderRelevance)).toHaveLength(15);
  });

  it('the event union narrows on `type`', () => {
    const handle = (event: UiEvent): string => {
      switch (event.type) {
        case 'session.started':
          // Narrowed: sessionId/backend are visible only on this variant.
          return `${event.backend}:${event.sessionId}`;
        case 'turn.completed':
          return event.stopReason;
        case 'item.delta':
          assertType<Equal<typeof event.field, 'text' | 'reasoning' | 'output'>>();
          return event.delta;
        case 'plan.updated':
          return event.entries.map((entry: PlanEntry) => entry.status).join(',');
        case 'usage.updated':
          return String(event.usage.total);
        case 'session.ended':
        case 'session.error':
        case 'turn.started':
        case 'item.started':
        case 'item.updated':
        case 'item.completed':
        case 'permission.requested':
        case 'permission.resolved':
        case 'ask.requested':
        case 'image':
          return event.type;
        default: {
          // Exhaustiveness: a new variant makes this line fail to compile.
          const unreachable: never = event;
          return unreachable;
        }
      }
    };

    expect(handle({ type: 'turn.started', turnId: 't1' })).toBe('turn.started');
    expect(
      handle({ type: 'session.started', sessionId: 's1', backend: 'codex' }),
    ).toBe('codex:s1');
    expect(handle({ type: 'item.delta', itemId: 'i1', field: 'output', delta: 'ok' })).toBe('ok');
    expect(
      handle({
        type: 'ask.requested',
        requestId: 'ask_1',
        questions: [
          { header: 'Lib', question: 'Which?', options: [{ label: 'a' }, { label: 'b' }] },
        ],
      }),
    ).toBe('ask.requested');
  });

  it('the item union narrows on `kind`', () => {
    const label = (item: UiItem): string => {
      switch (item.kind) {
        case 'message':
          assertType<Equal<typeof item.role, 'assistant' | 'user'>>();
          return item.text;
        case 'reasoning':
          return item.text;
        case 'tool':
          // Tool-only fields exist exactly here.
          assertType<Equal<typeof item.status, ToolStatus>>();
          assertType<Equal<typeof item.exitCode, number | undefined>>();
          return item.title;
        default: {
          const unreachable: never = item;
          return unreachable;
        }
      }
    };

    const tool: UiToolItem = {
      kind: 'tool',
      id: 'i1',
      name: 'Bash',
      toolKind: 'execute',
      title: 'Ran npm test',
      status: 'running',
    };
    expect(label(tool)).toBe('Ran npm test');
    expect(label({ kind: 'message', id: 'i2', role: 'assistant', text: 'hi' })).toBe('hi');
  });

  it('TokenUsage carries raw counts (all numeric, cost lives on the event)', () => {
    const usage: TokenUsage = {
      input: 1000,
      output: 200,
      cacheRead: 8000,
      cacheWrite: 400,
      reasoning: 50,
      total: 9650,
      contextWindow: 200_000,
    };
    // No pre-weighted field exists on the type — weighting is presentation.
    assertType<Equal<keyof TokenUsage, 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'reasoning' | 'total' | 'contextWindow'>>();
    expect(usage.total).toBe(9650);
  });

  it('events survive a JSON round-trip (wire-safe: plain data only)', () => {
    const events: UiEvent[] = [
      { type: 'session.started', sessionId: 's1', backend: 'claude', model: 'claude-fable-5', cwd: '/repo', tools: ['Bash'] },
      { type: 'turn.started', turnId: 't1' },
      {
        type: 'item.started',
        item: {
          kind: 'tool',
          id: 'i1',
          name: 'Edit',
          toolKind: 'edit',
          title: 'Edit src/a.ts',
          status: 'running',
          input: { file_path: 'src/a.ts' },
          diffs: [{ path: 'src/a.ts', oldText: 'a', newText: 'b' }],
          locations: [{ path: 'src/a.ts', line: 3 }],
          parentItemId: 'task-1',
        },
      },
      { type: 'plan.updated', entries: [{ content: 'x', status: 'in_progress', activeForm: 'Doing x' }] },
      { type: 'turn.completed', turnId: 't1', stopReason: 'end_turn', usage: { input: 1, output: 2, total: 3 }, costUsd: 0.01 },
      { type: 'session.ended', reason: 'end_turn' },
    ];

    expect(JSON.parse(JSON.stringify(events))).toEqual(events);
  });
});

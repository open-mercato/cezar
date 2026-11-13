import { describe, expect, it } from 'vitest';
import type { RunRecord } from '../runs/store.ts';
import type { GraphNode } from './graph.ts';
import { graphAgentAffinity } from './graph-agent-affinity.ts';

const record = { steps: [
  { id: 'implement', backend: 'codex', model: 'gpt-new', sessionId: 'session-1' },
] } as RunRecord;
const node = (id: string, extra: object = {}) => ({ id, type: 'agent', prompt: '{{task}}', ...extra }) as Extract<GraphNode, { type: 'agent' }>;

describe('graph agent session affinity', () => {
  it('reopens a routed node on its recorded runner and model after restart', () => {
    expect(graphAgentAffinity(node('implement'), record, true)).toEqual({ runner: 'codex', model: 'gpt-new' });
  });
  it('continues a routed session from another graph node', () => {
    expect(graphAgentAffinity(node('fix', { session: { continue: 'implement' } }), record, false))
      .toEqual({ runner: 'codex', model: 'gpt-new' });
  });
  it('retains explicit node pins and starts fresh without a recorded owner', () => {
    expect(graphAgentAffinity(node('fix', { runner: 'claude', model: 'sonnet', session: { continue: 'implement' } }), record, false))
      .toEqual({ runner: 'claude', model: 'sonnet' });
    expect(graphAgentAffinity(node('fix', { runner: 'claude', session: { continue: 'implement' } }), record, false))
      .toEqual({ runner: 'claude' });
    expect(graphAgentAffinity(node('fix', { session: { continue: 'missing' } }), record, false)).toEqual({});
  });
});

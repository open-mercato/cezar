import { describe, expect, it } from 'vitest';

import type { RunnerId } from '../core/agent-runner.ts';
import type { RunRecord } from '../runs/store.ts';
import { countActiveRuns } from './agent-active-runs.ts';

/** Which tasks hold an agent's update (spec 2026-11-25-agent-cli-install-and-update). */

const run = (over: Partial<RunRecord>): RunRecord =>
  ({ id: 'r', status: 'running', steps: [], ...over }) as unknown as RunRecord;

const project = (root: string, runs: RunRecord[]) => ({ root, listRuns: () => runs });
const defaults = (map: Record<string, RunnerId>) => async (root: string) => map[root] ?? 'claude';

describe('countActiveRuns', () => {
  it("counts a run with no runner against its project's default, not claude", async () => {
    const sources = [project('/codex-repo', [run({ id: 'a' })]), project('/claude-repo', [run({ id: 'b' })])];
    const map = defaults({ '/codex-repo': 'codex', '/claude-repo': 'claude' });
    expect(await countActiveRuns(sources, 'codex', map)).toBe(1);
    expect(await countActiveRuns(sources, 'claude', map)).toBe(1);
  });

  it('counts a workflow step on its own backend against that backend', async () => {
    const step = { id: 'review', status: 'running', backend: 'gemini', startedAt: '2026-11-25T10:00:00Z' };
    const sources = [project('/codex-repo', [run({ id: 'w', currentStepId: 'review', steps: [step] as RunRecord['steps'] })])];
    const map = defaults({ '/codex-repo': 'codex' });
    expect(await countActiveRuns(sources, 'gemini', map)).toBe(1);
    expect(await countActiveRuns(sources, 'codex', map)).toBe(0);
  });

  it('honours an explicit runner, and skips runs that are not running', async () => {
    const sources = [project('/codex-repo', [run({ runner: 'opencode' }), run({ status: 'review' }), run({ status: 'queued' })])];
    const map = defaults({ '/codex-repo': 'codex' });
    expect(await countActiveRuns(sources, 'opencode', map)).toBe(1);
    expect(await countActiveRuns(sources, 'codex', map)).toBe(0);
  });

  it('falls back to claude when the project config cannot be read', async () => {
    const sources = [project('/broken', [run({})])];
    expect(await countActiveRuns(sources, 'claude', async () => { throw new Error('unreadable'); })).toBe(1);
  });
});

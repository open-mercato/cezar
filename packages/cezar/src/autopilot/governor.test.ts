import { describe, expect, it } from 'vitest';
import { decideGovernor } from './governor.ts';
import type { TowerRunRow } from '@open-mercato/cezar-contract';
import { defaultAutopilotGovernor } from '@open-mercato/cezar-contract';

function run(over: Partial<TowerRunRow> & Pick<TowerRunRow, 'runId'>): TowerRunRow {
  return {
    projectId: 'p',
    projectName: 'p',
    title: over.runId,
    status: 'running',
    createdAt: new Date().toISOString(),
    ageMinutes: 1,
    stuck: false,
    ...over,
  };
}

describe('decideGovernor', () => {
  it('emits nothing when every cap is null', () => {
    const out = decideGovernor({
      governor: defaultAutopilotGovernor(),
      runs: [run({ runId: 'a', costUsd: 9 })],
      spendUsdLastHour: 9,
      totalRssMb: 4000,
      maxParallel: 4,
    });
    expect(out.actions).toEqual([]);
    expect(out.effectiveMaxParallel).toBe(4);
  });

  it('warns and pauses the heaviest run when spend exceeds the hourly cap', () => {
    const out = decideGovernor({
      governor: { ...defaultAutopilotGovernor(), maxSpendUsdPerHour: 1, softMaxParallel: 1 },
      runs: [
        run({ runId: 'cheap', costUsd: 0.2 }),
        run({ runId: 'rich', costUsd: 2 }),
      ],
      spendUsdLastHour: 2.2,
      totalRssMb: 100,
      maxParallel: 4,
    });
    expect(out.actions.some((a) => a.kind === 'warn')).toBe(true);
    expect(out.actions.some((a) => a.kind === 'soft-cap')).toBe(true);
    expect(out.effectiveMaxParallel).toBe(1);
    const pause = out.actions.find((a) => a.kind === 'pause');
    expect(pause?.runId).toBe('rich');
  });

  it('pauses stuck runs past stuckAfterMinutes', () => {
    const out = decideGovernor({
      governor: { ...defaultAutopilotGovernor(), stuckAfterMinutes: 30 },
      runs: [run({ runId: 'stale', ageMinutes: 45, stuck: true })],
      spendUsdLastHour: 0,
      totalRssMb: 10,
      maxParallel: 2,
    });
    expect(out.actions).toEqual([
      expect.objectContaining({ kind: 'pause', runId: 'stale' }),
    ]);
  });

  it('flags what-if spend over the cap', () => {
    const out = decideGovernor({
      governor: { ...defaultAutopilotGovernor(), maxSpendUsdPerHour: 5 },
      runs: [run({ runId: 'a', costUsd: 4 })],
      spendUsdLastHour: 4,
      totalRssMb: 100,
      maxParallel: 2,
      extraParallel: 4,
    });
    expect(out.forecast.wouldExceedSpend).toBe(true);
    expect(out.forecast.projectedUsdPerHour).toBeGreaterThan(5);
  });
});

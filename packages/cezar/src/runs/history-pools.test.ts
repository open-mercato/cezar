import { afterEach, describe, expect, it } from 'vitest';
import { effectiveHistoryPools, runRetentionLimits, setConfiguredRunRetention } from './history-pools.ts';

describe('task history pools', () => {
  afterEach(() => {
    delete process.env.CEZ_RUNS_KEEP;
    delete process.env.CEZ_AUTOMATION_RUNS_KEEP;
    setConfiguredRunRetention({});
  });

  it('defaults both pools to 300', () => {
    expect(runRetentionLimits()).toEqual({ regular: 300, automation: 300, archived: 500 });
    expect(effectiveHistoryPools({})).toEqual({ runsKept: 300, automationRunsKept: 300 });
  });

  it('falls back to the env vars, and the settings win over them', () => {
    process.env.CEZ_RUNS_KEEP = '40';
    process.env.CEZ_AUTOMATION_RUNS_KEEP = '20';
    expect(effectiveHistoryPools({})).toEqual({ runsKept: 40, automationRunsKept: 20 });
    setConfiguredRunRetention({ regular: 1000 });
    expect(runRetentionLimits()).toMatchObject({ regular: 1000, automation: 20 });
  });

  it('ignores an invalid setting instead of keeping nothing', () => {
    setConfiguredRunRetention({ regular: 0, automation: null });
    expect(runRetentionLimits()).toMatchObject({ regular: 300, automation: 300 });
  });
});

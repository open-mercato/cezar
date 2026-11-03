import { describe, expect, it } from 'vitest';
import * as contract from '@open-mercato/cezar-contract';

describe('dashboard cost contract', () => {
  it('bounds detail requests and rejects unsupported cohorts and sorting', () => {
    expect(contract).toHaveProperty('dashboardCostsQuerySchema');
    const s = contract.dashboardCostsQuerySchema;
    expect(s.parse({})).toEqual({
      period: 'all',
      sort: 'cost',
      offset: 0,
      limit: 20,
    });
    for (const query of [
      { period: 'today' },
      { sort: 'weighted' },
      { limit: 21 },
      { offset: -1 },
      { projectId: '' },
      { tzOffsetMinutes: -841 },
      { tzOffsetMinutes: 841 },
    ])
      expect(s.safeParse(query).success).toBe(false);
    expect(s.parse({ tzOffsetMinutes: '-840' }).tzOffsetMinutes).toBe(-840);
    expect(s.parse({ tzOffsetMinutes: '-120' }).tzOffsetMinutes).toBe(-120);
  });
  it('distinguishes absent, unknown and measured-zero amounts without accepting invalid numbers', () => {
    expect(contract).toHaveProperty('dashboardCostTotalsSchema');
    const s = contract.dashboardCostTotalsSchema;
    expect(s.parse({ tasks: 2 })).toEqual({ tasks: 2 });
    expect(
      s.parse({ tasks: 2, costUsd: { value: null, reportedTasks: 0 } }).costUsd?.value,
    ).toBeNull();
    expect(s.parse({ tasks: 2, costUsd: { value: 0, reportedTasks: 1 } }).costUsd?.value).toBe(
      0,
    );
    for (const value of [-1, Infinity, NaN])
      expect(s.safeParse({ tasks: 1, costUsd: { value, reportedTasks: 1 } }).success).toBe(
        false,
      );
  });
  it('preserves future preference keys but validates the new usage flag', () => {
    expect(
      contract.setWorkspaceUiStateInputSchema.safeParse({
        dashboard: { tiles: { usage: 'no' } },
      }).success,
    ).toBe(false);
    expect(
      contract.workspaceUiStateSchema.parse({
        dashboard: { tiles: { usage: 'no', future: 9 } },
      }).dashboard?.tiles,
    ).toEqual({ usage: true, future: 9 });
    expect(
      contract.workspaceUiStateSchema.parse({
        dashboard: { tiles: { usage: false } },
      }).dashboard?.tiles?.usage,
    ).toBe(false);
    expect(
      contract.workspaceUiStateSchema.parse({
        dashboard: { tiles: { trends: 'no' } },
      }).dashboard?.tiles?.trends,
    ).toBe(true);
    expect(
      contract.workspaceUiStateSchema.parse({
        dashboard: { order: ['trends', 'fleet'] },
      }).dashboard?.order,
    ).toEqual(['trends', 'fleet']);
  });
});

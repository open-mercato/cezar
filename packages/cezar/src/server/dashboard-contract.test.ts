import { describe, expect, it } from 'vitest';
import * as contract from '@open-mercato/cezar-contract';

describe('dashboard contract', () => {
  it('rejects unknown task group and unsafe pagination while defaulting a bounded page', () => {
    expect(contract).toHaveProperty('dashboardTasksQuerySchema');
    const schema = contract.dashboardTasksQuerySchema;
    expect(schema.safeParse({ snapshotId: 's', group: 'stuck' }).success).toBe(false);
    expect(schema.safeParse({ snapshotId: 's', group: 'running', limit: '999' }).success).toBe(false);
    expect(schema.parse({ snapshotId: 's', group: 'running' })).toEqual({ snapshotId: 's', group: 'running', limit: 20, offset: 0 });
  });
  it('keeps CPU unavailable distinct from measured zero', () => {
    expect(contract).toHaveProperty('dashboardTelemetrySchema');
    expect(contract.dashboardTelemetrySchema.parse({ asOf: '2026-09-18T00:00:00.000Z', samples: [{ projectId: 'p', runId: 'r', sampledAt: '2026-09-18T00:00:00.000Z', cpuPct: null, rssBytes: 1, procCount: 1 }] }).samples[0]?.cpuPct).toBeNull();
  });
});

describe('dashboard preferences', () => {
  it('rejects malformed known flags on write but salvages read preferences', () => {
    expect(contract.setWorkspaceUiStateInputSchema.safeParse({ dashboard: { tiles: { fleet: 'false' } } }).success).toBe(false);
    expect(contract.workspaceUiStateSchema.parse({ dashboard: { tiles: { fleet: 'broken', needsYou: false, future: 42 }, other: 7 } }).dashboard).toEqual({ tiles: { fleet: true, needsYou: false, future: 42 }, other: 7 });
  });
});

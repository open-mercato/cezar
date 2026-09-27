import { hc, type InferResponseType } from 'hono/client';
import { describe, it, expect } from 'vitest';
import type {
  DashboardSnapshot,
  DashboardAutomations,
  DashboardOverview,
  DashboardCosts,
  DashboardTasksPage,
  DashboardTelemetry,
  DashboardFeed,
} from '@open-mercato/cezar-contract';
import type { AppType } from './app-type.ts';
const client = hc<AppType>('http://127.0.0.1');
const dashboard = client.api.v1.workspace.dashboard;
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
type Automations = Assert<Exact<DashboardAutomations, InferResponseType<typeof dashboard.automations.$get, 200>>>;
type Overview = Assert<
  Exact<DashboardOverview, InferResponseType<typeof dashboard.overview.$get, 200>>
>;
type Costs = Assert<Exact<DashboardCosts, InferResponseType<typeof dashboard.costs.$get, 200>>>;
type Snapshot = Assert<Exact<DashboardSnapshot, InferResponseType<typeof dashboard.$get, 200>>>;
type Tasks = Assert<
  Exact<DashboardTasksPage, InferResponseType<typeof dashboard.tasks.$get, 200>>
>;
type Telemetry = Assert<
  Exact<DashboardTelemetry, InferResponseType<typeof dashboard.telemetry.$get, 200>>
>;
type Feed = Assert<Exact<DashboardFeed, InferResponseType<typeof dashboard.feed.$get, 200>>>;
// Never invoked: compile-time guarantees that query validators reached AppType.
function typedQueries() {
  dashboard.automations.$get({ query: { projectId: 'p' } });
  // @ts-expect-error project id is required middleware input
  dashboard.automations.$get({ query: {} });

  dashboard.costs.$get({ query: { period: '7d', sort: 'input', limit: '20', offset: '0' } });
  // @ts-expect-error unknown metric
  dashboard.costs.$get({ query: { sort: 'weighted' } });
  // @ts-expect-error unknown cohort
  dashboard.costs.$get({ query: { period: 'today' } });
  dashboard.tasks.$get({
    query: { snapshotId: 's', group: 'questions', offset: '0', limit: '20' },
  });
  // @ts-expect-error missing required snapshot identity
  dashboard.tasks.$get({ query: { group: 'questions' } });
  // @ts-expect-error unknown task group
  dashboard.tasks.$get({ query: { snapshotId: 's', group: 'other' } });
  // @ts-expect-error unknown feed filter
  dashboard.feed.$get({ query: { filter: 'other' } });
}
describe('dashboard response and typed query parity', () => {
  it('keeps chained routes visible to the typed client', () => expect(dashboard).toBeDefined());
});

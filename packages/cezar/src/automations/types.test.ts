import { describe, expect, it } from 'vitest';
import {
  automationDefinitionSchema,
  automationDefinitionsFileSchema,
  automationRuntimeStateSchema,
} from './types.ts';

const definition = {
  id: 'review-new-prs',
  revision: 1,
  name: 'Review new PRs',
  enabled: false,
  events: ['pull_request.opened'],
  intervalSeconds: 300,
  filters: { lookbackDays: 7, maxRecords: 25 },
  task: { prompt: 'Review {{github.url}}' },
  createdAt: '2026-07-26T00:00:00.000Z',
  updatedAt: '2026-07-26T00:00:00.000Z',
};

describe('automation schemas', () => {
  it('pins safe interval, lookback, and result bounds', () => {
    expect(automationDefinitionSchema.safeParse({ ...definition, intervalSeconds: 59 }).success).toBe(false);
    expect(
      automationDefinitionSchema.safeParse({
        ...definition,
        filters: { lookbackDays: 91, maxRecords: 101 },
      }).success,
    ).toBe(false);
  });

  it('requires watched labels for label transition events', () => {
    expect(
      automationDefinitionSchema.safeParse({ ...definition, events: ['issue.labeled'] }).success,
    ).toBe(false);
  });

  it('preserves unknown fields at every persisted object layer', () => {
    const parsed = automationDefinitionSchema.parse({
      ...definition,
      future: true,
      filters: { ...definition.filters, futureFilter: 'kept' },
      task: { ...definition.task, futureTask: 'kept' },
    });
    expect(parsed.future).toBe(true);
    expect(parsed.filters?.futureFilter).toBe('kept');
    expect(parsed.task.futureTask).toBe('kept');
    expect(automationDefinitionsFileSchema.parse({ version: 1, automations: [], future: 1 }).future).toBe(1);
    expect(automationRuntimeStateSchema.parse({ future: 'kept' }).future).toBe('kept');
  });

  it('defaults new definitions to paused and conservative bounds', () => {
    const parsed = automationDefinitionSchema.parse({
      ...definition,
      enabled: undefined,
      intervalSeconds: undefined,
      filters: {},
    });
    expect(parsed.enabled).toBe(false);
    expect(parsed.intervalSeconds).toBe(300);
    expect(parsed.filters).toMatchObject({ lookbackDays: 7, maxRecords: 25 });
  });
});

describe('automation schemas — kinds (spec 2026-09-14)', () => {
  it('reads a pre-schedule definition as a poll and fills its defaults', () => {
    const parsed = automationDefinitionSchema.parse({ ...definition, intervalSeconds: undefined, filters: undefined });
    expect(parsed.kind).toBe('github');
    expect(parsed.intervalSeconds).toBe(300);
    expect(parsed.filters).toMatchObject({ lookbackDays: 7, maxRecords: 25 });
  });

  it('accepts a schedule without any GitHub key and stamps no poll defaults onto it', () => {
    const parsed = automationDefinitionSchema.parse({
      id: 's', revision: 1, name: 'Nightly', kind: 'schedule', schedule: { type: 'weekly', day: 5, hour: 16 },
      task: { prompt: 'Draft the changelog for {{date}}', dispatch: { maxSubtasks: 4, reviewChild: true } },
      createdAt: '2026-09-14T00:00:00.000Z', updatedAt: '2026-09-14T00:00:00.000Z',
    });
    expect(parsed).toMatchObject({ kind: 'schedule', enabled: false, schedule: { type: 'weekly', day: 5, hour: 16 } });
    expect(parsed.intervalSeconds).toBeUndefined();
    expect(parsed.filters).toBeUndefined();
    expect(parsed.task.dispatch).toEqual({ maxSubtasks: 4, reviewChild: true });
  });

  it('refuses a schedule without a schedule and a poll without events', () => {
    expect(automationDefinitionSchema.safeParse({ ...definition, kind: 'schedule' }).success).toBe(false);
    expect(automationDefinitionSchema.safeParse({ ...definition, events: [] }).success).toBe(false);
    expect(automationDefinitionSchema.safeParse({ ...definition, task: { ...definition.task, dispatch: { maxSubtasks: 0 } } }).success).toBe(false);
  });
});

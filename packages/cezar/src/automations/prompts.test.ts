import { describe, expect, it } from 'vitest';
import { automationDefinitionSchema, automationEventSchema } from './types.ts';
import {
  AUTOMATIONS_PROMPT,
  AUTOMATION_SCHEMA_REFERENCE,
  CREATE_AUTOMATION_SKILL_BODY,
  CREATE_AUTOMATION_SKILL_NAME,
} from './prompts.ts';

/** The prompts are the ONLY place an agent learns the `cez automation` CLI and the definition
 *  shape, so they must name every command, every event and every key the storage schema accepts. */
describe('the automations prompt part', () => {
  it('teaches the CLI through the cockpit’s own entrypoint, and the create → check → enable order', () => {
    expect(AUTOMATIONS_PROMPT).toContain('node "$CEZ_BIN" automation');
    for (const command of ['schema', 'create --file', '--enable', 'check <id>', 'list', 'show <id>', 'update <id>', 'enable <id>', 'pause <id>', 'delete <id>']) {
      expect(AUTOMATIONS_PROMPT).toContain(command);
    }
    expect(AUTOMATIONS_PROMPT).toMatch(/Create it PAUSED/);
    expect(AUTOMATIONS_PROMPT).toMatch(/Never enable an automation whose filter you have not previewed/);
  });

  it('names the intent it recognises and forbids the substitutes a refused agent reaches for', () => {
    expect(AUTOMATIONS_PROMPT).toContain('"whenever"');
    expect(AUTOMATIONS_PROMPT).toMatch(/instead of polling GitHub yourself/);
    expect(AUTOMATIONS_PROMPT).toMatch(/do not write a cron job, a GitHub Action or a polling script/);
    expect(AUTOMATIONS_PROMPT).toMatch(/stop and report that automations are unavailable/);
  });
});

describe('the definition reference', () => {
  it('names every event the storage schema accepts, and no other', () => {
    for (const event of automationEventSchema.options) expect(AUTOMATION_SCHEMA_REFERENCE).toContain(event);
    const mentioned = AUTOMATION_SCHEMA_REFERENCE.match(/\b(?:pull_request|issue)\.[a-z_]+/g) ?? [];
    for (const event of new Set(mentioned)) expect(automationEventSchema.options).toContain(event);
  });

  it('names every top-level, filter and task key of the storage schema', () => {
    const shape = automationDefinitionSchema.shape;
    for (const key of Object.keys(shape)) {
      if (['id', 'revision', 'createdAt', 'updatedAt', 'enabled'].includes(key)) continue;
      expect(AUTOMATION_SCHEMA_REFERENCE).toContain(`"${key}"`);
    }
    for (const key of Object.keys(shape.filters.shape)) expect(AUTOMATION_SCHEMA_REFERENCE).toContain(`"${key}"`);
    for (const key of Object.keys(shape.task.shape)) expect(AUTOMATION_SCHEMA_REFERENCE).toContain(`"${key}"`);
  });

  it('lists the prompt placeholders the task template accepts and the paused-by-default rule', () => {
    for (const placeholder of ['github.kind', 'github.number', 'github.title', 'github.url', 'github.author', 'github.assignees', 'github.labels', 'github.event']) {
      expect(AUTOMATION_SCHEMA_REFERENCE).toContain(`{{${placeholder}}}`);
    }
    expect(AUTOMATION_SCHEMA_REFERENCE).toMatch(/PAUSED unless created with --enable/);
    expect(AUTOMATION_SCHEMA_REFERENCE).toMatch(/changedLabels.*REQUIRED for issue\.labeled/);
  });

  it('is a definition the storage schema accepts once the comments are stripped', () => {
    // The object runs from the first brace to the first closing brace on a line of its own; the
    // prose after it mentions `{{placeholders}}`, so `lastIndexOf('}')` would overshoot.
    const start = AUTOMATION_SCHEMA_REFERENCE.indexOf('{');
    const end = AUTOMATION_SCHEMA_REFERENCE.indexOf('\n}', start) + 2;
    const block = AUTOMATION_SCHEMA_REFERENCE.slice(start, end);
    const withoutComments = block.replace(/\/\/[^\n]*/g, '');
    const parsed = JSON.parse(withoutComments) as Record<string, unknown>;
    // The example shows BOTH ways to name the task's chain; a real definition picks one.
    const task = { ...(parsed.task as Record<string, unknown>) };
    delete task.steps;
    const result = automationDefinitionSchema.safeParse({
      ...parsed,
      task,
      id: 'example',
      revision: 1,
      createdAt: '2026-09-13T00:00:00.000Z',
      updatedAt: '2026-09-13T00:00:00.000Z',
    });
    expect(result.success, JSON.stringify(result.success ? null : result.error.issues)).toBe(true);
    const steps = { ...parsed, task: { ...task, workflow: undefined, steps: (parsed.task as { steps: unknown }).steps }, id: 'e', revision: 1, createdAt: '2026-09-13T00:00:00.000Z', updatedAt: '2026-09-13T00:00:00.000Z' };
    expect(automationDefinitionSchema.safeParse(steps).success).toBe(true);
  });
});

describe('the built-in skill body', () => {
  it('walks the create → preview → report path and embeds the reference', () => {
    expect(CREATE_AUTOMATION_SKILL_NAME).toBe('create-cezar-automation');
    expect(CREATE_AUTOMATION_SKILL_BODY).toContain('node "$CEZ_BIN" automation create --file');
    expect(CREATE_AUTOMATION_SKILL_BODY).toContain('node "$CEZ_BIN" automation check <id>');
    expect(CREATE_AUTOMATION_SKILL_BODY).toContain('cez automation update <id> --file');
    expect(CREATE_AUTOMATION_SKILL_BODY).toContain(AUTOMATION_SCHEMA_REFERENCE);
    expect(CREATE_AUTOMATION_SKILL_BODY).toMatch(/created PAUSED/);
    expect(CREATE_AUTOMATION_SKILL_BODY).toMatch(/ask one precise question and stop/);
    expect(CREATE_AUTOMATION_SKILL_BODY).toMatch(/do not add cron jobs, GitHub Actions, webhooks or polling scripts/);
  });
});

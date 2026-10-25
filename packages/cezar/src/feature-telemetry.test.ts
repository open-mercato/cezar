import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { automationLabel, automationTaskOrigin, collectFeatureInventory, skillLabel, taskOriginOf, workflowLabel } from './feature-telemetry.ts';
import { cezarHomeDir } from './paths.ts';
import { mergeWriteWorkspaceConfig } from './workspace/config.ts';

const teamLoads = vi.hoisted(() => ({ count: 0 }));
vi.mock('./skills-remote.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./skills-remote.ts')>();
  return { ...actual, getTeamSkillsCached: (root: string) => { teamLoads.count += 1; return actual.getTeamSkillsCached(root); } };
});

describe('feature telemetry labels', () => {
  it('derives a task origin from what the start input carries', () => {
    expect(taskOriginOf({ origin: 'cli', deviceSid: 'x' })).toBe('cli');
    expect(taskOriginOf({ dispatch: { parentRunId: 'p' } })).toBe('dispatch_implement');
    expect(taskOriginOf({ dispatch: { parentRunId: 'p', kind: 'review' } })).toBe('dispatch_review');
    // A dispatch ROOT has no parent: it is wherever the user started it.
    expect(taskOriginOf({ dispatch: {}, deviceSid: 'x' })).toBe('cockpit');
    expect(taskOriginOf({})).toBe('api');
  });

  it('tells an automation from a composer schedule send', () => {
    expect(automationTaskOrigin({ kind: 'github' })).toBe('automation_github');
    expect(automationTaskOrigin({ kind: 'tracker' })).toBe('automation_tracker');
    expect(automationTaskOrigin({ kind: 'schedule' })).toBe('automation_schedule');
    expect(automationTaskOrigin({ kind: 'schedule', deferredStart: {} as never })).toBe('scheduled_task');
  });

  it('names built-in workflows and folds every user workflow', () => {
    expect(workflowLabel({ name: 'quick-task', source: 'built-in' }, false)).toBe('quick-task');
    expect(workflowLabel({ name: 'review-council', source: 'built-in' }, false)).toBe('review-council');
    expect(workflowLabel({ name: '(planned)', source: 'built-in' }, false)).toBe('planned');
    expect(workflowLabel({ name: '(planned)', source: 'built-in' }, true)).toBe('dispatch');
    expect(workflowLabel({ name: 'acme-release', source: 'file' }, false)).toBe('custom');
    expect(workflowLabel({ name: 'acme-graph', source: 'file', graph: {} as never }, false)).toBe('custom_graph');
    // A user file that shadows a built-in name is still the user's.
    expect(workflowLabel({ name: 'quick-task', source: 'file' }, false)).toBe('custom');
    expect(workflowLabel({ name: 'Set up e2e', source: 'built-in' }, false)).toBe('other_builtin');
  });

  it('sends public skill names only', () => {
    expect(skillLabel({ name: 'om-auto-review-pr', source: 'agents' })).toBe('om-auto-review-pr');
    expect(skillLabel({ name: 'create-cezar-automation', source: 'builtin' })).toBe('create-cezar-automation');
    expect(skillLabel({ name: 'om-new-one', source: 'team', team: { repo: 'open-mercato/skills', ref: 'main', path: 'x', dir: true } } as never)).toBe('om-new-one');
    expect(skillLabel({ name: 'acme-deploy', source: 'team', team: { repo: 'acme/private-skills', ref: 'main', path: 'x', dir: true } } as never)).toBe('team');
    expect(skillLabel({ name: 'acme-deploy', source: 'cezar' })).toBe('repo');
    expect(skillLabel({ name: 'acme-deploy', source: 'agents' })).toBe('repo');
    expect(skillLabel({ name: 'acme-deploy', source: 'global' })).toBe('global');
  });

  it('labels an automation by what it listens to, never by its name', () => {
    expect(automationLabel({ kind: 'github', events: ['pull_request.opened'] })).toBe('github:pull_request.opened');
    expect(automationLabel({ kind: 'github', events: ['issue.opened', 'issue.labeled'] })).toBe('github:multi');
    expect(automationLabel({ kind: 'schedule', schedule: { type: 'weekdays' } as never })).toBe('schedule:weekdays');
    expect(automationLabel({ kind: 'tracker', trackerTrigger: { association: { kind: 'linear' } } as never })).toBe('tracker:linear');
  });
});

describe('collectFeatureInventory', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('counts configured features across registered projects, and only what exists', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cez-inventory-'));
    dirs.push(root);
    mkdirSync(join(root, '.ai/cezar/workflows'), { recursive: true });
    mkdirSync(join(root, '.ai/cezar/skills'), { recursive: true });
    writeFileSync(join(root, '.ai/cezar/workflows/mine.yaml'), 'name: mine\nsteps:\n  - id: a\n    prompt: "{{task}}"\n');
    writeFileSync(join(root, '.ai/cezar/skills/acme.md'), '---\nname: acme\n---\n\nBody.\n');
    writeFileSync(join(root, '.ai/cezar/automations.json'), JSON.stringify({
      version: 1,
      automations: [{ enabled: true }, { enabled: false }, { enabled: true, deferredStart: {} }],
    }));
    mkdirSync(join(cezarHomeDir(), 'tracker-connections'), { recursive: true });
    writeFileSync(join(cezarHomeDir(), 'tracker-connections', `${'a'.repeat(64)}.env`), '');
    await mergeWriteWorkspaceConfig((config) => {
      config.projects = [{ id: 'one', root }, { id: 'gone', root: join(root, 'missing') }] as never;
    });

    const rows = new Map((await collectFeatureInventory()).map((r) => [r.label, r.value]));
    expect(rows.get('projects')).toBe(1);
    expect(rows.get('automations_enabled')).toBe(1);
    expect(rows.get('automations_paused')).toBe(1);
    expect(rows.get('workflows_custom')).toBe(1);
    expect(rows.get('skills_repo')).toBe(1);
    expect(rows.get('tracker_connections')).toBe(1);
    expect(rows.has('skills_repos_custom')).toBe(false);
    expect([...rows.values()].every((v) => v > 0)).toBe(true);
    // The daily read of every registered project is disk-only: no team-repo clone or fetch.
    expect(teamLoads.count).toBe(0);
  });
});

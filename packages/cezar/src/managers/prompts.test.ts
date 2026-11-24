import { describe, expect, it } from 'vitest';
import type { Manager, ManagerAttentionItem, ManagerSnapshot } from '@open-mercato/cezar-contract';
import { MANAGER_QUIET, managerSystemPrompt, watchPrompt } from './prompts.ts';

const manager = (instructions: string): Manager => ({
  id: 'm', name: 'Self-assessment Manager', instructions, avatar: 0, projects: 'all', cronMinutes: 15, jobs: [],
  createdAt: '2026-11-20T00:00:00.000Z', updatedAt: '2026-11-20T00:00:00.000Z',
});
const pr: ManagerAttentionItem = { key: 'pr:alpha/7', kind: 'task-review', projectId: 'alpha', title: 'Open PR', number: 7 };
const snapshot: ManagerSnapshot = { generatedAt: '2026-11-20T00:00:00.000Z', projects: [], attention: [pr] };
const GOAL = 'Analyze my work for my self-assessment.';

describe('watchPrompt and the manager goal', () => {
  it('carries the goal, its precedence over the default role, and the quiet reply when nothing serves it', () => {
    const prompt = watchPrompt(snapshot, [pr], '', [], `  ${GOAL}\n`);
    expect(prompt).toContain(`The user created you for this goal, and it takes precedence over the default role of watching pull requests and proposing merges:\n${GOAL}\n`);
    expect(prompt).toContain('Raise only what serves that goal.');
    expect(prompt).toContain('Anything in the snapshot that does not serve it, open pull requests and failing tasks included, is not your concern on this check');
    expect(prompt).toContain('never ask whether to merge or review it unless the goal asks for that');
    expect(prompt).toContain('If nothing in the snapshot serves the goal, give the quiet reply described below.');
    expect(prompt).toContain(`reply with exactly ${MANAGER_QUIET} and nothing else, after any CEZ:ASK-CLOSE lines`);
  });

  it('without a goal keeps the default check, with no goal section', () => {
    for (const goal of [undefined, '', '   ']) {
      const prompt = watchPrompt(snapshot, [pr], '', [], goal);
      expect(prompt).not.toContain('takes precedence');
      expect(prompt).not.toContain('Raise only what serves');
      expect(prompt).toMatch(/SNAPSHOT-[0-9a-f]{12}\n\nTell the user, briefly, what deserves their attention and why/);
      expect(prompt).toContain(`If nothing deserves them, reply with exactly ${MANAGER_QUIET}`);
    }
  });
});

describe('managerSystemPrompt and the manager goal', () => {
  it('routes agent changes and retries in place to the agent selection commands', () => {
    const prompt = managerSystemPrompt(manager(''), []);
    expect(prompt).toContain('use `cez-manager task switch`. Do not cancel and recreate it.');
    expect(prompt).toContain('including unpinned steps that use it');
    expect(prompt).toContain('Cancel or switch any task');
    expect(prompt).toContain('use `task retry` with the agent flags. This keeps the task id.');
  });

  it('frames watching and merges as the default and puts the goal above it', () => {
    const prompt = managerSystemPrompt(manager(GOAL), []);
    expect(prompt).toContain('Unless the user\'s goal near the end of this prompt says otherwise, you watch the repositories below');
    expect(prompt).toContain(`What the user wants from you (your goal, which takes precedence over the default role above):\n${GOAL}`);
  });

  it('without a goal keeps the watching role and adds no goal section', () => {
    const prompt = managerSystemPrompt(manager(' '), []);
    expect(prompt).toContain('you watch the repositories below, tell the user what needs them');
    expect(prompt).toContain('and propose merges.');
    expect(prompt).not.toContain('What the user wants from you');
    expect(prompt).not.toContain('near the end of this prompt');
  });
});

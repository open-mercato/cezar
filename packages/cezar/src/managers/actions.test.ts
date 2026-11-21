import { describe, expect, it } from 'vitest';
import { managerActionRequestSchema, managerSchema, type Manager, type ManagerActionRequest } from '@open-mercato/cezar-contract';
import { ACTION_OPS, actionKey, actionOpsFor, actionPin, actionSubject, CARD_CHANGED, describeAction, seenRefusal, UPDATE_TO_APPROVE } from './actions.ts';

const manager = (overrides: Partial<Manager> = {}): Manager => managerSchema.parse({
  id: 'm1', name: 'Scout', instructions: '', avatar: 0, projects: ['alpha'], cronMinutes: 0, jobs: [],
  createdAt: '2026-11-20T00:00:00.000Z', updatedAt: '2026-11-20T00:00:00.000Z', ...overrides,
});

describe('the proposal registry (spec 2026-11-20-manager-admin-actions § 2.1)', () => {
  it('has exactly one op for every proposal type the contract accepts', () => {
    const contractTypes = managerActionRequestSchema.options.map((option) => option.shape.type.value).sort();
    expect(Object.keys(ACTION_OPS).sort()).toEqual(contractTypes);
    for (const [type, op] of Object.entries(ACTION_OPS)) expect(op.type).toBe(type);
  });

  it('pins every existing type to ask: none may ever be approved by a policy', () => {
    for (const op of Object.values(ACTION_OPS)) expect({ type: op.type, risk: op.risk, pinnedAsk: op.pinnedAsk }).toEqual({ type: op.type, risk: 'high', pinnedAsk: true });
  });

  it('keeps the one-card-per-target keys of #2241: a new head, method or revision is a new card for the same subject', () => {
    const merge = (headSha: string, method?: 'squash' | 'merge'): ManagerActionRequest => ({ type: 'merge-pr', projectId: 'alpha', number: 12, headSha, ...(method ? { method } : {}) });
    expect(actionKey(merge('a'))).toBe(actionKey(merge('a')));
    expect(actionKey(merge('a'))).not.toBe(actionKey(merge('b')));
    expect(actionKey(merge('a', 'squash'))).not.toBe(actionKey(merge('a', 'merge')));
    expect(actionSubject(merge('a'))).toBe(actionSubject(merge('b', 'squash')));
    const enable = (revision: number): ManagerActionRequest => ({ type: 'enable-automation', projectId: 'alpha', automationId: 'x', revision });
    expect(actionKey(enable(1))).not.toBe(actionKey(enable(2)));
    expect(actionSubject(enable(1))).toBe(actionSubject(enable(2)));
    expect(actionSubject({ type: 'add-job', name: 'n', prompt: 'p', everyMinutes: 60 })).toBeUndefined();
    expect(actionSubject({ type: 'connector-call', connector: 'c', tool: 't', args: {} })).toBeUndefined();
  });

  it('describes each card in the words the chat notes already use', () => {
    expect(describeAction({ type: 'merge-pr', projectId: 'alpha', number: 12 })).toBe('Merge of alpha#12');
    expect(describeAction({ type: 'enable-automation', projectId: 'alpha', automationId: 'x', name: 'Nightly' })).toBe('Enabling automation Nightly');
    expect(describeAction({ type: 'add-job', name: 'Brief', prompt: 'p', everyMinutes: 60 })).toBe('Adding job Brief');
    expect(describeAction({ type: 'connector-call', connector: 'c', tool: 'send', args: {}, connectorName: 'Gmail' })).toBe('Calling send on Gmail');
  });

  it('refuses merging or enabling on a read-only project, and a connector tool the user denied', () => {
    const readOnly = manager({ access: 'read' });
    expect(ACTION_OPS['merge-pr'].refusal(readOnly, { type: 'merge-pr', projectId: 'alpha', number: 1 })).toContain('read-only');
    expect(ACTION_OPS['enable-automation'].refusal(readOnly, { type: 'enable-automation', projectId: 'alpha', automationId: 'x' })).toContain('read-only');
    expect(ACTION_OPS['connector-call'].refusal(manager(), { type: 'connector-call', connector: 'c', tool: 'send', args: {} })).toContain('not granted');
  });

  describe('actionOpsFor', () => {
    const available = (m: Manager, runner = 'claude', connected: string[] = ['alpha']) => Object.fromEntries(actionOpsFor(m, runner, connected).map((op) => [op.type, op.available]));

    it('offers project proposals only with a write project', () => {
      expect(available(manager())).toMatchObject({ 'merge-pr': true, 'enable-automation': true, 'add-job': true });
      expect(available(manager({ access: 'read' }))).toMatchObject({ 'merge-pr': false, 'enable-automation': false, 'add-job': true });
      expect(available(manager({ access: 'read', projectAccess: { alpha: 'write' } }))).toMatchObject({ 'merge-pr': true });
      expect(available(manager({ projects: 'all', access: 'read', projectAccess: { beta: 'write' } }), 'claude', ['alpha', 'beta'])).toMatchObject({ 'merge-pr': true });
    });

    it('judges the projects it is connected to, not its default access (review nit on #2358)', () => {
      // `all` with write by default, yet every connected project set to read: nothing to merge or enable.
      const allRead = manager({ projects: 'all', access: 'write', projectAccess: { alpha: 'read', beta: 'read' } });
      expect(available(allRead, 'claude', ['alpha', 'beta'])).toMatchObject({ 'merge-pr': false, 'enable-automation': false });
      // An unlisted connected project falls back to write.
      expect(available(allRead, 'claude', ['alpha', 'beta', 'gamma'])).toMatchObject({ 'merge-pr': true });
      expect(actionOpsFor(manager(), 'claude', []).find((op) => op.type === 'merge-pr')).toMatchObject({ available: false, reason: 'this manager is connected to no project' });
    });

    it('offers connector calls only to a Claude manager with a grant that asks', () => {
      const granted = manager({ connectors: { claude_ai_Gmail: { level: 'write' } } });
      expect(available(granted)['connector-call']).toBe(true);
      expect(available(granted, 'codex')['connector-call']).toBe(false);
      expect(available(manager())['connector-call']).toBe(false);
      expect(available(manager({ connectors: { claude_ai_Gmail: { level: 'read', tools: { send: 'ask' } } } }))['connector-call']).toBe(true);
    });

    it('says why an op is unavailable', () => {
      const merge = actionOpsFor(manager({ access: 'read' }), 'claude', ['alpha']).find((op) => op.type === 'merge-pr');
      expect(merge).toMatchObject({ available: false, reason: 'every connected project is read-only for this manager' });
    });
  });

  describe('what the deciding device showed (spec 2026-11-20 § 2.2)', () => {
    const merge: ManagerActionRequest = { type: 'merge-pr', projectId: 'alpha', number: 12, headSha: 'abc' };

    it('fingerprints the stamped action, so any stamped fact changes it', () => {
      expect(actionPin(merge)).toMatch(/^[0-9a-f]{32}$/);
      expect(actionPin({ ...merge })).toBe(actionPin(merge));
      expect(actionPin({ ...merge, headSha: 'abd' })).not.toBe(actionPin(merge));
    });

    it('marks only the types every released cockpit can show', () => {
      for (const op of Object.values(ACTION_OPS)) expect(op.shownByEveryCockpit).toBe(true);
    });

    it('refuses a pin that differs, and a missing one for a type older cockpits cannot show', () => {
      const pin = actionPin(merge);
      const legacy = { shownByEveryCockpit: true as const };
      const newer = {};
      expect(seenRefusal(legacy, pin, pin)).toBeUndefined();
      expect(seenRefusal(newer, pin, pin)).toBeUndefined();
      expect(seenRefusal(legacy, pin, undefined)).toBeUndefined();
      expect(seenRefusal(newer, pin, undefined)).toEqual({ error: UPDATE_TO_APPROVE, status: 409 });
      expect(seenRefusal(legacy, pin, 'other')).toEqual({ error: CARD_CHANGED, status: 409 });
      expect(seenRefusal(newer, pin, 'other')).toEqual({ error: CARD_CHANGED, status: 409 });
      // A card stored before the pin existed: nothing to compare.
      expect(seenRefusal(newer, undefined, undefined)).toBeUndefined();
    });
  });
});

import { describe, expect, it } from 'vitest';
import { managerSchema, type Manager } from '@open-mercato/cezar-contract';
import { autoApprovalCeiling, evaluateAutoApproval, type AutoApprovalCard } from './auto-approve.ts';

const manager = (overrides: Record<string, unknown> = {}): Manager => managerSchema.parse({
  id: 'm1', name: 'Scout', instructions: '', avatar: 0, projects: 'all', cronMinutes: 0, jobs: [],
  createdAt: '2026-11-20T00:00:00.000Z', updatedAt: '2026-11-20T00:00:00.000Z', ...overrides,
});
const eligible: AutoApprovalCard = { type: 'project-config.default-models', risk: 'medium', pinnedAsk: false, turn: 'chat', fullUndo: true };
const rule = { id: 'r1', match: { categories: ['project-settings'], maxRisk: 'medium' }, projects: 'connected', provenance: 'chat' };

describe('auto-approval (spec 2026-11-20-manager-admin-actions § 4)', () => {
  it('always asks in phase 0, even with a stored rule that would match', () => {
    const withRule = manager({ autoApprove: { rules: [rule] } });
    expect(withRule.autoApprove?.rules).toHaveLength(1);
    expect(evaluateAutoApproval(withRule, eligible)).toEqual({ mode: 'ask', why: 'automatic approval is not available yet' });
    expect(evaluateAutoApproval(manager(), eligible)).toEqual({ mode: 'ask', why: 'no rule' });
  });

  it.each([
    [{ pinnedAsk: true }, 'always asks'],
    [{ risk: 'high' as const }, 'high risk'],
    [{ fullUndo: false }, 'cannot be fully undone'],
    [{ turn: 'followup' as const }, 'not asked for in the chat'],
    [{ turn: 'watch' as const }, 'not asked for in the chat'],
    [{ turn: 'job' as const }, 'not asked for in the chat'],
    [{ turn: undefined }, 'not asked for in the chat'],
  ])('the ceiling refuses %j whatever the rules say', (change, why) => {
    expect(autoApprovalCeiling(manager({ autoApprove: { rules: [rule] } }), { ...eligible, ...change })).toBe(why);
  });

  it('the ceiling refuses an inactive manager', () => {
    expect(autoApprovalCeiling(manager({ inactive: { since: '2026-11-20T00:00:00.000Z' } }), eligible)).toBe('manager inactive');
  });

  it('a malformed stored policy is dropped, never the manager', () => {
    const parsed = manager({ autoApprove: { rules: [{ id: '', provenance: 'anything' }] } });
    expect(parsed.id).toBe('m1');
    expect(parsed.autoApprove).toBeUndefined();
  });
});

import { describe, it, expect } from 'vitest';
import { DEFAULT_ACTIONS } from '../../src/actions-v2/default-actions.js';
import type { ActionTrigger } from '../../src/actions-v2/action.js';
import { EFFECT_REGISTRY } from '../../src/actions-v2/effects.js';
import { discoverBuiltinSkills } from '../../src/skills/skill-catalog.js';

/**
 * Catalog drift guard — the TS catalog is the single seed source (Phase 3),
 * so any accidental change to the shipped specs (names, triggers, skill refs,
 * acceptance config) is a behaviour change for every workspace on the next
 * seed. These tests pin the contract.
 */

const VALID_TRIGGERS: ReadonlySet<ActionTrigger> = new Set<ActionTrigger>([
  'manual',
  'on-issue-opened',
  'on-issue-edited',
  'on-issue-reopened',
]);

describe('DEFAULT_ACTIONS catalog', () => {
  it('contains exactly the 2 consolidated actions', () => {
    expect(DEFAULT_ACTIONS.map((a) => a.name)).toEqual(['auto-triage', 'security']);
  });

  it('every action is an enabled built-in issue action with a non-empty prompt', () => {
    for (const action of DEFAULT_ACTIONS) {
      expect(action.kind).toBe('built-in');
      expect(action.target).toBe('issue');
      expect(action.enabled).toBe(true);
      expect(action.systemPrompt.trim().length).toBeGreaterThan(0);
      expect(action.description?.trim().length).toBeGreaterThan(0);
    }
  });

  it('every trigger is a member of the live ActionTrigger union (Phase 4 — no retired triggers)', () => {
    for (const action of DEFAULT_ACTIONS) {
      expect(action.triggers.length).toBeGreaterThan(0);
      for (const trigger of action.triggers) {
        expect(VALID_TRIGGERS.has(trigger), `${action.name}: unknown trigger "${trigger}"`).toBe(
          true,
        );
      }
    }
  });

  it('auto-triage: tool-use mode, open-issues KB, HITL 90/60', () => {
    const autoTriage = DEFAULT_ACTIONS.find((a) => a.name === 'auto-triage')!;
    expect(autoTriage.effects).toBeNull();
    expect(autoTriage.contextRefs).toEqual(['open-issues']);
    expect(autoTriage.triggers).toEqual(['on-issue-opened', 'on-issue-reopened', 'manual']);
    expect(autoTriage.acceptanceMode).toBe('human-in-the-loop');
    expect(autoTriage.confidenceConfig).toEqual({ autoAcceptAbove: 90, autoDenyBelow: 60 });
    // The suggestion target is per-workspace user data — the catalog must
    // never ship one (seeding would clobber the workspace's choice).
    expect(autoTriage.suggestedFlowId ?? null).toBeNull();
  });

  it('security: declared mode with label.add + comment', () => {
    const security = DEFAULT_ACTIONS.find((a) => a.name === 'security')!;
    expect(security.effects).toEqual(['label.add', 'comment']);
    expect(security.triggers).toEqual(['on-issue-opened', 'on-issue-edited', 'manual']);
    expect(security.outputSchema).not.toBeNull();
  });

  it('every skillRef resolves against the shipped built-in skill catalog', async () => {
    const skills = await discoverBuiltinSkills();
    const names = new Set(skills.map((s) => s.name));
    for (const action of DEFAULT_ACTIONS) {
      for (const ref of action.skillRefs) {
        expect(names.has(ref), `${action.name}: skillRef "${ref}" has no built-in skill file`).toBe(
          true,
        );
      }
    }
  });

  it('every declared effect exists in EFFECT_REGISTRY', () => {
    for (const action of DEFAULT_ACTIONS) {
      if (action.effects === null) continue;
      for (const effect of action.effects) {
        expect(effect in EFFECT_REGISTRY, `${action.name}: unknown effect "${effect}"`).toBe(true);
      }
    }
  });

  it('every contextRef is a known provider name', () => {
    // The only provider shipped today; extend when new providers land.
    const known = new Set(['open-issues']);
    for (const action of DEFAULT_ACTIONS) {
      for (const ref of action.contextRefs ?? []) {
        expect(known.has(ref), `${action.name}: unknown contextRef "${ref}"`).toBe(true);
      }
    }
  });
});

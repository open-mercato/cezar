import { describe, expect, it } from 'vitest';

import {
  COPILOT_AUTH_FAILURE_MESSAGE,
  COPILOT_META_KEY,
  copilotDialect,
  copilotParentItem,
  copilotToolName,
  isCopilotAuthFailure,
} from './copilot-ui-mapper.ts';
import { isRuntimeProviderAuthFailure } from './provider-auth.ts';

/**
 * The Copilot ACP dialect's own rules, unit-tested away from the fixtures.
 *
 * Every expectation here is traceable to `.ai/runs/2026-09-27-copilot-cli-runner/
 * copilot-acp-notes.md`, which records what `@github/copilot` 1.0.88 actually emits; the golden
 * fixtures then pin the same rules end to end through the shared mapper.
 */
describe('copilot dialect', () => {
  describe('tool name recovery (ACP carries a title and a kind, never a name)', () => {
    it('recognises `skill` by the one argument the CLI proves is its own', () => {
      expect(copilotToolName({ kind: 'other', rawInput: { skill: 'release-notes' } })).toBe('skill');
    });

    it('recognises `task` — kind `other` plus the delegation argument the agent registry reads', () => {
      expect(copilotToolName({ kind: 'other', rawInput: { description: 'Audit the migrations' } })).toBe('task');
      expect(copilotToolName({ kind: 'other', rawInput: { name: 'auditor', description: 'Audit' } })).toBe('task');
    });

    it('does not mistake a non-`other` kind carrying a description for a delegation', () => {
      // `description` is also the CLI's generic title override, so kind is load-bearing here.
      expect(copilotToolName({ kind: 'execute', rawInput: { description: 'Run the tests' } })).toBe('execute');
    });

    it('reports the ACP kind for everything it cannot identify, rather than guessing', () => {
      expect(copilotToolName({ kind: 'execute', rawInput: { command: 'ls' } })).toBe('execute');
      expect(copilotToolName({ kind: 'read', rawInput: { path: 'a.ts' } })).toBe('read');
      expect(copilotToolName({})).toBe('tool');
      expect(copilotToolName({ kind: '' })).toBe('tool');
    });

    it('never throws on wire garbage', () => {
      for (const update of [{ rawInput: null }, { rawInput: 'text' }, { rawInput: [] }, { kind: 7 }]) {
        expect(() => copilotToolName(update as Record<string, unknown>)).not.toThrow();
      }
    });
  });

  describe('sub-agent attribution', () => {
    it('reads the delegating task call id out of Copilot’s own `_meta` namespace', () => {
      expect(copilotParentItem({ _meta: { [COPILOT_META_KEY]: { agentId: 'call_42' } } })).toBe('call_42');
    });

    it('is absent for the main agent’s own calls, and for anything malformed', () => {
      expect(copilotParentItem({})).toBeUndefined();
      expect(copilotParentItem({ _meta: {} })).toBeUndefined();
      expect(copilotParentItem({ _meta: { [COPILOT_META_KEY]: {} } })).toBeUndefined();
      expect(copilotParentItem({ _meta: { [COPILOT_META_KEY]: { agentId: '' } } })).toBeUndefined();
      expect(copilotParentItem({ _meta: { other: { agentId: 'x' } } })).toBeUndefined();
      expect(copilotParentItem({ _meta: 'nope' })).toBeUndefined();
    });
  });

  describe('tool status', () => {
    it('reads Copilot’s `pending` as running — it is emitted from `tool.execution_start`', () => {
      expect(copilotDialect.toolStatusOf?.({ status: 'pending' }, undefined)).toBe('running');
    });

    it('never regresses a call that already has a later status', () => {
      expect(copilotDialect.toolStatusOf?.({ status: 'pending' }, 'completed')).toBe('completed');
    });

    it('defers to the plain ACP reading for every other status', () => {
      for (const status of ['in_progress', 'completed', 'failed', undefined]) {
        expect(copilotDialect.toolStatusOf?.({ status }, undefined)).toBeUndefined();
      }
    });
  });

  describe('authentication failures', () => {
    it('matches the error Copilot really answers an unauthenticated `session/new` with', () => {
      expect(isCopilotAuthFailure('Authentication required')).toBe(true);
      expect(copilotDialect.errorMessage?.({ code: -32000, message: 'Authentication required' }))
        .toBe(COPILOT_AUTH_FAILURE_MESSAGE);
    });

    it('leaves an unrelated error to the shared mapper’s own wording', () => {
      expect(copilotDialect.errorMessage?.({ code: -32602, message: 'Session abc not found' })).toBeUndefined();
    });

    it('produces a message the server recognises as a runtime auth failure', () => {
      // The latch that raises `provider-auth-required` is a text match, so the dialect's wording
      // is load-bearing: a message it does not match would leave the run failing silently.
      expect(isRuntimeProviderAuthFailure(COPILOT_AUTH_FAILURE_MESSAGE)).toBe(true);
    });
  });

  it('names itself `copilot`, and maps only the delegation tool to a task item', () => {
    expect(copilotDialect.backend).toBe('copilot');
    expect(copilotDialect.toolKindOf?.('task', {})).toBe('task');
    expect(copilotDialect.toolKindOf?.('skill', {})).toBeUndefined();
    expect(copilotDialect.toolKindOf?.('execute', {})).toBeUndefined();
  });
});

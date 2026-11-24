import { describe, expect, it } from 'vitest';
import { chooseTaskAgent, type AccountOption } from './task-agent-choice.ts';

const NOW = Date.parse('2099-01-01T00:00:00.000Z');
const LATER = NOW + 3_600_000;
const SOONER = NOW + 600_000;
const first: AccountOption = { runner: 'claude', agentProfile: 'first', account: 'first', label: 'Work' };
const second: AccountOption = { runner: 'claude', agentProfile: 'second', account: 'second', label: 'Home' };
const automatic: AccountOption = { runner: 'codex', account: 'default', label: 'default account' };
const held = (option: AccountOption, until: number): AccountOption => ({ ...option, until });

describe('chooseTaskAgent', () => {
  it('keeps the list order: the first account with capacity', () => {
    expect(chooseTaskAgent([first, second], { explicitAccount: false, fromSettings: true, now: NOW }))
      .toEqual({ chosen: first, reason: 'default from manager settings: claude Work' });
  });

  it('skips an out-of-limits account for the next one and says so', () => {
    const choice = chooseTaskAgent([held(first, LATER), second], { explicitAccount: false, fromSettings: true, now: NOW });
    expect(choice.chosen).toBe(second);
    expect(choice.reason).toBe('default from manager settings: claude Work out of limits until 2099-01-01T01:00:00.000Z, used claude Home');
    expect(choice.queuedUntil).toBeUndefined();
  });

  it('a hold that already expired is capacity', () => {
    expect(chooseTaskAgent([held(first, NOW - 1), second], { explicitAccount: false, fromSettings: true, now: NOW }).chosen.account).toBe('first');
  });

  it('every account exhausted: the one that resets first, queued', () => {
    const choice = chooseTaskAgent([held(first, LATER), held(second, SOONER)], { explicitAccount: false, fromSettings: true, now: NOW });
    expect(choice.chosen.account).toBe('second');
    expect(choice.queuedUntil).toBe(SOONER);
    expect(choice.reason).toContain('every allowed account is out of limits');
    expect(choice.warning).toBeUndefined();
  });

  it('an explicit account wins; out of limits it queues and names a free allowed one', () => {
    const limited = held(first, LATER);
    const choice = chooseTaskAgent([limited], { explicitAccount: true, fromSettings: true, allowed: [limited, second], now: NOW });
    expect(choice.chosen).toBe(limited);
    expect(choice.queuedUntil).toBe(LATER);
    expect(choice.warning).toBe('claude Work is out of usage limits until 2099-01-01T01:00:00.000Z; claude Home has capacity (--runner claude --account second)');
    expect(chooseTaskAgent([first], { explicitAccount: true, fromSettings: true, allowed: [first, second], now: NOW }))
      .toEqual({ chosen: first, reason: 'explicit --account' });
  });

  it('an explicit account with no free alternative queues without a warning', () => {
    const choice = chooseTaskAgent([held(first, LATER)], { explicitAccount: true, fromSettings: true, allowed: [held(first, LATER), held(second, SOONER)], now: NOW });
    expect(choice.warning).toBeUndefined();
    expect(choice.queuedUntil).toBe(LATER);
  });

  it('the automatic account: no --account in the suggested flags, and Automatic selection named', () => {
    expect(chooseTaskAgent([automatic], { explicitAccount: false, fromSettings: false, now: NOW }))
      .toEqual({ chosen: automatic, reason: 'automatic selection: codex default account' });
    const choice = chooseTaskAgent([held(first, LATER)], { explicitAccount: true, fromSettings: true, allowed: [held(first, LATER), automatic], now: NOW });
    expect(choice.warning).toContain('codex default account has capacity (--runner codex)');
  });

  it('an explicit account whose hold already expired is capacity: no queue, no warning', () => {
    expect(chooseTaskAgent([held(first, NOW - 1)], { explicitAccount: true, fromSettings: true, allowed: [held(first, NOW - 1), second], now: NOW }))
      .toEqual({ chosen: held(first, NOW - 1), reason: 'explicit --account' });
  });

  it('decided: an explicit out-of-limits account with no free alternative queues with no warning (the queue line says it all)', () => {
    const choice = chooseTaskAgent([held(first, LATER)], { explicitAccount: true, fromSettings: true, allowed: [held(first, LATER)], now: NOW });
    expect(choice).not.toHaveProperty('warning');
    expect(choice.reason).toContain('so the task waits in the queue');
  });

  it('automatic selection with its account out of limits queues on it, worded for one account', () => {
    const choice = chooseTaskAgent([held(automatic, LATER)], { explicitAccount: false, fromSettings: false, now: NOW });
    expect(choice.chosen.account).toBe('default');
    expect(choice.queuedUntil).toBe(LATER);
    expect(choice.reason).toBe('automatic selection: codex default account out of limits until 2099-01-01T01:00:00.000Z; the task waits in the queue until it resets');
  });

  it('--runner narrowed to exhausted accounts while another allowed one is free: a truthful reason and a warning', () => {
    const codex: AccountOption = { runner: 'codex', agentProfile: 'work', account: 'work', label: 'Work' };
    const codex2: AccountOption = { runner: 'codex', agentProfile: 'team', account: 'team', label: 'Team' };
    const choice = chooseTaskAgent([held(codex, LATER), held(codex2, SOONER)], {
      explicitAccount: false, fromSettings: true, now: NOW, narrowedBy: '--runner codex',
      allowed: [held(codex, LATER), held(codex2, SOONER), second],
    });
    expect(choice.chosen.account).toBe('team');
    expect(choice.queuedUntil).toBe(SOONER);
    expect(choice.reason).toContain('every allowed account for --runner codex is out of limits');
    expect(choice.reason).not.toContain('every allowed account is');
    expect(choice.warning).toBe('--runner codex has no account with capacity until 2099-01-01T00:10:00.000Z; claude Home has capacity (--runner claude --account second)');
    // Narrowed but every allowed account exhausted too: no alternative to name.
    expect(chooseTaskAgent([held(codex, LATER)], { explicitAccount: false, fromSettings: true, now: NOW, narrowedBy: '--runner codex', allowed: [held(codex, LATER), held(second, LATER)] }))
      .not.toHaveProperty('warning');
  });

  it('refuses an empty candidate list', () => {
    expect(() => chooseTaskAgent([], { explicitAccount: false, fromSettings: true, now: NOW })).toThrow();
  });
});

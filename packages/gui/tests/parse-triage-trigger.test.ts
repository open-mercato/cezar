import { describe, it, expect } from 'vitest';
import { parseTriageTrigger } from '../src/lib/run-triage-pass-job';

describe('parseTriageTrigger', () => {
  it('accepts every known TRIAGE_TRIGGERS string verbatim', () => {
    expect(parseTriageTrigger('on-issue-opened')).toBe('on-issue-opened');
    expect(parseTriageTrigger('on-issue-reopened')).toBe('on-issue-reopened');
    expect(parseTriageTrigger('on-issue-edited')).toBe('on-issue-edited');
  });

  it('falls back to on-issue-opened for an unknown string', () => {
    expect(parseTriageTrigger('sweep')).toBe('on-issue-opened');
    expect(parseTriageTrigger('on-issue-closed')).toBe('on-issue-opened');
    expect(parseTriageTrigger('')).toBe('on-issue-opened');
  });

  it('falls back to on-issue-opened for non-string values', () => {
    expect(parseTriageTrigger(undefined)).toBe('on-issue-opened');
    expect(parseTriageTrigger(null)).toBe('on-issue-opened');
    expect(parseTriageTrigger(42)).toBe('on-issue-opened');
    expect(parseTriageTrigger({ trigger: 'on-issue-edited' })).toBe('on-issue-opened');
    expect(parseTriageTrigger(['on-issue-opened'])).toBe('on-issue-opened');
  });
});

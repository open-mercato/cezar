import { describe, it, expect } from 'vitest';
import { deriveTriageTrigger } from '../src/lib/derive-triage-trigger';

describe('deriveTriageTrigger', () => {
  it('maps reopened to on-issue-reopened', () => {
    expect(deriveTriageTrigger('reopened')).toBe('on-issue-reopened');
  });

  it('maps edited to on-issue-edited', () => {
    expect(deriveTriageTrigger('edited')).toBe('on-issue-edited');
  });

  it('maps opened to on-issue-opened', () => {
    expect(deriveTriageTrigger('opened')).toBe('on-issue-opened');
  });

  it('falls back to on-issue-opened for any other action', () => {
    expect(deriveTriageTrigger('labeled')).toBe('on-issue-opened');
    expect(deriveTriageTrigger('assigned')).toBe('on-issue-opened');
    expect(deriveTriageTrigger('')).toBe('on-issue-opened');
  });
});

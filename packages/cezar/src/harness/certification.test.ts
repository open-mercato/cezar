import { describe, expect, it } from 'vitest';

import { CERTIFICATION_FRESH_MS, certificationFor } from './certification.js';

/**
 * The eval-gate certification layer (spec 2026-08-06-eval-gated-model-routing,
 * Phase 1). A certification is recorded evidence that a binding passed the
 * role-mapped slice of an eval pack's case suite. Cezar only READS it — the
 * certify lane and the setup skill write it — so every malformed shape must
 * degrade to 'uncertified' rather than fail a config load.
 */

const CERT = {
  pack: 'omh',
  catalogVersion: '203@4529-head',
  binding: { family: 'deepseek', model: 'deepseek-v4-pro', adapter: 'preset' },
  roles: { reviewer: { cases: 28, passed: 27 } },
  recordedAt: '2026-08-01T00:00:00.000Z',
  resultDigest: 'a'.repeat(64),
};

const NOW = new Date('2026-08-06T12:00:00.000Z');

describe('certificationFor', () => {
  it('answers uncertified when the config carries nothing for the id', () => {
    expect(certificationFor('deepseek', { models: {} }, NOW)).toEqual({ status: 'uncertified' });
    expect(certificationFor('deepseek', undefined, NOW)).toEqual({ status: 'uncertified' });
    expect(certificationFor('deepseek', { certifications: [] }, NOW)).toEqual({
      status: 'uncertified',
    });
  });

  it('resolves a valid certification with its role rates and provenance', () => {
    const resolved = certificationFor('deepseek', { certifications: { deepseek: CERT } }, NOW);
    expect(resolved.status).toBe('certified');
    expect(resolved.roles?.reviewer).toEqual({ cases: 28, passed: 27 });
    expect(resolved.pack).toBe('omh');
    expect(resolved.catalogVersion).toBe('203@4529-head');
    expect(resolved.recordedAt).toBe('2026-08-01T00:00:00.000Z');
  });

  it('degrades to stale past the freshness window — models move underneath their ids', () => {
    const old = { ...CERT, recordedAt: '2026-01-01T00:00:00.000Z' };
    const resolved = certificationFor('deepseek', { certifications: { deepseek: old } }, NOW);
    expect(resolved.status).toBe('stale');
    // Provenance survives staleness: the chip still says WHAT aged out.
    expect(resolved.roles?.reviewer).toEqual({ cases: 28, passed: 27 });
    expect(resolved.recordedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('flips exactly at the freshness boundary', () => {
    const at = (deltaMs: number) =>
      certificationFor(
        'deepseek',
        {
          certifications: {
            deepseek: { ...CERT, recordedAt: new Date(NOW.getTime() - deltaMs).toISOString() },
          },
        },
        NOW,
      ).status;
    expect(at(CERTIFICATION_FRESH_MS)).toBe('certified');
    expect(at(CERTIFICATION_FRESH_MS + 1)).toBe('stale');
  });

  it('treats a malformed entry as uncertified rather than throwing (config is untrusted)', () => {
    for (const bad of [
      { pack: 42 },
      { ...CERT, roles: {} }, // must cover at least one role
      { ...CERT, resultDigest: 'not-a-digest' },
      { ...CERT, recordedAt: 'yesterday' },
      'deepseek-is-great',
      null,
    ]) {
      expect(certificationFor('deepseek', { certifications: { deepseek: bad } }, NOW)).toEqual({
        status: 'uncertified',
      });
    }
  });

  it('is keyed strictly by binding id — a sibling id never answers for another', () => {
    const resolved = certificationFor('kimi', { certifications: { deepseek: CERT } }, NOW);
    expect(resolved).toEqual({ status: 'uncertified' });
  });
});

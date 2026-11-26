import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectEnvironment } from './backend-detect.ts';
import { GEMINI_DEPRECATION_HINT } from './gemini-ui-mapper.ts';

describe('gemini deprecation hint (#2439)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('labels gemini deprecated and names antigravity, while it stays available', async () => {
    vi.stubEnv('CEZ_DRY_RUN', '1');
    const gemini = (await detectEnvironment()).find((c) => c.name === 'gemini');
    expect(gemini?.available).toBe(true);
    expect(gemini?.hint).toBe(GEMINI_DEPRECATION_HINT);
    expect(gemini?.hint).toMatch(/antigravity/i);
  });

  it('keeps the deprecation hint when gemini is not installed', async () => {
    vi.stubEnv('CEZ_DRY_RUN', '');
    vi.stubEnv('CEZ_GEMINI_BIN', '/nonexistent/gemini-bin');
    const gemini = (await detectEnvironment()).find((c) => c.name === 'gemini');
    expect(gemini?.available).toBe(false);
    expect(gemini?.hint).toContain(GEMINI_DEPRECATION_HINT);
  });
});

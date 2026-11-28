import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detectEnvironment } from './backend-detect.ts';
import { GEMINI_AUTH_HINT, GEMINI_DEPRECATION_HINT } from './gemini-ui-mapper.ts';

describe('gemini deprecation hint (#2439)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('labels gemini deprecated and names antigravity, while it stays available', async () => {
    vi.stubEnv('CEZ_DRY_RUN', '1');
    const gemini = (await detectEnvironment()).find((c) => c.name === 'gemini');
    expect(gemini?.available).toBe(true);
    expect(gemini?.hint).toBe(GEMINI_DEPRECATION_HINT);
    expect(gemini?.deprecated).toBe(GEMINI_DEPRECATION_HINT);
    expect(gemini?.hint).toMatch(/antigravity/i);
  });

  it('keeps the deprecation hint when gemini is not installed', async () => {
    vi.stubEnv('CEZ_DRY_RUN', '');
    vi.stubEnv('CEZ_GEMINI_BIN', '/nonexistent/gemini-bin');
    const gemini = (await detectEnvironment()).find((c) => c.name === 'gemini');
    expect(gemini?.available).toBe(false);
    expect(gemini?.hint).toContain(GEMINI_DEPRECATION_HINT);
    expect(gemini?.deprecated).toBe(GEMINI_DEPRECATION_HINT);
  });

  describe.skipIf(process.platform === 'win32')('when gemini is installed', () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'cez-gemini-detect-'));
      const bin = join(dir, 'gemini');
      writeFileSync(bin, '#!/bin/sh\necho 0.60.0\n');
      chmodSync(bin, 0o755);
      vi.stubEnv('CEZ_DRY_RUN', '');
      vi.stubEnv('CEZ_GEMINI_BIN', bin);
      // An empty gemini home and no credential env: only what each case stubs counts.
      vi.stubEnv('GEMINI_CLI_HOME', dir);
      for (const key of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GEMINI_BASE_URL', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_GENAI_USE_GCA']) {
        vi.stubEnv(key, '');
      }
    });

    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('carries only the deprecation hint when credentials are present', async () => {
      vi.stubEnv('GEMINI_API_KEY', 'test-key');
      const gemini = (await detectEnvironment()).find((c) => c.name === 'gemini');
      expect(gemini?.available).toBe(true);
      expect(gemini?.version).toBe('0.60.0');
      expect(gemini?.hint).toBe(GEMINI_DEPRECATION_HINT);
      expect(gemini?.deprecated).toBe(GEMINI_DEPRECATION_HINT);
    });

    it('joins the deprecation and auth hints when no credentials are found', async () => {
      const gemini = (await detectEnvironment()).find((c) => c.name === 'gemini');
      expect(gemini?.available).toBe(true);
      expect(gemini?.hint).toBe(`${GEMINI_DEPRECATION_HINT} ${GEMINI_AUTH_HINT}`);
      expect(gemini?.deprecated).toBe(GEMINI_DEPRECATION_HINT);
    });
  });
});

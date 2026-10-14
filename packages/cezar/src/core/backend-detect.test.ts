import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { detectEnvironment } from './backend-detect.ts';

vi.mock('./cursor-agent-runner.ts', () => ({
  resolveCursorAgentBin: () => 'agent',
}));

describe('backend-detect probeOpencode', () => {
  const originalDryRun = process.env.CEZ_DRY_RUN;
  const originalBin = process.env.CEZ_OPENCODE_BIN;

  beforeEach(() => {
    delete process.env.CEZ_DRY_RUN;
    delete process.env.CEZ_OPENCODE_BIN;
  });

  afterEach(() => {
    if (originalDryRun !== undefined) process.env.CEZ_DRY_RUN = originalDryRun;
    else delete process.env.CEZ_DRY_RUN;
    if (originalBin !== undefined) process.env.CEZ_OPENCODE_BIN = originalBin;
    else delete process.env.CEZ_OPENCODE_BIN;
  });

  it('detects OpenCode in CEZ_DRY_RUN mode', async () => {
    process.env.CEZ_DRY_RUN = '1';
    const env = await detectEnvironment();
    const opencode = env.find((b) => b.name === 'opencode');
    expect(opencode).toMatchObject({
      name: 'opencode',
      available: true,
      version: 'mock (CEZ_DRY_RUN=1)',
    });
  });

  it('detects installed OpenCode with real version', async () => {
    const env = await detectEnvironment();
    const opencode = env.find((b) => b.name === 'opencode');
    expect(opencode).toBeDefined();
    // In our Windows environment, OpenCode 1.19.0 is installed
    if (opencode?.available) {
      expect(opencode.version).toMatch(/\d+\.\d+/);
    }
  });

  it('reports unavailable with hint when CEZ_OPENCODE_BIN points to non-existent binary', async () => {
    process.env.CEZ_OPENCODE_BIN = 'nonexistent-opencode-binary-xyz-12345';
    const env = await detectEnvironment();
    const opencode = env.find((b) => b.name === 'opencode');
    expect(opencode).toEqual({
      name: 'opencode',
      available: false,
      hint: expect.stringContaining('optional: install OpenCode'),
    });
  });
});

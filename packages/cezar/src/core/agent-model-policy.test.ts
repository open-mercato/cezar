import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { agentModelsLocked } from './agent-model-policy.ts';

describe('agentModelsLocked', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('is off by default and only exact 1 enables it', () => {
    const home = mkdtempSync(join(tmpdir(), 'cez-model-policy-home-'));
    roots.push(home);
    expect(agentModelsLocked(undefined, { CEZ_HOME: home })).toBe(false);
    expect(agentModelsLocked(undefined, { CEZ_HOME: home, CEZ_AGENT_MODELS_LOCKED: '0' })).toBe(false);
    expect(agentModelsLocked(undefined, { CEZ_HOME: home, CEZ_AGENT_MODELS_LOCKED: 'true' })).toBe(false);
    expect(agentModelsLocked(undefined, { CEZ_HOME: home, CEZ_AGENT_MODELS_LOCKED: '1' })).toBe(true);
  });

  it('also accepts the optional repo config flag and degrades malformed files', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'cez-model-policy-'));
    const home = mkdtempSync(join(tmpdir(), 'cez-model-policy-home-'));
    roots.push(repoRoot, home);
    mkdirSync(join(repoRoot, '.ai', 'cezar'), { recursive: true });

    writeFileSync(join(repoRoot, '.ai', 'cezar', 'config.json'), '{"modelsLocked":true}\n');
    expect(agentModelsLocked(repoRoot, { CEZ_HOME: home })).toBe(true);

    writeFileSync(join(repoRoot, '.ai', 'cezar', 'config.json'), '{"modelsLocked":false}\n');
    expect(agentModelsLocked(repoRoot, { CEZ_HOME: home })).toBe(false);

    writeFileSync(join(repoRoot, '.ai', 'cezar', 'config.json'), '{broken');
    expect(agentModelsLocked(repoRoot, { CEZ_HOME: home })).toBe(false);
  });

  it('accepts the global workspace flag for every repository', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'cez-model-policy-'));
    const home = mkdtempSync(join(tmpdir(), 'cez-model-policy-home-'));
    roots.push(repoRoot, home);
    writeFileSync(join(home, 'config.json'), '{"modelsLocked":true}\n');

    expect(agentModelsLocked(repoRoot, { CEZ_HOME: home })).toBe(true);
    expect(agentModelsLocked(undefined, { CEZ_HOME: home })).toBe(true);
  });
});

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RUNNER_IDS } from './agent-runner.ts';
import { detectEnvironment } from './backend-detect.ts';
import { mockCodexPath, resolveCodexExecutable } from './codex-app-server-transport.ts';
import { discoverCodexModels } from './codex-model-catalog.ts';
import { discoverOpencodeModels, mockOpencodePath, resolveOpencodeExecutable } from './opencode-model-catalog.ts';
import { createRunner } from './runner-factory.ts';

// #1898: under CEZ_DRY_RUN=1 no backend may reach a real agent CLI, even one signed in on PATH.
const REAL_BINS = ['claude', 'codex', 'opencode', 'cursor-agent', 'agent', 'pi', 'junie', 'copilot', 'omp', 'agy', 'gemini', 'kimi'];

let root: string;
let stubs: string;
let log: string;
let cwd: string;

const spawnedRealBins = (): string[] => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cez-dry-run-1898-'));
  stubs = join(root, 'bin');
  log = join(root, 'spawned.log');
  cwd = join(root, 'repo');
  for (const dir of [stubs, cwd]) mkdirSync(dir);
  for (const bin of REAL_BINS) {
    const file = join(stubs, bin);
    writeFileSync(file, `#!/bin/sh\necho "${bin} $*" >> "${log}"\nexit 1\n`);
    chmodSync(file, 0o755);
  }
  vi.stubEnv('PATH', `${stubs}${delimiter}${process.env.PATH ?? ''}`);
  vi.stubEnv('CEZ_DRY_RUN', '1');
  for (const key of Object.keys(process.env)) if (/^CEZ_.*_BIN$/.test(key)) vi.stubEnv(key, undefined);
});

beforeEach(() => rmSync(log, { force: true }));

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('CEZ_DRY_RUN=1 never spawns a real agent CLI (#1898)', () => {
  it.each(RUNNER_IDS)('%s: a task runs on the bundled mock', async (id) => {
    await createRunner(id).run({ userPrompt: 'hello from the dry run', cwd });
    expect(spawnedRealBins()).toEqual([]);
  }, 30_000);

  it('the Codex and OpenCode model catalogs answer from the mock', async () => {
    await expect(discoverCodexModels({ cwd })).resolves.toEqual([expect.objectContaining({ id: 'mock-codex' })]);
    await expect(discoverOpencodeModels({ cwd })).resolves.toEqual([expect.objectContaining({ id: 'mock/mock-model' })]);
    expect(spawnedRealBins()).toEqual([]);
  }, 30_000);

  it('no health check spawns a real CLI, and Codex and OpenCode report the mock', async () => {
    const checks = await detectEnvironment();
    for (const name of ['codex', 'opencode']) {
      expect(checks.find((check) => check.name === name)).toMatchObject({ available: true, version: 'mock (CEZ_DRY_RUN=1)' });
    }
    expect(spawnedRealBins()).toEqual([]);
  }, 30_000);

  it('an explicit CEZ_CODEX_BIN / CEZ_OPENCODE_BIN still wins over the mock', () => {
    expect(resolveCodexExecutable()).toBe(mockCodexPath());
    expect(resolveOpencodeExecutable()).toBe(mockOpencodePath());
    expect(existsSync(mockCodexPath()) && existsSync(mockOpencodePath())).toBe(true);
    vi.stubEnv('CEZ_CODEX_BIN', '/host/codex');
    vi.stubEnv('CEZ_OPENCODE_BIN', '/host/opencode');
    try {
      expect(resolveCodexExecutable()).toBe('/host/codex');
      expect(resolveOpencodeExecutable()).toBe('/host/opencode');
    } finally {
      vi.stubEnv('CEZ_CODEX_BIN', undefined);
      vi.stubEnv('CEZ_OPENCODE_BIN', undefined);
    }
  });
});

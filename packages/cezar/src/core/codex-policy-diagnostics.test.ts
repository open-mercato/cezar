import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { planChain } from '../planner.ts';
import { generateRunName } from '../runs/auto-name.ts';
import { generateCommitMessage } from '../workflows/commit-message.ts';

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it('explains tool-policy refusal when planning and naming fall back', async () => {
  vi.stubEnv('CEZ_DRY_RUN', '1');
  vi.stubEnv('CEZ_CODEX_BIN', fileURLToPath(new URL('./__fixtures__/codex/mock-codex-app-server.mjs', import.meta.url)));
  vi.stubEnv('CEZ_AUTONAME', '1');
  const root = mkdtempSync(join(tmpdir(), 'cez-policy-diagnostics-'));
  dirs.push(root);
  mkdirSync(join(root, '.ai/cezar'), { recursive: true });
  writeFileSync(join(root, '.ai/cezar/config.json'), JSON.stringify({ defaultRunner: 'codex' }));
  const plan = await planChain(root, 'check the diff');
  expect(plan.fallback).toBe(true);
  expect(plan.rationale).toContain('tool-policy enforcement unavailable');
  const reasons: string[] = [];
  expect(await generateRunName(root, { task: 'check diff', nameBranch: true, branchNaming: 'feat/' },
    { runner: 'codex', env: {} }, (reason) => reasons.push(reason))).toBeNull();
  expect(reasons).toEqual([expect.stringContaining('tool-policy enforcement unavailable')]);
  expect(await generateCommitMessage(root, { files: [{ status: 'A', path: 'a.ts' }], patch: '+a' }))
    .toEqual({ reason: expect.stringContaining('tool-policy enforcement unavailable') });
}, 15_000);

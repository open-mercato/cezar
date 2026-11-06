import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCliRunner } from '../core/claude-cli-runner.js';
import { sharedHarnessProbeCache } from './probe.js';
import { createProjectProber } from './probe-transports.js';

// readiness probes ran on the default login and shared one cache across projects,
// so a project on its "work" account was certified (or refused) by a login its phases never use.
describe('a project prober probes the account the project selected', () => {
  let home: string;
  let workRepo: string;
  let plainRepo: string;
  const workDir = () => join(home, 'claude-work');

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-probe-accounts-'));
    workRepo = join(home, 'work-repo');
    plainRepo = join(home, 'plain-repo');
    for (const dir of [workRepo, plainRepo, workDir()]) mkdirSync(dir, { recursive: true });
    vi.stubEnv('CEZ_HOME', join(home, '.cezar'));
    mkdirSync(join(home, '.cezar'), { recursive: true });
    writeFileSync(join(home, '.cezar', 'agent-accounts.json'), JSON.stringify({
      version: 1,
      accounts: [{ id: 'work', provider: 'claude', configDir: workDir(), label: 'Work' }],
      selections: { [workRepo]: { claude: 'work' } },
    }));
    sharedHarnessProbeCache.clear();
  });

  afterEach(() => {
    sharedHarnessProbeCache.clear();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
  });

  it('runs the probe on the selected account and never answers another project from its verdict', async () => {
    const run = vi.spyOn(ClaudeCliRunner.prototype, 'run').mockResolvedValue({ text: 'OK', toolCalls: [], tokensUsed: 0 });
    const ref = { runner: 'claude', model: 'sonnet' } as const;

    await expect((await createProjectProber({ repoRoot: workRepo })).probe(ref)).resolves.toMatchObject({ status: 'ready' });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0].env).toMatchObject({ CLAUDE_CONFIG_DIR: workDir() });

    await (await createProjectProber({ repoRoot: plainRepo })).probe(ref);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]![0].env?.CLAUDE_CONFIG_DIR).toBeUndefined();
  });
});

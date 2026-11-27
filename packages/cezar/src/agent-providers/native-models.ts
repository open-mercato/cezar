import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RunnerModelOption } from '@open-mercato/cezar-contract';
import { buildChildEnv } from '../core/agent-env.ts';
import { spawnableCommand } from '../core/windows-shim.ts';

const exec = promisify(execFile);

export function nativeProviderModels(runner: 'pi' | 'omp', stdout: string, stderr: string): RunnerModelOption[] {
  let rows: { provider: string; id: string; name?: string }[] = [];
  if (runner === 'pi') {
    // Non-TTY pi versions may put the whole table on stderr.
    for (const line of (stdout + '\n' + stderr).split(/\r?\n/)) {
      const match = /^([\w.-]+)\s+([\w.:/-]+)\s+[\d.KMG]+\s+[\d.KMG]+\s+(?:yes|no)\s+(?:yes|no)\s*$/i.exec(line.trim());
      if (match) rows.push({ provider: match[1]!, id: match[2]! });
    }
  } else {
    const value: unknown = JSON.parse(stdout);
    if (value && typeof value === 'object' && 'models' in value && Array.isArray(value.models)) {
      rows = value.models.filter(row => row && typeof row.provider === 'string' && typeof row.id === 'string' &&
        (!row.kind || row.kind === 'chat') && (!row.name || typeof row.name === 'string'));
    }
  }
  return rows.slice(0, 5000).map(row => ({ id: row.provider + '/' + row.id, label: row.name ?? row.id, description: '' }));
}

export async function discoverNativeProviderModels(runner: 'pi' | 'omp', cwd: string): Promise<RunnerModelOption[]> {
  if (process.env.CEZ_DRY_RUN === '1') return ['anthropic/claude-test', 'openai-codex/gpt-test'].map(id => ({ id, label: id, description: '' }));
  const bin = (runner === 'pi' ? process.env.CEZ_PI_BIN : process.env.CEZ_OMP_BIN) ?? runner;
  const args = runner === 'pi' ? ['--offline', '--no-extensions', '--list-models'] : ['models', 'ls', '--json', '--no-extensions'];
  const env = buildChildEnv({ backend: runner, extraEnv: { NO_COLOR: '1' } });
  const [program, argv] = spawnableCommand(bin, args, { env });
  const { stdout, stderr } = await exec(program, argv, { cwd, env, timeout: 10_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
  return nativeProviderModels(runner, stdout, stderr);
}

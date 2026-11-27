import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { agentHomePaths } from '../paths.ts';
import { buildChildEnv } from '../core/agent-env.ts';
import { spawnableCommand } from '../core/windows-shim.ts';

const exec = promisify(execFile);
const nativeMethods = ['anthropic', 'openai-codex'] as const;
type PiMethod = typeof nativeMethods[number];
type Observation = 'connected' | 'disconnected' | 'unknown';
const authAnswer = z.object({ provider: z.string(), status: z.string(), authType: z.string().optional() });

/** Pi's model table names providers, but can also be populated by API keys. Its offline auth
 * check reports the effective credential type and never needs to show the credential itself. */
export async function piSubscriptionStatus(method: string, cwd: string, env: NodeJS.ProcessEnv): Promise<Observation> {
  try {
    const args = ['auth', 'check', '--provider', method, '--json', '--no-refresh'];
    const [bin, argv] = spawnableCommand(process.env.CEZ_PI_BIN ?? 'pi', args, { env });
    // Pi exits 1 for a normal not_ready response. Both paths parse metadata only.
    const { stdout, code } = await exec(bin, argv, { cwd, env, timeout: 3000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, windowsHide: true })
      .then(({ stdout }) => ({ code: 0, stdout }))
      .catch((error: unknown) => z.object({ code: z.literal(1), stdout: z.string() }).parse(error));
    const result = authAnswer.parse(JSON.parse(stdout));
    if (result.provider !== method) return 'unknown';
    if (code === 1 && result.status === 'not_ready') return 'disconnected';
    if (code !== 0 || result.status !== 'ready') return 'unknown';
    return result.authType === 'oauth' ? 'connected' : result.authType === 'api_key' ? 'disconnected' : 'unknown';
  } catch { return 'unknown'; }
}

/** One pair of checks per minute on reads of a configured Pi. Each launch verifies independently. */
export function cachedPiSubscriptions(probe = piSubscriptionStatus) {
  let cached: { scope: string; expires: number; result: Promise<Partial<Record<PiMethod, Observation>>> } | undefined;
  return (cwd: string) => {
    const scope = JSON.stringify([cwd, agentHomePaths().pi, process.env.CEZ_PI_BIN]);
    if (cached && cached.scope === scope && cached.expires > Date.now()) return cached.result;
    const env = buildChildEnv({ backend: 'pi' });
    const result = Promise.all(nativeMethods.map(async id => [id, await probe(id, cwd, env)] as const))
      .then(entries => Object.fromEntries(entries));
    cached = { scope, expires: Date.now() + 60_000, result };
    return result;
  };
}

import { defaultRunProviderCommand } from './provider-auth.ts';
import type { ModelOption } from './runner-model-catalog.ts';

export async function discoverPiModels(cwd: string): Promise<ModelOption[]> {
  const result = await defaultRunProviderCommand(
    process.env.CEZ_PI_BIN ?? 'pi',
    ['--list-models'],
    10_000,
    { PWD: cwd },
  );
  if (result.exitCode !== 0 || result.timedOut)
    throw new Error('Pi model discovery failed');
  return parsePiModels(`${result.stdout}\n${result.stderr}`);
}

export function parsePiModels(output: string): ModelOption[] {
  const models = new Map<string, ModelOption>();
  for (const line of output
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
    .split('\n')) {
    const match = /^([a-z0-9][a-z0-9._-]*)\s+(\S+)\s+\d[\d.KMk]*\s+\d/i.exec(
      line.trim(),
    );
    if (!match || match[1] === 'provider') continue;
    const id = `${match[1]}/${match[2]}`;
    models.set(id, { id, label: match[2]!, description: `via ${match[1]}` });
    if (models.size >= 5000) break;
  }
  return [...models.values()];
}

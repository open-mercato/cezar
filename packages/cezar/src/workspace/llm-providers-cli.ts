import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { LlmProviders } from './llm-providers.ts';
import { createLlmProviderSchema } from '@open-mercato/cezar-contract';
import { isRunnerId } from '../core/agent-runner.ts';
import { routeLlmProvider } from '../core/llm-provider-routing.ts';
import { buildChildEnv } from '../core/agent-env.ts';
import { spawnableCommand } from '../core/windows-shim.ts';

export async function runLlmProvidersCommand(args: string[]): Promise<number> {
  const store = new LlmProviders();
  try {
    const separator = args.indexOf('--');
    const { values, positionals } = parseArgs({
      args: separator < 0 ? args : args.slice(0, separator),
      allowPositionals: true,
      options: {
        name: { type: 'string' },
        url: { type: 'string' },
        protocol: { type: 'string', default: 'openai-completions' },
        openrouter: { type: 'boolean' },
        'key-stdin': { type: 'boolean' },
        model: { type: 'string' },
      },
    });
    const [command = 'list', id, runner] = positionals;
    if (command === 'list') {
      console.log(JSON.stringify(await store.list(), null, 2));
      return 0;
    }
    if (command === 'add') {
      if (!values['key-stdin'] || process.stdin.isTTY)
        throw new Error(
          'Pipe the API key to stdin with --key-stdin; keys are never accepted as command-line arguments.',
        );
      let apiKey = '';
      for await (const chunk of process.stdin) {
        apiKey += String(chunk);
        if (Buffer.byteLength(apiKey) > 16384)
          throw new Error('API key exceeds 16 KiB');
      }
      const provider = await store.add(
        createLlmProviderSchema.parse({
          kind: values.openrouter ? 'openrouter' : 'custom',
          name: values.name ?? (values.openrouter ? 'OpenRouter' : ''),
          baseUrl: values.openrouter
            ? 'https://openrouter.ai/api/v1'
            : values.url,
          protocol: values.protocol,
          apiKey: apiKey.trim(),
        }),
      );
      console.log(JSON.stringify(provider, null, 2));
      return 0;
    }
    if (!id) throw new Error('A provider id is required');
    if (command === 'remove') {
      await store.remove(id);
      return 0;
    }
    if (command === 'models') {
      console.log(JSON.stringify(await store.models(id), null, 2));
      return 0;
    }
    if (command === 'exec') {
      if (!runner || !isRunnerId(runner))
        throw new Error(
          'Choose a supported agent: claude, codex, pi, opencode, copilot or junie',
        );
      const spec = routeLlmProvider(runner, {
        cwd: process.cwd(),
        userPrompt: '',
        model: values.model,
        llmProvider: await store.resolve(id, runner),
      });
      const env = buildChildEnv({ backend: runner, extraEnv: spec.env });
      const nativeArgs = separator < 0 ? [] : args.slice(separator + 1);
      if (
        nativeArgs.some((arg) =>
          [
            '--model',
            '-m',
            '--provider',
            '--config',
            '-c',
            '--config-dir',
            '--model-location',
            '--model-default-locations',
          ].some((flag) => arg === flag || arg.startsWith(`${flag}=`)),
        )
      )
        throw new Error(
          'Pass model and provider through cezar; native routing overrides are not accepted.',
        );
      const [file, argv] = spawnableCommand(runner, [
        ...nativeArgs,
        '--model',
        spec.model!,
      ]);
      return await new Promise<number>((resolve, reject) => {
        const child = spawn(file, argv, {
          cwd: spec.cwd,
          env,
          stdio: 'inherit',
        });
        child.once('error', () =>
          reject(new Error(`Could not start ${runner}`)),
        );
        child.once('exit', (code) => resolve(code ?? 1));
      });
    }
    throw new Error(
      'Usage: cez llm-providers list | add --openrouter --key-stdin | models <id> | remove <id> | exec <id> <runner> --model <model> [-- native arguments]',
    );
  } catch (error) {
    // Schema failures contain input values in some Zod versions; never echo credential input.
    console.error(
      error instanceof Error && error.name !== 'ZodError'
        ? error.message
        : 'Invalid provider settings. Check the name, API URL, protocol and key.',
    );
    return 1;
  }
}

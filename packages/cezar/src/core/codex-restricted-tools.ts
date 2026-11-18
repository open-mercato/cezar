import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { AgentRunSpec } from './agent-runner.ts';
import { codexBashArgv, type CodexRestrictedPolicy } from './codex-restricted-policy.ts';

const path = z.string().min(1).max(4_096);
const requestSchema = z.discriminatedUnion('tool', [
  z.object({ tool: z.literal('Read'), path, offset: z.number().int().min(1).max(1_000_000).optional(), limit: z.number().int().min(1).max(2_000).optional() }).strict(),
  z.object({ tool: z.literal('Grep'), pattern: z.string().max(4_096), path: path.optional(), glob: z.string().max(512).optional() }).strict(),
  z.object({ tool: z.literal('Glob'), pattern: z.string().max(512), path: path.optional() }).strict(),
  z.object({ tool: z.literal('Bash'), command: z.string().max(16_000) }).strict(),
]);

export const CODEX_READ_TOOL = {
  type: 'function', name: 'cezar_read',
  description: 'Read-only tools enforced by cezar. Use Read for files, Grep for content, Glob for file names, Bash for a single approved git/GitHub read command. Native shell and write tools are denied. No pipelines, shell syntax, writes, browser, pushes or GitHub mutations.',
  inputSchema: z.toJSONSchema(requestSchema),
};

export type CodexReadResult = { success: boolean; contentItems: Array<{ type: 'inputText'; text: string }> };
const result = (success: boolean, text: string): CodexReadResult => ({ success, contentItems: [{ type: 'inputText', text: text.slice(0, 64_000) }] });

export class CodexReadBroker {
  private readonly allowedRoots: Promise<string[]>;
  private readonly cwd: Promise<string>;
  private readonly aborter = new AbortController();

  constructor(private readonly policy: CodexRestrictedPolicy, spec: Pick<AgentRunSpec, 'cwd' | 'additionalDirectories'>, private readonly env: NodeJS.ProcessEnv) {
    this.cwd = realpath(spec.cwd);
    this.allowedRoots = Promise.all([spec.cwd, ...(spec.additionalDirectories ?? [])].map(async p => realpath(p).catch(() => undefined)))
      .then(paths => paths.filter((p): p is string => p !== undefined));
  }

  close(): void { this.aborter.abort(); }

  private async allowedPath(path: string): Promise<string> {
    const absolute = await realpath(resolve(await this.cwd, path));
    const roots = await this.allowedRoots;
    if (!roots.some(root => {
      const rel = relative(root, absolute);
      return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
    })) throw new Error('path is outside this step’s read roots');
    return absolute;
  }

  private async execute(argv: readonly string[]): Promise<string> {
    if (this.aborter.signal.aborted) throw new Error('session is closed');
    const cwd = await this.cwd;
    const [bin, ...args] = argv;
    return new Promise((done, fail) => {
      // stdin is closed; there is no shell, PTY or reusable interactive process.
      const child = execFile(bin!, args, { cwd, env: this.env, timeout: 15_000, maxBuffer: 256_000, encoding: 'utf8', signal: this.aborter.signal }, (err, stdout, stderr) => {
        if (err && !(bin === 'rg' && 'code' in err && err.code === 1)) fail(new Error(stderr.trim().slice(0, 2_000) || `read command failed (${err.message.slice(0, 200)})`));
        else done(stdout);
      });
      child.stdin?.end();
    });
  }

  async call(params: Record<string, unknown>): Promise<CodexReadResult> {
    try {
      if (this.aborter.signal.aborted) throw new Error('session is closed');
      if (params.tool !== CODEX_READ_TOOL.name || (params.namespace !== undefined && params.namespace !== null)) throw new Error('tool is not granted');
      const input = requestSchema.parse(params.arguments);
      if (!this.policy.tools.has(input.tool)) throw new Error(`${input.tool} is not granted`);
      switch (input.tool) {
        case 'Read': {
          const file = await open(await this.allowedPath(input.path), constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const stat = await file.stat();
            if (!stat.isFile() || stat.size > 2_000_000) throw new Error('Read requires a regular file of at most 2 MB');
            const text = await file.readFile('utf8');
            return result(true, text.split('\n').slice((input.offset ?? 1) - 1, (input.offset ?? 1) - 1 + (input.limit ?? 500)).join('\n'));
          } finally { await file.close(); }
        }
        case 'Grep': {
          const target = await this.allowedPath(input.path ?? '.');
          const argv = ['rg', '--no-config', '--line-number', '--max-count', '200', ...(input.glob ? ['--glob', input.glob] : []), '--', input.pattern, target];
          return result(true, await this.execute(argv));
        }
        case 'Glob': {
          const target = await this.allowedPath(input.path ?? '.');
          return result(true, await this.execute(['rg', '--no-config', '--files', '--glob', input.pattern, '--', target]));
        }
        case 'Bash': {
          const argv = codexBashArgv(input.command, this.policy);
          if (!argv) throw new Error('command is outside this step’s approved read-only Bash grant');
          return result(true, await this.execute(argv));
        }
      }
    } catch (err) {
      return result(false, `cezar denied or could not complete this read: ${err instanceof z.ZodError ? 'invalid tool arguments' : err instanceof Error ? err.message : String(err)}`);
    }
  }
}

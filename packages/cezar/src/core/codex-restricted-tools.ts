import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { AgentRunSpec } from './agent-runner.ts';
import { codexBashArgv, codexGithubOperands, type CodexRestrictedPolicy } from './codex-restricted-policy.ts';

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
  inputSchema: z.toJSONSchema(z.object({
    tool: z.enum(['Read', 'Grep', 'Glob', 'Bash']), path: path.nullable(),
    offset: z.number().int().nullable(), limit: z.number().int().nullable(),
    pattern: z.string().nullable(), glob: z.string().nullable(), command: z.string().nullable(),
  }).strict()),
};

export type CodexReadResult = { success: boolean; contentItems: Array<{ type: 'inputText'; text: string }> };
const RESULT_CAP = 64_000;
const TRUNCATED = '\n[cezar: output truncated; narrow the pattern, path or range]';
const result = (success: boolean, text: string): CodexReadResult => ({
  success, contentItems: [{ type: 'inputText', text: text.length > RESULT_CAP ? text.slice(0, RESULT_CAP) + TRUNCATED : text }],
});

export class CodexReadBroker {
  private readonly allowedRoots: Promise<string[]>;
  private readonly cwd: Promise<string>;
  private readonly aborter = new AbortController();

  constructor(private readonly policy: CodexRestrictedPolicy, spec: Pick<AgentRunSpec, 'cwd' | 'additionalDirectories'>, private readonly env: NodeJS.ProcessEnv, private readonly githubReadsAllowed = true) {
    this.cwd = realpath(spec.cwd);
    void this.cwd.catch(() => {});
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

  private async execute(argv: readonly string[], truncate = true): Promise<string> {
    if (this.aborter.signal.aborted) throw new Error('session is closed');
    const cwd = await this.cwd;
    const [bin, ...args] = argv;
    return new Promise((done, fail) => {
      // stdin is closed; there is no shell, PTY or reusable interactive process.
      const child = execFile(bin!, args, { cwd, env: this.env, timeout: 15_000, maxBuffer: 256_000, encoding: 'utf8', signal: this.aborter.signal }, (err, stdout, stderr) => {
        // Over the buffer cap the child is killed; model-facing output keeps what arrived, validation reads fail.
        if (truncate && err && 'code' in err && err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') done(stdout + TRUNCATED);
        else if (err && !(bin === 'rg' && 'code' in err && err.code === 1)) fail(new Error(stderr.trim().slice(0, 2_000) || `read command failed (${err.message.slice(0, 200)})`));
        else done(stdout);
      });
      child.stdin?.end();
    });
  }

  private pending = 0;
  async call(params: Record<string, unknown>): Promise<CodexReadResult> {
    if (this.pending >= 4) return result(false, 'cezar: at most four read operations may run at once');
    this.pending++;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([this.perform(params), new Promise<CodexReadResult>(done => {
        timer = setTimeout(() => { this.close(); done(result(false, 'cezar: read timed out; this broker is closed')); }, 20_000);
        timer.unref?.();
      })]);
    } finally { if (timer) clearTimeout(timer); this.pending--; }
  }

  private async perform(params: Record<string, unknown>): Promise<CodexReadResult> {
    try {
      if (this.aborter.signal.aborted) throw new Error('session is closed');
      if (params.tool !== CODEX_READ_TOOL.name || (params.namespace !== undefined && params.namespace !== null)) throw new Error('tool is not granted');
      const raw = params.arguments;
      const nullable = new Set(['path', 'offset', 'limit', 'pattern', 'glob', 'command']);
      const args = raw && typeof raw === 'object' && !Array.isArray(raw)
        ? Object.fromEntries(Object.entries(raw).filter(([key, value]) => value !== null || !nullable.has(key))) : raw;
      const input = requestSchema.parse(args);
      if (!this.policy.tools.has(input.tool)) throw new Error(`${input.tool} is not granted`);
      switch (input.tool) {
        case 'Read': {
          const target = await this.allowedPath(input.path);
          // Windows has no O_NOFOLLOW; the path is already realpath-resolved, this refuses a link swapped in since.
          if (constants.O_NOFOLLOW === undefined && (await lstat(target)).isSymbolicLink()) throw new Error('Read requires a regular file of at most 2 MB');
          const file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
          try {
            const stat = await file.stat();
            if (!stat.isFile() || stat.size > 2_000_000) throw new Error('Read requires a regular file of at most 2 MB');
            const buffer = Buffer.alloc(stat.size);
            const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
            const text = buffer.subarray(0, bytesRead).toString('utf8');
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
          if (argv[0] === 'gh') {
            if (!this.githubReadsAllowed) throw new Error('GitHub reads are disabled by CEZ_CODEX_NETWORK=0');
            const hosts = new Set(['github.com', (this.env.GH_HOST ?? 'github.com').toLowerCase()]);
            const repository = (value: string): void => {
              if (/^https?:\/\//i.test(value)) {
                const url = new URL(value);
                if (url.protocol === 'https:' && !url.username && !url.password && !url.port && hosts.has(url.hostname.toLowerCase())) return;
              } else {
                const parts = value.split('/');
                if (parts.length === 3 && hosts.has(parts[0]!.toLowerCase())) parts.shift();
                if (parts.length === 2 && parts.every(p => /^[A-Za-z0-9_.-]+$/.test(p))) return;
              }
              throw new Error('GitHub repository host is not granted');
            };
            let explicit = false;
            for (let i = 3; i < argv.length; i++) if (argv[i] === '--repo' || argv[i] === '-R') {
              repository(argv[++i]!); explicit = true;
            }
            const operands = codexGithubOperands(argv);
            if (operands.length > 1) throw new Error('unsupported GitHub operands');
            for (const operand of operands) {
              if (argv[1] === 'repo' || /^https?:\/\//i.test(operand)) { repository(operand); explicit = true; }
              else if (!/^[A-Za-z0-9_.-]+$/.test(operand)) throw new Error('unsupported GitHub operand');
            }
            if (!explicit) {
              // gh can infer an enterprise host from ANY resolved Git remote, including URL rewrites.
              const remotes = await this.execute(['git', 'remote', '-v'], false);
              const urls = remotes.trim().split('\n').filter(Boolean).map(line => line.split(/\s+/)[1]!);
              if (!urls.length) throw new Error('GitHub reads need an explicit --repo or a configured GitHub remote');
              for (const remote of urls) {
                const scp = /^[^@/]+@([^:/]+):(.+)$/.exec(remote);
                if (scp) repository(`${scp[1]}/${scp[2]}`);
                else repository(remote);
              }
            }
          }
          return result(true, await this.execute(argv));
        }
      }
    } catch (err) {
      return result(false, `cezar denied or could not complete this read: ${err instanceof z.ZodError ? 'invalid tool arguments' : err instanceof Error ? err.message : String(err)}`);
    }
  }
}

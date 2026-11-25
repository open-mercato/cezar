import { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { accessSync, constants, constants as fsConstants, statSync } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, posix, relative, resolve, sep, win32 } from 'node:path';
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

/** The tool a session's model sees: a manager's shell is described by the manager. */
export function codexReadTool(policy: CodexRestrictedPolicy): typeof CODEX_READ_TOOL {
  if (!policy.shell) return CODEX_READ_TOOL;
  return { ...CODEX_READ_TOOL, description: `Tools enforced by cezar. Use Read for files, Grep for content, Glob for file names, Bash for one command: ${policy.shell.describe} Native shell and write tools are denied; cezar refuses every other command and any other shell syntax.` };
}

const SHELL_TIMEOUT_MS = 120_000;
// The read path's guard (`codexBashArgv`); a newline stays legal for a heredoc body.
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f]/;
const SHELL_OUTPUT_CAP = 256_000;
// A detached Windows child gets its own console window and has no process group to signal.
const STAGE_GROUPS = process.platform !== 'win32';
const STDERR_CAP = 16_000;

/** `taskkill` by absolute path: a bare name is looked up in the current directory (the repo) first. */
export function taskkillPath(env: NodeJS.ProcessEnv = process.env): string {
  return win32.join(env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'taskkill.exe');
}

/** How a running stage and what it forked are killed: its process group on POSIX, `taskkill /T` on Windows. */
export function stageKillPlan(pid: number, platform: NodeJS.Platform = process.platform): { group: number } | { taskkill: { file: string; args: string[] } } {
  return platform === 'win32' ? { taskkill: { file: taskkillPath(), args: ['/pid', String(pid), '/T', '/F'] } } : { group: -pid };
}

export interface StageKillDeps {
  platform?: NodeJS.Platform;
  spawn?: typeof spawn;
  spawnSync?: typeof spawnSync;
  killGroup?: (group: number) => void;
}

const exited = (child: ChildProcess): boolean => child.exitCode !== null || child.signalCode !== null;
const killGroup = (group: number): void => { try { process.kill(group, 'SIGKILL'); } catch { /* the group is gone */ } };

const TASKKILL_TIMEOUT_MS = 5_000;
// Deduplicate async taskkill calls to narrow the pid reuse window.
const pendingKills = new WeakSet<ChildProcess>();
const hardKill = (child: ChildProcess): void => { try { child.kill('SIGKILL'); } catch { /* already gone */ } };

/**
 * Kills a stage and what it forked. Never throws: it runs from timers, listeners and `finish()`.
 *
 * A stage that already exited is never targeted by pid: a reaped pid (and an emptied group) may
 * belong to someone else by now; on POSIX its leftovers were killed as it exited (`onStageExit`).
 *
 * Windows has no process group and Node no job object, so `taskkill /T` walks the live stage's
 * tree. An async `taskkill` can hit a reused pid if the stage exits while it starts. Server exit
 * uses `spawnSync`, which blocks the event loop and keeps the stage's handle open.
 * The reader-quit path uses `tree: false`, killing the writer by handle and leaving all of its
 * descendants alive.
 */
export function killStage(child: ChildProcess, opts: { sync?: boolean; tree?: boolean } & StageKillDeps = {}): void {
  if (!child.pid || exited(child) || opts.tree === false) { hardKill(child); return; }
  const plan = stageKillPlan(child.pid, opts.platform);
  if ('group' in plan) {
    try { (opts.killGroup ?? killGroup)(plan.group); } catch { /* the group is gone */ }
    hardKill(child);
    return;
  }
  // Dormant in production while codex-app-server-runner.ts refuses restricted Codex on Windows.
  const { file, args } = plan.taskkill;
  if (opts.sync) {
    try { (opts.spawnSync ?? spawnSync)(file, args, { stdio: 'ignore', windowsHide: true, timeout: TASKKILL_TIMEOUT_MS }); } catch { /* fall through */ }
    hardKill(child);
    return;
  }
  if (pendingKills.has(child)) return;
  pendingKills.add(child);
  let after = false;
  let bound: NodeJS.Timeout | undefined;
  const then = () => {
    if (after) return;
    after = true;
    if (bound) clearTimeout(bound);
    pendingKills.delete(child);
    hardKill(child);
  };
  // A taskkill that never returns must not keep the stage alive.
  bound = setTimeout(then, TASKKILL_TIMEOUT_MS);
  bound.unref?.();
  try {
    (opts.spawn ?? spawn)(file, args, { stdio: 'ignore', windowsHide: true, timeout: TASKKILL_TIMEOUT_MS }).on('exit', then).on('error', then);
  } catch {
    then();
  }
}

/** Whether a kill of this stage is still in flight (Windows `taskkill`). */
export function stageKillPending(child: ChildProcess): boolean {
  return pendingKills.has(child);
}

/**
 * POSIX: the moment a stage is reaped, kill whatever it left in its group (a forked grandchild
 * still holding its pipe). The group id stays reserved only while a member lives; when the stage
 * left nothing behind, this signals a just-freed id in the same tick as the reap — an accepted,
 * negligible race (it needs pid wraparound plus a `setsid` in that tick).
 *
 * Windows: nothing. Node has already closed the stage's handle and freed its pid, so a child it
 * left holding stdout is out of reach: that call settles at its timeout and the child is not killed.
 */
export function onStageExit(child: ChildProcess, deps: Pick<StageKillDeps, 'platform' | 'killGroup'> = {}): void {
  if ((deps.platform ?? process.platform) === 'win32' || !child.pid) return;
  try { (deps.killGroup ?? killGroup)(-child.pid); } catch { /* the group is gone */ }
}

// Detached stages miss the server's Ctrl-C and outlive its timers; a clean stop or a crash
// ('exit' fires for both) takes them down. A SIGKILLed server cannot, and their timeout dies with it.
// A stage leaves this set when it closes, not when its call settles: a kill still in flight is covered.
const liveStages = new Set<ChildProcess>();
let exitHookInstalled = false;
export function killLiveStages(): void {
  for (const child of liveStages) killStage(child, { sync: true });
  liveStages.clear();
}
export function liveStageCount(): number {
  return liveStages.size;
}

/**
 * A program's absolute path from the absolute PATH entries only. A bare name would otherwise be
 * looked up in the working directory first on Windows (a hostile branch's `rg.exe`), and a relative
 * PATH entry (`.`) does the same anywhere.
 */
export function resolveProgram(bin: string, env: Record<string, string | undefined>, platform: NodeJS.Platform = process.platform): string | undefined {
  const windows = platform === 'win32';
  const paths = windows ? win32 : posix;
  if (paths.isAbsolute(bin)) return bin;
  if (bin.includes('/') || bin.includes('\\')) return undefined;
  const search = env.PATH ?? env.Path ?? '';
  const extensions = windows ? [...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean), ''] : [''];
  for (const entry of search.split(windows ? ';' : ':')) {
    const dir = windows ? entry.replace(/^"(.*)"$/, '$1') : entry;
    if (!paths.isAbsolute(dir)) continue;
    for (const extension of extensions) {
      const candidate = paths.join(dir, bin + extension);
      try {
        if (statSync(candidate).isFile()) { accessSync(candidate, fsConstants.X_OK); return candidate; }
      } catch { /* not here */ }
    }
  }
  return undefined;
}

/** The longest prefix that does not end in a UTF-8 sequence a byte cap cut short. */
export function wholeUtf8(buffer: Buffer): Buffer {
  let index = buffer.length - 1;
  let continuation = 0;
  while (index >= 0 && continuation < 3 && (buffer[index]! & 0xc0) === 0x80) { index--; continuation++; }
  if (index < 0) return buffer;
  const lead = buffer[index]!;
  const needs = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return needs > continuation + 1 ? buffer.subarray(0, index) : buffer;
}

export interface PipelineOptions {
  cwd: string;
  env: Record<string, string | undefined>;
  signal: AbortSignal;
  /** Defaults to `SHELL_TIMEOUT_MS`; tests shorten it. */
  timeoutMs?: number;
  /** Tests inject a spawn that fails; production uses node's. */
  spawn?: typeof spawn;
  /** Program lookup; defaults to `resolveProgram` over the stage env's absolute PATH entries. */
  resolve?: (bin: string) => string | undefined;
}

export const PIPELINE_REFUSED = 'cezar: refused a command with an empty stage or a control character';

/**
 * Spawns a vetted argv pipeline with no shell: what the verifier read is exactly what runs. Settles
 * exactly once — on the last stage's close, the timeout, the output cap, an abort or a stage that
 * cannot start — and each stage leads its own process group, so a kill also reaches what it forked.
 */
export function runPipeline(pipeline: readonly string[][], stdin: string | undefined, opts: PipelineOptions): Promise<{ ok: boolean; text: string }> {
  const env = Object.fromEntries(Object.entries(opts.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  // Everything spawn could refuse synchronously is refused here, before any stage starts.
  const invalid = !pipeline.length || pipeline.some((stage) => !stage.length || stage.some((arg) => typeof arg !== 'string' || CONTROL.test(arg)))
    || (stdin !== undefined && (typeof stdin !== 'string' || /\0/.test(stdin)));
  if (invalid) return Promise.resolve({ ok: false, text: PIPELINE_REFUSED });
  // Every program by absolute path, resolved before anything starts.
  const lookup = opts.resolve ?? ((bin: string) => resolveProgram(bin, env));
  const resolved: string[][] = [];
  for (const [bin, ...args] of pipeline) {
    const path = lookup(bin!);
    if (!path) return Promise.resolve({ ok: false, text: `cezar: \`${bin}\` was not found on PATH` });
    resolved.push([path, ...args]);
  }
  const start = opts.spawn ?? spawn;
  const timeoutMs = opts.timeoutMs ?? SHELL_TIMEOUT_MS;
  return new Promise((done) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let truncated = false;
    let errTruncated = false;
    let failure: string | undefined;
    let open = pipeline.length;
    let code: number | null = null;
    let settled = false;
    const children: ChildProcess[] = [];
    const killOne = (child: ChildProcess, tree = true) => killStage(child, { tree });
    const killAll = () => { for (const child of children) killOne(child); };
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal.removeEventListener('abort', onAbort);
      // Nothing here may stop `done` below: settled is already true, so a throw would hang the call.
      try {
        killAll();
        // Release pipes a surviving grandchild may hold, so nothing keeps this call's streams open.
        for (const child of children) for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy();
      } catch { /* the stages are being torn down either way */ }
      // A cap cuts bytes; never leave half a character (U+FFFD) in front of the marker.
      const stdoutBytes = Buffer.concat(out);
      const text = (truncated ? wholeUtf8(stdoutBytes) : stdoutBytes).toString('utf8') + (truncated ? TRUNCATED : '');
      const stderrBytes = Buffer.concat(err);
      const errText = (errTruncated ? wholeUtf8(stderrBytes) : stderrBytes).toString('utf8').trim();
      // Over the cap is the read path's truncation, not a failure: cezar stopped it, the command did not fail.
      const ok = !failure && (truncated || code === 0);
      const detail = [text, errText && `[stderr]\n${errText}`, failure, !ok && !failure ? `[exit ${code ?? 'signal'}]` : ''].filter(Boolean).join('\n');
      done({ ok, text: detail || '(no output)' });
    };
    const onAbort = () => { failure ??= 'session is closed'; finish(); };
    // Armed before the first spawn, and it settles on its own: a 'close' a grandchild blocks never comes.
    const timer = setTimeout(() => { failure ??= `command timed out after ${timeoutMs / 1000}s`; finish(); }, timeoutMs);
    timer.unref?.();
    if (opts.signal.aborted) { onAbort(); return; }
    opts.signal.addEventListener('abort', onAbort, { once: true });
    let stage = 0;
    try {
      for (; stage < pipeline.length; stage++) {
        const [bin, ...args] = resolved[stage]!;
        const child = start(bin!, args, { cwd: opts.cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'], detached: STAGE_GROUPS, windowsHide: true });
        children.push(child);
        liveStages.add(child);
        child.once('close', () => liveStages.delete(child));
        child.once('exit', () => onStageExit(child));
        if (!exitHookInstalled) { exitHookInstalled = true; process.on('exit', killLiveStages); }
        // Listen at once: a child that fails below still emits 'error' a tick later, and unheard it crashes the server.
        child.on('error', (error) => { failure ??= `${pipeline[children.indexOf(child)]![0]}: ${error.message.slice(0, 200)}`; });
        // EMFILE/ENFILE: node returns a child without stdio and reports the error a tick later.
        if (!child.stdin || !child.stdout || !child.stderr) throw new Error('no stdio (out of file descriptors?)');
      }
    } catch (error) {
      failure = `cezar: could not start ${pipeline[stage]?.[0] ?? 'the command'}: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`;
      finish();
      return;
    }
    children.forEach((child, index) => {
      const next = children[index + 1];
      if (next) child.stdout!.pipe(next.stdin!).on('error', () => {});
      else child.stdout!.on('data', (chunk: Buffer) => {
        if (truncated) return;
        const room = SHELL_OUTPUT_CAP - outBytes;
        out.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
        outBytes += Math.min(chunk.length, room);
        if (chunk.length > room) { truncated = true; finish(); }
      });
      child.stderr!.on('data', (chunk: Buffer) => {
        const room = STDERR_CAP - errBytes;
        if (room <= 0) return;
        if (chunk.length > room) errTruncated = true;
        err.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
        errBytes += Math.min(chunk.length, room);
      });
      child.stdin!.on('error', () => {});
      child.on('close', (exit) => {
        if (!next) code = exit;
        // A shell's SIGPIPE: a reader that quit (`| head`) ends the writers before it, or they block on a full pipe.
        for (const upstream of children.slice(0, index)) if (upstream.exitCode === null && upstream.signalCode === null) killOne(upstream, process.platform !== 'win32');
        if (--open === 0) finish();
      });
    });
    const first = children[0]!.stdin!;
    if (stdin !== undefined) first.end(stdin); else first.end();
  });
}

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

  constructor(
    private readonly policy: CodexRestrictedPolicy,
    spec: Pick<AgentRunSpec, 'cwd' | 'additionalDirectories'>,
    private readonly env: NodeJS.ProcessEnv,
    private readonly githubReadsAllowed = true,
    /** Tests shorten both; the backstop only fires when the command's own timeout failed to. */
    private readonly limits: { shellTimeoutMs?: number; backstopMs?: number } = {},
  ) {
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
    const [name, ...args] = argv;
    const bin = resolveProgram(name!, this.env);
    if (!bin) throw new Error(`\`${name}\` was not found on PATH`);
    return new Promise((done, fail) => {
      // stdin is closed; there is no shell, PTY or reusable interactive process.
      const child = execFile(bin!, args, { cwd, env: this.env, timeout: 15_000, maxBuffer: 256_000, encoding: 'utf8', signal: this.aborter.signal }, (err, stdout, stderr) => {
        // Over the buffer cap the child is killed; model-facing output keeps what arrived, validation reads fail.
        if (truncate && err && 'code' in err && err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') done(stdout + TRUNCATED);
        else if (err && !(name === 'rg' && 'code' in err && err.code === 1)) fail(new Error(stderr.trim().slice(0, 2_000) || `read command failed (${err.message.slice(0, 200)})`));
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
    // A manager command has its own timeout; this backstop only fires if that one fails.
    const limit = this.limits.backstopMs ?? (this.policy.shell ? (this.limits.shellTimeoutMs ?? SHELL_TIMEOUT_MS) + 10_000 : 20_000);
    try {
      return await Promise.race([this.perform(params), new Promise<CodexReadResult>(done => {
        timer = setTimeout(() => { this.close(); done(result(false, 'cezar: read timed out; this broker is closed')); }, limit);
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
          const file = await open(await this.allowedPath(input.path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
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
          if (this.policy.shell) {
            if (CONTROL.test(input.command)) throw new Error('cezar manager policy: a control character');
            const plan = this.policy.shell.verify(input.command);
            if (!plan.ok) throw new Error(`cezar manager policy: ${plan.reason}`);
            // Network off: only programs the shell names as offline run — gh and any user-allowed gh pattern do not.
            const offline = new Set(this.policy.shell.offlinePrograms ?? []);
            const online = plan.pipeline.find(([bin]) => !offline.has(bin!));
            if (!this.githubReadsAllowed && online) throw new Error(`network commands are disabled by CEZ_CODEX_NETWORK=0 (\`${online[0]}\` may reach the network)`);
            const ran = await runPipeline(plan.pipeline, plan.stdin, { cwd: await this.cwd, env: this.policy.shell.env, signal: this.aborter.signal, ...(this.limits.shellTimeoutMs ? { timeoutMs: this.limits.shellTimeoutMs } : {}) });
            return result(ran.ok, ran.text);
          }
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

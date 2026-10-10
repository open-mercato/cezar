import { execFile, spawn } from 'node:child_process';
import type { LifecycleOutputFrame, LifecycleProcessIdentity } from '@open-mercato/cezar-contract';
export type { LifecycleProcessIdentity } from '@open-mercato/cezar-contract';
import { hostname } from 'node:os';
import { promisify } from 'node:util';
import { collectSecretValues, redactSecrets } from '../core/secret-redaction.ts';
import { StreamRedaction } from '../runs/stream-redaction.ts';

export const LIFECYCLE_DEFAULT_TIMEOUT_SECONDS = 1_800;
export const LIFECYCLE_OUTPUT_LIMIT = 1024 * 1024;
export const LIFECYCLE_FRAME_LIMIT = 16 * 1024;
const execFileAsync = promisify(execFile);
export type LifecycleExecutorOutput = Pick<LifecycleOutputFrame, 'stream' | 'text'>;
export interface LifecycleExecutorOptions {
  /** Already validated/rendered by templates.ts. */
  command: string;
  cwd: string;
  timeoutSeconds?: number;
  signal?: AbortSignal;
  dryRun?: boolean;
  /** A durable start checkpoint. The child waits at a pipe gate until this resolves. */
  onStart?: (identity: LifecycleProcessIdentity) => Promise<void>;
  onOutput?: (frame: LifecycleExecutorOutput) => Promise<void> | void;
  /** Dependency injection for runtime-unavailable tests; production uses bash. */
  bashPath?: string;
}
export interface LifecycleExecutionResult {
  state: 'succeeded' | 'failed' | 'interrupted';
  exitCode: number | null;
  signal?: string;
  reason?: string;
  identity?: LifecycleProcessIdentity;
  quiescent: boolean;
  truncated: boolean;
}

async function processStart(pid: number): Promise<string | undefined> {
  if (process.platform === 'win32') return undefined;
  try {
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'lstart='], { timeout: 2000 });
    return stdout.trim() || undefined;
  } catch { return undefined; }
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
/** A read-only conservative recovery probe. Never signal a PID loaded from disk. */
export async function probeLifecycleProcess(identity: LifecycleProcessIdentity): Promise<'quiescent' | 'running' | 'unknown'> {
  if (identity.hostname !== hostname() || !Number.isSafeInteger(identity.pid) || identity.pid <= 0) return 'unknown';
  const groupAlive = process.platform === 'win32' ? alive(identity.pid) : alive(-identity.pid);
  if (!groupAlive) return 'quiescent';
  if (!identity.startIdentity) return 'unknown';
  const current = await processStart(identity.pid);
  return current === identity.startIdentity ? 'running' : 'unknown';
}
const delay = (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds));

/** Commands run in their own process group, with stdin closed after a durable launch gate.
 * Output callbacks are serialized and only receive bounded, already-redacted text. */
export async function executeLifecycleCommand(options: LifecycleExecutorOptions): Promise<LifecycleExecutionResult> {
  const timeout = options.timeoutSeconds ?? LIFECYCLE_DEFAULT_TIMEOUT_SECONDS;
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 86400) throw new Error('Lifecycle timeout must be 1–86400 seconds');
  if (options.dryRun || process.env.CEZ_DRY_RUN === '1') return { state: 'succeeded', exitCode: 0, quiescent: true, truncated: false };
  if (options.signal?.aborted) return { state: 'interrupted', exitCode: null, reason: 'Stopped before launch', quiescent: true, truncated: false };
  // Windows cannot provide the POSIX process-group guarantee used for directory ownership.
  // Refuse safely instead of launching a child whose descendants cannot be supervised.
  if (process.platform === 'win32') return { state: 'failed', exitCode: null, reason: 'Lifecycle process supervision requires a POSIX host with Bash', quiescent: true, truncated: false };
  const secrets = collectSecretValues();
  const redactor = new StreamRedaction();
  let retained = 0;
  let truncated = false;
  let outputError = false;
  let finished = false;
  let outputChain = Promise.resolve();
  let pendingFrames: LifecycleExecutorOutput[] = [];
  const enqueue = (stream: LifecycleExecutorOutput['stream'], text: string): void => {
    if (!text) return;
    const bytes = Buffer.from(text);
    const remaining = LIFECYCLE_OUTPUT_LIMIT - retained;
    if (bytes.length > remaining) {
      if (!truncated) { pendingFrames.push({ stream: 'system', text: '\n[Output truncated at 1 MiB]\n' }); truncated = true; }
      return;
    }
    retained += bytes.length;
    // Split on code points, keeping both UTF-8 boundaries and the byte frame limit.
    let frame = ''; let size = 0;
    for (const point of text) {
      const length = Buffer.byteLength(point);
      if (size + length > LIFECYCLE_FRAME_LIMIT) { pendingFrames.push({ stream, text: frame }); frame = ''; size = 0; }
      frame += point; size += length;
    }
    if (frame) pendingFrames.push({ stream, text: frame });
  };
  const flush = (): void => {
    const frames = pendingFrames; pendingFrames = [];
    if (!frames.length) return;
    outputChain = outputChain.then(async () => {
      for (const frame of frames) await options.onOutput?.(frame);
    }).catch(() => { outputError = true; if (!finished) stop('Could not persist lifecycle output'); });
  };
  const safeLine = (stream: 'stdout' | 'stderr', text: string): void => {
    const event = redactor.transform('execution', { type: 'item.delta', itemId: stream, field: 'text', delta: redactSecrets(text, secrets) }, secrets);
    enqueue(stream, event.delta as string);
  };
  const buffers = { stdout: '', stderr: '' };
  const discarding = { stdout: false, stderr: false };
  const receive = (stream: 'stdout' | 'stderr', chunk: string): void => {
    // Holding a line preserves unknown token-pattern redaction across arbitrary pipe chunks.
    // Overlong lines are discarded whole, so a token crossing the bound cannot leak.
    for (const piece of chunk.split(/(?<=\n)/)) {
      if (!discarding[stream]) {
        buffers[stream] += piece;
        if (Buffer.byteLength(buffers[stream]) > LIFECYCLE_FRAME_LIMIT) {
          buffers[stream] = ''; discarding[stream] = true; truncated = true;
          enqueue('system', '[Overlong output line omitted]\n');
        }
      }
      if (piece.endsWith('\n')) {
        if (!discarding[stream]) safeLine(stream, buffers[stream]);
        buffers[stream] = ''; discarding[stream] = false;
      }
    }
  };
  const bash = options.bashPath ?? 'bash';
  const child = spawn(bash, ['-c', 'IFS= read -r _cezar_launch || exit 125; exec "$0" -c "$1"', bash, options.command], {
    cwd: options.cwd, env: process.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => receive('stdout', chunk));
  child.stderr.on('data', (chunk: string) => receive('stderr', chunk));
  child.stdin.on('error', () => { /* a stopped gate may already be closed */ });
  let stopReason: string | undefined;
  let forced: ReturnType<typeof setTimeout> | undefined;
  const signalGroup = (signal: NodeJS.Signals): void => {
    if (!child.pid) return;
    try { process.kill(-child.pid, signal); } catch { /* checked for quiescence below */ }
  };
  function stop(reason: string): void {
    if (stopReason) return;
    stopReason = reason;
    child.stdin.end(); signalGroup('SIGTERM');
    forced = setTimeout(() => signalGroup('SIGKILL'), 5000);
  }
  const aborted = (): void => stop('Stopped by user or shutdown');
  options.signal?.addEventListener('abort', aborted, { once: true });
  const timer = setTimeout(() => stop('Command exceeded its wall-clock timeout'), timeout * 1000);
  const batch = setInterval(flush, 100);
  const completed = new Promise<{ code: number | null; signal?: string; error?: string }>(resolve => {
    child.once('error', error => resolve({ code: null, error: redactSecrets(error.message, secrets) }));
    child.once('exit', (code, signal) => resolve({ code, ...(signal ? { signal } : {}) }));
  });
  let identity: LifecycleProcessIdentity | undefined;
  if (child.pid) {
    const start = await processStart(child.pid);
    identity = { pid: child.pid, hostname: hostname(), startedAt: new Date().toISOString(), ...(start ? { startIdentity: start } : {}) };
    try {
      await options.onStart?.(identity);
      if (!stopReason) child.stdin.end('start\n');
    } catch { stop('Could not persist command start; command was not launched'); }
  }
  const outcome = await completed;
  // Background children that did not detach must not outlive ownership of the directory.
  if (child.pid && alive(-child.pid)) {
    stop(stopReason ?? 'Command left background processes attached');
    const deadline = Date.now() + 5500;
    while (alive(-child.pid) && Date.now() < deadline) await delay(25);
  }
  const quiescent = !child.pid || !alive(-child.pid);
  finished = true;
  clearTimeout(timer); clearInterval(batch); if (forced) clearTimeout(forced);
  options.signal?.removeEventListener('abort', aborted);
  // Let pipe data queued with the exit event drain, without waiting on escaped descendants.
  await Promise.race([closed, delay(100)]);
  child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
  for (const stream of ['stdout', 'stderr'] as const) if (buffers[stream]) safeLine(stream, buffers[stream]);
  for (const event of redactor.drain('execution', { type: 'turn.completed' })) enqueue(event.itemId as 'stdout' | 'stderr', event.delta as string);
  flush(); await outputChain;
  const reason = outcome.error ?? (outputError ? 'Could not persist lifecycle output' : stopReason);
  return {
    state: reason ? (stopReason && !outputError && !stopReason.startsWith('Could not persist') ? 'interrupted' : 'failed') : outcome.code === 0 && quiescent ? 'succeeded' : 'failed',
    exitCode: outcome.code, ...(outcome.signal ? { signal: outcome.signal } : {}), ...(reason ? { reason } : {}),
    ...(identity ? { identity } : {}), quiescent, truncated,
  };
}

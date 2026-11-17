// One supervisor for every extension worker process cezar spawns, shipped chat adapters included.
// It owns only the process plumbing — env policy, line framing, stderr drain, hung
// detection, bounded stop and restart budgets. Each host keeps its own frame protocol (protocol.ts).
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { encodeFrame, MAX_FRAME_BYTES } from './rpc.ts'

// Network-relevant variables only: never PATH, HOME, credentials or NODE_OPTIONS.
const FORWARDED_ENV = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'NODE_EXTRA_CA_CERTS', 'NODE_USE_ENV_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
]

export function workerEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = { NODE_ENV: 'production' }
  for (const key of FORWARDED_ENV) {
    const value = env[key]
    if (typeof value !== 'string') continue
    // Proxy URLs are forwarded to untrusted extension code. Never put credentials in a
    // worker environment: even a well-behaved extension can expose its environment in a
    // diagnostic, and a malicious one should not receive host secrets. The host-side HTTP
    // transport remains responsible for authenticated proxies.
    if (/proxy$/i.test(key)) {
      try {
        const parsed = new URL(value)
        if (parsed.username || parsed.password) continue
      } catch {
        // Preserve malformed values for the host's existing proxy handling; they contain no
        // parseable authority credentials and are still bounded by the allowlist.
      }
    }
    out[key] = value
  }
  return out
}

/** A live worker that times out this many calls in a row is hung and gets killed. */
export const HUNG_AFTER_TIMEOUTS = 3
const STDERR_LINE_CHARS = 500
const STDERR_TAIL_CHARS = 4096
const TERM_WAIT_MS = 2_000
const EXIT_DRAIN_MS = 250

export interface WorkerProcessOptions {
  /** Prefix for log lines, e.g. `[extension acme.chat]`. */
  label: string
  /** Arguments after `process.execPath`. */
  args: readonly string[]
  cwd: string
  /** The environment the allowlist reads from (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv
  log(line: string): void
  /** Sanitize a complete bounded diagnostic BEFORE any line/tail truncation. */
  sanitizeStderr?: (text: string) => string
  /** One parsed JSON line. Throwing is a protocol error: the worker is killed. */
  onFrame(frame: unknown): void
  /** Called exactly once, when the process is gone (including after `stop`). */
  onExit(error: Error): void
  /** Optional diagnostic after stderr EOF, or a bounded omission if a descendant holds pipes. */
  onExitDiagnostic?(error: Error, tail: string): void
}

export interface WorkerProcess {
  readonly child: ChildProcessWithoutNullStreams
  readonly alive: boolean
  readonly exited: Promise<void>
  /** True while stdin is backed up; the caller decides whether to drop or wait. */
  readonly congested: boolean
  /** Encode one frame (1 MiB cap) and write it; throws when the process is gone or the frame is oversized. */
  write(frame: unknown): void
  kill(reason?: string): void
  /** Count a timed-out call; the third in a row kills the worker. */
  timedOut(): void
  /** Any answer from the worker proves it is not hung. */
  answered(): void
  /** The last few KiB of stderr, for an exit diagnostic. */
  stderrTail(): string
  /** Wait `graceMs` for a voluntary exit, then SIGTERM, then SIGKILL — bounded either way. */
  stop(graceMs: number): Promise<void>
}

export function spawnWorkerProcess(options: WorkerProcessOptions): WorkerProcess {
  const child = spawn(process.execPath, [...options.args], {
    cwd: options.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: workerEnv(options.env),
  })
  let alive = true
  let timeouts = 0
  let tail = ''
  let exited!: () => void
  const exit = new Promise<void>(done => { exited = done })

  const finish = (error: Error) => {
    if (!alive) return
    alive = false
    exited()
    options.onExit(error)
  }
  const kill = (reason?: string) => {
    if (reason) options.log(`${options.label} ${reason}; killing worker`)
    if (alive) child.kill('SIGKILL')
  }

  let exitError: Error | undefined
  let diagnosticSent = false
  let drainTimer: ReturnType<typeof setTimeout> | undefined
  const diagnostic = (complete: boolean) => {
    if (!exitError || diagnosticSent) return
    diagnosticSent = true
    options.onExitDiagnostic?.(exitError, complete ? tail.trim() : '[stderr omitted: output did not close after worker exit]')
  }
  const processGone = (error: Error) => {
    if (!alive) return
    exitError = error
    // Process death releases pending calls and restart slots immediately. A descendant
    // may inherit pipes; it must not extend the worker's lifetime or keep us alive.
    finish(error)
    if (child.stderr.readableEnded) diagnostic(true)
    drainTimer = setTimeout(() => {
      diagnostic(child.stderr.readableEnded)
      child.stdin.destroy()
      child.stdout.destroy()
      child.stderr.destroy()
    }, EXIT_DRAIN_MS)
    drainTimer.unref()
  }
  child.once('error', processGone)
  child.once('exit', (code, signal) => processGone(new Error(`${options.label} worker exited (${code ?? signal ?? 'unknown'})`)))
  child.once('close', () => {
    clearTimeout(drainTimer)
    diagnostic(child.stderr.readableEnded)
  })
  child.stdin.on('error', () => kill())
  drainStderr(child, options, line => { tail = `${tail}${line}\n`.slice(-STDERR_TAIL_CHARS) })
  child.stderr.once('end', () => { if (!alive) diagnostic(true) })
  readFrames(child, frame => { if (alive) options.onFrame(frame) }, reason => { if (alive) kill(`protocol error: ${reason}`) })

  const wait = (ms: number) => Promise.race([
    exit.then(() => true),
    new Promise<boolean>(done => { setTimeout(() => done(false), ms).unref() }),
  ])

  return {
    child,
    exited: exit,
    get alive() { return alive },
    get congested() { return child.stdin.writableNeedDrain },
    write(frame) {
      if (!alive || !child.stdin.writable) throw new Error(`${options.label} worker IPC closed`)
      child.stdin.write(encodeFrame(frame))
    },
    kill,
    timedOut() {
      if (++timeouts >= HUNG_AFTER_TIMEOUTS && alive) kill(`${timeouts} calls timed out in a row`)
    },
    answered() { timeouts = 0 },
    stderrTail: () => tail.trim(),
    async stop(graceMs) {
      if (!alive) return
      if (graceMs > 0 && await wait(graceMs)) return
      child.kill('SIGTERM')
      if (await wait(TERM_WAIT_MS)) return
      child.kill('SIGKILL')
      await wait(TERM_WAIT_MS)
    },
  }
}

/** Newline-delimited JSON with a hard per-frame cap, enforced before a line is complete. */
function readFrames(child: ChildProcessWithoutNullStreams, onFrame: (frame: unknown) => void, fail: (reason: string) => void) {
  let buffer = Buffer.alloc(0)
  let failed = false
  child.stdout.on('data', (chunk: Buffer) => {
    if (failed) return
    buffer = Buffer.concat([buffer, chunk])
    try {
      let end: number
      while ((end = buffer.indexOf(10)) !== -1) {
        if (end > MAX_FRAME_BYTES) throw new Error('frame exceeds 1 MiB')
        const line = buffer.subarray(0, end).toString('utf8')
        buffer = buffer.subarray(end + 1)
        let raw: unknown
        try { raw = JSON.parse(line) } catch { throw new Error('invalid JSON frame') }
        onFrame(raw)
      }
      if (buffer.length > MAX_FRAME_BYTES) throw new Error('frame exceeds 1 MiB')
    } catch (error) {
      failed = true
      buffer = Buffer.alloc(0)
      fail(error instanceof Error ? error.message : 'invalid frame')
    }
  })
}

/** Always drain stderr, so a chatty worker never blocks on a full pipe. */
function drainStderr(child: ChildProcessWithoutNullStreams, options: WorkerProcessOptions, keep: (line: string) => void) {
  // Sanitized hosts retain at most 64 KiB, then discard the WHOLE diagnostic. Keeping
  // a prefix/suffix could expose a secret cut by that bound. Collecting through EOF
  // also handles secrets split across UTF-8 chunks or newlines. Incomplete output
  // is never sanitized/published: processGone suppresses it at the drain deadline.
  if (options.sanitizeStderr) {
    const chunks: Buffer[] = []
    let bytes = 0
    let overflow = false
    child.stderr.on('data', (chunk: Buffer) => {
      if (overflow) return
      bytes += chunk.length
      if (bytes > 64 * 1024) { overflow = true; chunks.length = 0; return }
      chunks.push(chunk)
    })
    child.stderr.on('end', () => {
      let safe = '[stderr omitted: diagnostic exceeds 64 KiB]'
      if (!overflow) {
        try { safe = options.sanitizeStderr!(Buffer.concat(chunks).toString('utf8')) }
        catch { safe = '[stderr omitted: sanitization failed]' }
      }
      chunks.length = 0
      for (const text of safe.split(/\r?\n/)) {
        const clipped = text.slice(0, STDERR_LINE_CHARS)
        keep(clipped)
      }
    })
    return
  }
  let partial = ''
  const line = (text: string) => keep(text.slice(0, STDERR_LINE_CHARS))
  child.stderr.on('data', (chunk: Buffer) => {
    const lines = `${partial}${chunk.toString('utf8')}`.split(/\r?\n/)
    partial = lines.pop()!.slice(0, STDERR_LINE_CHARS)
    for (const text of lines) line(text)
  })
  child.stderr.on('end', () => { if (partial) line(partial) })
}

export interface RestartBudgetOptions {
  /** Consecutive rapid crashes tolerated before giving up. */
  maxRestarts?: number
  delayMs?(attempt: number): number
}

/** Bounded restart with backoff. A worker that lived a minute is healthy again; only rapid crash
 *  loops count toward giving up. */
export class RestartBudget {
  private crashes = 0
  constructor(private readonly options: RestartBudgetOptions = {}) {}

  /** The next attempt and its delay, or undefined once restarts are exhausted. */
  crashed(spawnedAt: number, now = Date.now()): { attempt: number; delayMs: number } | undefined {
    this.crashes = now - spawnedAt < 60_000 ? this.crashes + 1 : 1
    if (this.crashes > (this.options.maxRestarts ?? 3)) return undefined
    const delayMs = this.options.delayMs?.(this.crashes) ?? Math.min(30_000, 1_000 * 2 ** (this.crashes - 1))
    return { attempt: this.crashes, delayMs }
  }
}

import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentEvent, AgentRunResult, AgentRunSpec, AgentRunner, AgentSession, AgentToolCallRecord, SessionOptions } from './agent-runner.ts';
import { prependSystemPrompt, trackChildExit } from './agent-runner.ts';
import { buildChildEnv } from './agent-env.ts';
import { disclaimedCommand } from './disclaim-spawn.ts';
import { readNdjson } from './ndjson.ts';
import { createAntigravityUiState, mapAntigravityMessage } from './antigravity-ui-mapper.ts';

export const ANTIGRAVITY_OPT_IN_HINT = 'Enable Antigravity with CEZ_ANTIGRAVITY=1 and sign in by running agy in a terminal.';
export const antigravityEnabled = (): boolean => process.env.CEZ_ANTIGRAVITY === '1';
export const resolveAntigravityBin = (bin?: string): string => bin || process.env.CEZ_AGY_BIN || 'agy';
export const mockAntigravityPath = (): string => resolve(dirname(fileURLToPath(import.meta.url)), '../../scripts/mock-antigravity.mjs');

export function buildAntigravityArgs(spec: AgentRunSpec): string[] {
  const args = ['--output-format', 'stream-json', '--dangerously-skip-permissions'];
  if (spec.model?.trim()) args.push('--model', spec.model.trim());
  if (spec.resume && spec.sessionId) args.push('--conversation', spec.sessionId);
  for (const dir of spec.additionalDirectories ?? []) args.push('--add-dir', dir);
  return [...args, '-p', prependSystemPrompt(spec.systemPrompt, spec.userPrompt)];
}

// Serialize real CLI turns across projects; a rejected/cancelled turn must release the slot.
let slot: Promise<void> = Promise.resolve();
const live = new Map<number, () => void>();
process.once('exit', () => { for (const stop of live.values()) stop(); });

function descendants(pid: number): number[] {
  if (process.platform === 'win32') return [];
  try {
    const rows = execFileSync('ps', ['-e', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: 2_000 })
      .trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
    const result = [pid];
    for (let i = 0; i < result.length; i++) for (const [child, parent] of rows) {
      if (parent === result[i] && child && !result.includes(child)) result.push(child);
    }
    return result.slice(1);
  } catch { return []; }
}
const signal = (pid: number, sig: NodeJS.Signals): void => { try { process.kill(pid, sig); } catch { /* already exited */ } };

export class AntigravityRunner implements AgentRunner {
  readonly backend = 'antigravity' as const;
  private session?: AgentSession;
  constructor(private readonly options: { bin?: string; timeoutMs?: number; killGraceMs?: number } = {}) {}
  run(spec: AgentRunSpec, onEvent?: (event: AgentEvent) => void): Promise<AgentRunResult> {
    return this.startSession(spec, onEvent, { autoEndAfterFirstTurn: true }).result;
  }
  async interrupt(): Promise<void> { this.session?.interrupt(); }
  startSession(spec: AgentRunSpec, onEvent?: (event: AgentEvent) => void, opts: SessionOptions = {}): AgentSession {
    const bin = this.options.bin || process.env.CEZ_AGY_BIN || (process.env.CEZ_DRY_RUN === '1' ? mockAntigravityPath() : 'agy');
    const mock = bin === mockAntigravityPath();
    if (!mock && !antigravityEnabled()) throw new Error(ANTIGRAVITY_OPT_IN_HINT);
    if (spec.images?.length) throw new Error('Antigravity headless image input is unsupported. Use a file path in the prompt.');
    if (spec.mcpServers?.length) throw new Error('Antigravity private MCP injection is unsupported.');
    let child: ChildProcessWithoutNullStreams | undefined;
    let open = true;
    let stopped = false;
    let timedOut = false;
    let authRequired = false;
    let spawnError: Error | undefined;
    let escalation: NodeJS.Timeout | undefined;
    let deadline: NodeJS.Timeout | undefined;
    let tree: number[] = [];
    let state = createAntigravityUiState(spec.resume ? spec.sessionId : undefined);
    let text = '';
    let sessionId = state.sessionId;
    let tokensUsed = 0;
    let streamError: string | undefined;
    const toolCalls: AgentToolCallRecord[] = [];
    const emit = (event: AgentEvent): void => {
      if (event.type === 'text') text += event.text;
      if (event.type === 'session') sessionId = event.sessionId;
      if (event.type === 'token-usage') tokensUsed = event.tokensUsed;
      if (event.type === 'error') streamError = event.message;
      if (event.type === 'tool-call') toolCalls.push({ id: event.id, name: event.tool, input: event.input });
      onEvent?.(event);
    };
    const map = (frame: unknown): void => {
      const mapped = mapAntigravityMessage(frame, state);
      state = mapped.state;
      for (const event of mapped.events) opts.onUiEvent?.(event);
      for (const event of mapped.agentEvents) emit(event);
    };
    const stop = (): void => {
      stopped = true;
      open = false;
      if (!child || escalation) return;
      const pid = child.pid;
      tree = pid ? descendants(pid) : [];
      if (pid && process.platform !== 'win32') signal(-pid, 'SIGTERM');
      else child.kill('SIGTERM');
      for (const descendant of tree) signal(descendant, 'SIGTERM');
      const exited = trackChildExit(child);
      escalation = setTimeout(() => {
        if (!exited()) {
          if (pid && process.platform !== 'win32') signal(-pid, 'SIGKILL');
          else child?.kill('SIGKILL');
        }
        // Descendants may live after their parent exits; retain the watchdog for them.
        for (const descendant of tree) signal(descendant, 'SIGKILL');
      }, this.options.killGraceMs ?? 10_000);
      escalation.unref();
    };
    const launch = async (): Promise<AgentRunResult> => {
      if (stopped) return { text, toolCalls, tokensUsed, sessionId };
      const env = buildChildEnv({ backend: this.backend, extraEnv: spec.env });
      const args = buildAntigravityArgs(spec);
      const script = /\.[cm]?js$/.test(bin);
      const [program, argv] = disclaimedCommand(script ? process.execPath : bin, script ? [bin, ...args] : args, env);
      child = spawn(program, argv, { cwd: spec.cwd, env, detached: process.platform !== 'win32' });
      child.on('error', error => { spawnError = error; });
      const proc = child;
      const closed = new Promise<number | null>(resolve => proc.once('close', resolve));
      if (proc.pid) live.set(proc.pid, () => {
        const pid = proc.pid!;
        const victims = descendants(pid);
        if (process.platform !== 'win32') signal(-pid, 'SIGKILL');
        else signal(pid, 'SIGKILL');
        for (const victim of victims) signal(victim, 'SIGKILL');
      });
      proc.stdin.on('error', () => {});
      proc.stdin.end();
      let stderr = '';
      proc.stderr.on('data', (data: Buffer) => {
        stderr = (stderr + data.toString('utf8')).slice(-16_384);
        if (/authentication required|please sign in/i.test(stderr)) { authRequired = true; stop(); }
      });
      const timeoutMs = spec.timeoutMs ?? this.options.timeoutMs ?? 30 * 60_000;
      if (timeoutMs > 0) {
        deadline = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
        deadline.unref();
      }
      try {
        try {
          for await (const line of readNdjson(proc.stdout)) {
            let frame: unknown;
            try { frame = JSON.parse(line); } catch { continue; }
            map(frame);
          }
        } catch (error) { if (!stopped && !spawnError) throw error; }
        const code = await closed;
        if (spawnError) throw new Error(`Cannot start Antigravity (${bin}): ${spawnError.message}`);
        if (authRequired) throw new Error('Antigravity authentication required. Run agy in a terminal and sign in.');
        if (timedOut) throw new Error(`Antigravity timed out after ${timeoutMs}ms`);
        if (!stopped && streamError) throw new Error(streamError);
        if (!stopped && (code !== 0 || !state.finished)) throw new Error(`Antigravity exited without a successful result (code ${code})${stderr.trim() ? `: ${stderr.trim()}` : ''}`);
        if (!state.finished) map({ event: 'result', result: { status: 'CANCELED' } });
        opts.onUiEvent?.({ type: 'session.ended', reason: stopped ? 'cancelled' : 'end_turn' });
        emit({ type: 'done' });
        return { text: text.trim(), toolCalls, tokensUsed, sessionId };
      } catch (error) {
        stop();
        const message = error instanceof Error ? error.message : String(error);
        if (!state.finished) map({ event: 'result', result: { status: 'ERROR', error: message } });
        else if (!streamError) {
          emit({ type: 'error', message });
          opts.onUiEvent?.({ type: 'session.error', message, fatal: true });
        }
        opts.onUiEvent?.({ type: 'session.ended', reason: timedOut ? 'timeout' : 'error' });
        throw error;
      } finally {
        open = false;
        if (deadline) clearTimeout(deadline);
        if (proc.pid) live.delete(proc.pid);
        if (!tree.length && escalation) clearTimeout(escalation);
      }
    };
    const ahead = mock ? Promise.resolve() : slot;
    let release!: () => void;
    if (!mock) slot = new Promise<void>(resolve => { release = resolve; });
    const result = ahead.then(launch).finally(() => release?.());
    this.session = { result, get pid() { return child?.pid; }, get open() { return open; },
      sendMessage() { return false; }, end: stop, interrupt: stop };
    return this.session;
  }
}

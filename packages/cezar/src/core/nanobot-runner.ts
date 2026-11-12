import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { AgentEvent, AgentRunner, AgentRunSpec, AgentSession, AgentRunResult, ContentBlock, SessionOptions } from './agent-runner.ts';
import { assertReasoningEffortSupported, prependSystemPrompt } from './agent-runner.ts';
import { buildChildEnv } from './agent-env.ts';
import { disclaimedCommand } from './disclaim-spawn.ts';
import { armInactivityDeadline, inactivityTimeoutMessage } from './inactivity-deadline.ts';
import { readNdjson } from './ndjson.ts';
import { resolveNanobotExecutable } from './nanobot-model-catalog.ts';
import { NanobotEventMapper } from './nanobot-ui-mapper.ts';

export class NanobotRunner implements AgentRunner {
  readonly backend = 'nanobot' as const;
  private lastSession?: AgentSession;
  constructor(private readonly options: { bin?: string; timeoutMs?: number; killGraceMs?: number } = {}) {}

  run(spec: AgentRunSpec, onEvent?: (event: AgentEvent) => void): Promise<AgentRunResult> {
    return this.startSession(spec, onEvent, { autoEndAfterFirstTurn: true }).result;
  }
  async interrupt(): Promise<void> { this.lastSession?.interrupt(); }

  startSession(spec: AgentRunSpec, onEvent?: (event: AgentEvent) => void, opts: SessionOptions = {}): AgentSession {
    assertReasoningEffortSupported(this.backend, spec.reasoningEffort);
    if (spec.enforceReadOnly || spec.bashAllowlist?.length) {
      throw new Error('Nanobot local cannot enforce read-only or command-prefix restrictions. Choose another runner.');
    }
    const bin = this.options.bin ?? resolveNanobotExecutable();
    const env = buildChildEnv({ backend: this.backend, extraEnv: spec.env });
    const [file, args] = disclaimedCommand(bin, ['--rpc'], env);
    const child = spawn(file, args, { cwd: spec.cwd, env, detached: process.platform !== 'win32' });
    let open = true;
    let closed = false;
    let stopping = false;
    let cancelled = false;
    let initialized = false;
    let pendingTurns = 0;
    let failure: Error | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const mapper = new NanobotEventMapper();
    const output: AgentRunResult = { text: '', toolCalls: [], tokensUsed: 0, sessionId: spec.sessionId ?? randomUUID() };
    const texts: string[] = [];
    // Register before reading stdout: a missing binary can close before an async reader starts.
    const exit = new Promise<number | null>((resolve) => {
      child.once('error', (error) => { failure = error; });
      child.once('close', (code) => { closed = true; open = false; resolve(code); });
    });
    child.stdin.on('error', () => {});
    // Native diagnostics may contain MCP credentials or provider response bodies. Never relay stderr.
    child.stderr.resume();
    const write = (message: unknown): boolean => {
      if (!open || !child.stdin.writable) return false;
      child.stdin.write(`${JSON.stringify(message)}\n`);
      return true;
    };
    const signal = (sig: NodeJS.Signals): void => {
      if (closed) return;
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch { /* The process may have exited between close and signal. */ }
    };
    const stop = (cancel: boolean): void => {
      if (stopping || closed) return;
      stopping = true;
      cancelled = cancel;
      write({ type: cancel ? 'abort' : 'end' });
      open = false;
      child.stdin.end();
      if (cancel) signal('SIGTERM');
      killTimer = setTimeout(() => {
        signal('SIGKILL');
      }, this.options.killGraceMs ?? 10_000);
      killTimer.unref();
    };
    const limitMs = spec.timeoutMs ?? this.options.timeoutMs ?? 30 * 60_000;
    const deadline = armInactivityDeadline(limitMs, () => {
      failure = new Error(inactivityTimeoutMessage('Nanobot', limitMs, deadline.expiredBy));
      stop(true);
    });
    const sendMessage = (content: ContentBlock[]): boolean => {
      const sent = write({ type: 'prompt',
        text: content.filter((b) => b.type === 'text').map((b) => b.text).join('\n'),
        images: content.filter((b) => b.type === 'image').map((b) => ({ mediaType: b.source.media_type, data: b.source.data })),
      });
      if (sent) pendingTurns++;
      return sent;
    };
    write({ type: 'init', cwd: spec.cwd, sessionId: output.sessionId, resume: spec.resume === true,
      model: spec.model, mcpServers: spec.mcpServers ?? [], allowedTools: spec.allowedTools,
      additionalDirectories: spec.additionalDirectories });
    sendMessage([...(spec.images ?? []), { type: 'text', text: prependSystemPrompt(spec.systemPrompt, spec.userPrompt) }]);
    const result = (async (): Promise<AgentRunResult> => {
      try {
        for await (const line of readNdjson(child.stdout)) {
          deadline.touch();
          let value: unknown;
          try { value = JSON.parse(line); } catch {
            failure = new Error('Nanobot bridge emitted invalid JSON');
            stop(true);
            continue;
          }
          const mapped = mapper.map(value);
          for (const event of mapped.ui) opts.onUiEvent?.(event);
          for (const event of mapped.agent) {
            onEvent?.(event);
            switch (event.type) {
              case 'text': texts.push(event.text); break;
              case 'tool-call': output.toolCalls.push({ id: event.id, name: event.tool, input: event.input }); break;
              case 'token-usage': output.tokensUsed = event.tokensUsed; break;
              case 'session': initialized = true; output.sessionId = event.sessionId; break;
              case 'error': failure = new Error(event.message); stop(true); break;
              case 'turn-end': pendingTurns = Math.max(0, pendingTurns - 1); if (opts.autoEndAfterFirstTurn) stop(false); break;
            }
          }
        }
        const code = await exit;
        if (failure) throw failure;
        if (!cancelled && code !== 0) throw new Error(`Nanobot bridge exited with code ${code ?? 'signal'}`);
        if (!cancelled && (!initialized || pendingTurns > 0)) {
          throw new Error('Nanobot bridge exited before completing the requested turn');
        }
        output.text = texts.join('\n').trim();
        opts.onUiEvent?.({ type: 'session.ended', reason: stopping ? mapper.stopReason : 'end_turn' });
        onEvent?.({ type: 'done' });
        return output;
      } catch (error) {
        stop(true);
        await exit;
        const message = error instanceof Error ? error.message : 'Nanobot session failed';
        onEvent?.({ type: 'error', message });
        opts.onUiEvent?.({ type: 'session.ended', reason: 'error', message });
        throw error;
      } finally {
        deadline.clear();
        if (killTimer) clearTimeout(killTimer);
        open = false;
      }
    })();
    const session: AgentSession = { result, pid: child.pid, sendMessage, end: () => stop(false),
      interrupt: () => { mapper.stopReason = 'cancelled'; stop(true); },
      hardStop: () => { mapper.stopReason = 'cancelled'; stop(true); signal('SIGKILL'); },
      get open() { return open; } };
    this.lastSession = session;
    return session;
  }
}

import { emitUsageWindows, normalizeClaudeTerminalUsageLimit, normalizeClaudeUsageWindows } from './usage-windows.ts';
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { cezarHomeDir } from '../paths.ts';
import type {
  AgentEvent,
  AgentRunResult,
  AgentRunSpec,
  AgentRunner,
  AgentSession,
  AgentToolCallRecord,
  ContentBlock,
  SessionOptions,
} from './agent-runner.ts';

// Re-exported for backends and the run manager that still import them from here.
export type { AgentSession, SessionOptions } from './agent-runner.ts';
import { isSignalTerminationExit, trackChildExit } from './agent-runner.ts';
import { unwrapJsonErrorEnvelope } from './agent-errors.ts';
import { buildChildEnv } from './agent-env.ts';
import { holdForOwnShutdown, ownShutdownExitMessage, ownSignalBehindExit, receivedOwnSignalSince, watchOwnSignals } from './process-signals.ts';
import { disclaimedCommand } from './disclaim-spawn.ts';
import { resolveClaudeBin } from './claude-bin.ts';
import { costWeightedTokens, type RawUsage } from './usage.ts';
import { readNdjson } from './ndjson.ts';
import { claudeUsageStatus } from './claude-usage-status.ts';
import { ClaudeSessionCost } from './claude-session-cost.ts';
import { armInactivityDeadline, inactivityTimeoutMessage } from './inactivity-deadline.ts';
import { claudeMcpAllowRules, toClaudeMcpConfig, type PrivateMcpServer } from './private-mcp.ts';
import {
  CLAUDE_PERMISSION_ASK_PREFIX,
  claudeAutoDeny,
  claudeControlError,
  claudeControlSuccess,
  claudeNobodyAnswersDeny,
  claudePermissionAnswer,
  claudePermissionCard,
  parseClaudeControlLine,
  type ClaudeControlMessage,
  type ClaudePermissionRequest,
  type ClaudePermissionResult,
} from './claude-permission-prompt.ts';
import { askClosedEvent } from './ui-events.ts';
import {
  claudeTurnStarted,
  createClaudeUiState,
  mapClaudeMessage,
  stringifyToolResultContent,
  toolResultImageBlocks,
  type ClaudeUiMapping,
} from './claude-ui-mapper.ts';

/** Default inactivity cap (no stream frame for this long) before SIGTERM → SIGKILL (cf2191f1).
 *  Interactive sessions pass `timeoutMs: 0` to disable it entirely. */
export const DEFAULT_RUN_TIMEOUT_MS = 30 * 60_000;
/** Grace period between SIGTERM and SIGKILL when a timeout fires. */
export const KILL_GRACE_MS = 10_000;
/** After `end()` closes stdin: claude in stream-json mode can ignore EOF and
 *  hang (janitor-confirmed CLI bug) — escalate SIGTERM, then SIGKILL. */
export const EOF_TERM_GRACE_MS = 8_000;
export const EOF_KILL_GRACE_MS = 4_000;
/** Reopen window after a turn ends before an auto-ended session closes stdin. */
export const AUTO_END_DELAY_MS = 250;

/**
 * Claude runs through cezar's headless stream-json transport. There is no
 * cockpit permission response channel yet, so a denial must become actionable
 * prose rather than an invitation to use Claude Code's interactive controls.
 */
export const CLAUDE_HEADLESS_GUIDANCE = `You are running Claude Code through cezar's headless integration. Permission prompts cannot be answered in the cezar cockpit. If a tool call is denied, do not suggest Shift+Tab, /permissions, changing Claude permission settings, or replying Continue to retry it. Report the exact blocked tool and path or command, stop retrying that operation, and explain that the task's actual Open in… action is the workaround: continue in an interactive claude --resume <session id> shell in the task worktree and approve the prompt there. Do not use filesystem workarounds or claim that cezar can approve the request.`;

/**
 * The variant for a run whose permission prompts reach the cezar cockpit (`--permission-prompt-tool
 * stdio` plus a user who can answer): a denial now means the user refused, not that nobody could ask.
 */
export const CLAUDE_COCKPIT_PERMISSION_GUIDANCE = `You are running Claude Code through cezar. A tool call outside the allow list is shown to the user in the cezar cockpit for approval. If the user denies one, respect it: do not retry the same call, do not suggest Shift+Tab, /permissions, or changing Claude permission settings, and do not use filesystem workarounds. Say exactly what was blocked and continue with what you can still do.`;

/** Keep caller-owned instructions intact while adding guidance owned by this backend. The cockpit
 *  variant only when the user can answer a prompt (`promptsAnswerable`); otherwise the headless one. */
export function appendClaudeSystemPrompt(systemPrompt?: string, promptsAnswerable = false): string {
  const guidance = promptsAnswerable ? CLAUDE_COCKPIT_PERMISSION_GUIDANCE : CLAUDE_HEADLESS_GUIDANCE;
  return systemPrompt ? `${systemPrompt}\n\n---\n\n${guidance}` : guidance;
}

export interface ClaudePromptMode {
  /** The `--permission-mode` value. */
  permissionMode: 'dontAsk' | 'bypassPermissions' | 'acceptEdits' | 'manual';
  /** Whether `--permission-prompt-tool stdio` is on, so `can_use_tool` reaches the host. */
  promptTool: boolean;
}

/**
 * The permission mode a spawn gets, and whether Claude may ask on the control channel. One place,
 * so `startSession` (guidance, queue) and `buildClaudeArgs` (flags) cannot disagree.
 *
 * Read-only/strict win, then `bypassPermissions`, then the project's `claudePermissionMode`, then
 * `CEZ_APPROVAL_GATE` (acceptEdits, no prompt channel), then `dontAsk`. `acceptEdits` is honoured
 * only for a step that already allows Edit, Write and unrestricted Bash; else `manual`, so a
 * repo-tracked config never widens a step's tool fence (spec 2026-07-17-permission-modes).
 */
export function claudePromptMode(spec: AgentRunSpec, env: NodeJS.ProcessEnv = process.env): ClaudePromptMode {
  if (spec.strictPermissions || spec.enforceReadOnly) return { permissionMode: 'dontAsk', promptTool: false };
  if (spec.bypassPermissions) return { permissionMode: 'bypassPermissions', promptTool: false };
  if (spec.claudePermissionMode) {
    const allowed = buildAllowedTools(spec.allowedTools ?? [], spec.bashAllowlist);
    const fenceAllowsEdits = ['Edit', 'Write', 'Bash'].every((tool) => allowed.includes(tool));
    return {
      permissionMode: spec.claudePermissionMode === 'acceptEdits' && fenceAllowsEdits ? 'acceptEdits' : 'manual',
      promptTool: true,
    };
  }
  return { permissionMode: env.CEZ_APPROVAL_GATE === '1' ? 'acceptEdits' : 'dontAsk', promptTool: false };
}

export interface ClaudeCliRunnerOptions {
  /** Override the binary name/path; defaults to `claude` on PATH. */
  bin?: string;
  /** Inactivity timeout for a run (ms); per-spec `timeoutMs` still wins. */
  timeoutMs?: number;
}

/**
 * The claude binary a spawn should use: an explicit override, else `CEZ_CLAUDE_BIN`, else the
 * bundled mock under `CEZ_DRY_RUN`, else `claude` on PATH or at a known install location
 * (`resolveClaudeBin`).
 *
 * Exported so model discovery (`claude-model-catalog.ts`) resolves the executable exactly the
 * way execution does — the catalog and the runs it feeds cannot disagree about which CLI, and
 * therefore which account and which model list, is authoritative.
 */
export function resolveClaudeExecutable(override?: string): string {
  if (override) return override;
  // CEZ_DRY_RUN=1 swaps in the bundled mock so the cockpit / store /
  // GUI can be exercised without a logged-in claude or burning tokens.
  if (process.env.CEZ_CLAUDE_BIN) return process.env.CEZ_CLAUDE_BIN;
  return process.env.CEZ_DRY_RUN === '1' ? mockClaudePath() : resolveClaudeBin();
}

/**
 * `AgentRunner` over the Claude Code CLI in headless stream-json mode. Auth =
 * the host's logged-in Pro/Max subscription (no API key needed). Sandboxing is
 * `--allowedTools` (default-deny for anything not listed) + running inside the
 * repo `cwd`; `Bash` is narrowed to `Bash(<prefix>:*)` patterns only when
 * `bashAllowlist` is set — the zero-config default has no allowlist, so `Bash`
 * is unrestricted shell access (#430).
 *
 * Session mechanics (multi-turn stdin, EOF watchdog, reopen window) follow
 * github-janitor's `claudeRunner.ts`; the original single-turn adaptation
 * came from @cezar/core's `ClaudeCodeCliRunner`.
 */
export class ClaudeCliRunner implements AgentRunner {
  readonly backend = 'claude' as const;

  private readonly bin: string;
  private readonly timeoutMs: number;
  private lastSession: AgentSession | null = null;

  constructor(opts: ClaudeCliRunnerOptions = {}) {
    this.bin = resolveClaudeExecutable(opts.bin);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  }

  /** One-shot run: start a session and auto-end it after the first turn. */
  run(spec: AgentRunSpec, onEvent?: (event: AgentEvent) => void): Promise<AgentRunResult> {
    return this.startSession(spec, onEvent, { autoEndAfterFirstTurn: true }).result;
  }

  async interrupt(): Promise<void> {
    this.lastSession?.interrupt();
  }

  startSession(
    spec: AgentRunSpec,
    onEvent?: (event: AgentEvent) => void,
    opts: SessionOptions = {},
  ): AgentSession {
    const mcpConfig = writeClaudeMcpConfig(spec.mcpServers);
    // Read once at spawn: the guidance a session starts with cannot change later.
    const { promptTool } = claudePromptMode(spec, process.env);
    const promptsAnswerable = promptTool && !!opts.onUiEvent && opts.canAskPermission?.() === true;
    const promptFile = writeClaudeSystemPromptFile(appendClaudeSystemPrompt(spec.systemPrompt, promptsAnswerable));
    const settingsFile = writeClaudeSettingsFile(spec.claudeSettings);
    // A fence that could not be written must not run unfenced.
    if (spec.claudeSettings && !settingsFile) {
      mcpConfig?.cleanup();
      promptFile?.cleanup();
      throw new Error('claude: could not write the --settings file');
    }
    const args = buildClaudeArgs(spec, process.env, mcpConfig?.path, promptFile?.path, settingsFile?.path, promptsAnswerable);
    watchOwnSignals();
    const startedAt = Date.now();

    let child: ChildProcessWithoutNullStreams;
    let sessionCost: ClaudeSessionCost;
    try {
      const env = buildChildEnv({ backend: this.backend, extraEnv: spec.env });
      // `--strict-mcp-config` drops configured servers; claude.ai connectors need their own switch.
      if (spec.noMcpServers) env.ENABLE_CLAUDEAI_MCP_SERVERS = 'false';
      sessionCost = new ClaudeSessionCost(spec.sessionId, spec.resume === true, spec.cwd, env.CLAUDE_CONFIG_DIR);
      // Mock auth replays share one marker directory across worktrees.
      if (this.bin === mockClaudePath()) env.CEZ_HOME = resolvePath(cezarHomeDir(env));
      const [file, argv] = disclaimedCommand(this.bin, args, env);
      child = nodeSpawn(file, argv, { cwd: spec.cwd, env });
    } catch (err) {
      mcpConfig?.cleanup();
      promptFile?.cleanup();
      settingsFile?.cleanup();
      throw wrapSpawnError(err, this.bin);
    }

    // A write racing the child's exit reports EPIPE as an async 'error', which the try/catch in
    // sendMessage cannot see; unhandled, it kills the server (acfb01e4). Exit owns settlement.
    child.stdin.on('error', () => {});
    let stdinOpen = true;
    let autoEndTimer: NodeJS.Timeout | undefined;
    let eofTermTimer: NodeJS.Timeout | undefined;
    let eofKillTimer: NodeJS.Timeout | undefined;
    let hardKillTimer: NodeJS.Timeout | undefined;

    // Protocol v2 emission — additive alongside v1 (`onEvent` keeps flowing
    // byte-identical); the channel is `opts.onUiEvent` (RunManager wiring
    // lands in R2 step 2.1). The mapper never throws, but a defect in it
    // must still never disturb the v1 stream — hence the belt-and-braces try.
    let uiState = createClaudeUiState({ fallbackSessionId: spec.sessionId });
    const emitUi = (map: (state: typeof uiState) => ClaudeUiMapping): void => {
      try {
        const mapped = map(uiState);
        uiState = mapped.state;
        if (opts.onUiEvent) {
          for (const event of mapped.events) opts.onUiEvent(event);
        }
      } catch {
        // v2 mapping is best-effort; v1 consumers stay unaffected.
      }
    };

    const sendMessage = (content: ContentBlock[]): boolean => {
      if (!stdinOpen) return false;
      // A follow-up inside the reopen window cancels the scheduled close.
      if (autoEndTimer) {
        clearTimeout(autoEndTimer);
        autoEndTimer = undefined;
      }
      const line = JSON.stringify({
        type: 'user',
        message: { role: 'user', content },
        session_id: spec.sessionId,
      });
      try {
        child.stdin.write(`${line}\n`);
        // Each user message written to stdin begins a turn (§7.1).
        emitUi(claudeTurnStarted);
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        onEvent?.({ type: 'note', message: `claude: stdin write failed: ${message}` });
        return false;
      }
    };

    // Set the moment WE signal the child — the EOF watchdog, a cancel, or the
    // inactivity kill switch. claude installs its own SIGTERM handler and exits
    // 143 instead of dying from the signal, so without this flag our own
    // teardown reads as an agent failure (#703).
    let terminatedByCezar = false;
    const signalChild = (signal: 'SIGTERM' | 'SIGKILL'): void => {
      terminatedByCezar = true;
      child.kill(signal);
    };
    // Every watchdog below asks "is the child still alive?" — and that question
    // is NOT `child.killed`, which only reports signal delivery. claude handles
    // SIGTERM itself, so `killed` is true while the process runs on; escalation
    // has to follow real termination or it never fires (#844).
    const hasExited = trackChildExit(child);
    child.once('exit', () => {
      stdinOpen = false;
    });

    const end = (): void => {
      if (!stdinOpen) return;
      stdinOpen = false;
      try {
        child.stdin.end();
      } catch {
        // already gone
      }
      eofTermTimer = setTimeout(() => {
        if (!hasExited()) signalChild('SIGTERM');
        eofKillTimer = setTimeout(() => {
          if (!hasExited()) signalChild('SIGKILL');
        }, EOF_KILL_GRACE_MS);
        eofKillTimer.unref?.();
      }, EOF_TERM_GRACE_MS);
      eofTermTimer.unref?.();
    };

    const interrupt = (): void => {
      stdinOpen = false;
      if (!hasExited()) signalChild('SIGTERM');
    };

    const hardStop = (): void => {
      interrupt();
      if (hardKillTimer || hasExited()) return;
      hardKillTimer = setTimeout(() => {
        if (!hasExited()) signalChild('SIGKILL');
      }, 1_000);
      hardKillTimer.unref?.();
    };

    // Permission prompts (`can_use_tool`): the CLI blocks on each until it gets a control_response,
    // so the queue is answered out of band, never as a user turn. A user line written meanwhile does
    // NOT cancel or answer the prompt: claude 2.1.332 holds it and folds it into the same turn once
    // the control_response arrives (live probe), so `sendMessage` stays write-through and the run
    // stays parked while a prompt is pending. Only a prompt that has the prompt tool on is queued.
    // `shown` makes raising a card idempotent (a cancel and the post-answer raise can both fire).
    const pendingPermissions: Array<{ request: ClaudePermissionRequest; shown: boolean }> = [];
    const cardId = (request: ClaudePermissionRequest): string => `${CLAUDE_PERMISSION_ASK_PREFIX}${request.requestId}`;
    // A write racing the child's exit fails asynchronously on the stream (swallowed above), so only a
    // still-open, still-writable stdin counts as delivered.
    const writeControl = (frame: Record<string, unknown>): boolean => {
      if (!stdinOpen || !child.stdin.writable) return false;
      try {
        child.stdin.write(`${JSON.stringify(frame)}\n`);
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        onEvent?.({ type: 'note', message: `claude: stdin write failed: ${message}` });
        return false;
      }
    };
    const raiseHeadPermission = (): void => {
      const head = pendingPermissions[0];
      if (!head || head.shown) return;
      head.shown = true;
      try {
        opts.onUiEvent?.(claudePermissionCard(head.request));
      } catch {
        // a cockpit-side defect must not stop the stream
      }
    };
    const denyNow = (request: ClaudePermissionRequest, result: ClaudePermissionResult, note: string): void => {
      onEvent?.({ type: 'note', message: note });
      writeControl(claudeControlSuccess(request.requestId, result));
    };
    const closePermission = (request: ClaudePermissionRequest, reason: 'expired' | 'retracted', detail: string): void => {
      try {
        opts.onUiEvent?.(askClosedEvent(cardId(request), { reason, detail }));
      } catch {
        // as above
      }
    };
    const handleControl = (control: ClaudeControlMessage): void => {
      if (control.kind === 'unsupported') {
        writeControl(claudeControlError(control.requestId, `cezar does not support the ${control.subtype} control request`));
        return;
      }
      if (control.kind === 'cancel') {
        const at = pendingPermissions.findIndex((p) => p.request.requestId === control.requestId);
        if (at < 0) return;
        const [gone] = pendingPermissions.splice(at, 1);
        closePermission(gone!.request, 'retracted', 'Claude withdrew the permission prompt');
        if (at === 0) raiseHeadPermission();
        return;
      }
      const { request } = control;
      const autoDeny = claudeAutoDeny(request);
      if (autoDeny) {
        denyNow(request, autoDeny, `claude: denied ${request.toolName} (cezar cannot show it; Claude was told to ask in its reply)`);
      } else if (promptTool && opts.onUiEvent && opts.canAskPermission?.() === true) {
        pendingPermissions.push({ request, shown: false });
        raiseHeadPermission();
      } else {
        // An autonomous or headless run keeps the refusal: a park only a human could end is worse.
        denyNow(request, claudeNobodyAnswersDeny(request), `claude: refused ${request.toolName} (nobody can answer permission prompts in this run)`);
      }
    };
    const respondPermission = (requestId: string, text: string): boolean => {
      const at = pendingPermissions.findIndex((p) => requestId === cardId(p.request));
      if (at < 0) return false;
      const { request } = pendingPermissions[at]!;
      // A failed write keeps the prompt, so the card stays answerable or expires with the session.
      if (!writeControl(claudeControlSuccess(request.requestId, claudePermissionAnswer(request, text)))) return false;
      pendingPermissions.splice(at, 1);
      // Deferred: the caller's own "resumed" bookkeeping runs right after this returns and must not
      // overwrite the park the next card sets.
      if (at === 0 && pendingPermissions.length > 0) setImmediate(raiseHeadPermission);
      return true;
    };
    const expirePermissions = (): void => {
      for (const { request } of pendingPermissions.splice(0)) {
        closePermission(request, 'expired', 'the Claude session ended before this permission prompt was answered');
      }
    };

    // Seed the first user message — the same path every follow-up takes.
    // Pasted task screenshots (spec.images) ride along as leading blocks.
    sendMessage([...(spec.images ?? []), { type: 'text', text: spec.userPrompt }]);

    const toolCalls: AgentToolCallRecord[] = [];
    const textChunks: string[] = [];
    let tokensUsed = 0;
    let sawUsage = false;
    let initModel: string | undefined;
    const lastUsageStatus = new Map<unknown, string>();
    let spawnFailed: Error | null = null;

    child.on('error', (err: NodeJS.ErrnoException) => {
      spawnFailed = wrapSpawnError(err, this.bin);
    });

    const stderrChunks: string[] = [];
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => stderrChunks.push(chunk));

    // Optional inactivity kill switch (disabled for interactive sessions).
    const limitMs = spec.timeoutMs ?? this.timeoutMs;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const deadline = armInactivityDeadline(limitMs, () => {
      timedOut = true;
      if (pendingPermissions.length > 0) {
        onEvent?.({ type: 'note', message: 'claude: stopped by the inactivity timeout while a permission prompt was still unanswered' });
      }
      interrupt();
      child.stdout.destroy();
      killTimer = setTimeout(() => {
        if (!hasExited()) signalChild('SIGKILL');
      }, KILL_GRACE_MS);
      killTimer.unref?.();
    });

    const result = (async (): Promise<AgentRunResult> => {
      try {
        for await (const line of readNdjson(child.stdout)) {
          if (timedOut) break;
          deadline.touch();
          let msg: ClaudeStreamMessage;
          try {
            msg = JSON.parse(line) as ClaudeStreamMessage;
          } catch {
            onEvent?.({ type: 'note', message: `claude: skipped unparseable stream line: ${truncate(line)}` });
            continue;
          }

          // Control frames are a request/response channel, not conversation: never mapped.
          const control = parseClaudeControlLine(msg);
          if (control) {
            handleControl(control);
            continue;
          }

          emitUsageWindows(spec.onUsageWindows, normalizeClaudeUsageWindows(msg) ?? normalizeClaudeTerminalUsageLimit(msg));

          // Claude reports `error_during_execution` while reacting to our
          // teardown signal. Once cezar has signalled the child, that frame
          // describes the intentional stop rather than an agent failure.
          // Normalize only this precise wire shape so genuine result errors
          // (authentication, limits, malformed sessions) stay authoritative.
          const normalized = normalizeIntentionalTeardownResult(msg, terminatedByCezar || receivedOwnSignalSince(startedAt));
          const raw = normalized as { type?: unknown; subtype?: unknown; model?: unknown; session_id?: unknown };
          const isInit = raw.type === 'system' && raw.subtype === 'init';
          if (isInit && typeof raw.session_id === 'string') sessionCost.identify(raw.session_id);
          // Both v1 and v2 read this turn's own cost, never the session's running total.
          const mappedMessage = raw.type === 'result' ? sessionCost.result(normalized) : normalized;
          emitUi((state) => mapClaudeMessage(mappedMessage, state));

          if (isInit && typeof raw.model === 'string') initModel = raw.model;
          if (isInit) {
            const servers = claudeMcpServers(mappedMessage);
            if (servers) onEvent?.(servers);
          }
          const status = claudeUsageStatus(mappedMessage, initModel);
          // Every content block repeats its message's usage, so only a changed reading goes out.
          const statusKey = status === undefined ? '' : JSON.stringify(status);
          if (status !== undefined && statusKey !== lastUsageStatus.get(raw.type)) {
            lastUsageStatus.set(raw.type, statusKey);
            onEvent?.({ type: 'usage-status', status });
          }

          let delta = 0;
          try {
            delta = handleClaudeMessage(mappedMessage, { toolCalls, textChunks, onEvent });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            onEvent?.({ type: 'note', message: `claude: skipped malformed event (${msg.type ?? 'unknown'}): ${message}` });
            continue;
          }
          if (delta > 0) {
            sawUsage = true;
            tokensUsed += delta;
            onEvent?.({ type: 'token-usage', tokensUsed });
          }

          if (mappedMessage.type === 'result') {
            const usd = mappedMessage.total_cost_usd;
            if (typeof usd === 'number' && Number.isFinite(usd) && usd >= 0) {
              onEvent?.({ type: 'cost', usd });
            }
            onEvent?.({ type: 'turn-end' });
            if (opts.autoEndAfterFirstTurn && stdinOpen && !autoEndTimer) {
              autoEndTimer = setTimeout(end, AUTO_END_DELAY_MS);
              autoEndTimer.unref?.();
            }
          }
        }
      } catch (err) {
        // A timeout destroys stdout, which surfaces here as a premature-close
        // error — expected; rethrow anything else.
        if (!timedOut) throw err;
      } finally {
        deadline.clear();
        if (killTimer) clearTimeout(killTimer);
        if (hardKillTimer) clearTimeout(hardKillTimer);
        if (autoEndTimer) clearTimeout(autoEndTimer);
        stdinOpen = false;
        expirePermissions();
        // stdout closed: the CLI read `--mcp-config` at startup long ago, so the file can go.
        mcpConfig?.cleanup();
        promptFile?.cleanup();
        settingsFile?.cleanup();
      }

      const exitCode = await waitForExit(child);
      if (eofTermTimer) clearTimeout(eofTermTimer);
      if (eofKillTimer) clearTimeout(eofKillTimer);

      if (spawnFailed) throw spawnFailed;

      const text = textChunks.join('\n').trim();

      if (timedOut) {
        onEvent?.({ type: 'error', message: inactivityTimeoutMessage('claude CLI', limitMs, deadline.expiredBy) });
        onEvent?.({ type: 'done' });
        return { text, toolCalls, tokensUsed, sessionId: spec.sessionId };
      }

      // A session cezar itself tore down (EOF watchdog after `end()`, or a
      // cancel) exits 143/137 — that is our own signal coming back, not an
      // agent failure, so it settles on the normal path with a note (#703).
      if (terminatedByCezar && isSignalTerminationExit(exitCode)) {
        onEvent?.({
          type: 'note',
          message: `claude CLI did not exit on its own after close; terminated by cezar (code ${exitCode})`,
        });
        onEvent?.({ type: 'done' });
        return { text, toolCalls, tokensUsed, sessionId: spec.sessionId };
      }

      // The signal reached cezar too (Ctrl-C, a unit stop, a logout): its shutdown, not a crash.
      // Unsettled, the run stays `running` for boot recovery (telemetry 3ac6bbe3).
      const ownSignal = terminatedByCezar ? undefined : await ownSignalBehindExit(exitCode, startedAt);
      if (ownSignal) {
        await holdForOwnShutdown();
        const msg = ownShutdownExitMessage('claude CLI', ownSignal, exitCode!);
        onEvent?.({ type: 'error', message: msg });
        throw new Error(msg);
      }

      if (exitCode !== 0 && exitCode !== null) {
        const msg = claudeExitMessage(exitCode, stderrChunks.join(''));
        onEvent?.({ type: 'error', message: msg });
        throw new Error(msg);
      }

      if (!sawUsage) {
        onEvent?.({ type: 'note', message: 'token usage not reported by claude CLI' });
      }

      onEvent?.({ type: 'done' });
      return { text, toolCalls, tokensUsed, sessionId: spec.sessionId };
    })();

    const session: AgentSession = {
      result,
      sendMessage,
      end,
      interrupt,
      hardStop,
      pid: child.pid,
      get open() {
        return stdinOpen;
      },
      respondPermission,
      hasPendingPermission: (requestId?: string) =>
        requestId === undefined ? pendingPermissions.length > 0 : pendingPermissions.some((p) => cardId(p.request) === requestId),
    };
    this.lastSession = session;
    return session;
  }
}

/** What a read-only Claude run is denied, whatever the user's or repo's settings allow. */
export const CLAUDE_WRITE_TOOLS = ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

/**
 * Build the headless argv. `--print` is spelled out because both stream-json
 * formats are documented as "only works with --print"; `--input-format
 * stream-json` reads user messages from stdin; `--output-format stream-json
 * --verbose` gives per-event NDJSON, and `--include-partial-messages` adds the
 * `stream_event` token deltas the cockpit renders as live text;
 * `--permission-mode dontAsk` keeps headless runs non-interactive: tools in
 * `--allowedTools` proceed and everything else is denied instead of prompting.
 * `CEZ_APPROVAL_GATE=1` selects Claude's `acceptEdits` mode without a prompt
 * channel; a project's `claudePermissionMode` adds `--permission-prompt-tool
 * stdio`, so Claude asks and the cockpit answers (`claudePromptMode`).
 */
export function buildClaudeArgs(
  spec: AgentRunSpec,
  env: NodeJS.ProcessEnv = process.env,
  mcpConfigPath?: string,
  systemPromptFilePath?: string,
  settingsPath?: string,
  promptsAnswerable = false,
): string[] {
  const { permissionMode, promptTool } = claudePromptMode(spec, env);
  const args: string[] = [
    '--print',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-mode',
    permissionMode,
  ];
  // Without it a prompting mode silently denies; with it the CLI sends `can_use_tool` on stdout.
  if (promptTool) args.push('--permission-prompt-tool', 'stdio');
  if (systemPromptFilePath) args.push('--append-system-prompt-file', systemPromptFilePath);
  else args.push('--append-system-prompt', appendClaudeSystemPrompt(spec.systemPrompt, promptsAnswerable && promptTool));
  // Pin the session so the user can `claude --resume <sessionId>` in the repo
  // to take over interactively after a run. With `resume` we reopen the
  // existing on-disk conversation instead.
  if (spec.sessionId) {
    if (spec.resume) {
      args.push('--resume', spec.sessionId);
    } else {
      args.push('--session-id', spec.sessionId);
    }
  }
  const allowed = buildAllowedTools(spec.allowedTools ?? [], spec.bashAllowlist);
  const artifactsRule = claudeArtifactsWriteRule(spec);
  if (artifactsRule) allowed.push(artifactsRule);
  // Private MCP servers (spec 2026-10-07-private-project-mcp): `--mcp-config` ADDS to the repo's
  // own MCP config, and their tools are allowed — `dontAsk` would deny every one of them otherwise.
  if (spec.noMcpServers) {
    args.push('--strict-mcp-config');
  } else if (mcpConfigPath && spec.mcpServers?.length) {
    args.push('--mcp-config', mcpConfigPath);
    allowed.push(...claudeMcpAllowRules(spec.mcpServers));
  }
  if (allowed.length > 0) {
    args.push('--allowedTools', allowed.join(','));
  }
  // A prefix rule cannot say "gh api GET only"; the hook can, and its deny outranks the allow rules.
  const bashAllowed = allowed.some((rule) => rule === 'Bash' || rule.startsWith('Bash('));
  const hook = spec.bashHookCommand && bashAllowed
    ? { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: spec.bashHookCommand }] }] } }
    : {};
  // For a command the user's Bash sandbox would cut off from the loopback cockpit. Claude honors
  // this key from `--settings` only for a plain command: every pipe stage must match, and a
  // heredoc, a substitution, `?`, `*`, `[` or a leading `~` keeps it sandboxed (#2258).
  const sandbox = spec.sandboxExcludedCommands?.length && bashAllowed
    ? { sandbox: { excludedCommands: spec.sandboxExcludedCommands } }
    : {};
  if (Object.keys(hook).length > 0 || Object.keys(sandbox).length > 0) {
    args.push('--settings', JSON.stringify({ ...hook, ...sandbox }));
  }
  // Settings allow rules widen `--allowedTools`; only a deny rule outranks them.
  const disallowed = [...(spec.enforceReadOnly ? CLAUDE_WRITE_TOOLS : []), ...claudeReadOnlyPathRules(spec.readOnlyPaths)];
  if (disallowed.length > 0) args.push('--disallowedTools', disallowed.join(','));
  if (spec.model) {
    args.push('--model', spec.model);
  }
  // Session-scoped, so a resumed process must be told again (#808).
  if (spec.reasoningEffort) {
    args.push('--effort', spec.reasoningEffort);
  }
  for (const dir of spec.additionalDirectories ?? []) {
    args.push('--add-dir', dir);
  }
  if (artifactsRule && !spec.additionalDirectories?.includes(spec.artifactsWriteDir!)) args.push('--add-dir', spec.artifactsWriteDir!);
  if (settingsPath && spec.claudeSettings) args.push('--settings', settingsPath);
  return args;
}

/** `system/init`'s `mcp_servers` and `tools`, as a `mcp-servers` event; undefined when it has neither. */
export function claudeMcpServers(msg: unknown): Extract<AgentEvent, { type: 'mcp-servers' }> | undefined {
  const raw = msg as { mcp_servers?: unknown; tools?: unknown };
  if (!Array.isArray(raw.mcp_servers) && !Array.isArray(raw.tools)) return undefined;
  const servers = (Array.isArray(raw.mcp_servers) ? raw.mcp_servers : []).flatMap((server: unknown) => {
    const { name, status } = (server ?? {}) as { name?: unknown; status?: unknown };
    return typeof name === 'string' ? [{ name, status: typeof status === 'string' ? status : 'unknown' }] : [];
  });
  const tools = (Array.isArray(raw.tools) ? raw.tools : []).filter((tool: unknown): tool is string => typeof tool === 'string');
  return { type: 'mcp-servers', servers, tools };
}

/** `AgentRunSpec.claudeSettings` in a `0600` temp file for `--settings`: a hook command stays out of `ps`. */
export function writeClaudeSettingsFile(
  settings: Record<string, unknown> | undefined,
): { path: string; cleanup: () => void } | undefined {
  if (!settings) return undefined;
  try {
    const dir = mkdtempSync(join(tmpdir(), 'cez-settings-'));
    const path = join(dir, 'settings.json');
    writeFileSync(path, JSON.stringify(settings), { mode: 0o600 });
    return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  } catch {
    return undefined;
  }
}

/** Windows caps a command line at 32,767 chars; a skill body plus cezar's rules blows past it (#1584). */
const WINDOWS_ARGV_PROMPT_LIMIT = 8_000;

/** Whether the system prompt must travel in a file instead of argv. Never true off Windows. */
export function shouldSpoolSystemPrompt(
  prompt: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === 'win32' && prompt.length > WINDOWS_ARGV_PROMPT_LIMIT;
}

/** Write an oversized system prompt to a `0600` temp file for `--append-system-prompt-file`. */
export function writeClaudeSystemPromptFile(
  prompt: string,
  platform: NodeJS.Platform = process.platform,
): { path: string; cleanup: () => void } | undefined {
  if (!shouldSpoolSystemPrompt(prompt, platform)) return undefined;
  try {
    const dir = mkdtempSync(join(tmpdir(), 'cez-prompt-'));
    const path = join(dir, 'system-prompt.md');
    writeFileSync(path, prompt, { mode: 0o600 });
    return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  } catch {
    return undefined;
  }
}

/**
 * Write the private MCP servers to a `0600` temp file for `--mcp-config` — a file, not an inline
 * JSON argument, because argv is world-readable through `ps` and these entries carry tokens.
 * Removed when the session's process exits. Undefined when there is nothing to attach or the
 * temp dir is unwritable (the run then simply starts without them).
 */
export function writeClaudeMcpConfig(
  servers: readonly PrivateMcpServer[] | undefined,
): { path: string; cleanup: () => void } | undefined {
  if (!servers?.length) return undefined;
  try {
    const dir = mkdtempSync(join(tmpdir(), 'cez-mcp-'));
    const path = join(dir, 'mcp.json');
    writeFileSync(path, JSON.stringify(toClaudeMcpConfig(servers)), { mode: 0o600 });
    return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  } catch {
    return undefined;
  }
}

/**
 * A path-scoped `Edit(//<dir>/**)` rule — Claude applies Edit rules to every file-writing tool —
 * for a restricted step's own artifacts directory. Undefined when the step may write anyway, when
 * it must not write at all, or when the path cannot be expressed as a rule.
 */
export function claudeArtifactsWriteRule(spec: Pick<AgentRunSpec, 'artifactsWriteDir' | 'allowedTools' | 'enforceReadOnly'>): string | undefined {
  const dir = spec.artifactsWriteDir;
  if (!dir || spec.enforceReadOnly || !spec.allowedTools) return undefined;
  if (spec.allowedTools.some((t) => t === 'Write' || t === 'Edit' || t === 'MultiEdit')) return undefined;
  // Absolute POSIX paths only, and nothing a rule would read as a glob or end its specifier with.
  if (!dir.startsWith('/') || /[*?[\](),\n]/.test(dir)) return undefined;
  return `Edit(/${dir.replace(/\/+$/, '')}/**)`;
}

/** `Edit(//<path>)` deny rules — Claude applies Edit rules to every file-writing tool. A path a
 *  rule cannot express (relative, or with a rule's own delimiters) is dropped, never widened. */
export function claudeReadOnlyPathRules(paths: readonly string[] | undefined): string[] {
  return (paths ?? []).filter((p) => p.startsWith('/') && !/[?[\](),\n]/.test(p)).map((p) => `Edit(/${p})`);
}

/**
 * Map `allowedTools` onto claude's `--allowedTools` syntax. `Bash` with a
 * `bashAllowlist` becomes one `Bash(<prefix>:*)` entry per allowed prefix;
 * `Bash` with no allowlist stays plain `Bash`.
 */
export function buildAllowedTools(allowedTools: string[], bashAllowlist?: string[]): string[] {
  const out: string[] = [];
  for (const tool of allowedTools) {
    if (tool === 'Bash' && bashAllowlist && bashAllowlist.length > 0) {
      for (const prefix of bashAllowlist) {
        const p = prefix.trim();
        if (p) out.push(`Bash(${p}:*)`);
      }
    } else {
      out.push(tool);
    }
  }
  return out;
}

function truncate(s: string, max = 200): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** `claude --resume <id>` for a transcript the CLI no longer has — typically pruned by its own
 *  `cleanupPeriodDays` (default 30) between two Continues of a long-lived task. */
export function isClaudeMissingSessionError(message: string): boolean {
  return /No conversation found with session ID/i.test(message);
}

/** Path to the bundled mock (`scripts/mock-claude.mjs`), for CEZ_DRY_RUN=1. */
function mockClaudePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // here = <pkg>/dist/core (built) or <pkg>/src/core (tsx dev).
  return resolvePath(here, '..', '..', 'scripts', 'mock-claude.mjs');
}

// ---- stream-json event handling -------------------------------------------

interface ClaudeStreamMessage {
  type?: string;
  subtype?: string;
  message?: {
    role?: string;
    content?: unknown[];
    usage?: RawUsage;
  };
  // `result` messages carry these at the top level.
  result?: string;
  usage?: RawUsage;
  is_error?: boolean;
  total_cost_usd?: number;
}

function normalizeIntentionalTeardownResult(
  msg: ClaudeStreamMessage,
  terminatedByCezar: boolean,
): ClaudeStreamMessage {
  if (
    terminatedByCezar
    && msg.type === 'result'
    && msg.is_error === true
    && msg.subtype === 'error_during_execution'
  ) {
    return { ...msg, subtype: 'success', is_error: false };
  }
  return msg;
}

function handleClaudeMessage(
  msg: ClaudeStreamMessage,
  ctx: {
    toolCalls: AgentToolCallRecord[];
    textChunks: string[];
    onEvent?: (e: AgentEvent) => void;
  },
): number {
  if (msg.type === 'assistant' && msg.message?.content) {
    for (const block of msg.message.content) {
      const b = block as { type?: string; text?: string; id?: string; name?: string; input?: unknown };
      if (b.type === 'text' && typeof b.text === 'string') {
        ctx.textChunks.push(b.text);
        ctx.onEvent?.({ type: 'text', text: b.text });
      } else if (b.type === 'tool_use' && b.id && b.name) {
        ctx.toolCalls.push({ id: b.id, name: b.name, input: b.input });
        ctx.onEvent?.({ type: 'tool-call', id: b.id, tool: b.name, input: b.input });
      }
    }
    // Assistant-frame usage belongs to the individual API calls inside this
    // agentic turn. Claude's terminal result frame already aggregates those
    // calls, so adding both sources inflates the run total (#716). Keep these
    // frames presentation-only; the result branch below is authoritative,
    // matching the v2 `usage.updated` mapping in AGENT_PROTOCOL.md.
    return 0;
  }

  if (msg.type === 'user' && msg.message?.content) {
    for (const block of msg.message.content) {
      const b = block as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean };
      if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        ctx.onEvent?.({
          type: 'tool-result',
          toolCallId: b.tool_use_id,
          result: stringifyToolResultContent(b.content),
          isError: b.is_error === true,
        });
        // Screenshots and other images inside the result get their own
        // events — the text path above renders them as a placeholder.
        for (const img of toolResultImageBlocks(b.content)) {
          ctx.onEvent?.({ type: 'image', mediaType: img.media_type, data: img.data });
        }
      }
    }
    return 0;
  }

  if (msg.type === 'result') {
    // Final message of a turn: `result` is the full assistant text; only fall
    // back to it if we never saw streamed assistant text blocks.
    if (typeof msg.result === 'string' && ctx.textChunks.length === 0) {
      ctx.textChunks.push(msg.result);
      ctx.onEvent?.({ type: 'text', text: msg.result });
    }
    if (msg.is_error) {
      ctx.onEvent?.({
        type: 'error',
        // `API Error: 400 [400]: {"error":{…}}` from a gateway reads as its type and message (eb4b12dc).
        message: typeof msg.result === 'string' && msg.result.trim() !== ''
          ? unwrapJsonErrorEnvelope(msg.result)
          : `claude reported result error${msg.subtype ? ` (${msg.subtype})` : ''}`,
      });
    }
    return costWeightedTokens(msg.usage);
  }

  // system/init and anything else: nothing actionable.
  return 0;
}

// stringify/image helpers moved to claude-ui-mapper.ts (shared by v1 and v2).

// ---- subprocess plumbing --------------------------------------------------

/** The signals a `128 + n` exit names; only reached when cezar did NOT signal the child. */
const EXIT_SIGNALS: Record<number, string> = { 1: 'SIGHUP', 2: 'SIGINT', 3: 'SIGQUIT', 6: 'SIGABRT', 9: 'SIGKILL', 11: 'SIGSEGV', 13: 'SIGPIPE', 15: 'SIGTERM' };

/** A failed exit, naming the signal behind a `128 + n` code — a bare "code 129" (telemetry 046a0525)
 *  read as a crash, and cezar never sends SIGHUP (Windows raises it when the console closes). */
export function claudeExitMessage(exitCode: number, stderr: string): string {
  const signal = exitCode > 128 ? EXIT_SIGNALS[exitCode - 128] : undefined;
  const hint = signal === 'SIGHUP'
    ? ' (SIGHUP: the terminal or console it ran under went away — cezar did not stop it)'
    : signal ? ` (${signal}: a signal cezar did not send)` : '';
  const tail = stderr.trim();
  const detail = tail ? ` — ${tail.split('\n').slice(-3).join(' | ')}` : '';
  return `claude CLI exited with code ${exitCode}${hint}${detail}`;
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode != null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => {
    let done = false;
    const fin = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(safety);
      resolve(code);
    };
    child.once('close', (code) => fin(code));
    child.once('exit', (code) => fin(code));
    // Don't swallow a late error as a clean null exit — fall back to the
    // child's own exit code (which is non-null/non-zero on failure).
    child.once('error', () => fin(child.exitCode ?? null));
    // A SIGKILLed process may never emit 'close' through some edge cases.
    const safety = setTimeout(
      () => fin(child.exitCode ?? null),
      EOF_TERM_GRACE_MS + EOF_KILL_GRACE_MS + KILL_GRACE_MS + 5_000,
    );
    safety.unref?.();
  });
}

function wrapSpawnError(err: unknown, bin: string): Error {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') {
    return new Error(
      `\`${bin}\` not found on PATH — install Claude Code (https://claude.com/claude-code) and run \`claude\` once to log in`,
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}

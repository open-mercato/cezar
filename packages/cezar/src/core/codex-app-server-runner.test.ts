import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from './agent-runner.js';
import { KILL_GRACE_MS } from './claude-cli-runner.js';
import { CodexAppServerRunner, codexStageOnlyArgs, codexThreadOverrides, userInputAnswers } from './codex-app-server-runner.js';
import { RunStore } from '../runs/store.ts';

const MOCK_BIN = fileURLToPath(
  new URL('./__fixtures__/codex/mock-codex-app-server.mjs', import.meta.url),
);

type RpcRequest = { method?: string; params?: Record<string, unknown> };

function requestsFrom(file: string): RpcRequest[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RpcRequest);
}

async function waitForRequest(file: string, method: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (requestsFrom(file).some((request) => request.method === method)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for mock Codex request: ${method}`);
}

function paramsFor(requests: RpcRequest[], method: string): Record<string, unknown> {
  const request = requests.find((candidate) => candidate.method === method);
  if (!request) throw new Error(`missing mock Codex request: ${method}`);
  return request.params ?? {};
}

/** Only the escalation tests below swap the child out; every other test in this
 *  file keeps spawning the real mock app-server through the untouched `spawn`. */
const spawnHook = vi.hoisted(() => ({ override: null as null | (() => unknown) }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) =>
      spawnHook.override ? spawnHook.override() : actual.spawn(...args),
  };
});

/**
 * #703 backend parity — `claude-cli-runner.test.ts` proves the Claude half;
 * this is the same session-level shape for Codex. The fix only holds if BOTH
 * runners classify a cezar-initiated 128+signal exit as a teardown note rather
 * than an agent failure, so the Codex branch needs its own regression.
 */
describe('a teardown cezar initiated (codex app-server)', () => {
  it('settles the session instead of failing it when the app-server exits 143', async () => {
    const runner = new CodexAppServerRunner({ bin: MOCK_BIN, timeoutMs: 0 });
    const events: AgentEvent[] = [];
    let sawText: () => void = () => {};
    const firstText = new Promise<void>((resolve) => {
      sawText = resolve;
    });
    const session = runner.startSession(
      // MOCK_CODEX_IGNORE_EOF makes the mock stay deaf to stdin EOF and exit
      // 143 on SIGTERM — the real shape reported in #703.
      { userPrompt: 'check the working tree', cwd: process.cwd(), env: { MOCK_CODEX_IGNORE_EOF: '1' } },
      (event) => {
        events.push(event);
        if (event.type === 'text') sawText();
      },
    );
    await firstText;

    // The cancel path; the EOF watchdog reaches the same `terminatedByCezar`.
    session.interrupt();
    const result = await session.result;

    expect(result.text).toBe('Checking the working tree.');
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'done' });
    expect(
      events.some((e) => e.type === 'note' && e.message.includes('terminated by cezar (code 143)')),
    ).toBe(true);
  }, 15_000);

  it('forces the restricted sandbox for stage-only harness phases', async () => {
    const runner = new CodexAppServerRunner({ bin: MOCK_BIN, timeoutMs: 0 });
    const session = runner.startSession(
      {
        userPrompt: 'review without publishing',
        cwd: process.cwd(),
        env: { CEZ_HARNESS_STAGE_ONLY: '1' },
      },
      undefined,
      { autoEndAfterFirstTurn: true },
    );
    await expect(session.result).resolves.toMatchObject({ sessionId: 'th_mock_1' });
  }, 15_000);

  it('grants only the phase-output directory as a writable root under the stage-only sandbox', async () => {
    // The phase-result contract writes OUTSIDE the worktree (the run's
    // agent-output dir); codex must get it as sandbox_workspace_write.writable_roots
    // or the implementer EPERMs on the one file the driver requires (run d6ebd27c).
    // The wider runs tree must NOT be writable: it holds the guard and the ledger.
    const runner = new CodexAppServerRunner({ bin: MOCK_BIN, timeoutMs: 0 });
    const session = runner.startSession(
      {
        userPrompt: 'implement the phase',
        cwd: process.cwd(),
        env: {
          CEZ_HARNESS_STAGE_ONLY: '1',
          CEZ_HARNESS_OUTPUT_DIR: '/data/runs/x-harness/agent-output',
          MOCK_CODEX_REQUIRE_WRITABLE_ROOTS: '/data/runs/x-harness/agent-output',
        },
        additionalDirectories: ['/data/runs', '/tmp/attachments'],
      },
      undefined,
      { autoEndAfterFirstTurn: true },
    );
    await expect(session.result).resolves.toMatchObject({ sessionId: 'th_mock_1' });
  }, 15_000);

  // effort rode on thread/start, which codex ignores, so the Effort picker did nothing.
  it('sends the native reasoning effort on turn/start', async () => {
    const session = new CodexAppServerRunner({ bin: MOCK_BIN, timeoutMs: 0 }).startSession(
      { userPrompt: 'hi', cwd: process.cwd(), reasoningEffort: 'xhigh', env: { MOCK_CODEX_REQUIRE_EFFORT: 'xhigh' } },
      undefined,
      { autoEndAfterFirstTurn: true },
    );
    await expect(session.result).resolves.toMatchObject({ sessionId: 'th_mock_1' });
  }, 15_000);

  // the user's [mcp_servers] and network setting carried into stage-only phases,
  // and MCP tools run outside the workspace-write sandbox.
  it('disables every configured MCP server and the network for a stage-only phase', () => {
    const home = mkdtempSync(join(tmpdir(), 'cez-codex-home-'));
    const cwd = mkdtempSync(join(tmpdir(), 'cez-codex-cwd-'));
    try {
      writeFileSync(join(home, 'config.toml'), '[mcp_servers.github]\ncommand = "gh-mcp"\n\n[mcp_servers."Figma Desktop"]\nurl = "http://127.0.0.1:3845/mcp"\n');
      mkdirSync(join(cwd, '.codex'));
      writeFileSync(join(cwd, '.codex', 'config.toml'), '[mcp_servers.docs-2]\nurl = "https://x"\n');
      expect(codexStageOnlyArgs(cwd, { CODEX_HOME: home }, '/out')).toEqual([
        '-c', 'sandbox_workspace_write.writable_roots=["/out"]',
        '-c', 'sandbox_workspace_write.network_access=false',
        '-c', 'sandbox_workspace_write.exclude_slash_tmp=true',
        '-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true',
        '-c', 'mcp_servers.github.enabled=false',
        '-c', 'mcp_servers.Figma Desktop.enabled=false',
        '-c', 'mcp_servers.docs-2.enabled=false',
      ]);
      // `-c` cannot address a dotted name: refuse rather than leave that server live.
      writeFileSync(join(home, 'config.toml'), '[mcp_servers."odd.name"]\ncommand = "x"\n');
      expect(() => codexStageOnlyArgs(cwd, { CODEX_HOME: home }, '/out')).toThrow(/cannot disable MCP server "odd.name"/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  // on Linux a stage-only phase could write /tmp, where cezar's own scratch files
  // live, and plant a link for the unsandboxed server to follow.
  it('keeps the shared temp dirs out of a stage-only phase, but not the run\'s own TMPDIR', () => {
    const home = mkdtempSync(join(tmpdir(), 'cez-codex-home-'));
    const cwd = mkdtempSync(join(tmpdir(), 'cez-codex-cwd-'));
    try {
      const args = codexStageOnlyArgs(cwd, { CODEX_HOME: home, TMPDIR: '/data/tmp/run-1' }, '/out');
      expect(args).toContain('sandbox_workspace_write.exclude_slash_tmp=true');
      expect(args).toContain('sandbox_workspace_write.exclude_tmpdir_env_var=true');
      expect(args).toContain('sandbox_workspace_write.writable_roots=["/out","/data/tmp/run-1"]');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  // the worktree config was read with a plain readFileSync, so a model-planted FIFO
  // froze the server's thread and a /dev/zero link grew without bound.
  it.skipIf(process.platform === 'win32')('refuses a worktree config that is not a regular file, without blocking', () => {
    const home = mkdtempSync(join(tmpdir(), 'cez-codex-home-'));
    const cwd = mkdtempSync(join(tmpdir(), 'cez-codex-cwd-'));
    try {
      const dotfiles = join(home, 'dotfiles.toml');
      writeFileSync(dotfiles, '[mcp_servers.github]\ncommand = "gh-mcp"\n');
      symlinkSync(dotfiles, join(home, 'config.toml'));
      mkdirSync(join(cwd, '.codex'));
      // A symlinked user config is a dotfiles habit: followed.
      expect(codexStageOnlyArgs(cwd, { CODEX_HOME: home }, '/out')).toContain('mcp_servers.github.enabled=false');

      execFileSync('mkfifo', [join(cwd, '.codex', 'config.toml')]);
      expect(() => codexStageOnlyArgs(cwd, { CODEX_HOME: home }, '/out')).toThrow(/not a readable regular file/);
      rmSync(join(cwd, '.codex', 'config.toml'));
      symlinkSync('/dev/zero', join(cwd, '.codex', 'config.toml'));
      expect(() => codexStageOnlyArgs(cwd, { CODEX_HOME: home }, '/out')).toThrow(/not a readable regular file/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 10_000);

  it('surfaces a failed turn as an AgentEvent error', async () => {
    const runner = new CodexAppServerRunner({ bin: MOCK_BIN, timeoutMs: 0 });
    const events: AgentEvent[] = [];
    const session = runner.startSession(
      { userPrompt: 'mock:turn-failed', cwd: process.cwd() },
      (event) => events.push(event),
      { autoEndAfterFirstTurn: true },
    );

    await session.result;

    expect(events).toContainEqual({ type: 'error', message: 'model unavailable' });
    expect(events).toContainEqual({ type: 'turn-end' });
  }, 15_000);

  it('surfaces a turn/completed whose status is failed as an AgentEvent error', async () => {
    const runner = new CodexAppServerRunner({ bin: MOCK_BIN, timeoutMs: 0 });
    const events: AgentEvent[] = [];
    const session = runner.startSession(
      { userPrompt: 'mock:turn-completed-failed', cwd: process.cwd() },
      (event) => events.push(event),
      { autoEndAfterFirstTurn: true },
    );

    await session.result;

    expect(events).toContainEqual({ type: 'error', message: "The 'fable' model is not supported" });
    expect(events).toContainEqual({ type: 'turn-end' });
  }, 15_000);
});

describe('a model the ChatGPT-plan login cannot use (1350055f)', () => {
  const mockBin = fileURLToPath(
    new URL('./__fixtures__/codex/mock-codex-app-server.mjs', import.meta.url),
  );

  it('names the model cezar sent and where to change it', async () => {
    const events: AgentEvent[] = [];
    const session = new CodexAppServerRunner({ bin: MOCK_BIN, timeoutMs: 0 }).startSession(
      { userPrompt: 'mock:chatgpt-model', cwd: process.cwd(), model: 'gpt-5.1-codex' },
      (event) => events.push(event),
      { autoEndAfterFirstTurn: true },
    );
    await session.result;

    const error = events.find((e) => e.type === 'error');
    expect(error).toEqual({
      type: 'error',
      message:
        "400 invalid_request_error: The 'gpt-5.1-codex' model is not supported when using Codex with a ChatGPT account."
        + ' — "gpt-5.1-codex" needs an OpenAI API-key login: pick another model for the task (auto uses your Codex default),'
        + ' check the workflow step and the Codex default in Settings → Agents, or sign Codex in with an API key',
    });
  }, 15_000);
});

/** Telemetry 4c9de01a: Continue resumed a thread a still-live app-server held the writer lock for. */
describe('resuming a thread another Codex process still holds', () => {
  const mockBin = fileURLToPath(
    new URL('./__fixtures__/codex/mock-codex-app-server.mjs', import.meta.url),
  );
  const resume = async (locked: string) => {
    const events: AgentEvent[] = [];
    const session = new CodexAppServerRunner({ bin: MOCK_BIN, timeoutMs: 0, resumeLockRetryMs: [5, 5] }).startSession(
      { userPrompt: 'continue', cwd: process.cwd(), sessionId: 'th_old', resume: true, env: { MOCK_CODEX_RESUME_LOCKED: locked } },
      (event) => events.push(event),
      { autoEndAfterFirstTurn: true },
    );
    const result = await session.result;
    return { events, result };
  };

  it('resumes the same thread once the other writer lets go', async () => {
    const { events, result } = await resume('2');
    expect(result.sessionId).toBe('th_old');
    expect(events).toContainEqual({ type: 'session', sessionId: 'th_old' });
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(result.text).toBe('Checking the working tree.');
  }, 15_000);

  it('continues in a fork of the thread when the lock is never released', async () => {
    const { events, result } = await resume('always');
    expect(result.sessionId).toBe('fork_of_th_old');
    expect(events).toContainEqual({ type: 'session', sessionId: 'fork_of_th_old' });
    expect(events.some((e) => e.type === 'note' && e.message.includes('continuing in a fork'))).toBe(true);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(result.text).toBe('Checking the working tree.');
  }, 15_000);
});

describe('late Codex teardown events (#1105)', () => {
  const mockBin = fileURLToPath(
    new URL('./__fixtures__/codex/mock-codex-app-server.mjs', import.meta.url),
  );

  it('does not route a teardown follow-up failure into a removed run store', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-1105-'));
    const store = RunStore.open(join(dir, '.ai/cezar'));
    const run = store.createRun({
      title: 't', workflow: 'quick-task', task: 'check the working tree', runner: 'codex', worktree: false,
      steps: [{ id: 'task', name: 'Task', kind: 'agent' }],
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => unhandled.push(error);
    process.on('unhandledRejection', onUnhandled);
    let session: ReturnType<CodexAppServerRunner['startSession']> | undefined;
    try {
      const events: AgentEvent[] = [];
      session = new CodexAppServerRunner({ bin: MOCK_BIN, timeoutMs: 0 }).startSession(
        { userPrompt: 'mock:steer-silent keep going', cwd: dir },
        (event) => {
          events.push(event);
          // A late event would synchronously reproduce the removed-store failure
          // from the issue, including through the floating follow-up catch path.
          store.appendEvent(run.id, { ...event, stepId: 'task' });
        },
      );

      await expect.poll(() => events.some((event) => event.type === 'text'), { timeout: 10_000 }).toBe(true);
      expect(session.sendMessage([{ type: 'text', text: 'Continue' }])).toBe(true);
      session.interrupt();
      store.flush();
      rmSync(dir, { recursive: true, force: true });

      const resultError = await session.result.then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(resultError).toBeInstanceOf(Error);
      expect((resultError as NodeJS.ErrnoException).code).toBe('ENOENT');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      if (session?.open) session.interrupt();
      if (session) {
        await session.result.then(
          () => undefined,
          (error: unknown) => {
            // The removed fixture intentionally makes the late `done` append fail;
            // the assertion above already verifies that exact, expected ENOENT.
            if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          },
        );
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('still rejects the live session when its event callback fails', async () => {
    const session = new CodexAppServerRunner({ bin: MOCK_BIN, timeoutMs: 0 }).startSession(
      { userPrompt: 'check the working tree', cwd: process.cwd() },
      (event) => {
        if (event.type === 'session') throw new Error('active store corruption');
      },
    );

    await expect(session.result).rejects.toThrow('active store corruption');
  }, 15_000);
});

/**
 * #955 — a `contextCompaction` item is internal session maintenance, not the user being
 * handed the next action. The runner is the only layer that can tell the two apart, because
 * `turn/completed` looks identical either way by the time it reaches `RunManager`. These pin
 * the seam: the boundary rides out on the v1 `turn-end` as an ADDITIVE optional `reason`,
 * never as a new event type and never in place of the existing `contextCompaction` tool item.
 *
 * No redacted Luna trace was obtainable, so the fixture is built from the documented wire
 * contract — see the header of `mock-codex-app-server.mjs`.
 */
describe('a turn that ended at a context-compaction boundary (#955)', () => {
  const mockBin = fileURLToPath(
    new URL('./__fixtures__/codex/mock-codex-app-server.mjs', import.meta.url),
  );

  /** Run one scripted prompt to completion and collect the v1 stream. */
  async function collect(userPrompt: string): Promise<AgentEvent[]> {
    const runner = new CodexAppServerRunner({ bin: MOCK_BIN, timeoutMs: 0 });
    const events: AgentEvent[] = [];
    const session = runner.startSession({ userPrompt, cwd: process.cwd() }, (event) => events.push(event), {
      autoEndAfterFirstTurn: true,
    });
    await session.result;
    return events;
  }

  it('marks the turn-end as context-compaction and still emits the tool item', async () => {
    const events = await collect('mock:compaction-hold refactor the parser');
    // ADDITIVE, not a replacement: the "Compacted context" row still renders from the
    // unchanged tool-call/tool-result pair, so nothing that reads v1 today loses a frame.
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'tool-call', tool: 'contextCompaction' }),
    );
    expect(events.filter((e) => e.type === 'turn-end')).toEqual([
      { type: 'turn-end', reason: 'context-compaction' },
    ]);
  }, 15_000);

  it('leaves an ordinary turn-end bare, so old consumers see no new field', async () => {
    const events = await collect('check the working tree');
    expect(events.filter((e) => e.type === 'turn-end')).toEqual([{ type: 'turn-end' }]);
  }, 15_000);

  it('does not claim a compaction boundary when the model spoke after it', async () => {
    // `mock:compaction-done` compacts AFTER a `CEZ:DONE` message. The compaction is still
    // the last ITEM, which is exactly why the runner reports the boundary and `run.ts` —
    // not the runner — owns marker precedence. The text must survive intact either way.
    const events = await collect('mock:compaction-done wrap it up');
    expect(events.some((e) => e.type === 'text' && e.text.includes('CEZ:DONE'))).toBe(true);
  }, 15_000);

  it('never lets a CHILD thread compaction end the parent turn (#600 holds)', async () => {
    const events = await collect('mock:child-compaction fan out');
    // The child's own turn lifecycle is dropped, and its compaction item must not colour
    // the parent's boundary — the parent ended on its own message, so no reason at all.
    expect(events.filter((e) => e.type === 'turn-end')).toEqual([{ type: 'turn-end' }]);
    expect(events.some((e) => e.type === 'text' && e.text.includes('after the sub-agent compacted'))).toBe(true);
  }, 15_000);
});

/**
 * #955, second half — `sendMessage()` answers `true` the moment the frame is written to
 * stdin, long before the app-server's JSON-RPC response settles. `RunManager.deliverMessage`
 * takes that `true` as delivery, clears `waiting` and writes `running`; a later rejection
 * used to surface only as a quiet `note`, so the run sat there looking alive forever. The
 * rejection now speaks with the SAME authority `turn/failed` already has: an `error` event.
 */
describe('an asynchronous turn/start or turn/steer rejection (#955)', () => {
  const mockBin = fileURLToPath(
    new URL('./__fixtures__/codex/mock-codex-app-server.mjs', import.meta.url),
  );

  it('surfaces a refused follow-up turn/start as an error, not a quiet note', async () => {
    const runner = new CodexAppServerRunner({ bin: MOCK_BIN, timeoutMs: 0 });
    const events: AgentEvent[] = [];
    let sawTurnEnd: () => void = () => {};
    const firstTurnEnd = new Promise<void>((resolve) => {
      sawTurnEnd = resolve;
    });
    const session = runner.startSession(
      { userPrompt: 'mock:compaction-reject refactor the parser', cwd: process.cwd() },
      (event) => {
        events.push(event);
        if (event.type === 'turn-end') sawTurnEnd();
      },
    );
    await firstTurnEnd;

    expect(session.sendMessage([{ type: 'text', text: 'Continue' }])).toBe(true);
    await expect
      .poll(() => events.some((e) => e.type === 'error'), { timeout: 10_000 })
      .toBe(true);
    const error = events.find((e) => e.type === 'error');
    expect(error).toMatchObject({ type: 'error', message: expect.stringContaining('busy compacting context') });
    session.end();
    await session.result.catch(() => undefined);
  }, 20_000);

  it('reports a refused turn/steer WITHOUT killing the turn still in flight', async () => {
    // The other half of the rule, and the reason it is not "escalate every rejection": a
    // refused steer leaves no zombie — the turn is genuinely running and `running` is
    // genuinely true. Escalating would interrupt it and throw away real work to report a
    // problem the run does not have. What was lost is the follow-up, and the note says so.
    const runner = new CodexAppServerRunner({ bin: MOCK_BIN, timeoutMs: 0 });
    const events: AgentEvent[] = [];
    let sawText: () => void = () => {};
    const firstText = new Promise<void>((resolve) => {
      sawText = resolve;
    });
    const session = runner.startSession(
      // The turn stays OPEN, so the follow-up steers it instead of starting a new turn.
      { userPrompt: 'mock:steer-reject keep going', cwd: process.cwd() },
      (event) => {
        events.push(event);
        if (event.type === 'text') sawText();
      },
    );
    await firstText;

    expect(session.sendMessage([{ type: 'text', text: 'Continue' }])).toBe(true);
    await expect
      .poll(() => events.some((e) => e.type === 'note' && e.message.includes('did not reach the model')), {
        timeout: 10_000,
      })
      .toBe(true);
    expect(events.find((e) => e.type === 'note' && e.message.includes('did not reach the model'))).toMatchObject({
      message: expect.stringContaining('expectedTurnId'),
    });
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(session.open).toBe(true); // the live turn was NOT torn down
    session.end();
    await session.result.catch(() => undefined);
  }, 20_000);

  it("keeps cezar's OWN teardown a note, so cancelling never fails the run (#703 parity)", async () => {
    // The in-flight request the escalation must NOT fire on: `mock:steer-silent` never
    // answers the steer, so it is still pending when `interrupt()` tears the session down
    // and `rejectPending` settles it. Escalating that to `error` would turn every cancel
    // into a failed run — the exact class of self-inflicted failure #703 removed.
    const runner = new CodexAppServerRunner({ bin: MOCK_BIN, timeoutMs: 0 });
    const events: AgentEvent[] = [];
    let sawText: () => void = () => {};
    const firstText = new Promise<void>((resolve) => {
      sawText = resolve;
    });
    const session = runner.startSession(
      { userPrompt: 'mock:steer-silent keep going', cwd: process.cwd() },
      (event) => {
        events.push(event);
        if (event.type === 'text') sawText();
      },
    );
    await firstText;

    expect(session.sendMessage([{ type: 'text', text: 'Continue' }])).toBe(true);
    session.interrupt();
    await session.result.catch(() => undefined);

    expect(events.some((e) => e.type === 'error')).toBe(false);
  }, 20_000);
});

describe('Codex reasoning effort App Server mapping', () => {
  it('sends effort only on turn/start, including a resumed thread, and never on steer', async () => {
    const captureDir = mkdtempSync(join(tmpdir(), 'cezar-codex-effort-'));
    const requestsFile = join(captureDir, 'requests.ndjson');
    const runner = new CodexAppServerRunner({ bin: MOCK_BIN, timeoutMs: 0 });
    const session = runner.startSession(
      {
        userPrompt: 'mock:hold-turn',
        cwd: process.cwd(),
        reasoningEffort: 'high',
        env: { CEZ_MOCK_CODEX_REQUESTS_FILE: requestsFile },
      },
      undefined,
      { autoEndAfterFirstTurn: true },
    );

    try {
      await waitForRequest(requestsFile, 'turn/start');
      expect(session.sendMessage([{ type: 'text', text: 'steer this turn' }])).toBe(true);
      await session.result;

      const requests = requestsFrom(requestsFile);
      expect(paramsFor(requests, 'turn/start')).toMatchObject({ effort: 'high' });
      expect(paramsFor(requests, 'thread/start')).not.toHaveProperty('effort');
      expect(paramsFor(requests, 'turn/steer')).not.toHaveProperty('effort');
    } finally {
      session.interrupt();
      await session.result.catch(() => undefined);
      rmSync(captureDir, { recursive: true, force: true });
    }

    const resumedDir = mkdtempSync(join(tmpdir(), 'cezar-codex-effort-'));
    const resumedRequestsFile = join(resumedDir, 'requests.ndjson');
    const resumed = new CodexAppServerRunner({ bin: MOCK_BIN, timeoutMs: 0 }).startSession(
      {
        userPrompt: 'continue',
        cwd: process.cwd(),
        sessionId: 'th_saved',
        resume: true,
        reasoningEffort: 'low',
        env: { CEZ_MOCK_CODEX_REQUESTS_FILE: resumedRequestsFile },
      },
      undefined,
      { autoEndAfterFirstTurn: true },
    );
    try {
      await resumed.result;
      const requests = requestsFrom(resumedRequestsFile);
      expect(paramsFor(requests, 'turn/start')).toMatchObject({ effort: 'low' });
      expect(paramsFor(requests, 'thread/resume')).not.toHaveProperty('effort');
    } finally {
      resumed.interrupt();
      await resumed.result.catch(() => undefined);
      rmSync(resumedDir, { recursive: true, force: true });
    }
  }, 15_000);

  it('omits effort entirely when preserving Codex native defaults', async () => {
    const captureDir = mkdtempSync(join(tmpdir(), 'cezar-codex-effort-'));
    const requestsFile = join(captureDir, 'requests.ndjson');
    const session = new CodexAppServerRunner({ bin: MOCK_BIN, timeoutMs: 0 }).startSession(
      {
        userPrompt: 'use native defaults',
        cwd: process.cwd(),
        env: { CEZ_MOCK_CODEX_REQUESTS_FILE: requestsFile },
      },
      undefined,
      { autoEndAfterFirstTurn: true },
    );
    try {
      await session.result;
      expect(paramsFor(requestsFrom(requestsFile), 'turn/start')).not.toHaveProperty('effort');
    } finally {
      session.interrupt();
      await session.result.catch(() => undefined);
      rmSync(captureDir, { recursive: true, force: true });
    }
  }, 15_000);
});

/**
 * #844 — the runner's own SIGTERM sets `ChildProcess.killed`, so a watchdog
 * gated on `!child.killed` refused to escalate for exactly the app-server it
 * was written for: one that handles the signal and keeps running. The guard now
 * tracks real termination, and `terminatedByCezar` (#703) is still set before
 * every signal so the resulting 137/143 stays a teardown note, not a failure.
 */
describe('SIGTERM→SIGKILL escalation for an app-server that survives SIGTERM', () => {
  function signallableChild(): {
    child: ChildProcessWithoutNullStreams;
    signals: NodeJS.Signals[];
    exit: (code: number) => void;
  } {
    const signals: NodeJS.Signals[] = [];
    const emitter = new EventEmitter();
    const child = Object.assign(emitter, {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      killed: false,
      pid: 4243,
      // Node's semantics: delivery flips `killed` whether or not the child dies.
      kill: (signal: NodeJS.Signals) => {
        signals.push(signal);
        Object.assign(child, { killed: true });
        return true;
      },
    }) as unknown as ChildProcessWithoutNullStreams;
    const exit = (code: number) => {
      Object.assign(child, { exitCode: code });
      emitter.emit('exit', code, null);
    };
    return { child, signals, exit };
  }

  function withFakeChild(run: (fake: ReturnType<typeof signallableChild>) => void): void {
    const fake = signallableChild();
    spawnHook.override = () => fake.child;
    vi.useFakeTimers();
    try {
      run(fake);
    } finally {
      vi.useRealTimers();
      spawnHook.override = null;
    }
  }

  it.each([false, true])(
    'stops accepting messages after spontaneous child exit (stdout held open: %s)',
    async (holdStdoutOpen) => {
      const fake = signallableChild();
      const stdout = fake.child.stdout as PassThrough;
      spawnHook.override = () => fake.child;
      let firstTurn: () => void = () => {};
      const started = new Promise<void>((resolve) => { firstTurn = resolve; });
      fake.child.stdin.on('data', (chunk: Buffer) => {
        const request = JSON.parse(chunk.toString()) as { id?: number; method: string };
        if (request.id === undefined) return;
        const result = request.method === 'thread/start'
          ? { thread: { id: 'thread-1' } }
          : request.method === 'turn/start' ? { turn: { id: 'turn-1' } } : {};
        stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
        if (request.method === 'turn/start') firstTurn();
      });
      const session = new CodexAppServerRunner({ bin: 'codex', timeoutMs: 0 }).startSession({
        userPrompt: 'do it', cwd: process.cwd(),
      });
      let resultSettled = false;
      void session.result.then(() => { resultSettled = true; }, () => { resultSettled = true; });
      try {
        await started;
        expect(session.open).toBe(true);
        expect(fake.child.stdin.writable).toBe(true);
        fake.exit(0);
        if (!holdStdoutOpen) stdout.end();

        expect(session.open).toBe(false);
        expect(session.sendMessage([{ type: 'text', text: 'x' }])).toBe(false);
        if (holdStdoutOpen) {
          // A grandchild can inherit stdout and keep the result loop waiting after exit.
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(stdout.readableEnded).toBe(false);
          expect(resultSettled).toBe(false);
          expect(session.open).toBe(false);
          expect(session.sendMessage([{ type: 'text', text: 'x' }])).toBe(false);
        }
      } finally {
        stdout.end();
        await session.result;
        fake.child.stdin.destroy();
        fake.child.stderr.destroy();
        spawnHook.override = null;
      }
    },
  );

  it('escalates on the wall-clock timeout even after Node flagged the child as killed', () => {
    withFakeChild((fake) => {
      const session = new CodexAppServerRunner({ bin: 'codex', timeoutMs: 20 }).startSession({
        userPrompt: 'do it',
        cwd: process.cwd(),
      });
      void session.result.catch(() => undefined);

      vi.advanceTimersByTime(20);
      expect(fake.signals).toEqual(['SIGTERM']);
      // Delivered, not dead — the state that used to disable the escalation.
      expect(fake.child.killed).toBe(true);
      expect(fake.child.exitCode).toBeNull();

      vi.advanceTimersByTime(KILL_GRACE_MS);
      expect(fake.signals).toEqual(['SIGTERM', 'SIGKILL']);
    });
  });

  it('stops escalating once the app-server really exits after SIGTERM', () => {
    withFakeChild((fake) => {
      const session = new CodexAppServerRunner({ bin: 'codex', timeoutMs: 20 }).startSession({
        userPrompt: 'do it',
        cwd: process.cwd(),
      });
      void session.result.catch(() => undefined);

      vi.advanceTimersByTime(20);
      expect(fake.signals).toEqual(['SIGTERM']);
      fake.exit(143);

      vi.advanceTimersByTime(KILL_GRACE_MS);
      expect(fake.signals).toEqual(['SIGTERM']);
    });
  });

  it('does not signal a second time once interrupt() saw the child exit', () => {
    withFakeChild((fake) => {
      const session = new CodexAppServerRunner({ bin: 'codex', timeoutMs: 0 }).startSession({
        userPrompt: 'do it',
        cwd: process.cwd(),
      });
      void session.result.catch(() => undefined);
      fake.exit(0);

      session.interrupt();
      expect(fake.signals).toEqual([]);
    });
  });

  it('hard-stops a SIGTERM-ignoring app-server within the bounded grace', () => {
    withFakeChild((fake) => {
      const session = new CodexAppServerRunner({ bin: 'codex', timeoutMs: 0 }).startSession({
        userPrompt: 'do it',
        cwd: process.cwd(),
      });
      void session.result.catch(() => undefined);

      session.hardStop?.();
      expect(fake.signals).toEqual(['SIGTERM']);
      vi.advanceTimersByTime(KILL_GRACE_MS);
      expect(fake.signals).toEqual(['SIGTERM', 'SIGKILL']);
    });
  });
});

describe('the artifacts directory under the Codex sandbox (spec 2026-10-22-html-artifacts)', () => {
  const spec = { cwd: '/wt', model: 'gpt-5', env: { CEZ_ARTIFACTS_DIR: '/data/artifacts/r1' } };

  it('adds it as a workspace-write writable root when CEZ_CODEX_NETWORK=0', () => {
    expect(codexThreadOverrides(spec, { 'mcp_servers.x.command': 'y' }, { CEZ_CODEX_NETWORK: '0' })).toEqual({
      model: 'gpt-5',
      cwd: '/wt',
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
      config: { 'mcp_servers.x.command': 'y', 'sandbox_workspace_write.writable_roots': ['/data/artifacts/r1'] },
    });
  });

  it('leaves the default full-access overrides byte-identical', () => {
    expect(codexThreadOverrides(spec, undefined, {})).toEqual({
      model: 'gpt-5',
      cwd: '/wt',
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
      config: undefined,
    });
  });

  it.each([undefined, '0'])('keeps stage-only phases restricted without granting the artifacts root (network=%s)', (network) => {
    const mcpConfig = { 'mcp_servers.x.enabled': false };
    const phaseSpec = { ...spec, env: { ...spec.env, CEZ_HARNESS_STAGE_ONLY: '1' } };
    expect(codexThreadOverrides(phaseSpec, mcpConfig, { CEZ_CODEX_NETWORK: network })).toEqual({
      model: 'gpt-5',
      cwd: '/wt',
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
      config: mcpConfig,
    });
  });
});

describe('userInputAnswers — the ask card answer read back for requestUserInput', () => {
  const questions = [
    { id: 'library', header: 'Library', question: 'Which library?', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false },
    { id: 'parts', header: 'Parts', question: 'Which parts?', options: [{ label: 'A' }, { label: 'B' }], multiSelect: true },
  ];

  it('keeps a single-select answer whole, so the user\'s own text survives its commas', () => {
    expect(userInputAnswers(questions, 'Library: Temporal, once it ships\nParts: A, B')).toEqual({
      library: { answers: ['Temporal, once it ships'] },
      parts: { answers: ['A', 'B'] },
    });
  });

  it('passes a request for more information through as the answer', () => {
    const more = 'I need more information to answer this — please explain the context and ask again.';
    expect(userInputAnswers(questions, `Library: ${more}\nParts: A`).library).toEqual({ answers: [more] });
  });
});

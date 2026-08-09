import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from './agent-runner.js';
import { CodexAppServerRunner } from './codex-app-server-runner.js';

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

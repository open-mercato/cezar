import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isOutdatedBackendError } from '../core/agent-errors.ts';
import { reportAgentError, scrubAgentErrorMessage } from './agent-error-telemetry.ts';
import { RunStore } from './store.ts';
import { reportError, telemetryEnabled } from '../telemetry.ts';

vi.mock('../telemetry.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  reportError: vi.fn(),
  telemetryEnabled: vi.fn(() => true),
}));

const reported = () => vi.mocked(reportError).mock.calls.map(([error, context]) => ({
  name: (error as Error).name,
  message: (error as Error).message,
  context,
}));

beforeEach(() => vi.mocked(reportError).mockClear());

describe('isOutdatedBackendError', () => {
  it.each([
    ['OpenCode 1.18.0 or newer is required to use the free tier', true],
    ['This model requires version 2.1 or later', true],
    ['Codex 0.40+ or higher is required', true],
    ['Invalid API key', false],
    ['exit code 1', false],
  ] as const)('%s → %s', (message, expected) => {
    expect(isOutdatedBackendError(message)).toBe(expected);
  });
});

describe('scrubAgentErrorMessage', () => {
  it('keeps the vendor text and drops what may be the user\'s', () => {
    expect(scrubAgentErrorMessage(
      'step "task" failed: opencode: cannot read "secret.txt" at /Users/me/repo/src for me@example.com, see https://x.dev/a?b=1',
      'opencode',
    )).toBe('cannot read <value> at <path> for <email>, see <url>');
  });

  it('keeps the text after a colon — the part of a vendor message worth reading', () => {
    expect(scrubAgentErrorMessage('API Error: 529 Overloaded', 'claude')).toBe('API Error: 529 Overloaded');
  });

  it('masks a URL up to the next whitespace, query delimiters included', () => {
    expect(scrubAgentErrorMessage('fetch https://api.x.com/v1?token=abc,secret;session=s2 failed', 'codex'))
      .toBe('fetch <url> failed');
  });

  it('masks Windows paths too', () => {
    expect(scrubAgentErrorMessage('cannot open C:\\work\\acme\\app.ts', 'codex')).toBe('cannot open <path>');
  });

  it('stays fast on a long pathological line (stderr tails arrive unbounded)', () => {
    const started = performance.now();
    scrubAgentErrorMessage('a@'.repeat(50_000), 'claude');
    scrubAgentErrorMessage('a'.repeat(200_000), 'claude');
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe('reportAgentError', () => {
  it('reports one AgentError per message, named by backend, tagged when the CLI is outdated', () => {
    reportAgentError('opencode', { type: 'session.error', message: 'OpenCode 1.18.0 or newer is required to use the free tier', fatal: false });
    expect(reported()).toEqual([{
      name: 'AgentError',
      message: 'opencode: OpenCode 1.18.0 or newer is required to use the free tier',
      context: { 'agent.backend': 'opencode', 'agent.event': 'session.error', 'agent.fatal': false, 'agent.outdated': true },
    }]);
  });

  it('an unknown backend id never reaches the report', () => {
    reportAgentError('../../etc', { type: 'error', message: 'boom' });
    expect(reported()[0]?.message).toBe('unknown: boom');
  });

  it('does nothing without telemetry consent', () => {
    vi.mocked(telemetryEnabled).mockReturnValueOnce(false);
    reportAgentError('claude', { type: 'error', message: 'boom' });
    expect(reported()).toEqual([]);
  });

  it('skips restart bookkeeping', () => {
    reportAgentError('claude', { type: 'error', message: 'interrupted — cezar process exited during the run' });
    expect(reported()).toEqual([]);
  });
});

describe('RunStore.appendEvent → agent error reports', () => {
  let dir: string;
  let store: RunStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-agent-error-'));
    store = RunStore.open(join(dir, '.ai/cezar'));
  });

  afterEach(() => {
    store.flush();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports every red line the thread shows, under the session\'s backend', () => {
    const run = store.createRun({ title: 't', workflow: 'w', task: 'x', steps: [] });
    store.appendEvent(run.id, { type: 'session.started', sessionId: 's', backend: 'opencode' });
    store.appendEvent(run.id, { type: 'session.error', message: 'OpenCode 1.18.0 or newer is required to use the free tier', fatal: false });
    store.appendEvent(run.id, { type: 'error', message: 'opencode: boom' });
    store.appendEvent(run.id, { type: 'note', message: 'not an error' });

    expect(reported().map(({ message }) => message)).toEqual([
      'opencode: OpenCode 1.18.0 or newer is required to use the free tier',
      'opencode: boom',
    ]);
  });

  it('falls back to the run\'s runner before any session started', () => {
    const run = store.createRun({ title: 't', workflow: 'w', task: 'x', steps: [], runner: 'codex' });
    store.appendEvent(run.id, { type: 'error', message: 'spawn codex ENOENT' });
    expect(reported()[0]?.context).toMatchObject({ 'agent.backend': 'codex' });
  });
});

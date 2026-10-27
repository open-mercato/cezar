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

  // Spec 2026-10-24 item 9: the keys of a JSON envelope never reach the masker (36b68a95, eb4b12dc, 919887a0).
  it.each([
    [
      'codex',
      '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"Unsupported parameter: reasoning.summary"}}',
      '400 invalid_request_error: Unsupported parameter: reasoning.summary',
    ],
    [
      'claude',
      'API Error: 400 [400]: {"error":{"type":"invalid_request_error","message":"Invalid model name passed in model=gpt-5","param":null,"code":null}}',
      'API Error: 400 [400]: invalid_request_error: Invalid model name passed in model=gpt-5',
    ],
    [
      'opencode',
      'POST /session/ses_1/message → 500 {"name":"ProviderInitError","data":{"message":"provider not configured"}}',
      'POST <path> → 500 ProviderInitError: provider not configured',
    ],
  ])('reads a %s JSON error envelope as its type and message', (backend, message, expected) => {
    expect(scrubAgentErrorMessage(message, backend)).toBe(expected);
  });

  it('still masks paths, emails and quoted values inside an unwrapped message', () => {
    expect(scrubAgentErrorMessage(
      '{"error":{"type":"invalid_request_error","message":"cannot read /Users/me/acme/.env for me@acme.io: \'sk-secret\'"}}',
      'claude',
    )).toBe('invalid_request_error: cannot read <path> for <email> <value>');
  });

  it('masks JSON that is not an error envelope the way it always did', () => {
    expect(scrubAgentErrorMessage('tool failed: {"path":"secret.txt"}', 'codex')).toBe('tool failed: {<value>:<value>}');
  });

  it('masks Windows paths too', () => {
    expect(scrubAgentErrorMessage('cannot open C:\\work\\acme\\app.ts', 'codex')).toBe('cannot open <path>');
  });

  it('folds every reset instant of one usage limit into one message (telemetry 987e8238, c315ec03)', () => {
    const one = "You've hit your session limit · resets <time>";
    expect(scrubAgentErrorMessage("claude: You've hit your session limit · resets 3:10pm (UTC)", 'claude')).toBe(one);
    expect(scrubAgentErrorMessage("You've hit your session limit · resets 8:20pm (Europe/Warsaw)", 'claude')).toBe(one);
    expect(scrubAgentErrorMessage("You've hit your session limit · resets 9am (America/New_York)", 'claude')).toBe(one);
    expect(scrubAgentErrorMessage("You've hit your weekly limit · resets Oct 24, 9am (Europe/Warsaw)", 'claude'))
      .toBe("You've hit your weekly limit · resets <time>");
    expect(scrubAgentErrorMessage('Claude AI usage limit reached|1760450400', 'claude')).toBe('Claude AI usage limit reached|<time>');
    expect(scrubAgentErrorMessage('Usage limit reached. Try again at 2026-08-03T15:30:00Z.', 'codex'))
      .toBe('Usage limit reached. Try again at <time>.');
    expect(scrubAgentErrorMessage('rate limit exceeded — try again in 42 minutes', 'codex'))
      .toBe('rate limit exceeded — try again in <n> minutes');
  });

  it('leaves numbers that are not instants alone', () => {
    expect(scrubAgentErrorMessage('API Error: 529 Overloaded (request 12)', 'claude')).toBe('API Error: 529 Overloaded (request 12)');
    expect(scrubAgentErrorMessage('codex CLI 0.45.1 is too old', 'codex')).toBe('codex CLI 0.45.1 is too old');
    expect(scrubAgentErrorMessage('connect ECONNREFUSED 127.0.0.1:3000 (fetch)', 'opencode'))
      .toBe('connect ECONNREFUSED 127.0.0.1:3000 (fetch)');
  });

  it('stays fast on a long pathological line (stderr tails arrive unbounded)', () => {
    const started = performance.now();
    scrubAgentErrorMessage('a@'.repeat(50_000), 'claude');
    scrubAgentErrorMessage('a'.repeat(200_000), 'claude');
    scrubAgentErrorMessage('1:2 ('.repeat(50_000), 'claude');
    scrubAgentErrorMessage('Oct 1, '.repeat(50_000), 'claude');
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

  it('skips a usage limit auto-resume can schedule — the account\'s state, not a failure (telemetry 987e8238)', () => {
    reportAgentError('claude', { type: 'error', message: "You've hit your session limit · resets 3:10pm (UTC)" });
    reportAgentError('claude', { type: 'session.error', message: 'Claude AI usage limit reached|1760450400' });
    expect(reported()).toEqual([]);
  });

  it('skips account and conversation state — task_failed counts it, the thread explains it', () => {
    reportAgentError('claude', { type: 'error', message: 'Credit balance is too low' });
    reportAgentError('codex', { type: 'session.error', message: 'ENOSPC: no space left on device, write' });
    reportAgentError('claude', { type: 'error', message: 'Failed to authenticate: OAuth session expired and could not be refreshed' });
    reportAgentError('claude', { type: 'error', message: 'Request too large (max 32MB). Accumulated images and attachments in the conversation pushed the request over the limit.' });
    expect(reported()).toEqual([]);
  });

  it('still reports a usage limit with no readable reset, in one coded group (a parser gap)', () => {
    reportAgentError('codex', { type: 'error', message: 'You have hit your usage limit. Upgrade to continue.' });
    reportAgentError('cursor', { type: 'error', message: "cursor agent exited with code 1 — ActionRequiredError: You've hit your usage limit Get Cursor Pro for more Agent usage, unlimited Tab, and more." });
    expect(vi.mocked(reportError).mock.calls.map((call) => call[2]?.code)).toEqual(['usage_limit_unparsed', 'usage_limit_unparsed']);
  });

  it('holds a transient failure back until the run engine says it will not be retried', () => {
    reportAgentError('claude', { type: 'error', message: 'API Error: 529 Overloaded' });
    expect(reported()).toEqual([]);
    reportAgentError('claude', { type: 'error', message: 'step "task" failed: API Error: 529 Overloaded' }, { transientOutcome: 'retries_exhausted' });
    expect(reported()).toEqual([{
      name: 'AgentError',
      message: 'claude: API Error: 529 Overloaded',
      context: { 'agent.backend': 'claude', 'agent.event': 'error', 'agent.outdated': false, 'agent.transient': 'retries_exhausted' },
    }]);
  });

  it('gives an ordinary agent error no code, so it keeps grouping by its own message', () => {
    reportAgentError('claude', { type: 'error', message: 'exit code 1' });
    expect(vi.mocked(reportError).mock.calls[0]?.[2]?.code).toBeUndefined();
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

  it('names a per-step runner that failed before its session started (telemetry 26d1bbd7)', () => {
    const run = store.createRun({ title: 't', workflow: 'w', task: 'x', steps: [{ id: 'code', name: 'Code', kind: 'agent' }], runner: 'claude' });
    store.updateStep(run.id, 'code', { backend: 'cursor' });
    store.appendEvent(run.id, { type: 'step-start', stepId: 'code' });
    store.appendEvent(run.id, { type: 'error', stepId: 'code', message: 'cursor agent exited with code 1' });
    expect(reported()[0]).toMatchObject({ message: 'cursor: cursor agent exited with code 1', context: { 'agent.backend': 'cursor' } });
  });

  it('a Continue on another backend is not named after the previous session (telemetry a58394cc, 9f07e687)', () => {
    const run = store.createRun({ title: 't', workflow: 'w', task: 'x', steps: [{ id: 'task', name: 'Task', kind: 'agent' }], runner: 'codex' });
    store.updateStep(run.id, 'task', { backend: 'codex' });
    store.appendEvent(run.id, { type: 'session.started', stepId: 'task', sessionId: 's', backend: 'codex' });
    store.addStep(run.id, { id: 'continue-1', name: 'Continue', kind: 'agent' });
    store.updateStep(run.id, 'continue-1', { backend: 'opencode' });
    store.appendEvent(run.id, { type: 'step-start', stepId: 'continue-1' });
    store.appendEvent(run.id, { type: 'error', stepId: 'continue-1', message: 'opencode: POST /session → 405' });
    expect(reported()[0]?.context).toMatchObject({ 'agent.backend': 'opencode' });
  });

  it('a new step drops the last session\'s backend when the step names none', () => {
    const run = store.createRun({ title: 't', workflow: 'w', task: 'x', steps: [], runner: 'opencode' });
    store.appendEvent(run.id, { type: 'session.started', sessionId: 's', backend: 'claude' });
    store.appendEvent(run.id, { type: 'step-start', stepId: 'next' });
    store.appendEvent(run.id, { type: 'error', stepId: 'next', message: 'boom' });
    expect(reported()[0]?.context).toMatchObject({ 'agent.backend': 'opencode' });
  });
});

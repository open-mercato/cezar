/**
 * Persist-v2-only parity: for every backend's golden fixture, `deriveV1Events`
 * over the v2 events a REAL runner emits (folded through the RunManager's
 * `UiEventSink`, so only what reaches disk is used) must reproduce the v1
 * `tool-call` / `tool-result` events the same runner emitted live. Each runner
 * is pointed at a stub binary that replays the fixture's wire transcript.
 */
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { RunEvent } from '@open-mercato/cezar-contract';
import type { AgentEvent, AgentRunner } from './agent-runner.ts';
import { ClaudeCliRunner } from './claude-cli-runner.ts';
import { CodexAppServerRunner } from './codex-app-server-runner.ts';
import { CursorAgentRunner } from './cursor-agent-runner.ts';
import { OpencodeServerRunner } from './opencode-server-runner.ts';
import { PiRunner } from './pi-runner.ts';
import { deriveV1Events } from '../runs/derive-v1.ts';
import { UiEventSink } from '../runs/ui-event-sink.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');
const STEP_ID = 's1';

let workDir: string;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'cez-v1-derive-parity-'));
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function goldenFixtures(backend: string): string[] {
  const files = readdirSync(join(FIXTURES, backend));
  return files
    .filter((file) => file.endsWith('.ndjson') && files.includes(file.replace(/\.ndjson$/, '.expected.json')))
    .map((file) => file.replace(/\.ndjson$/, ''))
    .sort();
}

function fixturePath(backend: string, fixture: string): string {
  return join(FIXTURES, backend, `${fixture}.ndjson`);
}

function writeStub(name: string, body: string): string {
  const path = join(workDir, `${name}.mjs`);
  writeFileSync(path, `#!${process.execPath}\n${body}`);
  chmodSync(path, 0o755);
  return path;
}

/** Writes every fixture line to stdout, then lives until stdin closes (the
 *  runner's own end-of-session) or a short grace for runners that never close it. */
function lineReplayStub(backend: string, fixture: string): string {
  return writeStub(
    `${backend}-${fixture}`,
    `import { readFileSync } from 'node:fs';
const lines = readFileSync(${JSON.stringify(fixturePath(backend, fixture))}, 'utf8').split('\\n').filter((l) => l.trim() !== '');
process.stdout.write(lines.map((l) => l + '\\n').join(''));
process.stdin.on('data', () => {});
process.stdin.on('end', () => process.exit(0));
setTimeout(() => process.exit(0), 500);
`,
  );
}

/** A `codex app-server` that answers the runner's handshake itself and, on
 *  `turn/start`, replays the fixture's server frames (its recorded RPC
 *  responses are dropped: their ids belong to the recording, not this run). */
function codexStub(fixture: string): string {
  return writeStub(
    `codex-${fixture}`,
    `import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const frames = readFileSync(${JSON.stringify(fixturePath('codex', fixture))}, 'utf8').split('\\n').filter((l) => l.trim() !== '');
const parse = (l) => { try { return JSON.parse(l); } catch { return undefined; } };
const parsed = frames.map(parse);
const threadId =
  parsed.map((m) => m?.params?.thread?.id).find((v) => typeof v === 'string') ??
  parsed.map((m) => m?.params?.threadId).find((v) => typeof v === 'string') ??
  'th_stub';
const turnId = parsed.map((m) => m?.params?.turn?.id).find((v) => typeof v === 'string') ?? 'turn_stub';
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = parse(line);
  if (!msg || msg.method === undefined || msg.id === undefined) return;
  if (msg.method === 'initialize') out({ id: msg.id, result: { userAgent: 'codex-fixture-stub' } });
  else if (msg.method === 'thread/start') out({ id: msg.id, result: { thread: { id: threadId } } });
  else if (msg.method === 'turn/start') {
    out({ id: msg.id, result: { turn: { id: turnId } } });
    frames.forEach((frame, i) => {
      const m = parsed[i];
      if (m && m.id !== undefined && m.method === undefined) return;
      process.stdout.write(frame + '\\n');
    });
    setTimeout(() => process.exit(0), 500);
  } else out({ id: msg.id, result: {} });
});
rl.on('close', () => process.exit(0));
`,
  );
}

/** An `opencode serve` whose prompt POST streams the fixture's bus events over
 *  SSE and then answers, the ordering the real server shows. */
function opencodeStub(fixture: string): string {
  return writeStub(
    `opencode-${fixture}`,
    `import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
const frames = readFileSync(${JSON.stringify(fixturePath('opencode', fixture))}, 'utf8').split('\\n').filter((l) => l.trim() !== '');
const SESSION_ID = 'ses_01J8ZE00MAIN';
const args = process.argv.slice(2);
const arg = (flag, fallback) => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback; };
const hostname = arg('--hostname', '127.0.0.1');
const port = Number(arg('--port', '0'));
let sse = null;
const server = createServer((req, res) => {
  const url = req.url ?? '';
  if (req.method === 'GET' && url.startsWith('/event')) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(': connected\\n\\n');
    sse = res;
    return;
  }
  req.on('data', () => {});
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.method === 'POST' && url === '/session') {
      res.end(JSON.stringify({ id: SESSION_ID, title: 'cezar task' }));
      return;
    }
    if (req.method === 'POST' && url === '/session/' + SESSION_ID + '/message') {
      for (const frame of frames) sse?.write('data: ' + frame + '\\n\\n');
      setTimeout(() => res.end('{}'), 30);
      return;
    }
    res.end('{}');
  });
});
server.listen(port, hostname, () => {
  console.log('opencode server listening on http://' + hostname + ':' + port);
});
process.on('SIGTERM', () => process.exit(0));
`,
  );
}

interface Capture {
  v1: AgentEvent[];
  persisted: RunEvent[];
}

async function drive(runner: AgentRunner): Promise<Capture> {
  const v1: AgentEvent[] = [];
  const persisted: RunEvent[] = [];
  let seq = 0;
  const sink = new UiEventSink({
    persist: (event) => {
      seq += 1;
      persisted.push(JSON.parse(JSON.stringify({ ...event, stepId: STEP_ID, seq, ts: '2026-09-30T00:00:00.000Z' })));
    },
    emitLive: () => {},
  });
  const session = runner.startSession(
    { userPrompt: 'replay the fixture', cwd: workDir, timeoutMs: 20_000 },
    (event) => v1.push(event),
    { autoEndAfterFirstTurn: true, onUiEvent: (event) => sink.handle(event) },
  );
  // Error fixtures (turn/failed, is_error results) reject the result — the
  // events up to that point are what the run persisted.
  await session.result.catch(() => undefined);
  sink.flushAll();
  return { v1, persisted };
}

type Level = 'values' | 'identity';

/** `values` compares what a reader of the v1 line sees; `identity` only which
 *  tool calls exist and which of them failed. */
function project(events: readonly RunEvent[] | readonly AgentEvent[], level: Level): { calls: unknown[]; results: unknown[] } {
  const calls: unknown[] = [];
  const results: unknown[] = [];
  for (const event of events as ReadonlyArray<Record<string, unknown>>) {
    if (event.type === 'tool-call') {
      calls.push(JSON.parse(JSON.stringify(level === 'values' ? { id: event.id, tool: event.tool, input: event.input } : { id: event.id })));
    } else if (event.type === 'tool-result') {
      results.push(
        level === 'values'
          ? { toolCallId: event.toolCallId, result: event.result, isError: event.isError }
          : { toolCallId: event.toolCallId, isError: event.isError },
      );
    }
  }
  return { calls, results };
}

function expectParity({ v1, persisted }: Capture, level: Level): void {
  const expected = project(v1, level);
  const derived = project(deriveV1Events(persisted), level);
  expect.soft(derived.calls, 'tool-call').toEqual(expected.calls);
  expect.soft(derived.results, 'tool-result').toEqual(expected.results);
}

const BACKENDS: ReadonlyArray<{ backend: string; runner: (fixture: string) => AgentRunner }> = [
  { backend: 'claude', runner: (f) => new ClaudeCliRunner({ bin: lineReplayStub('claude', f), timeoutMs: 20_000 }) },
  { backend: 'codex', runner: (f) => new CodexAppServerRunner({ bin: codexStub(f), timeoutMs: 20_000 }) },
  { backend: 'opencode', runner: (f) => new OpencodeServerRunner({ bin: opencodeStub(f), timeoutMs: 20_000 }) },
  { backend: 'cursor', runner: (f) => new CursorAgentRunner({ bin: lineReplayStub('cursor', f), timeoutMs: 20_000 }) },
  { backend: 'pi', runner: (f) => new PiRunner({ bin: lineReplayStub('pi', f), timeoutMs: 20_000 }) },
];

/**
 * Fixtures whose runner puts raw wire JSON in the live v1 line while the v2
 * item carries the normalized value, so the derived line has the same calls
 * and failures but different `tool` / `input` / `result` text.
 */
const RAW_V1_VALUES: Readonly<Record<string, string>> = {
  'codex/command-lifecycle': 'v1 input/result = the raw item JSON; v2 carries the command and its output',
  'codex/file-change-and-mcp': 'v1 tool = item type, input/result = the raw item; v2 carries the display name, input and output',
  'opencode/tool-lifecycle': 'v1 result for an errored tool is the whole state JSON; v2 carries only the error string',
  'cursor/tools-plan-task': 'v1 result is the raw result JSON; v2 carries the extracted content',
};

/**
 * Fixtures where v1 and v2 do not even agree on which tool calls exist. The
 * derived view follows the v2 items the cockpit renders. Each runs as
 * `it.fails` at identity level, so a mapper or runner change that closes the
 * gap turns it red until its entry is removed here.
 */
const IDENTITY_DIVERGENCES: Readonly<Record<string, string>> = {
  'codex/collab-agent-tool-call': 'v1 results key on the wait item; v2 folds the collab exchange into the spawn item and synthesizes a child command',
  'codex/collab-tool-call': 'v1 results key on the close item; v2 folds the collab exchange into the spawn item',
  'codex/review-mode': 'v1 result keys on exitedReviewMode; v2 folds both review items into the enteredReviewMode item',
  'codex/sub-agent-activity': 'v1 emits results for completed-only activity items that v2 never completes as tools',
  'codex/todo-list': 'v1 emits a todoList tool lifecycle; v2 maps it to plan.updated only',
  'codex/turn-failed': 'v1 emits a result for a declined item; a declined v2 item derives none',
  'opencode/patch-and-step-finish': 'v2 surfaces a patch part as a tool item; v1 ignores patch parts',
  'opencode/subtask-nested': 'v2 surfaces subtask parts as tool items; v1 ignores them',
  'opencode/subtask-overlapping': 'v2 surfaces subtask parts as tool items; v1 ignores them',
};

for (const { backend, runner } of BACKENDS) {
  describe(`${backend}: deriveV1Events reproduces the runner's v1 stream`, () => {
    const fixtures = goldenFixtures(backend);

    it('has golden fixtures to replay', () => {
      expect(fixtures.length).toBeGreaterThan(0);
    });

    for (const fixture of fixtures) {
      const key = `${backend}/${fixture}`;
      const test = key in IDENTITY_DIVERGENCES ? it.fails : it;
      const level: Level = key in RAW_V1_VALUES || key in IDENTITY_DIVERGENCES ? 'identity' : 'values';
      test(fixture, { timeout: 30_000 }, async () => {
        const capture = await drive(runner(fixture));
        expect(capture.persisted.length, 'the runner produced no v2 events').toBeGreaterThan(0);
        expectParity(capture, level);
      });
    }
  });
}

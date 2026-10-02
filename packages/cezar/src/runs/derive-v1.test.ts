import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { RunEvent } from '@open-mercato/cezar-contract';
import { deriveV1Events } from './derive-v1.ts';

const dirs: string[] = [];

function fixture(events: Array<Partial<RunEvent> & Pick<RunEvent, 'seq' | 'type'>>): string {
  const dir = mkdtempSync(join(tmpdir(), 'cez-derive-v1-'));
  dirs.push(dir);
  const file = join(dir, 'run.ndjson');
  writeFileSync(
    file,
    events.map((event) => JSON.stringify({ ts: '2026-09-30T00:00:00.000Z', ...event })).join('\n') + '\n',
  );
  return file;
}

function parse(file: string): RunEvent[] {
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as RunEvent);
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('deriveV1Events', () => {
  it('reconstructs tool-call and tool-result from a v2 tool lifecycle', () => {
    const events = [
      { seq: 1, ts: 'x', type: 'turn.started', turnId: 't1' },
      {
        seq: 2,
        ts: 'x',
        stepId: 's1',
        type: 'item.started',
        item: { kind: 'tool', id: 'toolu_1', name: 'Bash', status: 'running', input: { command: 'git status' } },
      },
      {
        seq: 3,
        ts: 'x',
        stepId: 's1',
        type: 'item.completed',
        item: { kind: 'tool', id: 'toolu_1', name: 'Bash', status: 'completed', output: ' M a.ts' },
      },
    ] satisfies RunEvent[];

    expect(deriveV1Events(events).map((event) => ({ ...event }))).toEqual([
      { seq: 1, ts: 'x', type: 'turn.started', turnId: 't1' },
      {
        seq: 2,
        ts: 'x',
        stepId: 's1',
        type: 'item.started',
        item: { kind: 'tool', id: 'toolu_1', name: 'Bash', status: 'running', input: { command: 'git status' } },
      },
      {
        seq: 2,
        ts: 'x',
        stepId: 's1',
        type: 'tool-call',
        id: 'toolu_1',
        tool: 'Bash',
        input: { command: 'git status' },
      },
      {
        seq: 3,
        ts: 'x',
        stepId: 's1',
        type: 'item.completed',
        item: { kind: 'tool', id: 'toolu_1', name: 'Bash', status: 'completed', output: ' M a.ts' },
      },
      {
        seq: 3,
        ts: 'x',
        stepId: 's1',
        type: 'tool-result',
        toolCallId: 'toolu_1',
        result: ' M a.ts',
        isError: false,
      },
    ]);
  });

  it('marks a failed tool result as an error and gives a declined tool no v1 line at all', () => {
    const events = [
      {
        seq: 1,
        ts: 'x',
        type: 'item.completed',
        item: { kind: 'tool', id: 'fail', name: 'Bash', status: 'failed', error: 'exit 1' },
      },
      {
        seq: 2,
        ts: 'x',
        type: 'item.completed',
        item: { kind: 'tool', id: 'denied', name: 'Write', status: 'declined' },
      },
    ] satisfies RunEvent[];

    const derived = deriveV1Events(events);
    expect(derived.filter((event) => event.type === 'tool-call').map((event) => event.id)).toEqual(['fail']);
    expect(derived.filter((event) => event.type === 'tool-result')).toEqual([
      expect.objectContaining({ type: 'tool-result', toolCallId: 'fail', result: 'exit 1', isError: true }),
    ]);
  });

  it('takes a failed tool result from its output when the item carries no error', () => {
    const events = [
      {
        seq: 1,
        ts: 'x',
        type: 'item.completed',
        item: { kind: 'tool', id: 'cmd', name: 'commandExecution', status: 'failed', output: 'npm error Missing script', exitCode: 1 },
      },
    ] satisfies RunEvent[];

    expect(deriveV1Events(events).filter((event) => event.type === 'tool-result')).toEqual([
      expect.objectContaining({ toolCallId: 'cmd', result: 'npm error Missing script', isError: true }),
    ]);
  });

  it('never derives assistant text — v1 text is persisted as it always was', () => {
    const events = [
      { seq: 1, ts: 'x', type: 'turn.started', turnId: 't1' },
      {
        seq: 2,
        ts: 'x',
        type: 'item.started',
        item: { kind: 'message', id: 'm1', role: 'assistant', text: '' },
      },
      {
        seq: 3,
        ts: 'x',
        type: 'item.completed',
        item: {
          kind: 'message',
          id: 'm1',
          role: 'assistant',
          text: 'Opened the PR.\nCEZ:PR=42\nCEZ:ISSUE=7\nCEZ:TITLE=working\n\nCEZ:DONE',
        },
      },
      {
        seq: 4,
        ts: 'x',
        type: 'item.completed',
        item: { kind: 'message', id: 'm2', role: 'user', text: 'please continue' },
      },
    ] satisfies RunEvent[];

    expect(deriveV1Events(events)).toEqual(events);
  });

  it('returns a legacy mixed transcript unchanged — v1 twins are never duplicated', () => {
    const events = [
      { seq: 1, ts: 'x', type: 'turn.started', turnId: 't1' },
      { seq: 2, ts: 'x', type: 'tool-call', id: 'toolu_1', tool: 'Bash', input: { command: 'ls' } },
      { seq: 3, ts: 'x', type: 'item.started', item: { kind: 'tool', id: 'toolu_1', status: 'running' } },
      { seq: 4, ts: 'x', type: 'tool-result', toolCallId: 'toolu_1', result: 'a.ts', isError: false },
      { seq: 5, ts: 'x', type: 'item.completed', item: { kind: 'tool', id: 'toolu_1', status: 'completed', output: 'a.ts' } },
      { seq: 6, ts: 'x', type: 'text', text: 'done' },
      { seq: 7, ts: 'x', type: 'item.completed', item: { kind: 'message', id: 'm1', role: 'assistant', text: 'done' } },
    ] satisfies RunEvent[];

    expect(deriveV1Events(events)).toEqual(events);
  });

  it('replays a legacy NDJSON fixture without adding a single line', () => {
    const events: Array<Partial<RunEvent> & Pick<RunEvent, 'seq' | 'type'>> = [
      { seq: 1, ts: 'x', type: 'user-message', text: 'do the thing' },
      { seq: 2, ts: 'x', type: 'item.started', item: { kind: 'tool', id: 'toolu_1', name: 'Bash', status: 'running' } },
      { seq: 3, ts: 'x', type: 'tool-call', id: 'toolu_1', tool: 'Bash', input: { command: 'ls' } },
      { seq: 4, ts: 'x', type: 'item.completed', item: { kind: 'tool', id: 'toolu_1', name: 'Bash', status: 'completed', output: 'ok' } },
      { seq: 5, ts: 'x', type: 'tool-result', toolCallId: 'toolu_1', result: 'ok', isError: false },
      { seq: 6, ts: 'x', type: 'item.completed', item: { kind: 'message', id: 'm1', role: 'assistant', text: 'done' } },
      { seq: 7, ts: 'x', type: 'text', text: 'done' },
    ];
    const parsed = parse(fixture(events));
    const v1Lines = parsed.filter((event) => ['text', 'tool-call', 'tool-result'].includes(event.type));

    const derived = deriveV1Events(parsed);
    expect(v1Lines).toHaveLength(3);
    expect(derived).toEqual(parsed);
    expect(derived).toHaveLength(parsed.length);
  });

  it('keeps both halves of a run recorded before the change and continued after it', () => {
    const events: Array<Partial<RunEvent> & Pick<RunEvent, 'seq' | 'type'>> = [
      { seq: 1, ts: 'x', stepId: 'agent', type: 'session.started', sessionId: 'old' },
      { seq: 2, ts: 'x', stepId: 'agent', type: 'item.started', item: { kind: 'tool', id: 'item_1', name: 'Bash', status: 'running', input: { command: 'ls' } } },
      { seq: 3, ts: 'x', stepId: 'agent', type: 'tool-call', id: 'item_1', tool: 'Bash', input: { command: 'ls' } },
      { seq: 4, ts: 'x', stepId: 'agent', type: 'item.completed', item: { kind: 'tool', id: 'item_1', name: 'Bash', status: 'completed', output: 'a.ts' } },
      { seq: 5, ts: 'x', stepId: 'agent', type: 'tool-result', toolCallId: 'item_1', result: 'a.ts', isError: false },
      { seq: 6, ts: 'x', stepId: 'continue-1', type: 'user-message', text: 'now fix it' },
      { seq: 7, ts: 'x', stepId: 'continue-1', type: 'session.started', sessionId: 'new' },
      { seq: 8, ts: 'x', stepId: 'continue-1', type: 'item.started', item: { kind: 'tool', id: 'item_1', name: 'Edit', status: 'running', input: { file_path: 'a.ts' } } },
      { seq: 9, ts: 'x', stepId: 'continue-1', type: 'item.completed', item: { kind: 'tool', id: 'item_1', name: 'Edit', status: 'completed', output: 'edited' } },
    ];
    const v1 = deriveV1Events(parse(fixture(events))).filter((event) =>
      ['tool-call', 'tool-result'].includes(event.type),
    );

    expect(v1.map(({ type, stepId, seq }) => ({ type, stepId, seq }))).toEqual([
      { type: 'tool-call', stepId: 'agent', seq: 3 },
      { type: 'tool-result', stepId: 'agent', seq: 5 },
      { type: 'tool-call', stepId: 'continue-1', seq: 8 },
      { type: 'tool-result', stepId: 'continue-1', seq: 9 },
    ]);
  });

  it('treats a second session inside the same step as its own window', () => {
    const events = [
      { seq: 1, ts: 'x', stepId: 'agent', type: 'session.started', sessionId: 'old' },
      { seq: 2, ts: 'x', stepId: 'agent', type: 'item.started', item: { kind: 'tool', id: 'item_1', name: 'Bash', status: 'running', input: { command: 'ls' } } },
      { seq: 3, ts: 'x', stepId: 'agent', type: 'tool-call', id: 'item_1', tool: 'Bash', input: { command: 'ls' } },
      { seq: 4, ts: 'x', stepId: 'agent', type: 'session.started', sessionId: 'recovered' },
      { seq: 5, ts: 'x', stepId: 'agent', type: 'item.started', item: { kind: 'tool', id: 'item_1', name: 'Read', status: 'running', input: { file_path: 'a.ts' } } },
      { seq: 6, ts: 'x', stepId: 'agent', type: 'item.completed', item: { kind: 'tool', id: 'item_1', name: 'Read', status: 'completed', output: 'contents' } },
    ] satisfies RunEvent[];

    const derived = deriveV1Events(events);
    expect(derived.filter((event) => event.type === 'tool-call').map((event) => [event.seq, event.tool])).toEqual([
      [3, 'Bash'],
      [5, 'Read'],
    ]);
    expect(derived.filter((event) => event.type === 'tool-result').map((event) => event.seq)).toEqual([6]);
  });

  it('is idempotent for a v2-only transcript', () => {
    const events = [
      {
        seq: 1,
        ts: 'x',
        type: 'item.started',
        item: { kind: 'tool', id: 'toolu_1', name: 'Read', status: 'running', input: { file_path: 'a.ts' } },
      },
      {
        seq: 2,
        ts: 'x',
        type: 'item.completed',
        item: { kind: 'tool', id: 'toolu_1', name: 'Read', status: 'completed', output: 'contents' },
      },
      { seq: 3, ts: 'x', type: 'item.completed', item: { kind: 'message', id: 'm1', role: 'assistant', text: 'ok' } },
    ] satisfies RunEvent[];

    const once = deriveV1Events(events);
    expect(once.map((event) => event.type)).toEqual([
      'item.started',
      'tool-call',
      'item.completed',
      'tool-result',
      'item.completed',
    ]);
    expect(deriveV1Events(once)).toEqual(once);
  });
});

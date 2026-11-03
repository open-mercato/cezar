import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { RunEvent } from '@open-mercato/cezar-contract';
import {
  __clearContextCacheForTests,
  deriveRunContextEvents,
  readRunHistoryPage,
} from './event-history.ts';

const CHUNK = 64 * 1024;
const dirs: string[] = [];
const keys = ['a', 'b', 'c'];
const startTypes = new Set(['session', 'session.started', 'turn.started']);

function fixture(events: RunEvent[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'cez-history-review-'));
  dirs.push(dir);
  const file = join(dir, 'run.ndjson');
  writeFileSync(file, events.map((event) => JSON.stringify(event)).join('\n') + '\n');
  return file;
}

function writer(events: RunEvent[]) {
  return (event: Omit<RunEvent, 'seq' | 'ts'>) => {
    const seq = events.length + 1;
    events.push({ seq, ts: new Date(Date.UTC(2026, 9, 27, 8, 0, seq)).toISOString(), ...event } as RunEvent);
  };
}

function archive(): RunEvent[] {
  const events: RunEvent[] = [];
  const push = writer(events);
  for (let index = 0; index < 700; index += 1) {
    push({ type: 'turn.started', stepId: 'implement', turnId: `t${index}` });
    push({ type: 'item.completed', stepId: 'implement', item: {
      kind: 'message', id: `m${index}`, role: 'assistant', text: 'x'.repeat(8000),
    } });
  }
  return events;
}

afterEach(() => {
  __clearContextCacheForTests();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

// The real cockpit projection catches remounts caused by missing starts.
let rows: (events: RunEvent[], visible: Set<string>) => string[];
beforeAll(() => {
  const web = fileURLToPath(new URL('../../../web/src/', import.meta.url));
  const result = buildSync({
    stdin: {
      contents: `import { reduceThread } from './routes/task-thread/thread-state';
        import { buildTranscriptRows, mainTranscriptSections } from './routes/task-thread/session-transcript';
        export function rows(events, visible) {
          return buildTranscriptRows(mainTranscriptSections({ task: '' }, reduceThread(events)), 'run')
            .flatMap(row => row.content.kind === 'block' && row.content.block.kind === 'entry' &&
              visible.has(row.content.block.entry.sourceKey) ? [row.key] : []);
        }`,
      resolveDir: web,
    },
    alias: { '@': web },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    logLevel: 'silent',
  });
  const module = { exports: {} as { rows: typeof rows } };
  new Function('require', 'module', 'exports', result.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
  rows = module.exports.rows;
});

describe('phase-bounded council pages', () => {
  it.each(['queued message', 'reviewer nudge', 'resumed phase'])('retains all reviewer starts and row keys through Load earlier after a %s', async (boundary) => {
    const events = archive();
    const phaseOffset = Buffer.byteLength(events.map((event) => JSON.stringify(event)).join('\n') + '\n');
    const push = writer(events);
    push({ type: 'harness.phase.updated', stepId: 'review', phase: { id: 'review', status: 'running' } });
    for (const sessionKey of keys) {
      push({ type: 'session', stepId: 'review', sessionKey, sessionId: `sid-${sessionKey}` });
      push({ type: 'session.started', stepId: 'review', sessionKey, backend: 'claude' });
      push({ type: 'turn.started', stepId: 'review', sessionKey, turnId: 'turn_1' });
    }
    const starts = events.filter((event) => event.type === 'turn.started' && event.sessionKey);
    for (let index = 0; index < 450; index += 1) {
      if (index === 150) {
        if (boundary !== 'reviewer nudge') push({ type: 'user-message', text: 'Also check tests' });
        else {
          push({ type: 'turn.completed', stepId: 'review', sessionKey: 'a', turnId: 'turn_1' });
          push({ type: 'turn.started', stepId: 'review', sessionKey: 'a', turnId: 'turn_2' });
        }
      }
      if (boundary === 'resumed phase' && index === 400) {
        push({ type: 'lifecycle', message: 'Harness resumed from its durable ledger' });
        push({ type: 'harness.phase.updated', stepId: 'review', phase: { id: 'review', status: 'running' } });
        for (const sessionKey of keys.map((key) => `${key}-resumed`)) {
          push({ type: 'turn.started', stepId: 'review', sessionKey, turnId: 'turn_1' });
          starts.push(events.at(-1)!);
        }
      }
      const sessionKey = keys[index % keys.length]! + (boundary === 'resumed phase' && index >= 400 ? '-resumed' : '');
      const id = `item_${Math.floor(index / keys.length)}`;
      if (index % 4 === 3) {
        push({ type: 'item.completed', stepId: 'review', sessionKey, item: { kind: 'message', id, role: 'assistant', text: `Finding ${index}` } });
        push({ type: 'text', stepId: 'review', sessionKey, text: `Finding ${index}` });
      } else {
        push({ type: 'item.started', stepId: 'review', sessionKey, item: { kind: 'tool', id, name: 'Read', toolKind: 'read', status: 'running' } });
        push({ type: 'tool-call', stepId: 'review', sessionKey, id, tool: 'Read' });
        push({ type: 'item.completed', stepId: 'review', sessionKey, item: { kind: 'tool', id, name: 'Read', toolKind: 'read', status: 'completed', output: 'x'.repeat(8000) } });
        push({ type: 'tool-result', stepId: 'review', sessionKey, toolCallId: id, result: 'x'.repeat(8000) });
      }
    }
    const file = fixture(events);
    const reads: number[] = [];
    const newest = await readRunHistoryPage(file, undefined, ({ bytesRead }) => reads.push(bytesRead));
    const expectedStarts = starts.filter((event) => boundary !== 'reviewer nudge' || event.sessionKey !== 'a');
    for (const start of expectedStarts) expect(newest.events.some(({ seq }) => seq === start.seq), `missing reviewer ${start.sessionKey} start`).toBe(true);
    expect(reads[0]).toBeLessThanOrEqual(statSync(file).size - phaseOffset + 2 * CHUNK);
    expect(reads[0]).toBeGreaterThan(3 * 1024 * 1024);

    const visible = new Set(newest.events.filter((event) => event.type === 'item.completed' && (event.item as { kind: string }).kind === 'message')
      .map((event) => `${event.stepId}:${event.sessionKey}:${(event.item as { id: string }).id}`));
    const before = rows(newest.events, visible);
    expect(visible.size).toBeGreaterThan(0);
    expect(before).toHaveLength(visible.size);
    let page = newest;
    let window = newest.events;
    let pages = 1;
    while (page.olderCursor && pages < 6) {
      page = await readRunHistoryPage(file, page.olderCursor);
      if (pages === 1) {
        const forward = await readRunHistoryPage(file, page.newerCursor);
        for (const start of expectedStarts) expect(forward.events).toContainEqual(start);
        const seqs = forward.events.map(({ seq }) => seq);
        expect(seqs).toEqual([...new Set(seqs)].sort((a, b) => a - b));
      }
      window = [...new Map([...page.events, ...window].map((event) => [event.seq, event])).values()].sort((a, b) => a.seq - b.seq);
      expect(rows(window, visible)).toEqual(before);
      expect(window.map(({ seq }) => seq)).toEqual([...new Set(window.map(({ seq }) => seq))].sort((a, b) => a - b));
      pages += 1;
    }
    expect(pages).toBeGreaterThan(1);
  });

  it.each([50, 200, 2300])('guard: failed reviewer searches stop before the archive (council records=%s)', async (count) => {
    const hasPhase = count < 2300;
    const events = archive();
    const phaseOffset = Buffer.byteLength(events.map((event) => JSON.stringify(event)).join('\n') + '\n');
    const push = writer(events);
    if (hasPhase) push({ type: 'harness.phase.updated', stepId: 'review', phase: { status: 'running' } });
    for (let index = 0; index < count; index += 1) {
      if (!hasPhase && index === 1000) push({ type: 'harness.phase.updated', stepId: 'review', phase: { status: 'done' } });
      if (!hasPhase && index === 1500) push({ type: 'harness.phase.updated', stepId: 'unrelated', phase: { status: 'running' } });
      push({ type: 'note', message: 'x'.repeat(8000) });
    }
    push({ type: 'user-message', text: 'Check tests' });
    for (const type of ['error', 'session.error', 'session.ended']) push({ type, stepId: 'review', sessionKey: 'failed', message: 'Launch failed' });
    const file = fixture(events);
    const reads: number[] = [];
    const page = await readRunHistoryPage(file, undefined, ({ bytesRead }) => reads.push(bytesRead));
    expect(page.events.filter(({ sessionKey }) => sessionKey === 'failed').map(({ type }) => type)).toEqual(['error', 'session.error', 'session.ended']);
    expect(page.events.some((event) => startTypes.has(event.type) && event.sessionKey === 'failed')).toBe(false);
    const maximum = hasPhase ? Math.max(statSync(file).size - phaseOffset, 2 * 1024 * 1024) : 16 * 1024 * 1024;
    expect(reads[0]).toBeLessThanOrEqual(maximum + 16 * CHUNK);
    expect(reads[0]).toBeLessThan(statSync(file).size);
  });

  it('guard: unscoped failures retain the exact 1 MiB extension', async () => {
    const events = archive();
    const push = writer(events);
    push({ type: 'user-message', text: 'Check tests' });
    push({ type: 'session.error', sessionKey: 'failed', message: 'Launch failed' });
    const reads: number[] = [];
    await readRunHistoryPage(fixture(events), undefined, ({ bytesRead }) => reads.push(bytesRead));
    expect(reads).toEqual([14 * CHUNK + 1024 * 1024]);
  });
});

describe('compact open reviewer starts', () => {
  it.each([false, true])('retains latest open reviewer starts across queued messages and pruning (task root=%s)', async (hasRoot) => {
    const events: RunEvent[] = [];
    const push = writer(events);
    for (const sessionKey of keys) {
      push({ type: 'session', stepId: 'review', sessionKey, sessionId: `sid-${sessionKey}` });
      if (sessionKey === 'c' && hasRoot) continue;
      push({ type: 'session.started', stepId: 'review', sessionKey, backend: 'claude' });
      if (sessionKey !== 'c') push({ type: 'turn.started', stepId: 'review', sessionKey, turnId: 'turn_1' });
    }
    if (hasRoot) push({ type: 'item.started', stepId: 'review', sessionKey: 'a', item: { kind: 'tool', id: 'task', toolKind: 'task', status: 'running' } });
    push({ type: 'user-message', text: 'Check tests' });
    push({ type: 'turn.started', stepId: 'review', sessionKey: 'a', turnId: 'turn_2' });
    push({ type: 'turn.completed', stepId: 'review', sessionKey: 'b', turnId: 'turn_1' });
    push({ type: 'session.error', stepId: 'review', sessionKey: 'b', fatal: false, message: 'Retrying' });
    push({ type: 'plan.updated', entries: [] });
    if (hasRoot) push({ type: 'item.completed', stepId: 'review', sessionKey: 'a', item: { kind: 'tool', id: 'task', toolKind: 'task', status: 'completed' } });
    const file = fixture(events);
    const context = await deriveRunContextEvents(file);
    const latestStarts = keys.map((key) => events.filter((event) => event.sessionKey === key && startTypes.has(event.type)).at(-1)!);
    for (const start of latestStarts) expect(context.contextEvents, `missing open reviewer ${start.sessionKey} start`).toContainEqual(start);
    expect(context.contextEvents.map(({ seq }) => seq)).toEqual([...new Set(context.contextEvents.map(({ seq }) => seq))].sort((a, b) => a - b));
    expect(await deriveRunContextEvents(file)).toEqual(context);
    __clearContextCacheForTests();
    expect(await deriveRunContextEvents(file)).toEqual(context);

    const count = events.length;
    push({ type: 'session.ended', stepId: 'review', sessionKey: 'b' });
    push({ type: 'user-message', text: 'Continue' });
    appendFileSync(file, events.slice(count).map((event) => JSON.stringify(event)).join('\n') + '\n');
    const ended = await deriveRunContextEvents(file);
    expect(ended.contextEvents.some((event) => event.sessionKey === 'b' && startTypes.has(event.type))).toBe(false);
    expect(ended.contextEvents).toContainEqual(latestStarts[0]);
    expect(ended.contextEvents).toContainEqual(latestStarts[2]);
    __clearContextCacheForTests();
    expect(await deriveRunContextEvents(file)).toEqual(ended);
  });

  it('guard: a nonfatal error and a completed turn keep the keyed session open until session.ended', async () => {
    const events: RunEvent[] = [];
    const push = writer(events);
    push({ type: 'turn.started', sessionKey: 'a', turnId: 'turn_1' });
    push({ type: 'turn.completed', sessionKey: 'a', turnId: 'turn_1' });
    push({ type: 'session.error', sessionKey: 'a', fatal: false, message: 'Retrying' });
    const context = await deriveRunContextEvents(fixture(events));
    expect(context.contextEvents).toEqual(events);
  });

  it.each([false, true])('guard: ordinary context bytes and read budgets stay unchanged (task root=%s)', async (hasRoot) => {
    const events: RunEvent[] = [];
    const push = writer(events);
    push({ type: 'session', stepId: 'work', sessionId: 'ordinary' });
    push({ type: 'session.started', stepId: 'work', backend: 'claude' });
    push({ type: 'turn.started', stepId: 'work', turnId: 'turn_1' });
    if (hasRoot) push({ type: 'item.started', stepId: 'work', item: { kind: 'tool', id: 'task', toolKind: 'task', status: 'running' } });
    push({ type: 'user-message', text: 'Continue' });
    push({ type: 'turn.started', stepId: 'work', turnId: 'turn_2' });
    if (hasRoot) push({ type: 'item.completed', stepId: 'work', item: { kind: 'tool', id: 'task', toolKind: 'task', status: 'completed' } });
    push({ type: 'turn.completed', stepId: 'work', turnId: 'turn_2' });
    const file = fixture(events);
    const reads: number[] = [];
    const read = () => deriveRunContextEvents(file, ({ bytesRead }) => reads.push(bytesRead));
    const expected = { contextEvents: hasRoot ? events.slice(-1) : events.slice(-2), asOfSeq: events.length };
    expect(JSON.stringify(await read())).toBe(JSON.stringify(expected));
    expect(JSON.stringify(await read())).toBe(JSON.stringify(expected));
    const appended = JSON.stringify({ seq: events.length + 1, ts: 'x', type: 'note', message: 'ordinary live event' }) + '\n';
    appendFileSync(file, appended);
    expected.asOfSeq += 1;
    expect(JSON.stringify(await read())).toBe(JSON.stringify(expected));
    expect(reads).toEqual([statSync(file).size - Buffer.byteLength(appended) + 64, 0, Buffer.byteLength(appended) + 128]);
  });
});

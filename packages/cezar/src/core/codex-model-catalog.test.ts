import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { discoverCodexModels } from './codex-model-catalog.ts';

const fixtures = fileURLToPath(new URL('__fixtures__/codex/', import.meta.url));

function fixture(name: string): unknown[] {
  return readFileSync(`${fixtures}${name}.ndjson`, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as unknown);
}

function fakeChild(responses: unknown[] = []): {
  child: ChildProcessWithoutNullStreams;
  requests: Array<Record<string, unknown>>;
  emitExit(code: number): void;
} {
  const process = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const requests: Array<Record<string, unknown>> = [];
  const queued = [...responses];
  let input = '';
  stdin.setEncoding('utf8');
  stdin.on('data', (chunk: string) => {
    input += chunk;
    let newline: number;
    while ((newline = input.indexOf('\n')) >= 0) {
      const line = input.slice(0, newline);
      input = input.slice(newline + 1);
      if (!line) continue;
      requests.push(JSON.parse(line) as Record<string, unknown>);
      const response = queued.shift();
      if (response !== undefined) queueMicrotask(() => stdout.write(`${JSON.stringify(response)}\n`));
    }
  });
  Object.assign(process, {
    stdin,
    stdout,
    stderr,
    exitCode: null,
    killed: false,
    kill: () => true,
    pid: 123,
  });
  return {
    child: process as unknown as ChildProcessWithoutNullStreams,
    requests,
    emitExit(code: number) {
      Object.assign(process, { exitCode: code });
      process.emit('exit', code);
      stdout.end();
    },
  };
}

describe('Codex model discovery', () => {
  it('validates a wire response and keeps the first visible, non-blank model in server order', async () => {
    const fake = fakeChild(fixture('model-list-success'));
    await expect(discoverCodexModels({ cwd: '/repo', spawn: () => fake.child })).resolves.toEqual([
      { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', description: 'Frontier coding model' },
      { id: 'gpt-5.4-mini', label: 'gpt-5.4-mini', description: 'Fast model' },
    ]);
    expect(fake.requests).toEqual([
      expect.objectContaining({ id: 1, method: 'initialize' }),
      { method: 'initialized', params: {} },
      { id: 2, method: 'model/list', params: { cursor: null, includeHidden: false } },
    ]);
  });

  it('follows every pagination cursor without reordering pages', async () => {
    const fake = fakeChild(fixture('model-list-pagination'));
    await expect(discoverCodexModels({ cwd: '/repo', spawn: () => fake.child })).resolves.toEqual([
      { id: 'first', label: 'First', description: 'First page' },
      { id: 'second', label: 'Second', description: 'Second page' },
    ]);
    expect(fake.requests.at(-1)).toEqual({
      id: 3,
      method: 'model/list',
      params: { cursor: 'page-2', includeHidden: false },
    });
  });

  it('rejects an old app-server without model/list', async () => {
    const fake = fakeChild([
      { id: 1, result: {} },
      { id: 2, error: { code: -32601, message: 'Method not found' } },
    ]);
    await expect(discoverCodexModels({ cwd: '/repo', spawn: () => fake.child })).rejects.toThrow('Method not found');
  });

  it('rejects malformed model pages and malformed NDJSON', async () => {
    const invalidPage = fakeChild([{ id: 1, result: {} }, { id: 2, result: { data: [{ model: 42 }] } }]);
    await expect(discoverCodexModels({ cwd: '/repo', spawn: () => invalidPage.child })).rejects.toThrow('malformed model data');

    const invalidJson = fakeChild([{ id: 1, result: {} }]);
    invalidJson.child.stdin.on('data', () => queueMicrotask(() => (invalidJson.child.stdout as PassThrough).write('{broken\n')));
    await expect(discoverCodexModels({ cwd: '/repo', spawn: () => invalidJson.child })).rejects.toThrow('malformed NDJSON');
  });

  it('rejects cursor loops instead of returning an incomplete catalog', async () => {
    const fake = fakeChild([
      { id: 1, result: {} },
      { id: 2, result: { data: [], nextCursor: 'again' } },
      { id: 3, result: { data: [], nextCursor: 'again' } },
    ]);
    await expect(discoverCodexModels({ cwd: '/repo', spawn: () => fake.child })).rejects.toThrow('cursor loop');
  });

  it('rejects oversized catalogs and excessive pagination', async () => {
    const tooMany = fakeChild([
      { id: 1, result: {} },
      {
        id: 2,
        result: {
          data: Array.from({ length: 501 }, (_, index) => ({ model: `model-${index}` })),
          nextCursor: null,
        },
      },
    ]);
    await expect(discoverCodexModels({ cwd: '/repo', spawn: () => tooMany.child })).rejects.toThrow('size limit');

    const tooManyPages = fakeChild([
      { id: 1, result: {} },
      ...Array.from({ length: 25 }, (_, index) => ({
        id: index + 2,
        result: { data: [], nextCursor: `page-${index + 2}` },
      })),
    ]);
    await expect(discoverCodexModels({ cwd: '/repo', spawn: () => tooManyPages.child })).rejects.toThrow('page limit');
  });

  it('times out a non-responsive child', async () => {
    const fake = fakeChild();
    await expect(discoverCodexModels({ cwd: '/repo', timeoutMs: 10, spawn: () => fake.child })).rejects.toThrow('timed out');
  });

  it('rejects when the child exits while a request is pending', async () => {
    const fake = fakeChild();
    const discovery = discoverCodexModels({ cwd: '/repo', spawn: () => fake.child });
    queueMicrotask(() => fake.emitExit(7));
    await expect(discovery).rejects.toThrow('exited (7)');
  });
});

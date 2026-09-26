import { afterEach, describe, expect, it, vi } from 'vitest';
const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile }));
import { createGithubDriver } from './github.ts';

afterEach(() => {
  vi.unstubAllEnvs();
  execFile.mockReset();
});
describe('recent created GitHub items', () => {
  it('queries all states with creation descending ordering and an explicit enterprise repository', async () => {
    execFile.mockImplementation((_cmd, _args, _opts, cb) =>
      cb(null, {
        stdout: JSON.stringify({
          items: [
            {
              number: 4,
              title: 'Closed yesterday',
              created_at: '2026-09-17T12:00:00Z',
              html_url: 'https://github.example/o/r/issues/4',
              state: 'closed',
            },
          ],
        }),
      }),
    );
    const driver = createGithubDriver('/repo', { host: 'github.example', owner: 'o', repo: 'r' });
    expect(driver.recentCreated).toBeTypeOf('function');
    const result = await driver.recentCreated!('issue', '2026-09-11');
    expect(result).toEqual({
      available: true,
      items: [
        {
          number: 4,
          title: 'Closed yesterday',
          createdAt: '2026-09-17T12:00:00Z',
          url: 'https://github.example/o/r/issues/4',
        },
      ],
      truncated: false,
    });
    expect(execFile.mock.calls[0]?.[1]).toEqual([
      'api',
      '--hostname',
      'github.example',
      '--method',
      'GET',
      'search/issues',
      '-f',
      'q=repo:o/r is:issue created:>=2026-09-11',
      '-f',
      'sort=created',
      '-f',
      'order=desc',
      '-f',
      'per_page=30',
    ]);
  });
  it('rejects invalid dates before execution and validates remote JSON', async () => {
    const driver = createGithubDriver('/repo', { owner: 'o', repo: 'r' });
    expect(driver.recentCreated).toBeTypeOf('function');
    expect((await driver.recentCreated!('pr', 'oops sort:updated')).available).toBe(false);
    expect(execFile).not.toHaveBeenCalled();
    execFile.mockImplementation((_cmd, _args, _opts, cb) =>
      cb(null, { stdout: JSON.stringify({ items: [{ number: -1 }] }) }),
    );
    expect((await driver.recentCreated!('pr', '2026-09-11')).available).toBe(false);
  });
  it('provides recent dry-run entries without subprocesses', async () => {
    vi.stubEnv('CEZ_DRY_RUN', '1');
    const driver = createGithubDriver('/repo', { owner: 'o', repo: 'r' });
    expect(driver.recentCreated).toBeTypeOf('function');
    const result = await driver.recentCreated!('pr', new Date().toISOString().slice(0, 10));
    expect(result.available).toBe(true);
    expect(result.items.length).toBeGreaterThan(0);
    expect(execFile).not.toHaveBeenCalled();
  });
});

it('caps merged PR creation results at thirty and marks full or incomplete pages truncated', async () => {
  execFile.mockImplementation((_cmd, _args, _opts, cb) =>
    cb(null, {
      stdout: JSON.stringify({
        items: Array.from({ length: 35 }, (_, index) => ({
          number: index + 1,
          title: 'Merged',
          created_at: '2026-09-17T12:00:00Z',
          html_url: `https://github.com/o/r/pull/${index + 1}`,
          state: 'closed',
        })),
      }),
    }),
  );
  const driver = createGithubDriver('/repo', { owner: 'o', repo: 'r' });
  const result = await driver.recentCreated!('pr', '2026-09-11');
  expect(result.items).toHaveLength(30);
  expect(result.truncated).toBe(true);
  expect(execFile.mock.calls[0]?.[1]).toContain('q=repo:o/r is:pr created:>=2026-09-11');
  execFile.mockImplementation((_cmd, _args, _opts, cb) =>
    cb(null, { stdout: JSON.stringify({ items: [], incomplete_results: true }) }),
  );
  expect((await driver.recentCreated!('pr', '2026-09-11')).truncated).toBe(true);
});

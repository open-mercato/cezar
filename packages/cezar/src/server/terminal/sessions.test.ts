import { describe, expect, it, vi } from 'vitest';

import type { PtyBinding, PtyProcess, PtySpawnOptions } from './pty-module.ts';
import { MAX_SESSIONS, SCROLLBACK_LIMIT, TerminalSessions } from './sessions.ts';

/** A PTY that records what it was told, so no test forks a real shell. */
class FakePty implements PtyProcess {
  readonly pid = 4242;
  written: string[] = [];
  resized: Array<[number, number]> = [];
  killed: Array<string | undefined> = [];
  disposed = 0;
  private data?: (chunk: string) => void;
  private exit?: (event: { exitCode: number; signal?: number }) => void;

  onData(listener: (chunk: string) => void) {
    this.data = listener;
    return { dispose: () => { this.disposed += 1; } };
  }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
    this.exit = listener;
    return { dispose: () => { this.disposed += 1; } };
  }
  write(data: string) { this.written.push(data); }
  resize(cols: number, rows: number) { this.resized.push([cols, rows]); }
  kill(signal?: string) { this.killed.push(signal); }

  emit(chunk: string) { this.data?.(chunk); }
  finish(exitCode: number) { this.exit?.({ exitCode }); }
}

function harness(options: { spawn?: () => PtyProcess } = {}) {
  const spawned: FakePty[] = [];
  // Typed like the real `spawn` so the assertions below can read the options it was handed.
  const spawn = vi.fn((_file: string, _args: string[], _options: PtySpawnOptions): PtyProcess => {
    if (options.spawn) return options.spawn();
    const pty = new FakePty();
    spawned.push(pty);
    return pty;
  });
  const binding = async (): Promise<PtyBinding> => ({ available: true, module: { spawn } });
  return { sessions: new TerminalSessions(binding), spawned, spawn };
}

const open = async (sessions: TerminalSessions, runId = 'run-1', cwd = '/tmp/wt') => {
  const created = await sessions.create({ runId, cwd, cols: 100, rows: 30 });
  if (!created.ok) throw new Error(`expected a session, got: ${created.reason}`);
  return created.session;
};

describe('creating a session', () => {
  it('spawns one PTY in the task worktree, with a real terminal type', async () => {
    const { sessions, spawn } = harness();
    const session = await open(sessions);

    expect(session.runId).toBe('run-1');
    expect(session.cwd).toBe('/tmp/wt');
    expect(session.exitCode).toBeNull();
    const [, , options] = spawn.mock.calls[0]!;
    expect(options).toMatchObject({ cwd: '/tmp/wt', cols: 100, rows: 30, name: 'xterm-256color' });
    // A PTY with no TERM makes programs fall back to dumb output, which reads as broken.
    expect(options.env.TERM).toBe('xterm-256color');
  });

  it('degrades to an honest reason when the binding is unavailable', async () => {
    const sessions = new TerminalSessions(async () => ({ available: false, reason: 'not installed here' }));
    const created = await sessions.create({ runId: 'run-1', cwd: '/tmp/wt' });
    expect(created).toEqual({ ok: false, reason: 'not installed here' });
  });

  it('answers rather than throws when the shell cannot be spawned', async () => {
    const { sessions } = harness({ spawn: () => { throw new Error('ENOENT: no such file or directory'); } });
    const created = await sessions.create({ runId: 'run-1', cwd: '/gone' });
    expect(created.ok).toBe(false);
    expect(created.ok === false && created.reason).toContain('ENOENT');
  });

  it('bounds how many shells one client can fork', async () => {
    const { sessions } = harness();
    for (let n = 0; n < MAX_SESSIONS; n += 1) await open(sessions);
    const extra = await sessions.create({ runId: 'run-1', cwd: '/tmp/wt' });
    expect(extra.ok).toBe(false);
    expect(extra.ok === false && extra.reason).toContain('Too many terminal sessions');
  });

  it('clamps nonsense dimensions instead of passing them to the PTY', async () => {
    const { sessions, spawn } = harness();
    await sessions.create({ runId: 'run-1', cwd: '/tmp/wt', cols: 0, rows: Number.NaN });
    const [, , options] = spawn.mock.calls[0]!;
    expect(options).toMatchObject({ cols: 1, rows: 24 });
  });
});

describe('reading output', () => {
  it('replays everything retained from cursor 0 and advances the cursor', async () => {
    const { sessions, spawned } = harness();
    const session = await open(sessions);
    spawned[0]!.emit('hello ');
    spawned[0]!.emit('world');

    const first = sessions.read(session.id, 0)!;
    expect(first.data).toBe('hello world');
    expect(first.cursor).toBe(11);
    expect(first.truncated).toBe(false);

    // A follow-up read from that cursor sees only what is new.
    spawned[0]!.emit('!');
    const next = sessions.read(session.id, first.cursor)!;
    expect(next.data).toBe('!');
    expect(next.cursor).toBe(12);
  });

  it('reports truncation rather than silently skipping dropped scrollback', async () => {
    const { sessions, spawned } = harness();
    const session = await open(sessions);
    spawned[0]!.emit('x'.repeat(SCROLLBACK_LIMIT + 10));

    const read = sessions.read(session.id, 0)!;
    expect(read.data).toHaveLength(SCROLLBACK_LIMIT);
    expect(read.truncated).toBe(true);
    expect(read.cursor).toBe(SCROLLBACK_LIMIT + 10);
  });

  it('caps the retained scrollback no matter how much is written', async () => {
    const { sessions, spawned } = harness();
    const session = await open(sessions);
    for (let n = 0; n < 5; n += 1) spawned[0]!.emit('y'.repeat(100_000));
    expect(sessions.read(session.id, 0)!.data.length).toBeLessThanOrEqual(SCROLLBACK_LIMIT);
  });

  it('tolerates a cursor from the future', async () => {
    const { sessions, spawned } = harness();
    const session = await open(sessions);
    spawned[0]!.emit('abc');
    expect(sessions.read(session.id, 9_999)!).toMatchObject({ data: '', cursor: 3, truncated: false });
  });

  it('has nothing to say about a session it does not have', async () => {
    const { sessions } = harness();
    expect(sessions.read('nope', 0)).toBeNull();
  });
});

describe('input and resize', () => {
  it('forwards keystrokes to the PTY', async () => {
    const { sessions, spawned } = harness();
    const session = await open(sessions);
    expect(sessions.write(session.id, 'ls\r')).toBe(true);
    expect(spawned[0]!.written).toEqual(['ls\r']);
  });

  it('drops input to an exited shell instead of throwing', async () => {
    const { sessions, spawned } = harness();
    const session = await open(sessions);
    spawned[0]!.finish(0);
    expect(sessions.write(session.id, 'ls\r')).toBe(false);
    expect(spawned[0]!.written).toEqual([]);
  });

  it('propagates a resize and remembers it', async () => {
    const { sessions, spawned } = harness();
    const session = await open(sessions);
    expect(sessions.resize(session.id, 120, 40)).toBe(true);
    expect(spawned[0]!.resized).toEqual([[120, 40]]);
    expect(sessions.get(session.id)).toMatchObject({ cols: 120, rows: 40 });
  });
});

describe('exit', () => {
  it('records the code and keeps the last output readable', async () => {
    const { sessions, spawned } = harness();
    const session = await open(sessions);
    spawned[0]!.emit('build failed\n');
    spawned[0]!.finish(1);

    const read = sessions.read(session.id, 0)!;
    expect(read.exitCode).toBe(1);
    expect(read.data).toBe('build failed\n');
    expect(sessions.get(session.id)?.exitCode).toBe(1);
  });

  it('wakes subscribers on output and on exit', async () => {
    const { sessions, spawned } = harness();
    const session = await open(sessions);
    const woken = vi.fn();
    const release = sessions.subscribe(session.id, woken);

    spawned[0]!.emit('tick');
    expect(woken).toHaveBeenCalledTimes(1);
    spawned[0]!.finish(0);
    expect(woken).toHaveBeenCalledTimes(2);

    release();
    release(); // idempotent
    spawned[0]!.emit('ignored');
    expect(woken).toHaveBeenCalledTimes(2);
  });
});

describe('stopping', () => {
  it('signals the process GROUP so the shell takes its children with it', async () => {
    const { sessions } = harness();
    const session = await open(sessions);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      expect(sessions.kill(session.id)).toBe(true);
      // Negative pid — the whole tree, not just the shell.
      expect(kill).toHaveBeenCalledWith(-4242, 'SIGHUP');
    } finally {
      kill.mockRestore();
    }
  });

  it('falls back to the binding when the group signal fails', async () => {
    const { sessions, spawned } = harness();
    const session = await open(sessions);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('ESRCH'); });
    try {
      sessions.kill(session.id);
      expect(spawned[0]!.killed).toEqual(['SIGHUP']);
    } finally {
      kill.mockRestore();
    }
  });

  it('an explicit stop FORGETS the session, so a closed tab cannot come back', async () => {
    // Regression: `kill()` used to leave the entry in place, and `onExit` then retained the
    // corpse for a minute. The drawer reconciles its tab strip against `listFor` every two
    // seconds, so a tab the user had just closed reappeared — labelled "zakończony" — and a
    // drawer reopened inside that minute reattached to the dead shell instead of starting a
    // fresh one. Spec §6: confirming a close "closes the terminal session".
    const { sessions } = harness();
    const session = await open(sessions);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      expect(sessions.kill(session.id)).toBe(true);
    } finally {
      kill.mockRestore();
    }
    expect(sessions.listFor('run-1')).toEqual([]);
    expect(sessions.get(session.id)).toBeNull();
  });

  it('keeps a session that exited ON ITS OWN, so its last line and code can still be read', async () => {
    // The other half of the same rule: the retention window exists for a shell nobody closed —
    // the user typed `exit`, or the process died — whose exit code a still-polling client has
    // not seen yet. That one stays listed.
    const { sessions, spawned } = harness();
    const session = await open(sessions);
    spawned[0]!.finish(3);

    const listed = sessions.listFor('run-1');
    expect(listed).toHaveLength(1);
    expect(listed[0]!.exitCode).toBe(3);
    expect(sessions.read(session.id, 0)?.exitCode).toBe(3);
  });

  it('closeAll stops every session and forgets them', async () => {
    const { sessions } = harness();
    await open(sessions, 'run-1');
    await open(sessions, 'run-2');
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      sessions.closeAll();
    } finally {
      kill.mockRestore();
    }
    expect(sessions.listFor('run-1')).toEqual([]);
    expect(sessions.listFor('run-2')).toEqual([]);
  });
});

describe('listing', () => {
  it('keeps one task’s sessions out of another’s', async () => {
    const { sessions } = harness();
    const mine = await open(sessions, 'run-1');
    await open(sessions, 'run-2');
    expect(sessions.listFor('run-1').map((entry) => entry.id)).toEqual([mine.id]);
    expect(sessions.listFor('run-2')).toHaveLength(1);
  });
});

describe('tab labels', () => {
  it('starts at Terminal 1 and counts up within a task', async () => {
    const { sessions } = harness();
    const first = await open(sessions, 'run-1');
    const second = await open(sessions, 'run-1');
    expect([first.label, second.label]).toEqual(['Terminal 1', 'Terminal 2']);
  });

  it('numbers each task from one', async () => {
    const { sessions } = harness();
    await open(sessions, 'run-1');
    const other = await open(sessions, 'run-2');
    expect(other.label).toBe('Terminal 1');
  });

  it('names the tab after the running command, and KEEPS it once idle', async () => {
    const { sessions } = harness();
    const session = await open(sessions);
    // The fake PTY reports pid 4242, so a child of 4242 is this session's foreground.
    sessions.observe([{ pid: 1, ppid: 4242, command: 'npm run build' }]);
    expect(sessions.get(session.id)).toMatchObject({ label: 'npm run build', busy: true });

    // Command finished: the name stays, because the output under it is still worth reading.
    sessions.observe([]);
    expect(sessions.get(session.id)).toMatchObject({ label: 'npm run build', busy: false });

    // …until another command replaces it.
    sessions.observe([{ pid: 2, ppid: 4242, command: 'npm test' }]);
    expect(sessions.get(session.id)?.label).toBe('npm test');
  });

  it('leaves an exited session last label alone', async () => {
    const { sessions, spawned } = harness();
    const session = await open(sessions);
    sessions.observe([{ pid: 1, ppid: 4242, command: 'make dev' }]);
    spawned[0]!.finish(1);
    sessions.observe([{ pid: 9, ppid: 4242, command: 'something else' }]);
    expect(sessions.get(session.id)).toMatchObject({ label: 'make dev', exitCode: 1 });
  });
});

describe('a host that cannot read its process table', () => {
  // Windows has no `ps`, and a hardened container can hide the table. `observe(null)` is that
  // host. The old code resolved the failed read to `[]`, which reads as the positive claim
  // "nothing is running" — and that claim silently disabled the close warning spec §6 requires,
  // so closing a tab mid-build took the whole process tree without asking.
  it('reports busy as UNKNOWN rather than as idle', async () => {
    const { sessions } = harness();
    const session = await open(sessions);

    sessions.observe(null);

    expect(sessions.get(session.id)?.busy).toBeNull();
  });

  it('leaves the tab name alone, because an absence of information is not a new command', async () => {
    const { sessions, spawned } = harness();
    const session = await open(sessions);
    sessions.observe([{ pid: 5, ppid: spawned[0]!.pid, command: 'npm run build' }]);
    expect(sessions.get(session.id)?.label).toBe('npm run build');

    sessions.observe(null);

    expect(sessions.get(session.id)?.label).toBe('npm run build');
    expect(sessions.get(session.id)?.busy).toBeNull();
  });

  it('goes back to a definite answer once the table can be read again', async () => {
    const { sessions } = harness();
    const session = await open(sessions);
    sessions.observe(null);
    expect(sessions.get(session.id)?.busy).toBeNull();

    sessions.observe([]);

    expect(sessions.get(session.id)?.busy).toBe(false);
  });
});

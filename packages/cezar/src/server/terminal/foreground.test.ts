import { describe, expect, it } from 'vitest';

import { foregroundCommand, hasForeground, parseProcessRows, tidyCommand } from './foreground.ts';

/** A `ps -axo pid=,ppid=,command=` sample: a shell (900) running `npm run dev`, which has its
 *  own child, plus an unrelated process to prove the walk does not wander. */
const PS = `
  900   1 /bin/zsh -il
  901 900 npm run dev
  902 901 node /repo/node_modules/.bin/vite
  950   1 /usr/bin/unrelated --daemon
`;

describe('parseProcessRows', () => {
  it('keeps the whole command line, arguments and all', () => {
    const rows = parseProcessRows(PS);
    expect(rows).toHaveLength(4);
    expect(rows[1]).toEqual({ pid: 901, ppid: 900, command: 'npm run dev' });
  });

  it('skips rows ps truncated mid-exit', () => {
    expect(parseProcessRows('  900\n  not a row\n  901 900 npm run dev\n')).toEqual([
      { pid: 901, ppid: 900, command: 'npm run dev' },
    ]);
  });

  it('has nothing to say about empty output — a host with no readable table', () => {
    expect(parseProcessRows('')).toEqual([]);
  });
});

describe('foregroundCommand', () => {
  const rows = parseProcessRows(PS);

  it('names the tab after what the user typed, not the leaf process', () => {
    // `npm run dev`, not `node …/vite`: the first generation is the recognisable one.
    expect(foregroundCommand(rows, 900)).toBe('npm run dev');
  });

  it('is null at an idle prompt', () => {
    expect(foregroundCommand(rows, 902)).toBeNull();
  });

  it('never attributes an unrelated process to a shell', () => {
    expect(foregroundCommand(rows, 999)).toBeNull();
  });
});

describe('hasForeground', () => {
  const rows = parseProcessRows(PS);

  it('is the same reading the tab name comes from, so the two cannot disagree', () => {
    expect(hasForeground(rows, 900)).toBe(true);
    expect(foregroundCommand(rows, 900)).not.toBeNull();
  });

  it('is false for a shell sitting at its prompt', () => {
    expect(hasForeground(rows, 902)).toBe(false);
  });
});

describe('tidyCommand', () => {
  it('drops the directory, which never distinguishes one tab from another', () => {
    expect(tidyCommand('/opt/homebrew/bin/node server.js')).toBe('node server.js');
  });

  it('keeps a short command whole', () => {
    expect(tidyCommand('npm run dev:server')).toBe('npm run dev:server');
  });

  it('caps a long one so the strip stays a strip', () => {
    const tidy = tidyCommand(`npm run ${'x'.repeat(80)}`);
    expect(tidy).toHaveLength(40);
    expect(tidy.endsWith('…')).toBe(true);
  });

  it('survives whitespace-only input', () => {
    expect(tidyCommand('   ')).toBe('');
  });
});

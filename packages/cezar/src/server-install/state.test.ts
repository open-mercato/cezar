import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serverStatePath } from '../paths.js';
import {
  acquireLock,
  deleteServerState,
  firstIncompleteStep,
  isResolved,
  listServerInstances,
  loadServerState,
  LockHeldError,
  nextFreeInstancePort,
  saveServerState,
} from './state.js';
import { freshServerState } from './types.js';

describe('server state', () => {
  let home: string;
  const original = process.env.CEZ_HOME;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-state-'));
    process.env.CEZ_HOME = home;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = original;
    rmSync(home, { recursive: true, force: true });
  });

  it('degrades to fresh when the file is missing', () => {
    expect(loadServerState()).toEqual(freshServerState());
  });

  it('degrades to fresh on corrupt JSON', () => {
    writeFileSync(serverStatePath(), 'not json{{{');
    expect(loadServerState().installed).toBe(false);
  });

  it('round-trips and writes 0600', () => {
    const s = freshServerState();
    s.platform = 'ubuntu-vps';
    s.steps.deps = { status: 'done', created: null };
    saveServerState(s);
    const mode = statSync(serverStatePath()).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(loadServerState().steps.deps?.status).toBe('done');
  });

  it('firstIncompleteStep skips done and skipped, stops at pending/failed', () => {
    const s = freshServerState();
    s.steps = {
      a: { status: 'done', created: null },
      b: { status: 'skipped', created: null },
      c: { status: 'failed', created: null },
    };
    expect(firstIncompleteStep(['a', 'b', 'c', 'd'], s)).toBe('c');
    expect(isResolved(s.steps.a)).toBe(true);
    expect(isResolved(s.steps.b)).toBe(true);
    expect(isResolved(s.steps.c)).toBe(false);
  });

  it('lock is exclusive against a live foreign pid and reclaims stale', () => {
    const release = acquireLock();
    // simulate a live foreign holder
    writeFileSync(join(home, 'server.install.lock'), `${process.pid === 1 ? 2 : 1}\n`);
    // pid 1 is alive on posix; expect the lock to be held
    expect(() => acquireLock()).toThrow(LockHeldError);
    // a dead pid is reclaimed
    writeFileSync(join(home, 'server.install.lock'), '999999999\n');
    const release2 = acquireLock();
    release2();
    release();
  });

  it('lock acquisition is atomic (wx) — a pre-existing live lock file always wins', () => {
    // Simulate the race loser: the file appears (live pid) before our write.
    writeFileSync(join(home, 'server.install.lock'), `${process.pid === 1 ? 2 : 1}\n`, { flag: 'wx' });
    expect(() => acquireLock()).toThrow(LockHeldError);
  });

  it('named instances persist to their own file and never clobber the default', () => {
    const def = freshServerState();
    def.platform = 'ubuntu-vps';
    def.primaryPort = 4321;
    saveServerState(def); // default → server.json

    const shop = freshServerState();
    shop.platform = 'ubuntu-vps';
    shop.instance = 'shop-example-com';
    shop.domain = 'shop.example.com';
    shop.primaryPort = 4322;
    saveServerState(shop, 'shop-example-com'); // named → server-instances/…

    // Each loads back independently — the second install did not touch the first.
    expect(loadServerState().primaryPort).toBe(4321);
    expect(loadServerState('shop-example-com').primaryPort).toBe(4322);
    expect(loadServerState('shop-example-com').domain).toBe('shop.example.com');
    // A brand-new (unknown) instance still degrades to a fresh record.
    expect(loadServerState('nope').installed).toBe(false);
  });

  it('listServerInstances enumerates default + named; nextFreeInstancePort skips used ports', () => {
    expect(listServerInstances()).toHaveLength(0);
    expect(nextFreeInstancePort()).toBe(4321); // nothing recorded yet

    const def = freshServerState();
    def.primaryPort = 4321;
    saveServerState(def);
    const a = freshServerState();
    a.primaryPort = 4322;
    saveServerState(a, 'a-example-com');

    const names = listServerInstances().map((i) => i.instance).sort();
    expect(names).toEqual(['a-example-com', 'default']);
    expect(nextFreeInstancePort()).toBe(4323); // 4321 + 4322 both taken
  });

  it('deleteServerState drops a named record but leaves the default in place', () => {
    saveServerState(freshServerState()); // default
    const a = freshServerState();
    a.primaryPort = 4322;
    saveServerState(a, 'a-example-com');
    deleteServerState('a-example-com');
    expect(listServerInstances().map((i) => i.instance)).toEqual(['default']);
    // deleting the default is a no-op (legacy single-host record is kept)
    deleteServerState('default');
    expect(listServerInstances().map((i) => i.instance)).toEqual(['default']);
  });

  it('the install lock is per-instance — one instance never blocks another', () => {
    const release = acquireLock('shop-example-com');
    // a DIFFERENT instance acquires freely (independent lock file)
    const releaseOther = acquireLock('blog-example-com');
    releaseOther();
    // but the SAME instance is exclusive against a live foreign pid
    writeFileSync(
      join(home, 'server-instances', 'shop-example-com.install.lock'),
      `${process.pid === 1 ? 2 : 1}\n`,
    );
    expect(() => acquireLock('shop-example-com')).toThrow(LockHeldError);
    release();
  });

  it('a newer-version server.json degrades per-field, never to a fresh record', () => {
    writeFileSync(
      serverStatePath(),
      JSON.stringify({
        schema: 1,
        platform: 'ubuntu-vps-caddy', // platform this version does not ship
        installed: true,
        primaryPort: 4321,
        futureField: { keep: 'me' },
        steps: {
          deps: { status: 'done', created: { artifacts: [] } },
          'future-step': { status: 'running', created: null }, // unknown status
        },
      }),
    );
    const s = loadServerState();
    expect(s.platform).toBe('ubuntu-vps-caddy'); // ledger intact
    expect(s.installed).toBe(true);
    expect(s.steps.deps?.status).toBe('done');
    // unknown status degrades to failed (stays on the undo path), not to data loss
    expect(s.steps['future-step']?.status).toBe('failed');
    // unknown top-level fields survive a load+save round-trip
    saveServerState(s);
    expect(JSON.parse(readFileSync(serverStatePath(), 'utf8')).futureField).toEqual({ keep: 'me' });
  });
});

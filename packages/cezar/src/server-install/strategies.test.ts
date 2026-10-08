import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { availablePlatformIds, getStrategy } from './strategies.ts';
import { runInstall, runUninstall } from './engine.ts';
import { listServerInstances, loadServerState, nextFreeInstancePort } from './state.ts';
import { createAutoUi } from './ui.ts';
import { nginxVhost, systemdUnit } from './platforms/ubuntu-vps.ts';
import type { BackendCheck } from '../core/backend-detect.ts';
import type { Runner } from './types.ts';

const noRunner: Runner = { capture: async () => ({ code: 0, stdout: '', stderr: '' }), interactive: async () => 0 };

/**
 * The content a dry run would write to `path`. Privileged writes travel as
 * `printf %s '<base64>' | base64 --decode > '<path>'`, and a dry run prints that
 * command verbatim — so decoding it is the closest a unit test gets to reading
 * the file the installer puts on the server.
 */
function writtenFileContent(messages: string[], path: string): string {
  // The line is `DRY RUN — would run: sudo bash -lc '<command>'`, so the inner
  // command's own quotes arrive shell-escaped as `'\''`.
  const commands = messages
    .filter((m) => m.includes('sudo bash -lc '))
    .map((m) => m.slice(m.indexOf('sudo bash -lc ') + 'sudo bash -lc '.length).replace(/'\\''/g, "'").slice(1, -1));
  const cmd = commands.find((c) => c.includes(`base64 --decode > '${path}'`));
  if (!cmd) throw new Error(`no dry-run write of ${path} in:\n${messages.join('\n')}`);
  const b64 = /printf %s '([A-Za-z0-9+/=]+)'/.exec(cmd)?.[1];
  if (!b64) throw new Error(`could not read the payload out of: ${cmd}`);
  return Buffer.from(b64, 'base64').toString('utf8');
}

describe('registry', () => {
  it('resolves ubuntu-vps and lists available ids', () => {
    expect(getStrategy('ubuntu-vps')?.id).toBe('ubuntu-vps');
    expect(getStrategy('nope')).toBeUndefined();
    expect(availablePlatformIds()).toContain('ubuntu-vps');
  });
});

describe('nginxVhost', () => {
  it('points at the loopback port and disables SSE buffering', () => {
    const v = nginxVhost(4321);
    expect(v).toContain('proxy_pass http://127.0.0.1:4321;');
    expect(v).toContain('proxy_buffering off;');
    expect(v).toContain('auth_basic_user_file /etc/cezar/htpasswd;');
    // HTTP/2 is spelled per installed nginx version — ubuntu-vps.test.ts owns
    // that (#910); with no version given the output must stay 1.24-parseable.
    expect(v).not.toMatch(/^\s*http2\s/m);
  });
});

describe('ubuntu-vps dry-run', () => {
  let home: string;
  const original = process.env.CEZ_HOME;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-ubuntu-'));
    process.env.CEZ_HOME = home;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = original;
    rmSync(home, { recursive: true, force: true });
  });

  it('walks every Phase-1 step and writes a complete server.json', async () => {
    const strategy = getStrategy('ubuntu-vps')!;
    const res = await runInstall(strategy, {
      dryRun: true,
      assumeYes: true,
      reconfigure: new Set(),
      repoRoot: '/repo',
      now: '2026-07-16T00:00:00.000Z',
      ui: createAutoUi({ 'Missing tools — select the ones to install': [] as string[] }),
      runner: noRunner,
    });
    expect(res.status).toBe('complete');
    const state = loadServerState();
    expect(state.platform).toBe('ubuntu-vps');
    expect(state.steps.deps?.status).toBe('done');
    expect(state.steps['nginx-proxy']?.status).toBe('done');
    expect(state.steps.identity?.status).toBe('done');
    expect(state.installed).toBe(true);
  });

  /**
   * #913 — two cezar instances on one host, owned by two different unix users.
   *
   * The second user's `~/.cezar` is EMPTY (it is their own home), while the
   * first user's cezar really holds a loopback port. The recorded-state scan
   * alone therefore handed instance two the port instance one was already on,
   * and nginx then authenticated the second user against their own htpasswd and
   * forwarded them into the FIRST user's cockpit — their projects, their run
   * history, their coding-agent subscription quota, their `gh` credential.
   *
   * What this pins is the property nothing checked before: the port the vhost
   * is WRITTEN with, the port the state RECORDS, and the port the unit would
   * bind are the same number, and it is never the first instance's.
   */
  it("a second instance's vhost never points at the first instance's port", async () => {
    // The first user's cezar: an actual listening socket this test does not own
    // through any registry, exactly like another unix account's service.
    const firstInstance = createServer();
    await new Promise<void>((listening) => firstInstance.listen(0, '127.0.0.1', listening));
    const firstPort = (firstInstance.address() as AddressInfo).port;

    try {
      // Nothing in THIS user's registry knows about it — that is the whole bug.
      expect(listServerInstances()).toHaveLength(0);
      const port = await nextFreeInstancePort(firstPort);
      expect(port).not.toBe(firstPort);

      const messages: string[] = [];
      const res = await runInstall(getStrategy('ubuntu-vps')!, {
        dryRun: true,
        assumeYes: true,
        reconfigure: new Set(),
        repoRoot: '/repo',
        now: '2026-09-16T00:00:00.000Z',
        instance: 'b-example-com',
        domain: 'b.example.com',
        port,
        ui: createAutoUi({ 'Missing tools — select the ones to install': [] as string[] }, (m) => messages.push(m)),
        runner: noRunner,
      });
      expect(res.status).toBe('complete');

      // The vhost as the install would actually write it to disk.
      const vhost = writtenFileContent(messages, '/etc/nginx/sites-available/cezar-b-example-com');
      expect(vhost).toContain(`proxy_pass http://127.0.0.1:${port};`);
      expect(vhost).not.toContain(`127.0.0.1:${firstPort}`);

      // …and the two other records that must agree with it. Any pair agreeing
      // while the third differs is this bug.
      const recorded = loadServerState('b-example-com').primaryPort;
      expect(recorded).toBe(port);
      expect(vhost).toBe(nginxVhost(recorded, 'b.example.com', '/etc/cezar/htpasswd-b-example-com'));
      expect(systemdUnit('/repo', recorded, 'user', '/usr/local/bin/cezar')).toContain(`--port ${port}`);
    } finally {
      await new Promise<void>((closed) => firstInstance.close(() => closed()));
    }
  });
});

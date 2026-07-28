import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isNpxExecStart,
  nginxVhost,
  refreshNpxCacheForRedeploy,
  serviceExecStart,
  systemdUnit,
  ubuntuVps,
} from './ubuntu-vps.js';
import { StepAborted } from '../steps.js';
import { createAutoUi } from '../ui.js';
import type { InstallContext, InstallStep, Runner, Ui } from '../types.js';

const okRunner: Runner = { capture: async () => ({ code: 0, stdout: '', stderr: '' }), interactive: async () => 0 };

function ctxWith(over: {
  ui?: Ui;
  runner?: Runner;
  dryRun?: boolean;
  state?: Partial<InstallContext['state']>;
}): InstallContext {
  return {
    state: { schema: 1, installed: false, primaryPort: 4321, steps: {}, ...over.state },
    ui: over.ui ?? createAutoUi(),
    instance: 'default',
    runner: over.runner ?? okRunner,
    save: async () => {},
    dryRun: over.dryRun ?? false,
    assumeYes: true,
    reconfigure: new Set(),
    repoRoot: '/repo',
    now: '2026-07-16T00:00:00.000Z',
    prefs: {},
  };
}

function stepById(id: string): InstallStep {
  const s = ubuntuVps.steps(ctxWith({})).find((x) => x.id === id);
  if (!s) throw new Error(`no step ${id}`);
  return s;
}

describe('ubuntu-vps ssl step', () => {
  let home: string;
  const original = process.env.CEZ_HOME;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-ssl-'));
    process.env.CEZ_HOME = home;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = original;
    rmSync(home, { recursive: true, force: true });
  });

  it('orders the steps and only SSL is optional (the service must run)', () => {
    const ids = ubuntuVps.steps(ctxWith({})).map((s) => s.id);
    expect(ids).toEqual(['deps', 'nginx-proxy', 'ssl', 'autostart', 'identity']);
    expect(stepById('ssl').optional).toBe(true);
    // The service step is required now — after install cezar must actually run.
    expect(stepById('autostart').optional).toBeFalsy();
    expect(stepById('identity').optional).toBeFalsy();
  });

  it('--external-proxy drops our nginx + SSL steps (an existing front owns :80/:443)', () => {
    const ids = ubuntuVps.steps(ctxWith({ state: { externalProxy: true } })).map((s) => s.id);
    expect(ids).toEqual(['deps', 'autostart', 'identity']);
    expect(ids).not.toContain('nginx-proxy');
    expect(ids).not.toContain('ssl');
  });

  it('external-proxy verify passes when cezar answers on the bound host', async () => {
    const seen: string[] = [];
    const runner: Runner = {
      capture: async (program, args) => {
        if (program === 'curl') seen.push(args.join(' '));
        return { code: 0, stdout: program === 'curl' ? '200' : '', stderr: '' };
      },
      interactive: async () => 0,
    };
    const ctx = ctxWith({ runner, state: { externalProxy: true, bindHost: '172.17.0.1' } });
    await expect(stepById('identity').run(ctx)).resolves.toBeTruthy();
    // It must probe the bind host, not loopback — a container proxy can't use 127.0.0.1.
    expect(seen.some((a) => a.includes('http://172.17.0.1:4321/'))).toBe(true);
  });

  it('external-proxy verify aborts when nothing is listening', async () => {
    const runner: Runner = {
      // curl "000" = no connection; `sleep` between polls returns 0.
      capture: async (program) => ({ code: 0, stdout: program === 'curl' ? '000' : '', stderr: '' }),
      interactive: async () => 0,
    };
    const ctx = ctxWith({ runner, state: { externalProxy: true, bindHost: '172.17.0.1' } });
    await expect(stepById('identity').run(ctx)).rejects.toBeInstanceOf(StepAborted);
  });

  it('dry-run records the cert as a shared artifact and sets publicUrl', async () => {
    const ui = { ...createAutoUi(), text: async (o: { message: string }) => (o.message.includes('Domain') ? 'cezar.example.com' : 'you@example.com') } as Ui;
    const ctx = ctxWith({ dryRun: true, ui });
    const created = await stepById('ssl').run(ctx);
    const cert = created?.artifacts.find((a) => a.type === 'cert');
    expect(cert?.kind).toBe('shared');
    expect(cert?.name).toBe('cezar.example.com');
    expect(ctx.state.publicUrl).toBe('https://cezar.example.com');
  });

  it('undo does NOT remove the cert — it only lists it', async () => {
    const note = vi.fn();
    const ui = { ...createAutoUi(), note } as Ui;
    const ctx = ctxWith({ ui });
    await stepById('ssl').undo(ctx, { artifacts: [{ kind: 'shared', type: 'cert', name: 'x.example.com', removeHint: 'sudo certbot delete --cert-name x.example.com' }] });
    expect(note).toHaveBeenCalledOnce();
    expect(note.mock.calls[0]?.[0]).toContain('certbot delete');
  });
});

describe('ubuntu-vps nginx-proxy security', () => {
  function secCtx(password: string, capture: Runner['capture']) {
    const ui = {
      ...createAutoUi(),
      text: async (o: { message: string }) => (o.message.toLowerCase().includes('username') ? 'ops' : ''),
      password: async () => password,
    } as Ui;
    return { ...ctxWith({ ui }), assumeYes: true, runner: { capture, interactive: async () => 0 } } as InstallContext;
  }

  it('feeds the password to openssl via stdin, never as an argv (H2)', async () => {
    const capture = vi.fn(async (_p: string, _a: string[], _o?: { input?: string }) => ({ code: 0, stdout: 'hash', stderr: '' }));
    await stepById('nginx-proxy').run(secCtx('hunter2', capture));
    const openssl = capture.mock.calls.find((c) => c[0] === 'openssl');
    expect(openssl?.[1]).toEqual(['passwd', '-apr1', '-stdin']);
    expect(openssl?.[2]).toEqual({ input: 'hunter2\n' });
    // the plaintext is never passed as a command argument
    expect(capture.mock.calls.some((c) => c[1].includes('hunter2'))).toBe(false);
  });

  it('refuses an empty/too-short password instead of creating an open cockpit (H1)', async () => {
    const capture = vi.fn(async (_p: string, _a: string[], _o?: { input?: string }) => ({ code: 0, stdout: '', stderr: '' }));
    await expect(stepById('nginx-proxy').run(secCtx('', capture))).rejects.toBeInstanceOf(StepAborted);
  });
});

describe('nginxVhost', () => {
  it('defaults to a catch-all server_name and can target a domain', () => {
    expect(nginxVhost(4321)).toContain('server_name _;');
    // The SSL step rewrites server_name to the domain so certbot --nginx can find it.
    expect(nginxVhost(4321, 'cezar.example.com')).toContain('server_name cezar.example.com;');
  });

  it('enables HTTP/2 so long-lived SSE streams do not exhaust the browser connection pool', () => {
    expect(nginxVhost(4321)).toContain('http2 on;');
  });

  it('defaults to the legacy htpasswd path but accepts an instance-scoped one', () => {
    expect(nginxVhost(4321)).toContain('auth_basic_user_file /etc/cezar/htpasswd;');
    expect(nginxVhost(4322, 'shop.example.com', '/etc/cezar/htpasswd-shop-example-com')).toContain(
      'auth_basic_user_file /etc/cezar/htpasswd-shop-example-com;',
    );
  });
});

describe('ubuntu-vps multi-instance artifact paths', () => {
  /** ctx for a named instance whose domain is known up front. */
  function namedCtx(): InstallContext {
    const c = ctxWith({ dryRun: true });
    c.instance = 'shop-example-com';
    c.state.domain = 'shop.example.com';
    c.state.primaryPort = 4322;
    return c;
  }

  it('the default instance records the legacy un-suffixed nginx/htpasswd paths', async () => {
    const ui = { ...createAutoUi(), text: async () => 'ops', password: async () => 'longenough' } as Ui;
    const ctx = { ...ctxWith({ ui, dryRun: true }), assumeYes: true } as InstallContext;
    const created = await stepById('nginx-proxy').run(ctx);
    const paths = (created?.artifacts ?? []).map((a) => a.path).filter(Boolean);
    expect(paths).toContain('/etc/nginx/sites-available/cezar');
    expect(paths).toContain('/etc/nginx/sites-enabled/cezar');
    expect(paths).toContain('/etc/cezar/htpasswd');
  });

  it('a named instance suffixes the nginx site + htpasswd with its slug', async () => {
    const ctx = namedCtx();
    (ctx as { assumeYes: boolean }).assumeYes = true;
    ctx.ui = { ...createAutoUi(), text: async () => 'ops', password: async () => 'longenough' } as Ui;
    const created = await stepById('nginx-proxy').run(ctx);
    const paths = (created?.artifacts ?? []).map((a) => a.path).filter(Boolean);
    expect(paths).toContain('/etc/nginx/sites-available/cezar-shop-example-com');
    expect(paths).toContain('/etc/nginx/sites-enabled/cezar-shop-example-com');
    expect(paths).toContain('/etc/cezar/htpasswd-shop-example-com');
  });

  it("a named instance's systemd unit is cezar-<slug>.service", async () => {
    const created = await stepById('autostart').run(namedCtx());
    const svc = created?.artifacts.find((a) => a.type === 'service');
    expect(svc?.name).toBe('cezar-shop-example-com.service');
  });
});

describe('ubuntu-vps nginx-proxy identity (interactive, dry-run)', () => {
  it('suggests the current OS user and can auto-generate the cockpit password', async () => {
    const notes: string[] = [];
    const password = vi.fn(async () => 'should-not-be-asked');
    const ui = {
      ...createAutoUi(),
      // username: echo back the suggested (initialValue) default
      text: async (o: { initialValue?: string }) => o.initialValue ?? 'x',
      // credential prompt: pick the first option ("Generate a strong password for me")
      select: async (o: { options: Array<{ value: string }> }) => o.options[0]?.value,
      password,
      note: (m: string) => { notes.push(m); },
    } as unknown as Ui;
    // Interactive path (assumeYes:false) is where the generate/manual menu lives.
    const ctx = { ...ctxWith({ dryRun: true, ui }), assumeYes: false } as InstallContext;
    const created = await stepById('nginx-proxy').run(ctx);

    expect(password).not.toHaveBeenCalled(); // generated, not typed (issue #3)
    expect(notes.some((m) => m.includes('Password:'))).toBe(true); // shown once so it can be saved
    const htp = created?.artifacts.find((a) => a.type === 'htpasswd');
    expect(htp?.kind).toBe('owned');
    expect(htp?.name).toBeTruthy(); // the suggested current-user default (issue #2)
  });
});

describe('systemdUnit', () => {
  it('runs cezar serve loopback with CEZ_REMOTE=1 and the port', () => {
    const unit = systemdUnit('/srv/app', 4321, 'user', '/usr/local/bin/cezar');
    expect(unit).toContain('Environment=CEZ_REMOTE=1');
    expect(unit).toContain('ExecStart=/usr/local/bin/cezar serve --no-open --port 4321');
    expect(unit).toContain('WorkingDirectory=/srv/app');
    expect(unit).toContain('WantedBy=default.target');
  });
  it('system scope pins User= and multi-user.target', () => {
    const unit = systemdUnit('/srv/app', 5000, 'system', '/usr/local/bin/cezar');
    expect(unit).toContain('User=');
    expect(unit).toContain('WantedBy=multi-user.target');
  });

  it('takes an absolute "<node> <entry.js>" ExecStart verbatim (no bare name → no 203/EXEC)', () => {
    const unit = systemdUnit('/srv/app', 4321, 'system', '/usr/bin/node /srv/app/dist/index.js');
    expect(unit).toContain('ExecStart=/usr/bin/node /srv/app/dist/index.js serve --no-open --port 4321');
  });

  it('passes --bind-host when an external-proxy install needs a reachable interface', () => {
    const unit = systemdUnit('/srv/app', 4321, 'user', '/usr/local/bin/cezar', '172.17.0.1');
    expect(unit).toContain('ExecStart=/usr/local/bin/cezar serve --no-open --port 4321 --bind-host 172.17.0.1');
  });

  it('stays flag-free for loopback so existing units are unchanged', () => {
    const plain = systemdUnit('/srv/app', 4321, 'user', '/usr/local/bin/cezar');
    expect(systemdUnit('/srv/app', 4321, 'user', '/usr/local/bin/cezar', '127.0.0.1')).toBe(plain);
    expect(plain).not.toContain('--bind-host');
  });
});

describe('serviceExecStart', () => {
  const base = { node: '/n/node', entry: '/pkg/dist/index.js', npxPath: '/n/npx' };

  it('runs the built entry for a stable checkout/global install', () => {
    expect(serviceExecStart({ ...base, pkgRoot: '/pkg', entryExists: true })).toBe('/n/node /pkg/dist/index.js');
  });

  it('uses the official npx alias when launched from the ephemeral _npx cache', () => {
    expect(serviceExecStart({ ...base, pkgRoot: '/home/u/.npm/_npx/abcd/node_modules/cezar-cli', entryExists: false }))
      .toBe('/n/npx --yes cezar-cli');
  });

  it('falls back to a resolved global bin when the entry is missing', () => {
    expect(serviceExecStart({ ...base, pkgRoot: '/pkg', entryExists: false, globalBin: '/usr/bin/cezar-cli' }))
      .toBe('/n/node /usr/bin/cezar-cli');
  });
});

describe('isNpxExecStart (#696)', () => {
  it('is true for the unpinned npx launch form', () => {
    expect(isNpxExecStart('/home/u/.nvm/versions/node/v24/bin/npx --yes cezar-cli serve --no-open --port 4321')).toBe(true);
  });
  it('is false for a checkout (<node> dist/index.js) unit', () => {
    expect(isNpxExecStart('/usr/bin/node /home/cezar/cezar/dist/index.js serve --no-open --port 4321')).toBe(false);
  });
  it('is false for a global bin unit (no npx)', () => {
    expect(isNpxExecStart('/usr/bin/node /usr/bin/cezar-cli serve --no-open --port 4321')).toBe(false);
  });
});

describe('ubuntu-vps redeploy npx-cache refresh (#696)', () => {
  function recordingCtx(execStart: string) {
    const infos: string[] = [];
    const runner: Runner = {
      capture: async (_program, args) =>
        args.includes('ExecStart') ? { code: 0, stdout: execStart, stderr: '' } : { code: 0, stdout: '', stderr: '' },
      interactive: async () => 0,
    };
    const ui = { ...createAutoUi(), info: (message: string) => infos.push(message) } as Ui;
    return { ctx: ctxWith({ dryRun: true, runner, ui }), infos };
  }

  it('reports clearing the npx cache before restarting an npx-based unit', async () => {
    const { ctx, infos } = recordingCtx('/n/npx --yes cezar-cli serve --no-open --port 4321');
    await ubuntuVps.redeploy!(ctx);
    expect(infos.some((message) => /clear cached cezar-cli|npx refetch/i.test(message))).toBe(true);
  });

  it('does NOT touch the npx cache for a checkout-based unit', async () => {
    const { ctx, infos } = recordingCtx('/usr/bin/node /home/cezar/cezar/dist/index.js serve --no-open --port 4321');
    await ubuntuVps.redeploy!(ctx);
    expect(infos.some((message) => /npx/i.test(message))).toBe(false);
  });

  it('really deletes only the cezar-cli entries in the npx cache', () => {
    const cache = mkdtempSync(join(tmpdir(), 'cez-npx-'));
    const prev = process.env.npm_config_cache;
    process.env.npm_config_cache = cache;
    try {
      mkdirSync(join(cache, '_npx', 'aaaa', 'node_modules', 'cezar-cli'), { recursive: true });
      writeFileSync(join(cache, '_npx', 'aaaa', 'node_modules', 'cezar-cli', 'x'), '');
      mkdirSync(join(cache, '_npx', 'bbbb', 'node_modules', 'prettier'), { recursive: true });

      refreshNpxCacheForRedeploy(ctxWith({}), '/n/npx --yes cezar-cli serve --port 4321');

      expect(existsSync(join(cache, '_npx', 'aaaa'))).toBe(false);
      expect(existsSync(join(cache, '_npx', 'bbbb'))).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.npm_config_cache;
      else process.env.npm_config_cache = prev;
      rmSync(cache, { recursive: true, force: true });
    }
  });

  it('aborts before restart when the npx cache cannot be read', async () => {
    const cache = mkdtempSync(join(tmpdir(), 'cez-npx-'));
    const previousCache = process.env.npm_config_cache;
    process.env.npm_config_cache = cache;
    writeFileSync(join(cache, '_npx'), 'not a directory');
    const capture = vi.fn(async () => ({
      code: 0,
      stdout: '/n/npx --yes cezar-cli serve --port 4321',
      stderr: '',
    }));
    const interactive = vi.fn(async () => 0);

    try {
      await expect(ubuntuVps.redeploy!(ctxWith({ runner: { capture, interactive } }))).rejects.toThrow(
        /cannot inspect the npx cache.*service was not restarted/,
      );
      expect(interactive).not.toHaveBeenCalled();
    } finally {
      if (previousCache === undefined) delete process.env.npm_config_cache;
      else process.env.npm_config_cache = previousCache;
      rmSync(cache, { recursive: true, force: true });
    }
  });
});

describe('ubuntu-vps autostart step (dry-run)', () => {
  it('records a user-scoped service artifact and writes nothing to disk', async () => {
    const created = await stepById('autostart').run(ctxWith({ dryRun: true }));
    const svc = created?.artifacts.find((a) => a.type === 'service');
    expect(svc?.kind).toBe('owned');
    expect(svc?.scope).toBe('user');
    expect(svc?.name).toBe('cezar.service');
  });
});

describe('ubuntu-vps identity step (end-to-end verify)', () => {
  /** A runner whose curl returns codes by URL/args; sleep + everything else ok. */
  function curlRunner(byPort: string, throughProxy: string): Runner {
    return {
      interactive: async () => 0,
      capture: async (program, args) => {
        if (program === 'curl') {
          const target = args[args.length - 1] ?? '';
          const code = target.includes(`:${4321}`) ? byPort : throughProxy;
          return { code: 0, stdout: code, stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
      },
    };
  }

  it('passes when cezar is up, anon is 401, and an authed request reaches it', async () => {
    const ctx = { ...ctxWith({ runner: curlRunner('200', '401') }), assumeYes: false } as InstallContext;
    ctx.prefs.cockpit = { user: 'ops', password: 'hunter2!' };
    // authed request (curl -K -) must return 2xx/3xx — model that by returning 200
    // for the proxy when credentials are supplied via stdin:
    ctx.runner = {
      interactive: async () => 0,
      capture: async (program, args, opts) => {
        if (program === 'curl') {
          const target = args[args.length - 1] ?? '';
          if (target.includes(':4321')) return { code: 0, stdout: '200', stderr: '' }; // upstream up
          if (opts?.input) return { code: 0, stdout: '200', stderr: '' }; // authed → ok
          return { code: 0, stdout: '401', stderr: '' }; // anon → challenged
        }
        return { code: 0, stdout: '', stderr: '' };
      },
    };
    await expect(stepById('identity').run(ctx)).resolves.toEqual({ artifacts: [] });
  });

  it('fails the run when cezar is down (nginx would 502)', async () => {
    const ctx = { ...ctxWith({ runner: curlRunner('000', '401') }), assumeYes: false } as InstallContext;
    await expect(stepById('identity').run(ctx)).rejects.toBeInstanceOf(StepAborted);
  });
});

describe('ubuntu-vps review fixes (PR #423)', () => {
  it('ufwIsActive reads the world-readable ufw.conf, never root-only `ufw status`', async () => {
    const calls: string[][] = [];
    const runner: Runner = {
      capture: async (_p, args) => {
        calls.push(args);
        return { code: 0, stdout: 'ufw-enabled\n', stderr: '' };
      },
      interactive: async () => 0,
    };
    // reach the sub-step via the proxy step's run with everything else stubbed green
    const ui = {
      ...createAutoUi(),
      text: async () => 'ops',
      password: async () => 'longenough',
    } as Ui;
    const interactive = vi.fn(async () => 0);
    const captured: Array<{ args: string[]; input?: string }> = [];
    const ctx = {
      ...ctxWith({ ui }),
      runner: {
        capture: async (_p: string, args: string[], o?: { input?: string }) => {
          captured.push({ args, input: o?.input });
          if (args.join(' ').includes('openssl') || args[0] === 'passwd') return { code: 0, stdout: '$apr1$abc$hash', stderr: '' };
          if (args.join(' ').includes('ufw.conf')) return { code: 0, stdout: '', stderr: '' }; // ufw not enabled
          return { code: 0, stdout: '', stderr: '' };
        },
        interactive,
      },
    } as InstallContext;
    await stepById('nginx-proxy').run(ctx);
    // no capture or interactive call may contain a root-only bare `ufw status` probe
    const probeCalls = captured.map((c) => c.args.join(' ')).filter((a) => a.includes('ufw'));
    for (const probe of probeCalls) expect(probe).toContain('ufw.conf');
    expect(calls.length).toBe(0); // unused first runner sanity
  });

  it('htpasswd credential line goes to sudo stdin, not argv (hash never ps-visible)', async () => {
    const ui = { ...createAutoUi(), text: async () => 'ops', password: async () => 'longenough' } as Ui;
    const interactiveCalls: Array<{ args: string[]; input?: string }> = [];
    const ctx = {
      ...ctxWith({ ui }),
      runner: {
        capture: async (p: string, args: string[]) => {
          if (p === 'openssl') return { code: 0, stdout: '$apr1$abc$secret-hash', stderr: '' };
          return { code: 0, stdout: '', stderr: '' };
        },
        interactive: async (_p: string, args: string[], o?: { input?: string }) => {
          interactiveCalls.push({ args, input: o?.input });
          return 0;
        },
      },
    } as InstallContext;
    await stepById('nginx-proxy').run(ctx);
    const htpasswdCall = interactiveCalls.find((c) => c.args.join(' ').includes('htpasswd'));
    expect(htpasswdCall).toBeDefined();
    expect(htpasswdCall?.args.join(' ')).not.toContain('secret-hash');
    expect(htpasswdCall?.input).toBe('ops:$apr1$abc$secret-hash\n');
  });

  it('username validation rejects ":" and whitespace (htpasswd separator)', () => {
    let captured: ((v: string) => string | undefined) | undefined;
    const ui = {
      ...createAutoUi(),
      text: async (o: { message: string; validate?: (v: string) => string | undefined }) => {
        if (o.message.toLowerCase().includes('username')) captured = o.validate;
        return 'ops';
      },
      password: async () => 'longenough',
    } as Ui;
    const runner: Runner = {
      capture: async (p) => ({ code: 0, stdout: p === 'openssl' ? '$apr1$abc$hash' : '', stderr: '' }),
      interactive: async () => 0,
    };
    const ctx = { ...ctxWith({ ui, runner }) } as InstallContext;
    return stepById('nginx-proxy')
      .run(ctx)
      .then(() => {
        expect(captured).toBeDefined();
        expect(captured?.('team:ops')).toMatch(/:/);
        expect(captured?.('team ops')).toBeDefined();
        expect(captured?.('ops')).toBeUndefined();
      });
  });

  it('identity probe escapes `"` and `\\` in curl config credentials', async () => {
    const inputs: string[] = [];
    const ctx = {
      ...ctxWith({}),
      prefs: { cockpit: { user: 'ops', password: 'my"pa\\ss1' } },
      runner: {
        capture: async (_p: string, args: string[], o?: { input?: string }) => {
          if (o?.input) inputs.push(o.input);
          // upstream up + anon 401 + authed 200
          const joined = args.join(' ');
          if (joined.includes('4321')) return { code: 0, stdout: '200', stderr: '' };
          if (o?.input) return { code: 0, stdout: '200', stderr: '' };
          return { code: 0, stdout: '401', stderr: '' };
        },
        interactive: async () => 0,
      },
    } as InstallContext;
    await stepById('identity').run(ctx);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toBe('user = "ops:my\\"pa\\\\ss1"\n');
  });

  it('SSL re-run with TLS already configured updates server_name in place (no plain-HTTP rewrite)', async () => {
    const ui = {
      ...createAutoUi(),
      text: async (o: { message: string }) => (o.message.includes('Domain') ? 'cezar.example.com' : 'you@example.com'),
    } as Ui;
    const commands: string[] = [];
    const ctx = {
      ...ctxWith({ ui }),
      runner: {
        capture: async (_p: string, args: string[]) => {
          const joined = args.join(' ');
          if (joined.includes('ssl_certificate')) return { code: 0, stdout: '', stderr: '' }; // TLS present
          return { code: 0, stdout: '', stderr: '' };
        },
        interactive: async (_p: string, args: string[]) => {
          commands.push(args.join(' '));
          return 0;
        },
      },
    } as InstallContext;
    await stepById('ssl').run(ctx);
    const rewrites = commands.filter((c) => c.includes('base64 --decode'));
    const seds = commands.filter((c) => c.includes('sed -i') && c.includes('server_name'));
    expect(rewrites).toHaveLength(0); // never wipes certbot's 443 config
    expect(seds).toHaveLength(1);
  });

  it('uninstall reverses linger only when install recorded enabling it', async () => {
    const commands: string[] = [];
    const runner: Runner = {
      capture: async () => ({ code: 0, stdout: 'Linger=no', stderr: '' }),
      interactive: async (_p, args) => {
        commands.push(args.join(' '));
        return 0;
      },
    };
    const ctx = { ...ctxWith({ runner }) } as InstallContext;
    await stepById('autostart').undo(ctx, {
      artifacts: [
        { kind: 'owned', type: 'service', name: 'cezar.service', scope: 'user', path: '/tmp/does-not-exist.service' },
        { kind: 'owned', type: 'linger', name: 'ops' },
      ],
    });
    expect(commands.some((c) => c.includes('disable-linger'))).toBe(true);
    // and without the linger artifact, it is left alone
    commands.length = 0;
    await stepById('autostart').undo(ctx, {
      artifacts: [{ kind: 'owned', type: 'service', name: 'cezar.service', scope: 'user', path: '/tmp/does-not-exist.service' }],
    });
    expect(commands.some((c) => c.includes('disable-linger'))).toBe(false);
  });

  it('systemd unit escapes % so specifier expansion cannot corrupt PATH/ExecStart', () => {
    const oldPath = process.env.PATH;
    process.env.PATH = `/weird%dir/bin:${oldPath ?? ''}`;
    try {
      const unit = systemdUnit('/repo', 4321, 'user', '/usr/bin/node /x/dist/index.js');
      expect(unit).toContain('/weird%%dir/bin');
      expect(unit).not.toMatch(/Environment=PATH=[^\n]*\/weird%dir/);
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
    }
  });
});

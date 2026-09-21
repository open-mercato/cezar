import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import {
  enableHttp2OnTlsListenerSed,
  isNpxExecStart,
  nginxVhost,
  parseNginxVersion,
  refreshNpxCacheForRedeploy,
  serviceExecStart,
  supportsHttp2Directive,
  systemdUnit,
  ubuntuVps,
} from './ubuntu-vps.ts';
import { StepAborted } from '../steps.ts';
import { createAutoUi } from '../ui.ts';
import type { InstallContext, InstallStep, Runner, Ui } from '../types.ts';

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

  it('defaults to the legacy htpasswd path but accepts an instance-scoped one', () => {
    expect(nginxVhost(4321)).toContain('auth_basic_user_file /etc/cezar/htpasswd;');
    expect(nginxVhost(4322, 'shop.example.com', '/etc/cezar/htpasswd-shop-example-com')).toContain(
      'auth_basic_user_file /etc/cezar/htpasswd-shop-example-com;',
    );
  });
});

/**
 * Issue #910: the vhost carried a standalone `http2 on;`, a directive that only
 * exists from nginx 1.25.1. Ubuntu 24.04 LTS ships 1.24.0, where it is a hard
 * parse error — `nginx -t` failed and the certbot step could never complete.
 * The old test pinned that exact string, which is why CI never noticed.
 */
describe('HTTP/2 syntax per nginx version (#910)', () => {
  /** A `listen` line has no standalone `http2` directive on its own line. */
  const standaloneHttp2 = /^\s*http2\s/m;

  /** A runner that reports `version` from `nginx -v` and records sudo commands. */
  function nginxRunner(version: string | null) {
    const sudo: string[] = [];
    const ran = (prefix: string) => sudo.some((c) => c.startsWith(prefix));
    const runner: Runner = {
      capture: async (program, args) => {
        // `nginx -v` prints its banner on STDERR, not stdout.
        if (program === 'nginx' && args[0] === '-v') {
          return { code: 0, stdout: '', stderr: version ? `nginx version: nginx/${version} (Ubuntu)\n` : '' };
        }
        // The htpasswd step refuses to continue without a real apr1 hash.
        if (program === 'openssl') return { code: 0, stdout: '$apr1$salt$hash\n', stderr: '' };
        // The vhost only grows an `ssl_certificate` line once certbot has run…
        if (args.some((a) => a.includes('ssl_certificate'))) {
          return { code: ran('certbot') ? 0 : 1, stdout: '', stderr: '' };
        }
        // …and an `http2` listener parameter once the post-processing sed has.
        if (args.some((a) => a.includes('443.*http2'))) {
          return { code: ran('sed -i -E') ? 0 : 1, stdout: '', stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
      },
      interactive: async (program, args) => {
        if (program === 'sudo' && args[0] === 'bash') sudo.push(String(args[2]));
        return 0;
      },
    };
    return { runner, sudo };
  }

  /** The content a `writeFileStep` command carries (base64, so quoting survives). */
  function writtenFile(sudo: string[], path: string): string {
    const cmd = sudo.find((c) => c.includes(`base64 --decode > '${path}'`));
    if (!cmd) throw new Error(`nothing wrote ${path}; ran:\n${sudo.join('\n')}`);
    const b64 = /printf %s '([A-Za-z0-9+/=]+)'/.exec(cmd)?.[1];
    if (!b64) throw new Error(`no base64 payload in: ${cmd}`);
    return Buffer.from(b64, 'base64').toString('utf8');
  }

  function installerUi(): Ui {
    return {
      ...createAutoUi(),
      text: async (o: { message: string }) =>
        o.message.includes('Domain') ? 'cezar.example.com' : o.message.includes('Email') ? 'ops@example.com' : 'ops',
      password: async () => 'longenough',
    } as Ui;
  }

  it('reads the version out of the banner nginx -v prints on stderr', () => {
    expect(parseNginxVersion('nginx version: nginx/1.24.0 (Ubuntu)\n')).toBe('1.24.0');
    expect(parseNginxVersion('nginx version: nginx/1.27.3\n')).toBe('1.27.3');
    expect(parseNginxVersion('sudo: nginx: command not found')).toBeNull();
  });

  it('allows the standalone directive only from 1.25.1, and never on an unknown version', () => {
    expect(supportsHttp2Directive('1.24.0')).toBe(false); // Ubuntu 24.04 LTS
    expect(supportsHttp2Directive('1.25.0')).toBe(false); // the release just before it landed
    expect(supportsHttp2Directive('1.25.1')).toBe(true); // where the directive was introduced
    expect(supportsHttp2Directive('1.26.2')).toBe(true);
    expect(supportsHttp2Directive('2.0.0')).toBe(true);
    // Unknown ⇒ the `listen` parameter, which every nginx since 1.9.5 parses.
    expect(supportsHttp2Directive(null)).toBe(false);
    expect(supportsHttp2Directive('')).toBe(false);
    expect(supportsHttp2Directive('mainline')).toBe(false);
  });

  it('emits no standalone http2 directive for an nginx that cannot parse one', () => {
    const v = nginxVhost(4321, 'cezar.example.com', '/etc/cezar/htpasswd', '1.24.0');
    expect(v).not.toMatch(standaloneHttp2);
    // …and nothing else in the pre-certbot :80 block that 1.24 rejects either:
    // every directive it emits predates 1.24 by years.
    expect(v).toContain('listen 80;');
    expect(v).toContain('proxy_buffering off;');
  });

  it('emits the standalone http2 directive on nginx >= 1.25.1', () => {
    expect(nginxVhost(4321, 'cezar.example.com', '/etc/cezar/htpasswd', '1.25.1')).toMatch(standaloneHttp2);
    expect(nginxVhost(4321, 'cezar.example.com', '/etc/cezar/htpasswd', '1.26.0')).toContain('http2 on;');
  });

  it('defaults to the syntax every nginx understands when the version is unknown', () => {
    expect(nginxVhost(4321)).not.toMatch(standaloneHttp2);
  });

  it('nginx-proxy writes the vhost in the syntax the installed nginx accepts', async () => {
    for (const [version, wantsDirective] of [
      ['1.24.0', false],
      ['1.25.3', true],
    ] as const) {
      const { runner, sudo } = nginxRunner(version);
      await stepById('nginx-proxy').run({ ...ctxWith({ ui: installerUi(), runner }), assumeYes: true });
      const vhost = writtenFile(sudo, '/etc/nginx/sites-available/cezar');
      expect(standaloneHttp2.test(vhost), `nginx ${version}`).toBe(wantsDirective);
    }
  });

  it('ssl turns HTTP/2 on via certbot’s TLS listener when the directive is unavailable', async () => {
    const { runner, sudo } = nginxRunner('1.24.0');
    await stepById('ssl').run({ ...ctxWith({ ui: installerUi(), runner }), assumeYes: true });

    // The pre-certbot vhost must still be parseable by 1.24 …
    expect(writtenFile(sudo, '/etc/nginx/sites-available/cezar')).not.toMatch(standaloneHttp2);
    // … and HTTP/2 is switched on afterwards, on the TLS listener certbot made.
    const certbot = sudo.findIndex((c) => c.startsWith('certbot'));
    const http2 = sudo.findIndex((c) => c.includes('http2;'));
    expect(certbot).toBeGreaterThanOrEqual(0);
    expect(http2).toBeGreaterThan(certbot);
    expect(sudo[http2]).toContain('nginx -t && systemctl reload nginx');
  });

  it('ssl leaves the listener alone when the vhost already carries the directive', async () => {
    const { runner, sudo } = nginxRunner('1.25.3');
    await stepById('ssl').run({ ...ctxWith({ ui: installerUi(), runner }), assumeYes: true });

    expect(writtenFile(sudo, '/etc/nginx/sites-available/cezar')).toMatch(standaloneHttp2);
    expect(sudo.some((c) => c.startsWith('sed -i -E'))).toBe(false);
  });
});

describe('the sed that adds http2 to certbot’s TLS listener (#910)', () => {
  // The expression is GNU-sed syntax (`-E`, `!`, `{…}`) targeting Ubuntu/Debian.
  // Run it for real where a GNU sed exists rather than asserting on its text —
  // the property that matters is what it does to a certbot-shaped vhost.
  const gnuSed = (() => {
    try {
      return /GNU sed/.test(execFileSync('sed', ['--version'], { encoding: 'utf8' }));
    } catch {
      return false;
    }
  })();

  // Exactly what `certbot --nginx … --redirect` leaves behind.
  const certbotVhost = `server {
    server_name cezar.example.com;
    listen [::]:443 ssl ipv6only=on; # managed by Certbot
    listen 443 ssl; # managed by Certbot
    ssl_certificate /etc/letsencrypt/live/cezar.example.com/fullchain.pem; # managed by Certbot
}
server {
    listen 80;
    listen [::]:80;
    return 301 https://$host$request_uri; # managed by Certbot
}
`;

  it.runIf(gnuSed)('adds http2 to the TLS listeners only, and stays idempotent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-http2-'));
    try {
      const path = join(dir, 'vhost.conf');
      writeFileSync(path, certbotVhost);
      const sed = enableHttp2OnTlsListenerSed(path);
      execSync(sed);
      const once = readFileSync(path, 'utf8');
      execSync(sed); // a --reconfigure ssl re-run must not double it up
      const twice = readFileSync(path, 'utf8');

      expect(once).toContain('listen 443 ssl http2; # managed by Certbot');
      expect(once).toContain('listen [::]:443 ssl ipv6only=on http2; # managed by Certbot');
      // certbot's plain-HTTP redirect block has no TLS listener — leave it be.
      expect(once).toContain('    listen 80;\n');
      expect(once).toContain('    listen [::]:80;\n');
      expect(twice).toBe(once);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

describe('ubuntu-vps redeploy restart verification (#912)', () => {
  /** What `systemctl show -p MainPID -p ExecMainStartTimestampMonotonic` prints. */
  const showOutput = (p: { pid: string; started: string } | null) =>
    p ? `MainPID=${p.pid}\nExecMainStartTimestampMonotonic=${p.started}\n` : 'MainPID=0\nExecMainStartTimestampMonotonic=0\n';

  /**
   * A ctx modelling a real `--external-proxy` box: curl always answers 200 (the
   * port is served — by the OLD process when the restart failed, which is exactly
   * why "something answers" proves nothing), and `systemctl show` reports whoever
   * is serving at that moment.
   */
  function deployCtx(over: {
    restartCode?: number;
    restartStderr?: string;
    /** false ⇒ restart exits 0 but the process is untouched (the #912 stale process). */
    restartReplacesProcess?: boolean;
    /** non-zero ⇒ the identity can't be read at all (no user bus). */
    showCode?: number;
    /** non-zero ⇒ only the read AFTER the restart fails. */
    showCodeAfterRestart?: number;
    running?: { pid: string; started: string } | null;
    /** The sudo-driven system unit instead of the rootless `--user` one. */
    scope?: 'user' | 'system';
  }) {
    let current = over.running === undefined ? { pid: '1111', started: '1000' } : over.running;
    let restarted = false;
    const warns: string[] = [];
    const runner: Runner = {
      interactive: async () => 0,
      capture: async (program, args) => {
        if (program === 'curl') return { code: 0, stdout: '200', stderr: '' }; // the port always answers
        if (program === 'systemctl' && args.includes('show')) {
          if (args.includes('ExecStart')) return { code: 0, stdout: '/usr/bin/node /srv/dist/index.js', stderr: '' };
          const failCode = over.showCode ?? (restarted ? over.showCodeAfterRestart : undefined);
          if (failCode) return { code: failCode, stdout: '', stderr: 'Failed to connect to bus: No medium found\n' };
          return { code: 0, stdout: showOutput(current), stderr: '' };
        }
        if (program === 'systemctl' && args.includes('restart')) {
          const code = over.restartCode ?? 0;
          if (code === 0 && (over.restartReplacesProcess ?? true)) current = { pid: '2222', started: '2000' };
          restarted = true;
          return { code, stdout: '', stderr: over.restartStderr ?? '' };
        }
        return { code: 0, stdout: '', stderr: '' };
      },
    };
    const ui = { ...createAutoUi(), warn: (message: string) => warns.push(message) } as Ui;
    const ctx = ctxWith({
      runner,
      ui,
      state: {
        installed: true,
        externalProxy: true,
        // Pin the scope the way a real install records it (otherwise it falls
        // back to "does the unit file exist on this machine").
        steps: { autostart: { status: 'done', created: { artifacts: [{ kind: 'owned', type: 'service', name: 'cezar.service', scope: over.scope ?? 'user', path: '/tmp/cezar.service' }] } } },
      },
    });
    return { ctx, warns, pid: () => current?.pid ?? null };
  }

  it('a non-zero `systemctl --user restart` fails the deploy instead of warning', async () => {
    const { ctx } = deployCtx({ restartCode: 1 });
    // StepAborted ⇒ runDeploy reports `failed` ⇒ exit 1 and NO
    // "complete — the service was reloaded and verified" banner.
    await expect(ubuntuVps.redeploy!(ctx)).rejects.toBeInstanceOf(StepAborted);
    await expect(ubuntuVps.redeploy!(deployCtx({ restartCode: 1 }).ctx)).rejects.toThrow(/was NOT restarted/);
  });

  it('names the missing D-Bus session when that is why the restart failed', async () => {
    const bus = { restartCode: 1, restartStderr: 'Failed to connect to bus: No medium found\n' };
    await expect(ubuntuVps.redeploy!(deployCtx(bus).ctx)).rejects.toThrow(/No D-Bus user session/);
    // …echoing systemd's own line, and pointing at a way to get a real session.
    await expect(ubuntuVps.redeploy!(deployCtx(bus).ctx)).rejects.toThrow(/Failed to connect to bus: No medium found/);
    await expect(ubuntuVps.redeploy!(deployCtx(bus).ctx)).rejects.toThrow(/XDG_RUNTIME_DIR|machinectl shell/);
  });

  it('fails when the restart exits 0 but the OLD process is still serving', async () => {
    // The exact stale-process shape: the port answers, `is-active` would pass, and
    // nothing was deployed.
    const { ctx, pid } = deployCtx({ restartReplacesProcess: false });
    await expect(ubuntuVps.redeploy!(ctx)).rejects.toThrow(/did not actually restart/);
    expect(pid()).toBe('1111');
  });

  it('succeeds when the process really was replaced', async () => {
    const { ctx, pid } = deployCtx({});
    await expect(ubuntuVps.redeploy!(ctx)).resolves.toBeUndefined();
    expect(pid()).toBe('2222');
  });

  it('degrades (no false failure) when the service identity cannot be read at all', async () => {
    // `systemctl show` unavailable ⇒ nothing to compare; the restart's own exit
    // code stays the gate, so a clean restart must still pass.
    const { ctx } = deployCtx({ showCode: 1 });
    await expect(ubuntuVps.redeploy!(ctx)).resolves.toBeUndefined();
  });

  it('warns instead of failing when only the post-restart read is unavailable', async () => {
    const { ctx, warns } = deployCtx({ showCodeAfterRestart: 1 });
    await expect(ubuntuVps.redeploy!(ctx)).resolves.toBeUndefined();
    expect(warns.some((w) => /did-it-really-restart/.test(w))).toBe(true);
  });

  it('a unit that was not running before the deploy has nothing to compare against', async () => {
    const { ctx } = deployCtx({ running: null });
    await expect(ubuntuVps.redeploy!(ctx)).resolves.toBeUndefined();
  });

  it('the sudo-driven system unit is held to the same proof', async () => {
    // `is-active` passes for the process that was already there, so the system
    // scope needs the same before/after comparison the user scope gets.
    const { ctx } = deployCtx({ scope: 'system' });
    await expect(ubuntuVps.redeploy!(ctx)).rejects.toThrow(/did not actually restart/);
  });

  it('dry-run still stops before touching the service', async () => {
    const { ctx } = deployCtx({ restartCode: 1 });
    ctx.dryRun = true;
    await expect(ubuntuVps.redeploy!(ctx)).resolves.toBeUndefined();
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

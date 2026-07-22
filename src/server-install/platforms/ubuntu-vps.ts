import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CANCEL, PreflightError, type InstallContext, type InstallStep, type PlatformStrategy, type StepArtifact } from '../types.js';
import { depCheckStep, generatePassword, owned, shared, shquote, StepAborted, StepCancelled, StepSkipped, sudoStep, verifyCommand } from '../steps.js';

/**
 * The `ubuntu-vps` strategy: stand up an authenticated, proxied cezar on a bare
 * Ubuntu/Debian VPS. cezar itself stays loopback-bound; nginx is the single
 * public surface (TLS + htpasswd identity) forwarding to 127.0.0.1:<port>.
 *
 * Phase 1 ships deps → nginx+htpasswd → identity-verify (and their `undo`s).
 * Phase 2 appends the optional SSL and autostart steps to `steps()`.
 */

/**
 * Instance-scoped artifact paths. The `default` instance (a host with no
 * `--domain`, i.e. every pre-multi-instance install) keeps the original,
 * un-suffixed names so it upgrades in place; a named (domain-keyed) instance
 * suffixes the nginx site, htpasswd, and systemd unit with its slug so several
 * cockpits coexist on one host without colliding. `undefined`/`'default'` both
 * resolve to the legacy names.
 */
function inst(ctx: InstallContext): string {
  return ctx.instance && ctx.instance !== 'default' ? ctx.instance : 'default';
}
function vhostAvailable(ctx: InstallContext): string {
  const i = inst(ctx);
  return i === 'default' ? '/etc/nginx/sites-available/cezar' : `/etc/nginx/sites-available/cezar-${i}`;
}
function vhostEnabled(ctx: InstallContext): string {
  const i = inst(ctx);
  return i === 'default' ? '/etc/nginx/sites-enabled/cezar' : `/etc/nginx/sites-enabled/cezar-${i}`;
}
function htpasswdPath(ctx: InstallContext): string {
  const i = inst(ctx);
  return i === 'default' ? '/etc/cezar/htpasswd' : `/etc/cezar/htpasswd-${i}`;
}
function unitName(ctx: InstallContext): string {
  const i = inst(ctx);
  return i === 'default' ? 'cezar.service' : `cezar-${i}.service`;
}

/** Best-effort current OS username, suggested as the default cockpit login. */
function currentUsername(): string {
  try {
    return userInfo().username || 'ops';
  } catch {
    return 'ops';
  }
}

/**
 * True when ufw is installed and enabled. `ufw status` needs root and the
 * installer is mandatorily non-root, so it always failed — instead read
 * `/etc/ufw/ufw.conf` (world-readable), whose `ENABLED=yes` is the same truth
 * `ufw enable` maintains.
 */
async function ufwIsActive(ctx: InstallContext): Promise<boolean> {
  const r = await ctx.runner.capture('sh', [
    '-c',
    'grep -qi "^ENABLED=yes" /etc/ufw/ufw.conf 2>/dev/null && echo ufw-enabled || true',
  ]);
  return r.stdout.includes('ufw-enabled');
}

/** The HTTP status curl saw for a request ("000" = could not connect / no response). */
async function curlCode(ctx: InstallContext, args: string[], opts?: { input?: string }): Promise<string> {
  const r = await ctx.runner.capture('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', ...args], opts);
  return r.stdout.trim() || '000';
}

/** True once cezar answers on 127.0.0.1:<port> (any HTTP status = the process is up). */
async function isCezarUp(ctx: InstallContext, port: number): Promise<boolean> {
  const code = await curlCode(ctx, [`http://127.0.0.1:${port}/`]);
  return code !== '000';
}

/** Poll the loopback upstream until cezar responds or the attempts run out. */
async function waitForCezar(ctx: InstallContext, port: number, attempts = 15): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await isCezarUp(ctx, port)) return true;
    // `sleep 1` via the runner keeps this testable (no real timers in unit tests).
    if (i < attempts - 1) await ctx.runner.capture('sh', ['-c', 'sleep 1']);
  }
  return false;
}

/**
 * After a service is enabled, wait for cezar to actually answer on the loopback
 * port. A running unit that crash-loops (bad WorkingDirectory, missing build)
 * would otherwise leave nginx proxying to nothing (502) while the installer
 * claims success. On failure, point the operator at the service logs.
 */
async function confirmCezarRunning(ctx: InstallContext, statusCmd: string, logsCmd: string): Promise<void> {
  if (ctx.dryRun) {
    ctx.ui.info(`DRY RUN — would wait for cezar on 127.0.0.1:${ctx.state.primaryPort}.`);
    return;
  }
  const sp = ctx.ui.spinner();
  sp.start(`Waiting for cezar to start on 127.0.0.1:${ctx.state.primaryPort}…`);
  const up = await waitForCezar(ctx, ctx.state.primaryPort);
  sp.stop(up ? 'cezar is running.' : 'cezar did not come up.');
  if (!up) {
    ctx.ui.warn(
      `cezar is not answering on 127.0.0.1:${ctx.state.primaryPort} yet — nginx will return 502 until it is.\n` +
        `Check the service:\n  • ${statusCmd}\n  • ${logsCmd}\n` +
        'Common causes: the WorkingDirectory has no built cezar, or the port is wrong.',
    );
  }
}

/**
 * The nginx server block: auth_basic identity + SSE-safe proxy to loopback.
 * `serverName` defaults to the catch-all `_`; the SSL step rewrites it to the
 * real domain so the `certbot --nginx` plugin can find this vhost to edit.
 */
export function nginxVhost(port: number, serverName = '_', htpasswd = '/etc/cezar/htpasswd'): string {
  return `# Managed by cezar server-install — do not edit by hand.
server {
    listen 80;
    listen [::]:80;
    server_name ${serverName};

    # HTTP/2 multiplexes every request over ONE TCP connection. Without it the
    # browser's ~6-connections-per-origin HTTP/1.1 cap is exhausted by cezar's
    # long-lived SSE run streams, and further requests block until tabs close.
    # Valid on the plain :80 block too; it only takes effect once the SSL step
    # adds a 443 ssl listener (certbot preserves this directive).
    http2 on;

    auth_basic "cezar";
    auth_basic_user_file ${htpasswd};

    location / {
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # cezar streams SSE (run events). Never buffer it, or the cockpit goes mute.
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_set_header Connection '';
    }
}
`;
}

/** Build a privileged command that writes file content atomically (base64 → no quoting hell). */
function writeRootFileCmd(path: string, content: string, extra = ''): string {
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  const dir = path.slice(0, path.lastIndexOf('/')) || '/';
  return `install -d -m 0755 ${shquote(dir)} && printf %s ${shquote(b64)} | base64 --decode > ${shquote(path)}${extra ? ` && ${extra}` : ''}`;
}

/**
 * A sudoStep that writes a root-owned file. The command carries the content as
 * base64 (so quoting/newlines survive a copy-paste), which is unreadable — so we
 * always show the DECODED file content in a note first, so the operator can see
 * exactly what will land on disk and knows the base64 is not doing anything
 * hidden.
 */
function writeFileStep(
  ctx: InstallContext,
  opts: {
    description: string;
    path: string;
    content: string;
    /** Extra shell appended after the write (` && …`). */
    extra?: string;
    verify: (c: InstallContext) => Promise<boolean>;
  },
): Promise<void> {
  return sudoStep(ctx, {
    description: opts.description,
    note: `This writes ${opts.path} with exactly this content:\n\n${opts.content}`,
    command: writeRootFileCmd(opts.path, opts.content, opts.extra),
    verify: opts.verify,
  });
}

const nginxProxyStep: InstallStep = {
  id: 'nginx-proxy',
  title: 'Reverse proxy (nginx + htpasswd)',
  async check(ctx) {
    if (ctx.dryRun) return false;
    const nginxOk = await verifyCommand(ctx, 'nginx', ['-v']);
    const vhostOk = await verifyCommand(ctx, 'test', ['-f', vhostEnabled(ctx)]);
    return nginxOk && vhostOk;
  },
  async run(ctx): Promise<{ artifacts: StepArtifact[] }> {
    // 1) nginx. Record the package as a `shared` artifact only when this run
    //    installed it, so uninstall can list it for manual removal without
    //    claiming a pre-existing nginx.
    const nginxWasPresent = await verifyCommand(ctx, 'nginx', ['-v']);
    await sudoStep(ctx, {
      description: 'Install nginx (the public TLS + auth front for cezar).',
      command: 'apt-get update && apt-get install -y nginx',
      verify: (c) => verifyCommand(c, 'nginx', ['-v']),
    });

    // 2) identity credentials. This is the HTTP Basic-Auth login nginx will
    //    challenge for over HTTPS — i.e. what you type in the browser to reach
    //    the cockpit. Suggest the current OS user as a sensible default.
    const suggestedUser = currentUsername();
    const userAnswer = await ctx.ui.text({
      message: 'Cockpit login username (HTTPS Basic-Auth — you type this in the browser to reach the cockpit)',
      placeholder: suggestedUser,
      initialValue: suggestedUser,
      // htpasswd's line format is `user:hash` — a ":" in the username would
      // silently corrupt it into a login that can never succeed.
      validate: (v) => {
        if (!v.trim()) return 'username is required';
        if (/[:\s]/.test(v.trim())) return 'no ":" or whitespace — htpasswd uses ":" as its separator';
        return undefined;
      },
    });
    if (userAnswer === CANCEL) throw new StepCancelled();
    const user = String(userAnswer).trim();

    // Set the cockpit password. Interactive operators may auto-generate a strong
    // one (shown once) or type their own. Under `--yes` (no human) there is no
    // menu — the password comes straight from the UI, and the length backstop
    // below refuses an empty one rather than standing up an open cockpit (H1).
    let password: string;
    if (ctx.assumeYes) {
      const typed = await ctx.ui.password({
        message: `Set the HTTPS cockpit password for "${user}"`,
        validate: (v) => (v.length >= 6 ? undefined : 'use at least 6 characters'),
      });
      if (typed === CANCEL) throw new StepCancelled();
      password = String(typed);
    } else {
      const how = await ctx.ui.select<'generate' | 'manual'>({
        message: `Cockpit password for "${user}" (used with the username to log in over HTTPS)`,
        options: [
          { value: 'generate', label: 'Generate a strong password for me', hint: 'shown once — save it now' },
          { value: 'manual', label: 'Type my own password' },
        ],
        initialValue: 'generate',
      });
      if (how === CANCEL) throw new StepCancelled();
      if (how === 'generate') {
        password = generatePassword();
        ctx.ui.note(
          `Username: ${user}\nPassword: ${password}\n\nSave these now — this is your cockpit login. cezar stores only a hash; the plaintext is not written anywhere and cannot be recovered.`,
          'Generated cockpit credentials',
        );
      } else {
        const typed = await ctx.ui.password({
          message: `Set the HTTPS cockpit password for "${user}"`,
          validate: (v) => (v.length >= 6 ? undefined : 'use at least 6 characters'),
        });
        if (typed === CANCEL) throw new StepCancelled();
        password = String(typed);
      }
    }
    // The non-interactive UI (`--yes`) cannot invent a password and does not run
    // validators — refuse rather than write an empty-password htpasswd (a public
    // cockpit anyone can open). A real install must set a password interactively.
    if (!ctx.dryRun && String(password).length < 6) {
      throw new StepAborted('a cockpit password (≥6 chars) is required — run server-install without --yes to set one');
    }
    // Keep the credentials in memory (never persisted) so the final verify step
    // can prove an authenticated request actually reaches cezar over the proxy.
    ctx.prefs.cockpit = { user, password };

    // 3) htpasswd file. The hash (not the plaintext) is embedded in the write
    //    command; the plaintext is fed to openssl via stdin so it never appears
    //    in the process argv (visible to other users via `ps`). apr1 is what
    //    nginx's auth_basic expects.
    let hash = '<dry-run-hash>';
    if (!ctx.dryRun) {
      const out = await ctx.runner.capture('openssl', ['passwd', '-apr1', '-stdin'], { input: `${String(password)}\n` });
      hash = out.stdout.trim();
      if (out.code !== 0 || !hash) throw new StepAborted('failed to hash the password (openssl) — cannot write htpasswd');
    }
    // nginx workers run as www-data and read auth_basic_user_file per request,
    // so the file must be group-readable by www-data — 0640 root:root would make
    // every request 500. 0640 root:www-data: readable by nginx, not by others.
    // The credential line travels on STDIN (`cat > file`), never in argv — the
    // apr1 hash is offline-crackable, and argv is world-readable via `ps`.
    const htpasswd = htpasswdPath(ctx);
    await sudoStep(ctx, {
      description: 'Write the htpasswd identity file that nginx checks on every request.',
      note: `${htpasswd}\n\n${user}:<apr1 hash of your password>`,
      command: `install -d -m 0755 /etc/cezar && cat > ${htpasswd} && chown root:www-data ${htpasswd} && chmod 0640 ${htpasswd}`,
      input: `${user}:${hash}\n`,
      inputLabel: 'credential line (username:hash)',
      verify: (c) => verifyCommand(c, 'test', ['-f', htpasswd]),
    });

    // Record whether the distro's default site was enabled *before* we disable
    // it, so undo only re-enables it if we were the one who removed it.
    const defaultWasEnabled = await verifyCommand(ctx, 'test', ['-L', '/etc/nginx/sites-enabled/default']);

    // 4) vhost + enable + reload. A named instance already knows its domain, so
    //    stamp it into server_name from the start (Host-based routing works
    //    immediately and certbot --nginx can find the vhost later). The default
    //    instance keeps the catch-all `_` until the SSL step sets a domain.
    const vhostAvail = vhostAvailable(ctx);
    const vhostEnbl = vhostEnabled(ctx);
    const vhost = nginxVhost(ctx.state.primaryPort, ctx.state.domain ?? '_', htpasswd);
    await writeFileStep(ctx, {
      description: 'Write the cezar nginx site, enable it, and reload nginx.',
      path: vhostAvail,
      content: vhost,
      extra: `ln -sf ${vhostAvail} ${vhostEnbl} && rm -f /etc/nginx/sites-enabled/default && nginx -t && systemctl reload nginx`,
      verify: (c) => verifyCommand(c, 'test', ['-f', vhostEnbl]),
    });

    // 5) firewall: if ufw is active, the cockpit is unreachable until 80/443 are
    //    allowed — a common "installed fine but nothing loads" cause. This is a
    //    best-effort sub-step of the (required) proxy step: skipping it must not
    //    fail the whole install, so a StepSkipped is swallowed here.
    if (!ctx.dryRun && (await ufwIsActive(ctx))) {
      try {
        await sudoStep(ctx, {
          description: 'ufw is active — allow HTTP/HTTPS so the cockpit is reachable.',
          // Self-verifying: the trailing grep makes the (root) command itself
          // fail when the rule did not land — needed because rule listing also
          // requires root, so the unprivileged verify below can't always check.
          command: `ufw allow 'Nginx Full' && ufw status | grep -qi 'Nginx Full'`,
          skippable: true,
          skipHint: 'open ports 80 and 443 yourself, or via a cloud firewall',
          verify: async (c) => {
            if ((await c.runner.capture('sudo', ['-n', 'true'])).code === 0) {
              return (
                (await c.runner.capture('sudo', ['-n', 'bash', '-lc', "ufw status | grep -qi 'Nginx Full'"])).code === 0
              );
            }
            // No root and no human in the loop (`--yes`): nobody ran the
            // command, so it cannot have "verified itself" — fail, which the
            // skippable path converts into the loud firewall warning below.
            if (c.assumeYes) return false;
            // Interactive delegate: the operator confirmed running the
            // self-verifying command (the trailing grep fails their paste if
            // the rule is missing); we cannot re-check without root.
            c.ui.warn(
              'Cannot list ufw rules without root — trusting the self-verifying command you just ran. ' +
                'Double-check ports 80/443 are reachable.',
            );
            return true;
          },
        });
      } catch (err) {
        if (!(err instanceof StepSkipped)) throw err;
        ctx.ui.warn('Firewall left unchanged — make sure ports 80 and 443 are reachable, or the cockpit will not load.');
      }
    }

    const artifacts: StepArtifact[] = [
      owned('file', { path: vhostAvail }),
      owned('symlink', { path: vhostEnbl }),
      owned('htpasswd', { path: htpasswd, name: user }),
    ];
    if (defaultWasEnabled) artifacts.push(owned('nginx-default', { path: '/etc/nginx/sites-enabled/default' }));
    if (!nginxWasPresent) {
      artifacts.push(shared('package', { name: 'nginx', removeHint: 'sudo apt-get remove -y nginx' }));
    }
    return { artifacts };
  },
  async undo(ctx, created) {
    // Remove the *known* cezar-owned paths (constants), so uninstall works even
    // if server.json was lost and the step was re-recorded with created=null.
    // Only re-enable the default site if the run recorded that it disabled it.
    const restoreDefault = (created?.artifacts ?? []).some((a) => a.type === 'nginx-default');
    const restoreClause = restoreDefault
      ? ` && { [ -e /etc/nginx/sites-available/default ] && ln -sf /etc/nginx/sites-available/default /etc/nginx/sites-enabled/default || true; }`
      : '';
    // `shared` packages (nginx, when this install added it) are listed, never
    // auto-removed — the operator may have started depending on them.
    const sharedPkgs = (created?.artifacts ?? []).filter((a) => a.kind === 'shared');
    if (sharedPkgs.length > 0) {
      ctx.ui.note(
        sharedPkgs.map((a) => a.removeHint ?? a.name ?? '').filter(Boolean).join('\n'),
        'Installed for cezar but possibly used elsewhere — remove manually if unwanted',
      );
    }
    // rmdir /etc/cezar only succeeds when empty, so removing one instance's
    // htpasswd never nukes another instance's credentials in the same dir.
    const vhostEnbl = vhostEnabled(ctx);
    await sudoStep(ctx, {
      description: 'Remove the cezar nginx site + htpasswd, reload nginx.',
      command:
        `rm -f ${vhostEnbl} ${vhostAvailable(ctx)} ${htpasswdPath(ctx)}` +
        restoreClause +
        ` && { rmdir /etc/cezar 2>/dev/null || true; }` +
        ` && { nginx -t && systemctl reload nginx || true; }`,
      verify: (c) => verifyCommand(c, 'sh', ['-c', `! test -f ${vhostEnbl}`]),
    });
  },
};

const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9](-?[a-z0-9])*\.)+[a-z]{2,}$/i;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const sslStep: InstallStep = {
  id: 'ssl',
  title: 'Domain + SSL (Let’s Encrypt)',
  optional: true,
  async check() {
    return false; // optional — the engine gates it with a confirm; certbot is idempotent
  },
  async run(ctx): Promise<{ artifacts: StepArtifact[] }> {
    // A named instance already captured its domain up front (it is the instance
    // key) — reuse it instead of asking again. The default instance still
    // prompts here, since it may be HTTP-only until this step runs.
    const domain = ctx.state.domain
      ? ctx.state.domain
      : await ctx.ui.text({
          message: 'Domain pointing at this server (an A/AAAA record must resolve here)',
          placeholder: 'cezar.example.com',
          validate: (v) => (HOSTNAME_RE.test(v.trim()) ? undefined : 'enter a valid domain'),
        });
    if (domain === CANCEL) throw new StepCancelled();
    const email = await ctx.ui.text({
      message: 'Email for Let’s Encrypt renewal notices',
      placeholder: 'you@example.com',
      validate: (v) => (EMAIL_RE.test(v.trim()) ? undefined : 'enter a valid email'),
    });
    if (email === CANCEL) throw new StepCancelled();

    const certbotWasPresent = await verifyCommand(ctx, 'certbot', ['--version']);
    await sudoStep(ctx, {
      description: 'Install certbot + its nginx plugin.',
      command: 'apt-get install -y certbot python3-certbot-nginx',
      verify: (c) => verifyCommand(c, 'certbot', ['--version']),
    });

    // Point the nginx site's server_name at the domain BEFORE running certbot.
    // The `certbot --nginx` plugin locates the vhost by matching `server_name`
    // against `-d <domain>`; with the catch-all `server_name _;` it fails with
    // "Unable to find a VirtualHost". Doing this first also means that if the
    // operator skips certbot now, a later manual `certbot --nginx -d <domain>`
    // just works — no "could not find a matching server" (issue #8).
    //
    // On a RE-RUN (--reconfigure ssl / --reinstall / resume) the vhost may
    // already carry certbot's TLS edits (`listen 443 ssl`, `ssl_certificate`).
    // Rewriting it with the plain-HTTP template would take working HTTPS down
    // BEFORE certbot runs again — and leave it down if certbot then fails. So
    // when TLS config is present, only the `server_name` lines are updated
    // in place; the hostname regex bars every sed/shell metacharacter.
    const trimmedDomain = String(domain).trim();
    // Record the domain on the instance record so a resume / redeploy / verify
    // (and the nginx server_name) all agree on it, even for the default instance
    // that entered its domain here rather than up front.
    ctx.state.domain = trimmedDomain;
    const vhostAvail = vhostAvailable(ctx);
    const vhostEnbl = vhostEnabled(ctx);
    const vhostHasTls = await verifyCommand(ctx, 'sh', ['-c', `grep -qs ssl_certificate ${vhostAvail}`]);
    if (vhostHasTls) {
      await sudoStep(ctx, {
        description: `Update server_name to ${trimmedDomain} in the existing TLS-enabled nginx site (certbot config preserved).`,
        command: `sed -i 's/^\\([[:space:]]*\\)server_name .*;/\\1server_name ${trimmedDomain};/' ${vhostAvail} && nginx -t && systemctl reload nginx`,
        verify: (c) =>
          verifyCommand(c, 'sh', ['-c', `grep -qF ${shquote(`server_name ${trimmedDomain}`)} ${vhostAvail}`]),
      });
    } else {
      const domainVhost = nginxVhost(ctx.state.primaryPort, trimmedDomain, htpasswdPath(ctx));
      await writeFileStep(ctx, {
        description: `Point the nginx site at ${trimmedDomain} so certbot can configure TLS for it.`,
        path: vhostAvail,
        content: domainVhost,
        extra: `ln -sf ${vhostAvail} ${vhostEnbl} && nginx -t && systemctl reload nginx`,
        verify: (c) =>
          verifyCommand(c, 'sh', ['-c', `grep -qF ${shquote(`server_name ${trimmedDomain}`)} ${vhostAvail}`]),
      });
    }

    // certbot can legitimately fail on external state (DNS not pointed yet, LE
    // rate limit). Route it through sudoStep so it honors the sudo/delegate
    // choice (issue #7) and offers Skip on repeated failure (issue #8) — on
    // skip, nginx is already configured for a later manual certbot run.
    await sudoStep(ctx, {
      description: `Obtain and install a Let’s Encrypt certificate for ${String(domain).trim()} (adds HTTPS + redirect).`,
      command: `certbot --nginx -d ${shquote(String(domain).trim())} --non-interactive --agree-tos -m ${shquote(String(email).trim())} --redirect`,
      skippable: true,
      skipHint: `run later: sudo certbot --nginx -d ${String(domain).trim()}`,
      // Verify via the nginx vhost, NOT /etc/letsencrypt/live — that dir is 0700
      // root, so a non-root `test -d` (the operator ran certbot themselves) fails
      // with permission-denied and reports a false failure even when the cert was
      // issued. certbot --nginx writes `ssl_certificate …` into the vhost, which
      // is world-readable, so grepping it works without root.
      verify: (c) => verifyCommand(c, 'sh', ['-c', `grep -qs ssl_certificate ${vhostAvail} ${vhostEnbl}`]),
    });

    ctx.state.publicUrl = `https://${trimmedDomain}`;
    // The cert + its auto-renewal timer are `shared`: uninstall lists them, it
    // does not delete them (removing a cert can break other vhosts). Same for
    // the certbot packages when this run installed them.
    const artifacts: StepArtifact[] = [
      shared('cert', { name: trimmedDomain, removeHint: `sudo certbot delete --cert-name ${trimmedDomain}` }),
    ];
    if (!certbotWasPresent) {
      artifacts.push(
        shared('package', {
          name: 'certbot + python3-certbot-nginx',
          removeHint: 'sudo apt-get remove -y certbot python3-certbot-nginx',
        }),
      );
    }
    return { artifacts };
  },
  async undo(ctx, created) {
    const cert = (created?.artifacts ?? []).find((a) => a.type === 'cert');
    if (cert) {
      ctx.ui.note(
        `The TLS certificate for ${cert.name ?? 'your domain'} and its auto-renewal timer were left in place.\nRemove them yourself if you want them gone:\n${cert.removeHint ?? ''}`,
        'SSL',
      );
    }
    const pkgs = (created?.artifacts ?? []).filter((a) => a.type === 'package');
    if (pkgs.length > 0) {
      ctx.ui.note(
        pkgs.map((a) => a.removeHint ?? a.name ?? '').filter(Boolean).join('\n'),
        'Installed for cezar but possibly used elsewhere — remove manually if unwanted',
      );
    }
    // The vhost (with certbot’s edits) is removed by the nginx-proxy step’s undo.
  },
};

/**
 * systemd unit that runs cezar loopback-bound with CEZ_REMOTE=1.
 *
 * `execStart` must be an ABSOLUTE command — systemd resolves the ExecStart
 * executable against its OWN compiled-in PATH (/usr/local/bin:/usr/bin:…), NOT
 * the unit's `Environment=PATH`, so a bare `cezar` gives status=203/EXEC
 * ("Unable to locate executable"). `resolveExecStart` therefore returns an
 * absolute `"<node> <entry.js>"`. We still set `Environment=PATH` (with the
 * installer's node dir) for any child process the app spawns.
 */
export function systemdUnit(repoRoot: string, port: number, scope: 'user' | 'system', execStart: string): string {
  const userLine = scope === 'system' ? `User=${userInfo().username}\n` : '';
  const installTarget = scope === 'system' ? 'multi-user.target' : 'default.target';
  // Give the service the operator's own PATH (node dir + the login PATH the CLI
  // merged in, e.g. ~/.local/bin and nvm) so cezar can spawn claude / gh / codex
  // at runtime — systemd's default PATH has none of those.
  const pathDirs = [dirname(process.execPath), ...(process.env.PATH ?? '').split(':'), '/usr/local/bin', '/usr/bin', '/bin']
    .filter((d, i, a) => d && d !== '.' && a.indexOf(d) === i);
  // systemd expands `%` specifiers in Environment/ExecStart values — a literal
  // `%` (possible in an nvm dir name) must be doubled or the unit fails to load.
  const sysd = (s: string) => s.replace(/%/g, '%%');
  return `# Managed by cezar server-install — do not edit by hand.
[Unit]
Description=cezar cockpit
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
${userLine}WorkingDirectory=${repoRoot}
Environment=CEZ_REMOTE=1
Environment=PATH=${sysd(pathDirs.join(':'))}
ExecStart=${sysd(execStart)} serve --no-open --port ${port}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=${installTarget}
`;
}

/** Our official npm package/alias — what `npx <this>` reinstalls the CLI as. */
const OFFICIAL_CLI_PKG = 'cezar-cli';

/**
 * Decide the absolute ExecStart command for the service, mirroring how the
 * installer itself was launched so the box keeps running the same cezar:
 *
 *  - Launched via `npx <alias>` (the CLI package lives in npm's ephemeral
 *    `_npx` cache, which gets cleaned): the service can't point there, so it
 *    reinstalls-and-runs the same way — `<abs npx> --yes cezar-cli` (bare `npx`
 *    would 203/EXEC, so npx is made absolute).
 *  - A stable install (a checkout, or a global `cezar-cli`/`cezar`): run the
 *    CLI's own built entry `<node> <pkg>/dist/index.js`, or a resolved global
 *    bin. Absolute node + absolute script → systemd never resolves off PATH.
 */
export function serviceExecStart(opts: {
  node: string;
  pkgRoot: string;
  entry: string;
  entryExists: boolean;
  npxPath: string;
  globalBin?: string;
}): string {
  if (/[/\\]_npx[/\\]/.test(opts.pkgRoot)) return `${opts.npxPath} --yes ${OFFICIAL_CLI_PKG}`;
  if (opts.entryExists) return `${opts.node} ${opts.entry}`;
  if (opts.globalBin) return `${opts.node} ${opts.globalBin}`;
  return `${opts.node} ${opts.entry}`;
}

async function resolveExecStart(ctx: InstallContext): Promise<string> {
  const node = process.execPath; // absolute node running this installer
  // The CLI's OWN package root (…/dist/server-install/platforms/ → up 3), NOT the
  // repo being operated on — `--repo` / cwd can differ from where cezar lives.
  const pkgRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
  const entry = join(pkgRoot, 'dist', 'index.js');
  let npxPath = join(dirname(node), 'npx');
  if (ctx.dryRun) return serviceExecStart({ node, pkgRoot, entry, entryExists: true, npxPath });
  // A standalone node binary has no adjacent npx — fall back to the login
  // shell's, or ExecStart would 203/EXEC (the exact bug 9fea263 fixed).
  if (!existsSync(npxPath)) {
    const found = (await ctx.runner.capture('bash', ['-lc', 'command -v npx'])).stdout.trim().split('\n').pop()?.trim();
    if (found) npxPath = found;
  }

  let globalBin: string | undefined;
  if (!existsSync(entry) && !/[/\\]_npx[/\\]/.test(pkgRoot)) {
    const out = (await ctx.runner.capture('bash', ['-lc', `command -v ${OFFICIAL_CLI_PKG} || command -v cezar`])).stdout.trim();
    globalBin = out.split('\n').map((s) => s.trim()).filter(Boolean).pop();
    if (!globalBin) {
      ctx.ui.warn(
        `Could not locate a built cezar to run (${entry} missing, no global ${OFFICIAL_CLI_PKG}).\n` +
          `Install it (npm i -g ${OFFICIAL_CLI_PKG}) or build the checkout, then re-run with --reconfigure autostart.`,
      );
    }
  }
  return serviceExecStart({ node, pkgRoot, entry, entryExists: existsSync(entry), npxPath, globalBin });
}

const autostartStep: InstallStep = {
  id: 'autostart',
  // Required: after install the cockpit must actually be serving, so cezar runs
  // as a systemd service — started now AND enabled on boot. (id kept as
  // `autostart` for state compatibility.)
  title: 'Run cezar as a service (systemd — starts now + on boot)',
  async check() {
    return false; // always (re)assert the service is installed and running
  },
  async run(ctx): Promise<{ artifacts: StepArtifact[] }> {
    const UNIT_NAME = unitName(ctx);
    const execStart = await resolveExecStart(ctx);
    // Prefer a rootless `systemd --user` service + linger; fall back to a system
    // unit (via sudoStep) when the user bus is not reachable. `show-environment`
    // exits 0 iff the user manager is up — on a headless SSH box with no session
    // it fails (exit 1, not 127), which the old `!== 127` test misread as "up".
    const userBus = ctx.dryRun ? true : (await ctx.runner.capture('systemctl', ['--user', 'show-environment'])).code === 0;

    if (userBus) {
      const unitPath = join(homedir(), '.config', 'systemd', 'user', UNIT_NAME);
      if (ctx.dryRun) {
        ctx.ui.info(`DRY RUN — would write ${unitPath} and enable it (systemctl --user enable --now cezar).`);
      } else {
        mkdirSync(join(homedir(), '.config', 'systemd', 'user'), { recursive: true });
        writeFileSync(unitPath, systemdUnit(ctx.repoRoot, ctx.state.primaryPort, 'user', execStart), 'utf8');
        await ctx.runner.interactive('systemctl', ['--user', 'daemon-reload']);
        await ctx.runner.interactive('systemctl', ['--user', 'enable', '--now', UNIT_NAME]);
        if ((await ctx.runner.capture('systemctl', ['--user', 'is-enabled', UNIT_NAME])).code !== 0) {
          ctx.ui.warn('The user service did not enable cleanly — check `systemctl --user status cezar`.');
        }
      }
      // Linger lets the user service survive logout / start at boot — usually
      // needs root. Record it as owned only when THIS run turned it on, so
      // uninstall reverses exactly what install changed (a pre-existing linger
      // may serve other user services).
      const osUser = userInfo().username;
      const lingerWasOn = await verifyCommand(ctx, 'loginctl', ['show-user', osUser, '-p', 'Linger'], (r) =>
        r.stdout.includes('Linger=yes'),
      );
      await sudoStep(ctx, {
        description: 'Enable linger so the cockpit starts at boot without a login session.',
        command: `loginctl enable-linger ${shquote(osUser)}`,
        verify: (c) =>
          verifyCommand(c, 'loginctl', ['show-user', osUser, '-p', 'Linger'], (r) =>
            r.stdout.includes('Linger=yes'),
          ),
      });
      await confirmCezarRunning(ctx, 'systemctl --user status cezar', 'journalctl --user -u cezar -n 50 --no-pager');
      const artifacts: StepArtifact[] = [owned('service', { name: UNIT_NAME, scope: 'user', path: unitPath })];
      if (!lingerWasOn) artifacts.push(owned('linger', { name: osUser }));
      return { artifacts };
    }

    // System unit fallback.
    await writeFileStep(ctx, {
      description: 'Install the cezar systemd unit, start it now, and enable it at boot.',
      path: `/etc/systemd/system/${UNIT_NAME}`,
      content: systemdUnit(ctx.repoRoot, ctx.state.primaryPort, 'system', execStart),
      extra: `systemctl daemon-reload && systemctl enable --now ${UNIT_NAME}`,
      verify: (c) => verifyCommand(c, 'systemctl', ['is-enabled', UNIT_NAME]),
    });
    await confirmCezarRunning(ctx, 'sudo systemctl status cezar', 'sudo journalctl -u cezar -n 50 --no-pager');
    return { artifacts: [owned('service', { name: UNIT_NAME, scope: 'system', path: `/etc/systemd/system/${UNIT_NAME}` })] };
  },
  async undo(ctx, created) {
    const UNIT_NAME = unitName(ctx);
    const svc = (created?.artifacts ?? []).find((a) => a.type === 'service');
    // Reverse linger only when install recorded that it enabled it.
    const linger = (created?.artifacts ?? []).find((a) => a.type === 'linger');
    if (svc?.scope === 'user') {
      if (!ctx.dryRun) {
        await ctx.runner.interactive('systemctl', ['--user', 'disable', '--now', UNIT_NAME]);
        if (svc.path) rmSync(svc.path, { force: true });
        await ctx.runner.interactive('systemctl', ['--user', 'daemon-reload']);
      } else {
        ctx.ui.info('DRY RUN — would disable and remove the user service.');
      }
    } else if (svc) {
      await sudoStep(ctx, {
        description: 'Disable and remove the cezar systemd unit.',
        command: `systemctl disable --now ${UNIT_NAME}; rm -f /etc/systemd/system/${UNIT_NAME} && systemctl daemon-reload`,
        verify: (c) => verifyCommand(c, 'sh', ['-c', `! systemctl is-enabled ${UNIT_NAME}`]),
      });
    }
    if (linger?.name) {
      await sudoStep(ctx, {
        description: 'Disable linger (this install enabled it; nothing else needs it).',
        command: `loginctl disable-linger ${shquote(linger.name)}`,
        verify: (c) =>
          verifyCommand(c, 'loginctl', ['show-user', linger.name ?? '', '-p', 'Linger'], (r) =>
            r.stdout.includes('Linger=no'),
          ),
      });
    }
  },
};

const identityStep: InstallStep = {
  id: 'identity',
  title: 'Verify the cockpit end-to-end (auth + HTTPS reach cezar)',
  async check() {
    return false; // always re-verify; it creates nothing
  },
  async run(ctx): Promise<{ artifacts: StepArtifact[] }> {
    if (ctx.dryRun) {
      ctx.ui.info('DRY RUN — would verify auth (401 for anon) AND that an authenticated request reaches cezar.');
      return { artifacts: [] };
    }
    const port = ctx.state.primaryPort;
    const https = ctx.state.publicUrl?.startsWith('https://') ?? false;
    const base = https ? 'https://127.0.0.1/' : 'http://127.0.0.1/';
    const tls = https ? ['-k'] : [];
    // When several instances share nginx, a bare 127.0.0.1 request hits whatever
    // vhost nginx treats as default. Send this instance's own Host header so the
    // probe verifies THIS cockpit's vhost, not a sibling's.
    const host = ctx.state.domain ? ['-H', `Host: ${ctx.state.domain}`] : [];

    // 1) Is cezar actually listening on the loopback upstream? nginx challenges
    //    auth *before* proxying, so an anonymous 401 alone does NOT prove the
    //    backend is up — check the upstream directly.
    const upstreamUp = await isCezarUp(ctx, port);

    // 2) An anonymous request through nginx must be challenged (auth is active).
    const anonCode = await curlCode(ctx, [...tls, ...host, base]);
    const authEnforced = anonCode === '401';

    // 3) The real proof: an AUTHENTICATED request reaches cezar (2xx/3xx — not
    //    401/403 = bad creds, not 502/504 = upstream down). Credentials are read
    //    from stdin (curl -K -) so they never land in argv. `null` = not testable
    //    (a resume where the plaintext password is no longer in memory).
    let authedOk: boolean | null = null;
    const cred = ctx.prefs.cockpit;
    if (cred) {
      // curl's config format requires `\` and `"` escaped inside the quoted
      // value — both are legal password characters; unescaped they break the
      // config parse and fail a WORKING install with "bad credentials".
      const curlCfgQuote = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const code = await curlCode(ctx, [...tls, ...host, '-K', '-', base], {
        input: `user = "${curlCfgQuote(cred.user)}:${curlCfgQuote(cred.password)}"\n`,
      });
      authedOk = /^[23]\d\d$/.test(code);
    }

    const url = ctx.state.publicUrl ?? `http://<this-server>`;
    const coreOk = upstreamUp && authEnforced && authedOk !== false;
    if (coreOk) {
      ctx.ui.success(
        `Cockpit is live at ${url} — ${authedOk ? 'an authenticated request reached cezar' : 'auth is enforced and cezar is up'}. ` +
          'Log in with the username and password you set.',
      );
      if (!https) {
        ctx.ui.warn(
          'This cockpit is HTTP-only (no domain/SSL configured). To serve it over HTTPS with this same auth, ' +
            're-run: cezar server-install --platform ubuntu-vps --reconfigure ssl',
        );
      }
      return { artifacts: [] };
    }

    const problems: string[] = [];
    if (!upstreamUp) problems.push(`cezar is not listening on 127.0.0.1:${port} — the service is down, so nginx returns 502`);
    if (!authEnforced) problems.push(`nginx did not challenge an anonymous request (got "${anonCode}") — basic auth may not be active`);
    if (authedOk === false) problems.push('an authenticated request did not reach cezar (bad credentials, or the upstream is down)');
    ctx.ui.error(
      `The cockpit is NOT fully working yet:\n` +
        problems.map((p) => `  • ${p}`).join('\n') +
        `\n\nDiagnostics on the server:\n` +
        `  • systemctl --user status cezar   (or: sudo systemctl status cezar)\n` +
        `  • sudo systemctl status nginx && sudo nginx -t\n` +
        `  • sudo ss -ltnp | grep -E ':80|:443|:${port}'\n` +
        `  • ports 80/443 open in ufw AND any cloud firewall (Hetzner/AWS)`,
    );
    // Fail the run so `installed` stays false and the exit code is non-zero —
    // "complete" must mean the cockpit actually works. Re-run to resume (the
    // service/proxy steps are idempotent).
    throw new StepAborted('cockpit verification failed — see the diagnostics above');
  },
  async undo() {
    // nothing created
  },
};

export const ubuntuVps: PlatformStrategy = {
  id: 'ubuntu-vps',
  label: 'Ubuntu/Debian VPS',
  async preflight(ctx: InstallContext) {
    if (ctx.dryRun) {
      ctx.ui.info('DRY RUN — skipping OS/privilege preflight.');
      return;
    }
    const uname = await ctx.runner.capture('uname', ['-s']);
    if (!uname.stdout.includes('Linux')) {
      throw new PreflightError('ubuntu-vps requires Linux. On macOS use --platform macosx-ngrok.');
    }
    if ((await ctx.runner.capture('apt-get', ['--version'])).code !== 0) {
      throw new PreflightError('ubuntu-vps requires apt (Debian/Ubuntu).');
    }
    if ((await ctx.runner.capture('id', ['-u'])).stdout.trim() === '0') {
      throw new PreflightError('run server-install as a normal sudo-capable user, not root.');
    }
  },
  steps(): InstallStep[] {
    // deps → proxy → (optional) ssl → (optional) autostart → identity.
    return [depCheckStep(), nginxProxyStep, sslStep, autostartStep, identityStep];
  },
  async redeploy(ctx: InstallContext) {
    const UNIT_NAME = unitName(ctx);
    // Restart the systemd service so it picks up the new cezar (a fresh local
    // build the unit runs from, or a newly published cezar-cli via npx), then
    // re-run the same end-to-end verify install uses.
    const svc = (ctx.state.steps['autostart']?.created?.artifacts ?? []).find((a) => a.type === 'service');
    // No recorded artifact (older record, or the step was check()-satisfied):
    // prefer the scope whose unit file actually exists — the user unit is the
    // install default, so defaulting to `system` would sudo-restart a unit
    // that was never installed.
    const userUnitExists = existsSync(join(homedir(), '.config', 'systemd', 'user', UNIT_NAME));
    const scope: 'user' | 'system' =
      svc?.scope === 'user' || svc?.scope === 'system' ? svc.scope : userUnitExists ? 'user' : 'system';
    if (ctx.dryRun) {
      ctx.ui.info(`DRY RUN — would reload+restart the cezar ${scope} service and re-verify the cockpit.`);
      return;
    }
    ctx.ui.info(`Redeploying — restarting the cezar ${scope} service to pick up the new version.`);
    if (scope === 'user') {
      await ctx.runner.interactive('systemctl', ['--user', 'daemon-reload']);
      const code = await ctx.runner.interactive('systemctl', ['--user', 'restart', UNIT_NAME]);
      if (code !== 0) ctx.ui.warn('systemctl --user restart returned non-zero — check `systemctl --user status cezar`.');
    } else {
      await sudoStep(ctx, {
        description: 'Reload systemd and restart the cezar service.',
        command: `systemctl daemon-reload && systemctl restart ${UNIT_NAME}`,
        verify: (c) => verifyCommand(c, 'systemctl', ['is-active', UNIT_NAME]),
      });
    }
    await confirmCezarRunning(
      ctx,
      scope === 'user' ? 'systemctl --user status cezar' : 'sudo systemctl status cezar',
      scope === 'user' ? 'journalctl --user -u cezar -n 50 --no-pager' : 'sudo journalctl -u cezar -n 50 --no-pager',
    );
    await identityStep.run(ctx); // throws StepAborted if the cockpit isn't fully working
  },
};

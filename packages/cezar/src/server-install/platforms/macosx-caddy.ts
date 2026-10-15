import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { assertCezarHomeWriteIsSandboxed, cezarHomeDir } from '../../paths.ts';
import { CANCEL, type InstallContext, type InstallStep, type PlatformStrategy, type StepArtifact } from '../types.ts';
import {
  brewInstallTool,
  brewRemoveHint,
  depCheckStep,
  generatePassword,
  HOSTNAME_RE,
  owned,
  shared,
  shquote,
  StepAborted,
  StepCancelled,
  sudoStep,
  verifyCommand,
} from '../steps.ts';
import {
  CEZAR_PLIST_LABEL,
  cezarAutostartStep,
  darwinPreflight,
  installLaunchdAgent,
  kickstartAgent,
  launchAgentPath,
  launchdAgentPlist,
  probeHttp,
  removeLaunchdAgent,
} from './macosx-shared.ts';

/**
 * The `macosx-caddy` strategy: Caddy runs on the same Mac as the cockpit and is
 * the front — TLS plus **HTTP Basic Auth that cezar itself sets up**. That last
 * part is what separates this target from its macOS siblings: `macosx-ngrok`
 * borrows ngrok's edge auth, `macosx-cloudflare-tunnel` needs an Access
 * application you attach afterwards, `macosx-tailscale` leans on tailnet
 * membership, and `macosx-external-proxy` hands the whole problem to a front
 * you already own. Here the login is local: a bcrypt hash in a `0600`
 * Caddyfile, checked by Caddy on every request before anything reaches the
 * loopback cockpit — the macOS analogue of `ubuntu-vps`'s nginx + htpasswd.
 *
 * Three exposures, and the difference is only how TLS is obtained:
 *  - `internal` (default) — Caddy's own local CA issues the certificate, so a
 *    LAN / VPN / tailnet name works with no public DNS and no open ports. The
 *    cert is not publicly trusted; `caddy trust` installs the CA on this Mac.
 *  - `acme` — a real public domain with automatic Let's Encrypt certificates.
 *    Needs :80 + :443 reachable from the internet and DNS pointing here, and
 *    those ports are privileged, so Caddy runs as a root LaunchDaemon.
 *  - `http` — plain HTTP on a local port, for when something else already
 *    terminates TLS (a tunnel you run). Basic auth is still enforced here, so
 *    the tunnel does not have to provide it.
 *
 * Everything the front needs lives in one file cezar owns, so uninstall is
 * exact: the Caddyfile plus the one launchd job that runs it.
 */

const PLIST_LABEL = 'ai.cezar.caddy';
/** Privileged ports (<1024) need a root job — a user LaunchAgent cannot bind them. */
const DAEMON_PLIST_PATH = `/Library/LaunchDaemons/${PLIST_LABEL}.plist`;
/** Where Caddy's own output goes; launchd would otherwise discard it. */
const SYSTEM_LOG_PATH = '/var/log/cezar-caddy.log';

export type CaddyExposure = 'internal' | 'acme' | 'http';

/** The Caddyfile cezar owns. It holds a bcrypt hash, so it is written `0600`. */
export function caddyfilePath(): string {
  return join(cezarHomeDir(), 'Caddyfile');
}

function userLogPath(): string {
  return join(cezarHomeDir(), 'caddy.log');
}

/** Where the cockpit listens — loopback unless `--bind-host` named another interface. */
function bindHost(ctx: InstallContext): string {
  return ctx.state.bindHost?.trim() || '127.0.0.1';
}

/** Best-effort current OS username, suggested as the default cockpit login. */
function currentUsername(): string {
  try {
    return userInfo().username || 'ops';
  } catch {
    return 'ops';
  }
}

export interface CaddySite {
  exposure: CaddyExposure;
  /** Public host the cockpit answers on (the ACME domain, or a LAN/VPN name). */
  host: string;
  port: number;
  /** Basic-auth username. */
  user: string;
  /** bcrypt hash from `caddy hash-password` — never the plaintext. */
  hash: string;
  /** `host:port` the request is proxied to. */
  upstream: string;
}

/**
 * The site address Caddy matches on.
 *  - `acme`: the bare domain — Caddy then owns :443 (and redirects :80).
 *  - `internal`: the explicit hostname, because the internal CA has to issue a
 *    certificate FOR something. (The host in a site address is a matcher, not a
 *    bind address — Caddy still listens on every interface.)
 *  - `http`: port only, so any `Host` a tunnel forwards still matches.
 */
export function siteAddress(site: CaddySite): string {
  if (site.exposure === 'acme') return site.host;
  if (site.exposure === 'http') return `http://:${site.port}`;
  return `https://${site.host}:${site.port}`;
}

/** The public URL to hand the operator (and to probe). */
export function siteUrl(site: CaddySite): string {
  if (site.exposure === 'acme') return `https://${site.host}`;
  const scheme = site.exposure === 'http' ? 'http' : 'https';
  return `${scheme}://${site.host}:${site.port}`;
}

/** Render the Caddyfile: one site, one login, one upstream. */
export function caddyfile(site: CaddySite): string {
  // `admin off` closes Caddy's unauthenticated local admin API (:2019), which
  // can otherwise reconfigure this front from anything running on the Mac.
  // cezar reloads by restarting the launchd job instead.
  const tls = site.exposure === 'internal' ? '\n\ttls internal' : '';
  return `# Managed by cezar server-install — do not edit by hand.
{
\tadmin off
}

${siteAddress(site)} {
\t# The cockpit login. \`basic_auth\` is Caddy 2.8+; older versions call the
\t# same directive \`basicauth\`. The value is a bcrypt hash — cezar never
\t# stores the plaintext anywhere.
\tbasic_auth {
\t\t${site.user} ${site.hash}
\t}${tls}

\treverse_proxy ${site.upstream} {
\t\t# cezar streams SSE (run events). Flush every write, or the cockpit goes
\t\t# mute behind a buffering proxy.
\t\tflush_interval -1
\t}
}
`;
}

/** launchd job that keeps Caddy running against that Caddyfile. */
export function caddyPlist(caddyBin: string, configPath: string, system: boolean): string {
  return launchdAgentPlist({
    label: PLIST_LABEL,
    argv: [caddyBin, 'run', '--config', configPath, '--adapter', 'caddyfile'],
    // A root LaunchDaemon inherits no HOME, and Caddy resolves its data
    // directory (certificates, the internal CA) from it — without this it
    // refuses to start.
    env: system ? { HOME: '/var/root' } : {},
    stdoutPath: system ? SYSTEM_LOG_PATH : userLogPath(),
    stderrPath: system ? SYSTEM_LOG_PATH : userLogPath(),
  });
}

/** A privileged port needs a root LaunchDaemon; anything else is a user agent. */
export function needsRoot(port: number): boolean {
  return port < 1024;
}

/** Resolve the caddy binary (Apple Silicon and Intel Homebrew prefixes differ). */
async function resolveCaddyBin(ctx: InstallContext): Promise<string> {
  if (ctx.dryRun) return '/opt/homebrew/bin/caddy';
  return (await ctx.runner.capture('bash', ['-lc', 'command -v caddy'])).stdout.trim() || '/opt/homebrew/bin/caddy';
}

/**
 * `curl` flags that make a probe hit THIS Mac's Caddy with the right `Host` and
 * SNI: `--resolve` pins the site's hostname at loopback (a public domain may
 * not resolve here at all, and a `.local` name may resolve to a LAN address),
 * `-k` accepts the internal CA's certificate.
 */
export function probeArgs(site: CaddySite): string[] {
  if (site.exposure === 'http') return [];
  return ['-k', '--resolve', `${site.host}:${site.port}:127.0.0.1`];
}

/** The URL a local probe requests (the `http` exposure matches any Host). */
export function probeUrl(site: CaddySite): string {
  return site.exposure === 'http' ? `http://127.0.0.1:${site.port}/` : siteUrl(site);
}

/**
 * The site as it was configured, rebuilt from the recorded artifact so the
 * identity step and `server-deploy` can probe a front they did not just create.
 * `undefined` when nothing is recorded (a step satisfied via `check()` on a host
 * whose ledger was lost).
 */
export function recordedSite(ctx: InstallContext): CaddySite | undefined {
  const record = (ctx.state.steps.caddy?.created?.artifacts ?? []).find((a) => a.type === 'caddy-site');
  if (!record?.name || !record.scope) return undefined;
  const [host, port] = record.name.split('|');
  const exposure = record.scope;
  if (!host || !port || (exposure !== 'internal' && exposure !== 'acme' && exposure !== 'http')) return undefined;
  return {
    exposure,
    host,
    port: Number.parseInt(port, 10),
    user: '',
    hash: '',
    upstream: `${bindHost(ctx)}:${ctx.state.primaryPort}`,
  };
}

/** Write the Caddyfile `0600` — it carries the cockpit's password hash. */
function writeCaddyfile(ctx: InstallContext, content: string): string {
  const path = caddyfilePath();
  if (ctx.dryRun) {
    ctx.ui.info(`DRY RUN — would write ${path}:`);
    ctx.ui.message(content);
    return path;
  }
  assertCezarHomeWriteIsSandboxed(path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { encoding: 'utf8', mode: 0o600 });
  // `mode` only applies on create — chmod too, for a re-install over an
  // existing world-readable file.
  chmodSync(path, 0o600);
  return path;
}

/**
 * Install (and load) the root LaunchDaemon. The plist rides as base64 so
 * newlines and quotes survive a copy-paste into a root shell, with the decoded
 * content shown first; the command self-verifies by printing the loaded job, so
 * a delegated paste that silently failed does not pass.
 */
async function installCaddyDaemon(ctx: InstallContext, content: string): Promise<void> {
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  await sudoStep(ctx, {
    description: 'Install the Caddy launchd daemon (root — a user agent cannot bind a port below 1024).',
    note: `${DAEMON_PLIST_PATH}\n\n${content}`,
    command:
      `printf %s ${shquote(b64)} | base64 --decode > ${shquote(DAEMON_PLIST_PATH)}` +
      ` && chown root:wheel ${shquote(DAEMON_PLIST_PATH)} && chmod 0644 ${shquote(DAEMON_PLIST_PATH)}` +
      ` && { launchctl bootout system/${PLIST_LABEL} >/dev/null 2>&1 || true; }` +
      ` && launchctl bootstrap system ${shquote(DAEMON_PLIST_PATH)}` +
      ` && launchctl print system/${PLIST_LABEL} >/dev/null`,
    verify: (c) => verifyCommand(c, 'test', ['-f', DAEMON_PLIST_PATH]),
  });
}

/** Bootout + remove the root LaunchDaemon. */
async function removeCaddyDaemon(ctx: InstallContext): Promise<void> {
  await sudoStep(ctx, {
    description: 'Remove the Caddy launchd daemon.',
    command:
      `{ launchctl bootout system/${PLIST_LABEL} >/dev/null 2>&1 || true; }` +
      ` && rm -f ${shquote(DAEMON_PLIST_PATH)}`,
    verify: (c) => verifyCommand(c, 'test', ['!', '-f', DAEMON_PLIST_PATH]),
  });
}

/**
 * bcrypt the cockpit password with Caddy's own hasher. The plaintext goes in on
 * STDIN (`caddy hash-password` reads all of stdin when it is not a terminal),
 * never as `--plaintext` in argv where `ps` would expose it — and, because
 * stdin is read verbatim, without a trailing newline.
 */
async function hashPassword(ctx: InstallContext, caddyBin: string, password: string): Promise<string> {
  if (ctx.dryRun) return '$2a$14$<dry-run-hash>';
  const out = await ctx.runner.capture(caddyBin, ['hash-password'], { input: password });
  const hash = out.stdout.trim().split('\n').pop()?.trim() ?? '';
  if (out.code !== 0 || !hash.startsWith('$2')) {
    throw new StepAborted(
      `\`caddy hash-password\` did not return a bcrypt hash (exit ${out.code}) — cannot write the Caddyfile. ` +
        'Check `caddy version`; the stdin form needs Caddy 2.5 or newer.',
    );
  }
  return hash;
}

const caddyStep: InstallStep = {
  id: 'caddy',
  title: 'Caddy front (HTTPS + local basic auth)',
  async check(ctx) {
    if (ctx.dryRun) return false;
    const config = await verifyCommand(ctx, 'test', ['-f', caddyfilePath()]);
    if (!config) return false;
    const agent = await verifyCommand(ctx, 'test', ['-f', launchAgentPath(PLIST_LABEL)]);
    const daemon = await verifyCommand(ctx, 'test', ['-f', DAEMON_PLIST_PATH]);
    return agent || daemon;
  },
  async run(ctx): Promise<{ artifacts: StepArtifact[] }> {
    // 1) caddy present?
    const present = await verifyCommand(ctx, 'caddy', ['version']);
    if (!present) {
      if (ctx.dryRun) ctx.ui.info('DRY RUN — would run: brew install caddy');
      else await ctx.runner.interactive('brew', ['install', 'caddy']);
    }
    const caddyBin = await resolveCaddyBin(ctx);

    // 2) how should the front be reachable? The default needs no public DNS,
    //    no open ports, and no root.
    const picked = await ctx.ui.select<CaddyExposure>({
      message: 'How should Caddy publish the cockpit?',
      options: [
        {
          value: 'internal',
          label: 'LAN / VPN — HTTPS with Caddy\'s own CA',
          hint: 'no public DNS, no open ports, no root; the CA is not publicly trusted',
        },
        {
          value: 'acme',
          label: 'Public domain — automatic HTTPS (Let\'s Encrypt)',
          hint: 'needs DNS pointing here and :80/:443 reachable; runs Caddy as root',
        },
        {
          value: 'http',
          label: 'Plain HTTP on a local port',
          hint: 'for a tunnel that already does TLS — the login is still enforced here',
        },
      ],
      initialValue: 'internal',
    });
    if (picked === CANCEL) throw new StepCancelled();
    const exposure: CaddyExposure = picked === 'acme' || picked === 'http' ? picked : 'internal';

    // 3) the name it answers on. For ACME that is the certificate's subject, so
    //    it must be a real domain; otherwise anything resolvable on your network.
    const defaultHost = ctx.dryRun
      ? 'this-mac.local'
      : `${(await ctx.runner.capture('scutil', ['--get', 'LocalHostName'])).stdout.trim() || 'this-mac'}.local`;
    const hostAnswer = await ctx.ui.text({
      message:
        exposure === 'acme'
          ? 'Public domain for the cockpit (DNS must already point at this Mac)'
          : 'Hostname you will reach the cockpit on (used for the certificate)',
      placeholder: exposure === 'acme' ? 'cezar.example.com' : defaultHost,
      initialValue: exposure === 'acme' ? '' : defaultHost,
      validate: (v) => {
        const t = v.trim();
        if (!t) return 'a hostname is required';
        if (exposure === 'acme' && !HOSTNAME_RE.test(t)) return 'enter a bare public domain (no scheme), e.g. cezar.example.com';
        // Non-ACME names include `.local` and tailnet names, and may be an IP —
        // only reject what would break the Caddyfile or the URL.
        if (/[\s/:{}]/.test(t)) return 'enter a bare hostname (no scheme, port, or path)';
        return undefined;
      },
    });
    if (hostAnswer === CANCEL) throw new StepCancelled();
    const host = String(hostAnswer).trim();

    // 4) the port Caddy listens on. ACME owns 443 by definition; the others
    //    default above 1024 so no root is needed.
    let port = 443;
    if (exposure !== 'acme') {
      const portAnswer = await ctx.ui.text({
        message: 'Port Caddy listens on',
        placeholder: exposure === 'http' ? '8080' : '8443',
        initialValue: exposure === 'http' ? '8080' : '8443',
        validate: (v) => {
          const n = Number.parseInt(v.trim(), 10);
          if (!Number.isInteger(n) || n < 1 || n > 65535) return 'enter a port between 1 and 65535';
          if (n === ctx.state.primaryPort) return `${n} is the cockpit's own port — Caddy needs a different one`;
          return undefined;
        },
      });
      if (portAnswer === CANCEL) throw new StepCancelled();
      port = Number.parseInt(String(portAnswer).trim(), 10);
    }
    const system = needsRoot(port);

    // 5) the login Caddy enforces. Same shape as ubuntu-vps: generate a strong
    //    one (shown once) or type your own.
    const suggestedUser = currentUsername();
    const userAnswer = await ctx.ui.text({
      message: 'Cockpit login username (Basic-Auth — you type this in the browser)',
      placeholder: suggestedUser,
      initialValue: suggestedUser,
      // A Caddyfile token: whitespace would split the `basic_auth` line into
      // something that can never match.
      validate: (v) => {
        if (!v.trim()) return 'username is required';
        if (/[\s"{}]/.test(v.trim())) return 'no whitespace, quotes or braces — it is a Caddyfile token';
        return undefined;
      },
    });
    if (userAnswer === CANCEL) throw new StepCancelled();
    const user = String(userAnswer).trim();

    let password: string;
    if (ctx.assumeYes) {
      const typed = await ctx.ui.password({
        message: `Set the cockpit password for "${user}"`,
        validate: (v) => (v.length >= 6 ? undefined : 'use at least 6 characters'),
      });
      if (typed === CANCEL) throw new StepCancelled();
      password = String(typed);
    } else {
      const how = await ctx.ui.select<'generate' | 'manual'>({
        message: `Cockpit password for "${user}"`,
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
          `Username: ${user}\nPassword: ${password}\n\nSave these now — this is your cockpit login. ` +
            'cezar stores only a bcrypt hash; the plaintext is not written anywhere and cannot be recovered.',
          'Generated cockpit credentials',
        );
      } else {
        const typed = await ctx.ui.password({
          message: `Set the cockpit password for "${user}"`,
          validate: (v) => (v.length >= 6 ? undefined : 'use at least 6 characters'),
        });
        if (typed === CANCEL) throw new StepCancelled();
        password = String(typed);
      }
    }
    // The non-interactive UI (`--yes`) runs no validators and cannot invent a
    // password — refuse rather than stand up a front with an empty login.
    if (!ctx.dryRun && password.length < 6) {
      throw new StepAborted('a cockpit password (≥6 chars) is required — run server-install without --yes to set one');
    }
    // Kept in memory only (never in server.json) so the identity step can make a
    // real authenticated request through Caddy.
    ctx.prefs.cockpit = { user, password };

    // 6) the Caddyfile, then prove the config parses before launchd runs it.
    const site: CaddySite = {
      exposure,
      host,
      port,
      user,
      hash: await hashPassword(ctx, caddyBin, password),
      upstream: `${bindHost(ctx)}:${ctx.state.primaryPort}`,
    };
    const configPath = writeCaddyfile(ctx, caddyfile(site));
    if (!ctx.dryRun) {
      const check = await ctx.runner.capture(caddyBin, ['validate', '--adapter', 'caddyfile', '--config', configPath]);
      if (check.code !== 0) {
        throw new StepAborted(
          `caddy rejected the generated config (${configPath}):\n${(check.stderr || check.stdout).trim()}`,
        );
      }
    }

    // 7) run it. A privileged port needs a root LaunchDaemon; everything else is
    //    a plain user agent, like the other macOS strategies install.
    const plist = caddyPlist(caddyBin, configPath, system);
    let plistPath: string;
    if (system) {
      ctx.ui.info(`Port ${port} is privileged — Caddy will run as a root launchd daemon.`);
      await installCaddyDaemon(ctx, plist);
      plistPath = DAEMON_PLIST_PATH;
    } else {
      plistPath = await installLaunchdAgent(ctx, PLIST_LABEL, plist, 'the Caddy front');
    }

    ctx.state.publicUrl = siteUrl(site);
    // Nothing here rotates: the name and port are the operator's own.
    ctx.state.ephemeral = false;

    if (exposure === 'internal') {
      ctx.ui.note(
        `Caddy issued the certificate from its own local CA, which browsers do not trust yet. On this Mac:\n` +
          `  sudo ${caddyBin} trust\n` +
          `On other devices, install Caddy's root CA from:\n` +
          `  ~/Library/Application Support/Caddy/pki/authorities/local/root.crt`,
        'Local certificate',
      );
    } else if (exposure === 'acme') {
      ctx.ui.note(
        `Let's Encrypt validates over :80 and :443 — both must reach this Mac (router port-forward + firewall),\n` +
          `and ${host} must resolve to its public address. Certificate progress is logged to ${SYSTEM_LOG_PATH}.`,
        'Automatic HTTPS',
      );
    } else {
      ctx.ui.warn(
        `This front speaks plain HTTP on port ${port} — the login travels unencrypted. ` +
          'Only use it behind something that terminates TLS (a tunnel), and keep the port off the public internet.',
      );
    }

    const artifacts: StepArtifact[] = [
      owned('file', { path: configPath }),
      owned('launchd', { name: PLIST_LABEL, path: plistPath, scope: system ? 'system' : 'user' }),
      // The site itself, so identity + deploy can rebuild the probe without the
      // credentials: `<host>|<port>`, exposure in `scope`.
      owned('caddy-site', { name: `${host}|${port}`, scope: exposure }),
    ];
    if (!present) artifacts.push(shared('package', { name: 'caddy', removeHint: 'brew uninstall caddy' }));
    return { artifacts };
  },
  async undo(ctx, created) {
    // Work from the recorded scope, but fall back to removing both jobs: a step
    // satisfied via check() records `created: null`, and the front (whose config
    // holds the cockpit hash) must still come down.
    const scope = (created?.artifacts ?? []).find((a) => a.type === 'launchd')?.scope;
    if (ctx.dryRun) {
      ctx.ui.info('DRY RUN — would stop and remove the Caddy launchd job and the Caddyfile.');
      return;
    }
    if (scope !== 'system') await removeLaunchdAgent(ctx, PLIST_LABEL);
    if (scope === 'system' || (await verifyCommand(ctx, 'test', ['-f', DAEMON_PLIST_PATH]))) {
      await removeCaddyDaemon(ctx);
    }
    rmSync(caddyfilePath(), { force: true });

    const pkgs = (created?.artifacts ?? []).filter((a) => a.kind === 'shared');
    if (pkgs.length > 0) {
      ctx.ui.note(
        pkgs.map((a) => a.removeHint ?? a.name ?? '').filter(Boolean).join('\n'),
        'Installed for cezar but possibly used elsewhere — remove manually if unwanted',
      );
    }
  },
};

const identityStep: InstallStep = {
  id: 'identity',
  title: 'Verify the cockpit end-to-end (Caddy challenges, and auth reaches cezar)',
  async check() {
    return false; // always re-verify; it creates nothing
  },
  async run(ctx): Promise<{ artifacts: StepArtifact[] }> {
    if (ctx.dryRun) {
      ctx.ui.info('DRY RUN — would verify Caddy challenges an anonymous request AND that an authenticated one reaches cezar.');
      return { artifacts: [] };
    }

    // 1) the cockpit itself — Caddy can only proxy to something that is up, and
    //    an anonymous 401 alone would not prove the backend is alive.
    const upstream = `http://${bindHost(ctx)}:${ctx.state.primaryPort}`;
    if (!(await probeHttp(ctx, `${upstream}/api/v1/health`, (r) => r.stdout.trim() !== '000'))) {
      ctx.ui.error(
        `cezar is not answering on ${upstream}.\n\n` +
          `Diagnostics on this Mac:\n` +
          `  • launchctl print gui/${process.getuid ? process.getuid() : 0}/${CEZAR_PLIST_LABEL}\n` +
          `  • lsof -nP -iTCP:${ctx.state.primaryPort} -sTCP:LISTEN`,
      );
      throw new StepAborted('cockpit verification failed — see the diagnostics above');
    }

    const site = recordedSite(ctx);
    if (!site) {
      ctx.ui.warn(
        'No Caddy site is recorded in this install\'s ledger, so the front could not be probed. ' +
          `Re-run with --reconfigure caddy to rebuild it (config: ${caddyfilePath()}).`,
      );
      return { artifacts: [] };
    }

    // 2) an anonymous request must be challenged — that IS the local login.
    const url = probeUrl(site);
    const args = probeArgs(site);
    const challenged = await probeHttp(ctx, url, (r) => r.stdout.trim() === '401', 5, { extraArgs: args });

    // 3) the real proof: an authenticated request reaches cezar. Credentials go
    //    through curl's stdin config (`-K -`) so they never land in argv.
    //    `null` = not testable (a resume where the plaintext is long gone).
    let authedOk: boolean | null = null;
    const cred = ctx.prefs.cockpit;
    if (cred) {
      const q = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      authedOk = await probeHttp(ctx, url, (r) => /^[23]\d\d$/.test(r.stdout.trim()), 3, {
        extraArgs: [...args, '-K', '-'],
        input: `user = "${q(cred.user)}:${q(cred.password)}"\n`,
      });
    }

    if (challenged && authedOk !== false) {
      ctx.ui.success(
        `Cockpit is live at ${ctx.state.publicUrl ?? siteUrl(site)} — ` +
          (authedOk ? 'an authenticated request reached cezar' : 'Caddy is enforcing the login and cezar is up') +
          '. Log in with the username and password you set.',
      );
      if (site.exposure === 'internal') {
        ctx.ui.note(
          `The certificate comes from Caddy's local CA — trust it once per device (\`sudo caddy trust\` on this Mac) ` +
            'or accept the browser warning. Nothing outside your network can reach this front.',
          'Identity',
        );
      }
      return { artifacts: [] };
    }

    const problems: string[] = [];
    if (!challenged) problems.push(`Caddy did not answer 401 for an anonymous request to ${url} — the front may not be running, or the login is not active`);
    if (authedOk === false) problems.push('an authenticated request did not reach cezar (bad credentials, or Caddy cannot dial the cockpit)');
    ctx.ui.error(
      `The cockpit is NOT fully working yet:\n` +
        problems.map((p) => `  • ${p}`).join('\n') +
        `\n\nDiagnostics on this Mac:\n` +
        `  • tail -n 50 ${SYSTEM_LOG_PATH} (root daemon) or ${userLogPath()}\n` +
        `  • launchctl print gui/${process.getuid ? process.getuid() : 0}/${PLIST_LABEL}\n` +
        `  • caddy validate --adapter caddyfile --config ${caddyfilePath()}\n` +
        `  • lsof -nP -iTCP:${site.port} -sTCP:LISTEN` +
        (site.exposure === 'acme'
          ? `\n  • Let's Encrypt needs :80 and :443 reachable from the internet, and ${site.host} pointing here`
          : ''),
    );
    throw new StepAborted('cockpit verification failed — see the diagnostics above');
  },
  async undo() {
    // nothing created
  },
};

export const macosxCaddy: PlatformStrategy = {
  id: 'macosx-caddy',
  label: 'macOS + Caddy (local basic auth)',
  async preflight(ctx: InstallContext) {
    await darwinPreflight(ctx, 'macosx-caddy');
  },
  steps(): InstallStep[] {
    return [
      depCheckStep({ installTool: brewInstallTool, removeHint: brewRemoveHint }),
      cezarAutostartStep,
      caddyStep,
      identityStep,
    ];
  },
  async redeploy(ctx: InstallContext) {
    ctx.ui.info('Redeploying — restarting the cezar cockpit.');
    await kickstartAgent(ctx, CEZAR_PLIST_LABEL, 'the cezar cockpit agent');
    ctx.ui.info('Redeploying — restarting the Caddy front.');
    const site = recordedSite(ctx);
    if (site && needsRoot(site.port)) {
      // The root daemon lives in the system domain, which `launchctl kickstart`
      // only reaches as root.
      if (ctx.dryRun) ctx.ui.info('DRY RUN — would restart the Caddy root daemon.');
      else {
        await sudoStep(ctx, {
          description: 'Restart the Caddy root daemon so it re-reads its config.',
          command: `launchctl kickstart -k system/${PLIST_LABEL}`,
          verify: (c) => verifyCommand(c, 'test', ['-f', DAEMON_PLIST_PATH]),
        });
      }
    } else {
      await kickstartAgent(ctx, PLIST_LABEL, 'the Caddy front');
    }
    await identityStep.run(ctx); // throws StepAborted if the cockpit isn't answering
  },
};

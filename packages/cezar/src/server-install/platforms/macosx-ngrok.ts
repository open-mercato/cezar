import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CANCEL, PreflightError, type InstallContext, type InstallStep, type PlatformStrategy, type StepArtifact } from '../types.ts';
import { brewInstallTool, brewRemoveHint, depCheckStep, HOSTNAME_RE, owned, shared, StepAborted, StepCancelled, verifyCommand } from '../steps.ts';

/**
 * The `macosx-ngrok` strategy: the app runs locally on a Mac and ngrok is the
 * public front, in place of nginx+certbot. ngrok's built-in `--basic-auth` is
 * the identity gate (the htpasswd equivalent), and a launchd agent is the
 * autostart (the systemd equivalent). Proves the engine seam with a genuinely
 * different platform — same engine, different steps.
 */

const PLIST_LABEL = 'ai.cezar.ngrok';
const plistPath = (): string => join(homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);

/**
 * `launchctl bootstrap` + proof the agent actually loaded. A discarded
 * bootstrap exit code (malformed plist, spawn failure) used to record the
 * step `done` — install reported complete with nothing running.
 */
async function bootstrapVerified(ctx: InstallContext, uid: number, label: string, path: string, what: string): Promise<void> {
  const code = await ctx.runner.interactive('launchctl', ['bootstrap', `gui/${uid}`, path]);
  const loaded = (await ctx.runner.capture('launchctl', ['print', `gui/${uid}/${label}`])).code === 0;
  if (code !== 0 || !loaded) {
    throw new StepAborted(
      `launchctl could not load ${what} (bootstrap exit ${code}) — inspect it with: launchctl print gui/${uid}/${label}`,
    );
  }
}

/** Escape a value for inclusion in plist XML text. */
function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** launchd agent that keeps an authenticated ngrok tunnel to the local cockpit up. */
export function launchdPlist(port: number, basicAuth: string, domain?: string, ngrokBin = '/opt/homebrew/bin/ngrok'): string {
  const args = ['http', String(port), '--basic-auth', basicAuth];
  if (domain) args.push('--domain', domain);
  // Escape every arg — a password/domain with `&`, `<`, `>` would otherwise
  // produce invalid plist XML and launchctl would silently fail to load it.
  const argXml = [ngrokBin, ...args]
    .map((a) => `      <string>${escapeXml(a)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- Managed by cezar server-install — do not edit by hand. -->
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${PLIST_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${argXml}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
  </dict>
</plist>
`;
}

const ngrokStep: InstallStep = {
  id: 'ngrok',
  title: 'ngrok tunnel (authtoken + domain + basic-auth)',
  async check(ctx) {
    if (ctx.dryRun) return false;
    return verifyCommand(ctx, 'test', ['-f', plistPath()]);
  },
  async run(ctx): Promise<{ artifacts: StepArtifact[] }> {
    // 1) ngrok present?
    const present = await verifyCommand(ctx, 'ngrok', ['version']);
    if (!present) {
      if (ctx.dryRun) ctx.ui.info('DRY RUN — would run: brew install ngrok/ngrok/ngrok');
      else await ctx.runner.interactive('brew', ['install', 'ngrok/ngrok/ngrok']);
    }

    // 2) authtoken (a secret — never stored in server.json; it lives in ngrok's own config)
    const token = await ctx.ui.password({
      message: 'Paste your ngrok authtoken (dashboard.ngrok.com → Your Authtoken)',
      validate: (v) => (v.trim() ? undefined : 'authtoken is required'),
    });
    if (token === CANCEL) throw new StepCancelled();
    // The token expands INSIDE the child shell: argv carries only the literal
    // string `"$NGROK_AUTHTOKEN"`, so `ps` never sees the secret. It lands in
    // ngrok's own config (~/Library/Application Support/ngrok/ngrok.yml, 0600
    // by ngrok itself), never in server.json.
    if (!ctx.dryRun) {
      const code = await ctx.runner.interactive('bash', ['-c', 'ngrok config add-authtoken "$NGROK_AUTHTOKEN"'], {
        env: { NGROK_AUTHTOKEN: String(token) },
      });
      if (code !== 0) throw new StepAborted('ngrok rejected the authtoken (`ngrok config add-authtoken` failed) — check the token and re-run');
    }

    // 3) reserved domain (optional → ephemeral URL)
    const domainInput = await ctx.ui.text({
      message: 'Reserved ngrok domain (leave blank for an ephemeral URL that changes on restart)',
      placeholder: 'cezar.ngrok.app',
      // Bare hostname only — `https://…` here used to yield `--domain https://…`
      // in the plist and a `https://https://…` publicUrl.
      validate: (v) => (!v.trim() || HOSTNAME_RE.test(v.trim()) ? undefined : 'enter a bare hostname (no scheme), e.g. cezar.ngrok.app'),
    });
    if (domainInput === CANCEL) throw new StepCancelled();
    // Guard against `String(undefined)` → `"undefined"` — @clack/prompts can
    // return undefined when the user accepts without typing over the placeholder.
    const domain = typeof domainInput === 'string' && domainInput.trim() ? domainInput.trim() : undefined;

    // 4) basic-auth identity
    const user = await ctx.ui.text({
      message: 'Basic-auth username for the tunnel',
      placeholder: 'ops',
      validate: (v) => (v.trim() ? undefined : 'username is required'),
    });
    if (user === CANCEL) throw new StepCancelled();
    const password = await ctx.ui.password({
      message: `Basic-auth password for "${user}"`,
      validate: (v) => (v.length >= 6 ? undefined : 'use at least 6 characters'),
    });
    if (password === CANCEL) throw new StepCancelled();
    if (!ctx.dryRun && String(password).length < 6) {
      throw new StepAborted('a basic-auth password (≥6 chars) is required — run server-install without --yes to set one');
    }
    const basicAuth = `${String(user)}:${String(password)}`;

    // 5) launchd agent (the plist embeds the basic-auth creds, like htpasswd on Linux)
    const path = plistPath();
    if (ctx.dryRun) {
      ctx.ui.info(`DRY RUN — would write ${path} and launchctl bootstrap it.`);
    } else {
      // Resolve the real ngrok binary path so the plist works on both Apple
      // Silicon (/opt/homebrew/bin) and Intel (/usr/local/bin) Macs.
      const ngrokBin = (await ctx.runner.capture('bash', ['-lc', 'command -v ngrok'])).stdout.trim() || '/opt/homebrew/bin/ngrok';

      mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
      // 0600: unlike the Linux htpasswd (a hash, 0640 root:www-data), this file
      // embeds the PLAINTEXT basic-auth credentials. `mode` only applies on
      // create, so chmod too for re-installs over an existing 0644 plist.
      writeFileSync(path, launchdPlist(ctx.state.primaryPort, basicAuth, domain, ngrokBin), { encoding: 'utf8', mode: 0o600 });
      chmodSync(path, 0o600);

      // Use the modern launchctl API — the legacy `launchctl load` returns
      // error 5 (EIO) on recent macOS versions.
      const uid = process.getuid ? process.getuid() : 0;
      // Bootout any prior instance so re-installs don't collide.
      await ctx.runner.capture('launchctl', ['bootout', `gui/${uid}/${PLIST_LABEL}`]);
      await bootstrapVerified(ctx, uid, PLIST_LABEL, path, 'the ngrok tunnel agent');
    }

    if (domain) {
      ctx.state.publicUrl = `https://${domain}`;
      ctx.state.ephemeral = false;
    } else {
      ctx.state.ephemeral = true;
      ctx.ui.note('No reserved domain — the tunnel URL is ephemeral and changes each restart. Find it at http://localhost:4040.', 'ngrok');
    }

    return {
      artifacts: [
        shared('ngrok-config', { name: 'authtoken', removeHint: 'ngrok config add-authtoken "" (or edit ~/Library/Application Support/ngrok/ngrok.yml)' }),
        owned('launchd', { name: PLIST_LABEL, path }),
      ],
    };
  },
  async undo(ctx, created) {
    // Work from the static label/path, not just the recorded artifact — a step
    // satisfied via check() records `created: null`, and the agent (whose plist
    // holds the basic-auth credentials) must still be removed.
    const path = (created?.artifacts ?? []).find((a) => a.type === 'launchd')?.path ?? plistPath();
    if (ctx.dryRun) {
      ctx.ui.info('DRY RUN — would launchctl bootout and remove the ngrok agent.');
    } else {
      const uid = process.getuid ? process.getuid() : 0;
      await ctx.runner.capture('launchctl', ['bootout', `gui/${uid}/${PLIST_LABEL}`]);
      rmSync(path, { force: true });
    }
    const cfg = (created?.artifacts ?? []).find((a) => a.type === 'ngrok-config');
    if (cfg) {
      ctx.ui.note(
        `The ngrok authtoken was left in ngrok's own config — remove it yourself if you want it gone:\n${cfg.removeHint ?? ''}`,
        'ngrok',
      );
    }
  },
};

/* ── autostart: run cezar itself as a launchd agent ─────────────────── */

const CEZAR_PLIST_LABEL = 'ai.cezar.cockpit';
const OFFICIAL_CLI_PKG = 'cezar-cli';
const cezarPlistPath = (): string => join(homedir(), 'Library', 'LaunchAgents', `${CEZAR_PLIST_LABEL}.plist`);

/** Resolve the argv array for the cezar launchd agent, mirroring how the CLI was launched. */
async function resolveCezarArgv(ctx: InstallContext): Promise<string[]> {
  const node = process.execPath;
  const pkgRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
  const entry = join(pkgRoot, 'dist', 'index.js');
  const npxPath = join(dirname(node), 'npx');

  if (/[/\\]_npx[/\\]/.test(pkgRoot)) return [npxPath, '--yes', OFFICIAL_CLI_PKG];
  if (ctx.dryRun || existsSync(entry)) return [node, entry];

  const out = (await ctx.runner.capture('bash', ['-lc', `command -v ${OFFICIAL_CLI_PKG} || command -v cezar`])).stdout.trim();
  const globalBin = out.split('\n').map((s) => s.trim()).filter(Boolean).pop();
  if (globalBin) return [node, globalBin];

  // No runnable cezar → installing a KeepAlive agent would make launchd
  // respawn-throttle a permanently failing job across reboots. Fail the step.
  throw new StepAborted(
    `could not locate a runnable cezar (${entry} missing, no global ${OFFICIAL_CLI_PKG}) — ` +
      `install it (npm i -g ${OFFICIAL_CLI_PKG}) or build the checkout, then re-run with --reconfigure autostart`,
  );
}

/** launchd agent that keeps the cezar cockpit running on the given port. */
export function cezarLaunchdPlist(repoRoot: string, port: number, argv: string[]): string {
  // Give the agent the operator's PATH so cezar can spawn claude/gh/codex.
  const pathDirs = [dirname(process.execPath), ...(process.env.PATH ?? '').split(':'), '/usr/local/bin', '/usr/bin', '/bin']
    .filter((d, i, a) => d && d !== '.' && a.indexOf(d) === i);
  const fullArgv = [...argv, 'serve', '--no-open', '--port', String(port)];
  const argXml = fullArgv.map((a) => `      <string>${escapeXml(a)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- Managed by cezar server-install — do not edit by hand. -->
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${CEZAR_PLIST_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${argXml}
    </array>
    <key>WorkingDirectory</key>
    <string>${escapeXml(repoRoot)}</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>CEZ_REMOTE</key>
      <string>1</string>
      <key>PATH</key>
      <string>${escapeXml(pathDirs.join(':'))}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
  </dict>
</plist>
`;
}

const autostartStep: InstallStep = {
  id: 'autostart',
  title: 'Run cezar as a service (launchd — starts now + on boot)',
  async check(ctx) {
    if (ctx.dryRun) return false;
    return verifyCommand(ctx, 'test', ['-f', cezarPlistPath()]);
  },
  async run(ctx): Promise<{ artifacts: StepArtifact[] }> {
    const argv = await resolveCezarArgv(ctx);
    const path = cezarPlistPath();
    if (ctx.dryRun) {
      ctx.ui.info(`DRY RUN — would write ${path} and launchctl bootstrap it.`);
    } else {
      mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
      writeFileSync(path, cezarLaunchdPlist(ctx.repoRoot, ctx.state.primaryPort, argv), { encoding: 'utf8', mode: 0o600 });
      chmodSync(path, 0o600);
      const uid = process.getuid ? process.getuid() : 0;
      await ctx.runner.capture('launchctl', ['bootout', `gui/${uid}/${CEZAR_PLIST_LABEL}`]);
      await bootstrapVerified(ctx, uid, CEZAR_PLIST_LABEL, path, 'the cezar cockpit agent');
    }
    return { artifacts: [owned('launchd', { name: CEZAR_PLIST_LABEL, path })] };
  },
  async undo(ctx, created) {
    // Static label/path fallback — see the ngrok step's undo.
    const path = (created?.artifacts ?? []).find((a) => a.type === 'launchd')?.path ?? cezarPlistPath();
    if (ctx.dryRun) {
      ctx.ui.info('DRY RUN — would launchctl bootout and remove the cezar agent.');
    } else {
      const uid = process.getuid ? process.getuid() : 0;
      await ctx.runner.capture('launchctl', ['bootout', `gui/${uid}/${CEZAR_PLIST_LABEL}`]);
      rmSync(path, { force: true });
    }
  },
};

const identityStep: InstallStep = {
  id: 'identity',
  title: 'Identity check (ngrok basic-auth active)',
  async check() {
    return false;
  },
  async run(ctx): Promise<{ artifacts: StepArtifact[] }> {
    if (ctx.dryRun) {
      ctx.ui.info('DRY RUN — would confirm the ngrok tunnel is up and basic-auth is enforced.');
      return { artifacts: [] };
    }
    // ngrok needs a moment after launchctl bootstrap to bind to :4040.
    // Retry a few times with a short delay before giving up.
    let up = false;
    for (let attempt = 0; attempt < 5 && !up; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 1500));
      up = await verifyCommand(ctx, 'curl', ['-s', 'http://localhost:4040/api/tunnels'], (r) => r.stdout.includes('public_url'));
    }
    if (up) ctx.ui.success('ngrok tunnel is up (basic-auth enforced at the ngrok edge).');
    else ctx.ui.warn('Could not reach the ngrok local API (localhost:4040) — check the tunnel started.');
    return { artifacts: [] };
  },
  async undo() {
    // nothing created
  },
};

export const macosxNgrok: PlatformStrategy = {
  id: 'macosx-ngrok',
  label: 'macOS + ngrok',
  async preflight(ctx: InstallContext) {
    if (ctx.dryRun) {
      ctx.ui.info('DRY RUN — skipping OS preflight.');
      return;
    }
    if (!(await ctx.runner.capture('uname', ['-s'])).stdout.includes('Darwin')) {
      throw new PreflightError('macosx-ngrok requires macOS. On a Linux VPS use --platform ubuntu-vps.');
    }
  },
  steps(): InstallStep[] {
    return [
      depCheckStep({ installTool: brewInstallTool, removeHint: brewRemoveHint }),
      autostartStep,
      ngrokStep,
      identityStep,
    ];
  },
  async redeploy(ctx: InstallContext) {
    // Restart both the cezar cockpit and the ngrok tunnel, then re-verify.
    if (ctx.dryRun) {
      ctx.ui.info('DRY RUN — would restart the cezar and ngrok launchd agents and re-verify.');
      return;
    }
    const uid = process.getuid ? process.getuid() : 0;
    ctx.ui.info('Redeploying — restarting the cezar cockpit.');
    const cezarCode = await ctx.runner.interactive('launchctl', ['kickstart', '-k', `gui/${uid}/${CEZAR_PLIST_LABEL}`]);
    if (cezarCode !== 0) ctx.ui.warn(`launchctl kickstart returned non-zero — check \`launchctl print gui/${uid}/${CEZAR_PLIST_LABEL}\`.`);
    ctx.ui.info('Redeploying — restarting the ngrok tunnel.');
    const code = await ctx.runner.interactive('launchctl', ['kickstart', '-k', `gui/${uid}/${PLIST_LABEL}`]);
    if (code !== 0) ctx.ui.warn(`launchctl kickstart returned non-zero — check \`launchctl print gui/${uid}/${PLIST_LABEL}\`.`);
    await identityStep.run(ctx);
  },
};
